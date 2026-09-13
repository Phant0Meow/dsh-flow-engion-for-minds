/**
 * subagent-native.ts — 0.1.3 原生 stock 构建的 AI 演员执行体（2026-09-09；
 * 同日晚改版：显示面回归 femo-proj 角色投影窗）。
 *
 * 与 subagent.ts（one-shot 每节点新子代理，meow fork 旧版路径）并存：本文件
 * 只在原生模式（isNativeMode()）下由 engine-events 的 ai_request 分流调用，
 * 旧路径一行不改。
 *
 * 核心语义：**同一 Job 内同一 actor 复用同一个子代理作为执行体**；角色内容
 * 的显示面 = 旧版同款 femo-proj 角色投影窗（角色气泡/turn 段落头那套自绘
 * 渲染），子代理窗本身只是引擎，不对用户展示（目录里重新 ban，对齐旧版
 * 效果：节点拉起的子代理不出现在子代理列表）。
 *  - 复用：以 (主会话, Job, actorKey) 为键，经 0.1.3 官方 subagents.startContinuable
 *    建立 durable continuable child（childId 规则化 =
 *    femo-actor-j<jobId>-<主sid>-<actorKey>，跨重启可推导）；后续节点经
 *    subagents.sendMessage 投递（空闲目标自动开新回合；进程重启后持久化子代理
 *    自动冷恢复）。轮到角色说话时把最新上下文+prompt 发给他（每轮 sendMessage
 *    全量投递），收集其流式输出经既有镜像链路投影进 god/stage/角色投影窗。
 *  - 生命周期：节点间不 dispose（复用的前提）；run-control 掐断经官方
 *    subagents.interrupt（ActiveSubagent.interrupt 通路）；同一 Job×actor 的
 *    并发节点（par 同角色）经 per-actor 锁串行，防 steer 把两个节点的台词搅进
 *    同一回合。
 *  - 归档豁免：子代理会话留在 dsh 会话树里（不 archive、不 moveChildSessionOut
 *    ——subagent.ts finally 的归档只在旧版路径执行）；常驻执行体的冷恢复依赖
 *    持久化，且目录/列表不可见由前端显示层过滤承担。
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import type { FemoBridge } from './bridge'
import { sendActorFailure } from './bridge'
import type { ResolvedConfig } from './config'
import { buildTranscript, type TranscriptStep } from './engine-transcript'
import { broadcastSse } from './http'
import { LiveStreamFrames, onAssistantStreamFrames } from './stream-frames'
import { writeTurnScopeFile, mergeActorUsageFile, type ActorUsageRecord } from './state-files'
import { dedupeIndexFor, projectionAppend, projectionActorKey, type ProjectionRegistry, type ProjectionWindows } from './projection'
import { sectionGate } from './section-gate'
import { readSessionEvents } from './session-events'
import { apiRetry } from './api-retry'
import { broker, RETRY_STEER_TEXT } from './node-retry'
import { safeSteer } from './safe-steer'
import { projTrace, t4 } from './proj-trace' // 【诊断 2026-09-11 临时】节点生命周期埋点
import {
  TURN_BASE_EPOCH, turnBaseBySession, turnScopesBySession, actorUsageBySession,
  FORWARD_CHILD_EVENTS, SURFACE_OP_EVENTS, BUFFERED_CHILD_EVENTS,
  activeSubagents, activeChildRuns, runControlAborted, type ActiveSubagent,
  readSoulPersona, buildSubagentPrompt, KNOWN_BLOCK_KEYS,
  toolFilterOf, resolveMainModel, resolveSourceModel,
  appendActorPolicyPins, FEMO_CHILD_SCOPE_TEXT,
  debugEffortLog,
} from './subagent'

// ── 0.1.3 subagents 官方面（鸭子类型：只声明我们消费的子集）─────────────────

interface NativeContent { type: 'text'; text: string }

/** 常驻子代理的 live Agent 消费面（0.1.3 Agent；ctx.agents.get(childId) 解析）。 */
interface NativeChildAgent {
  id: SessionId
  session?: { append(type: string, data: unknown, surface?: unknown): void }
  ctx?: Context
  /** 空闲时开新回合、运行中在最近 step 边界消费（0.1.3 Agent.steer）。 */
  steer?(message: unknown): void
  whenIdle?(): Promise<void>
}

/** ctx.subagents 的 continuable 消费面（0.1.3 SubagentRuntime 子集）。 */
interface NativeSubagents {
  startContinuable(spec: {
    provider: string
    label: string
    /** 调用方预留的持久身份：规则化 id 让重启后仍能找到同一角色的子代理。 */
    childId?: SessionId
    request: {
      prompt: NativeContent[]
      parent: NativeChildAgent
      persona?: string
      agentOptions?: { provider?: string; model?: string }
      toolFilter?: { allow: string[] }
    }
    signal: AbortSignal
  }): Promise<{ childId: SessionId }>
  /** 空闲目标开新回合；运行中目标在最近 step 边界 steer；持久化缺失的
   *  direct child 自动冷恢复。sender 必须是 exact live parent Agent。 */
  sendMessage(sender: NativeChildAgent, targetId: SessionId, content: NativeContent[], options: { signal: AbortSignal }): Promise<unknown>
  /** 掐断常驻子代理当前回合（idle/absent 目标为合法 no-op）。 */
  interrupt(targetSessionId: SessionId, authority: { kind: 'user'; parentSessionId: SessionId } | { kind: 'ancestor'; agent: NativeChildAgent }): void
}

// ── 同角色子代理复用注册表（内存加速键；持久身份由规则化 childId 承担）──────

interface NativeActorEntry {
  childId: string
  actor: string
  /** 所属 Job（childId 段与注册表键都带；菜单按当前 Job 过滤的依据）。 */
  jobId: number
  /** 推理档位在两次节点调用之间的传递（agent/request 钩子按最新值生效）。 */
  reasoning: { actorThinking?: string }
  /** agent/request 钩子是否已装（进程内一次；冷恢复后的新 Agent 实例需重装）。 */
  hooked?: boolean
}
/** 主会话×Job×角色 → 子代理条目。进程重启即空——重启后靠规则化 childId +
 *  persistence.stat 判定「已存在」，直接走 sendMessage 冷恢复。 */
const actorChildren = new Map<string, NativeActorEntry>()

/** 注册表复合键（\u0000 分隔，杜绝 sid/actorKey 内部字符撞键）。 */
function actorRegistryKey(sid: string, jobId: number, actorKey: string): string {
  return `${sid}\u0000j${jobId}\u0000${actorKey}`
}

// ── 同角色节点串行锁（par 同角色分支防搅回合）────────────────────────────

/** lockKey → 尾节点闸门。后到者 await 前闸门：前节点从投递到回合收口（含
 *  停靠重试环）全程持锁，sendMessage 的 steer 语义绝不会把两个节点的话塞进
 *  同一回合。前节点失败不阻塞后节点（各自独立上报引擎）。 */
const actorTurnLocks = new Map<string, Promise<unknown>>()

/** childId 规则化（job 域化）：femo-actor-j<jobId>-<主sid>-<actorKey>
 *  —— job id 紧跟固定前缀（UUID 主 sid 的连字符不会干扰解析），actorKey 收尾；
 *  前端目录过滤按 femo-actor- 前缀整体 ban（常驻执行体不对用户展示）。
 *  同 Job 内同角色复用；新 Job 开新一轮执行体窗口。 */
function nativeChildId(sid: string, jobId: number, actorKey: string): string {
  return `femo-actor-j${jobId}-${sid}-${actorKey}`
}

// ── 主流程 ────────────────────────────────────────────────────────────────

/** One engine AI turn executed through the actor's REUSED continuable child
 * (0.1.3 native only). 签名与 subagent.runAiSubagent 完全同形（调用点同款
 * catch 兜底）。 */
export async function runAiSubagentNative(
  ctx: Context,
  resolved: ResolvedConfig,
  bridge: FemoBridge,
  session: Session,
  request: Record<string, unknown>,
  recordError: (sessionId: SessionId, text: string) => void,
  defaultModel?: { currentSelection(): unknown },
  nodeActors: ReadonlyMap<string, string> = new Map(),
  projections?: ProjectionRegistry,
  nodeShowprompts: ReadonlyMap<string, string> = new Map(),
  jobId: number = -1,
): Promise<void> {
  if (projections === undefined) throw new Error('projections registry unavailable')
  const waitKey = String(request.wait_key ?? '')
  if (waitKey.length === 0) return
  const subagents = ctx.get('subagents') as NativeSubagents | undefined
  if (subagents === undefined) {
    throw new Error('subagents service unavailable (continuable subagents require the 0.1.3 subagent runtime)')
  }
  const parent = ctx.agents.get(session.id) as NativeChildAgent | undefined
  if (parent === undefined) {
    throw new Error(`parent agent for ${session.id} is not live`)
  }

  // 料包拼装与身份（与旧路径同源：buildSubagentPrompt/readSoulPersona 共用）。
  const blocks = (request.blocks ?? {}) as Record<string, unknown>
  const unknownBlockKeys = Object.keys(blocks).filter(k => !KNOWN_BLOCK_KEYS.has(k))
  if (unknownBlockKeys.length > 0) {
    console.log(`[dsh-femo][native] ai_request(node=${String(request.node_name ?? '')}) blocks 含契约外语料键（宿主拼装器不识别已忽略）: ${unknownBlockKeys.join(', ')}`)
  }
  const prompt = buildSubagentPrompt(blocks)
  const actorInfo = (request.actor_info ?? {}) as { soul?: unknown }
  const soulId = typeof actorInfo.soul === 'string' ? actorInfo.soul : ''
  const soulPersona = soulId.length > 0 ? await readSoulPersona(bridge, soulId) : ''
  if (soulPersona.includes('{{')) {
    console.log(`[dsh-femo][native] WARNING soul persona (soul_id=${soulId}) contains "{{" — dsh prompt assembly treats it as a template variable and will fail loud`)
  }
  const blk = (key: string): string => typeof blocks[key] === 'string' ? String(blocks[key]) : ''
  const nodeName = String(request.node_name ?? '')
  console.log(`[dsh-femo][native] ai_request node=${nodeName} scope=${String(request.scope ?? '')} soul_id=${soulId}`
    + ` blocks: context=${blk('context').length}ch soul=${blk('soul').length}ch memory=${blk('memory').length}ch prompt=${blk('prompt').length}ch`)

  // 演员身份（par 安全：ai_name 优先，与旧路径同款三级兜底）。
  const requestAiName = typeof request.ai_name === 'string' && request.ai_name.length > 0
    ? request.ai_name
    : undefined
  const actor = requestAiName ?? nodeActors.get(nodeName) ?? nodeName
  const actorKey = projectionActorKey(actor)
  const sid = String(session.id)
  const actorThinking = typeof request.actor_thinking === 'string' && request.actor_thinking.trim().length > 0
    ? request.actor_thinking.trim()
    : undefined

  // ── 在飞登记 + 看门狗（abort 同款语义；interrupt 走官方 interrupt）──────
  const controller = new AbortController()
  const interruptRef: { fn?: () => void } = {}
  const activeEntry: ActiveSubagent = {
    controller,
    node: nodeName,
    jobId,
    interrupt: () => { interruptRef.fn?.() },
  }
  activeSubagents.add(activeEntry)
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const armIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      interruptRef.fn?.()
      controller.abort(new Error(`子 agent 空闲超时（${Math.round(resolved.subagentIdleTimeoutMs / 1000)}s 无输出）`))
    }, resolved.subagentIdleTimeoutMs)
  }

  // ── 同 Job×同角色 串行锁（含停靠重试环全程）──────────────────────────
  projTrace('node', `节点开跑 node=${nodeName} actor=${actor} waitKey=${waitKey} job=${jobId}`)
  const lockKey = actorRegistryKey(sid, jobId, actorKey)
  const prevLock = actorTurnLocks.get(lockKey) ?? Promise.resolve()
  let releaseLock!: () => void
  const lockGate = new Promise<void>(resolve => { releaseLock = resolve })
  const lockTicket = prevLock.then(() => lockGate)
  actorTurnLocks.set(lockKey, lockTicket)
  lockTicket.catch(() => undefined)
  try {
    await prevLock
  } catch {
    // 前一节点失败不阻塞本节点（各自独立上报引擎）。
  }

  // turn 号纪元重映射（每节点预留 100 个 turn）。
  const baseTurn = (turnBaseBySession.get(sid) ?? TURN_BASE_EPOCH) + 1
  turnBaseBySession.set(sid, baseTurn + 100)
  projTrace('node', `分配轮号 node=${nodeName} actor=${actor} turn=${t4(baseTurn)}（下一轮基数=${t4(baseTurn + 100)}）`)
  // 【2026-09-10 v7 段落闸门】同角色上一区块未落盘前不派发本节点：上一回合
  // 的直播桶还保留着内容（end 帧随闸门放行），本回合的流式帧 (index,step) 同
  // 键会跟残留块拼成乱串。等待在 per-actor 锁之后（锁只串节点周期，不等闸门）。
  await sectionGate.waitActorFlush(sid, actorKey)
  sectionGate.begin(sid, baseTurn, actorKey)

  // scope_info 先于建窗解析（建窗兜底要按本节点 scope 补建角色窗）。
  const scopeInfo = Array.isArray(request.scope_info)
    ? request.scope_info.filter((x): x is string => typeof x === 'string')
    : undefined

  // 投影窗：god+stage+角色窗全用（2026-09-09 晚改版：角色投影窗回归，与旧
  // 路径同款——registry 缺窗时按本节点 scope 补建；flow_start 已按剧本角色
  // 全量建过，此处是重启恢复/动态角色的兜底）。
  let windowsOrUndefined = projections.get(sid)
  if (windowsOrUndefined === undefined) {
    const headerCwd = (session.header as { cwd?: string } | undefined)?.cwd
    if (headerCwd === undefined || headerCwd.length === 0) {
      activeSubagents.delete(activeEntry)
      releaseLock()
      // 闸门登记必须清账：本区块以空 runner 释放（按序），否则队列头永久
      // 卡住、同角色下一节点的 waitActorFlush 永不返回。
      sectionGate.commit(sid, baseTurn, actorKey, () => {})
      throw new Error(`session ${sid} cwd missing — projection windows cannot be ensured (process.cwd() fallback forbidden)`)
    }
    windowsOrUndefined = await projections.ensure(sid, scopeInfo ?? [], headerCwd)
  }
  const windows: ProjectionWindows = windowsOrUndefined

  const showprompt = nodeName.length > 0 ? nodeShowprompts.get(nodeName) : undefined

  // 【2026-09-10 v7 直播轻锚】开跑即落（不进区块、不等闸门）：前端
  // femo-live-tail 以它为 start，把本演员的流式直播画在窗底直播区（锚恒在
  // 一切已落地区块之后）。区块落盘时本回合 turn/end 到位，轻锚节点随之隐藏；
  // 名字的正式归位由区块内的 speaker 行承担。
  // 【2026-09-11 v9】顺带带上 showprompt：显示层 v9 的"一轮一气"要求流式期就
  // 显示 📢 旁白（那一刻区块还没落盘，prompt 行还躺在闸门缓冲里）。老前端
  // 不认识这个字段，原样忽略。
  projectionAppend(windows, 'dsh-femo/chat', {
    kind: 'live',
    actor,
    turn: baseTurn,
    ...showprompt === undefined ? {} : { showprompt },
    ...scopeInfo === undefined ? {} : { visible: scopeInfo },
    seq: Date.now(),
  }, undefined, scopeInfo)
  projTrace('node', `写开轮锚点(live) actor=${actor} turn=${t4(baseTurn)} node=${nodeName}`)

  // 【2026-09-10 v7.1】节点=一个回合：常驻子代理的 turn 计数跨节点累加，且
  // 节点内停靠重试（engine node_retry → steer）会让同一子代理再开新回合——
  // 重试是「本回合内部的 steer」（猫猫拍板：每轮投影 = showprompt+名字+
  // 依次 cot/工具/回答+轮内 steer，直到本轮彻底结束），必须全部折进同一个
  // baseTurn，拆成 baseTurn+1… 会变成无名字的散块。故全部镜像事件恒映射
  // baseTurn；回合的收口 turn/end 由 releaseSection 在节点审结时合成一条。
  const mapTurn = (_childTurn: unknown): number => baseTurn

  let speakerWritten = false
  const appendSpeakerLine = (): void => {
    if (speakerWritten) return
    speakerWritten = true
    mirrorBuffer.push({
      type: 'dsh-femo/chat',
      data: {
        kind: 'speaker',
        actor,
        text: actor,
        turn: baseTurn,
        ...scopeInfo === undefined ? {} : { visible: scopeInfo },
        seq: Date.now(),
      },
      surface: undefined,
    })
  }
  let showpromptWritten = false
  const appendShowpromptLine = (): void => {
    if (showpromptWritten || showprompt === undefined) return
    showpromptWritten = true
    mirrorBuffer.push({
      type: 'dsh-femo/chat',
      data: {
        kind: 'prompt',
        text: `📢 ${showprompt}`,
        turn: baseTurn,
        ...scopeInfo === undefined ? {} : { visible: scopeInfo },
        seq: Date.now(),
      },
      surface: undefined,
    })
  }
  // 【2026-09-10 v7 直播轻锚】节点开跑即落一条 kind='live' 轻锚（不进区块、
  // 不等闸门）——前端 femo-live-tail 节点以它为 start，把该演员的流式直播画在
  // 窗底直播区（锚=1e12+seq 恒在一切已落地区块之后）；区块落盘时 turn/end
  // 归位，轻锚节点随之隐藏。名字行的正式归位仍由区块内的 speaker 行承担。

  // 【2026-09-10 v7】整段区块缓冲：骨架（turn/start、step/start）、speaker/📢
  // 行、错误行、内容块、turn/end 全部进缓冲，由段落闸门按开跑顺序一次性落盘
  // （见 section-gate.ts 头注释——段落顺序=开跑顺序且段内恒完整）。
  const mirrorBuffer: Array<{ type: string; data: Record<string, unknown>; surface: Record<string, unknown> | undefined }> = []
  const toolNamesByCallId = new Map<string, string>()
  const flushMirrorBuffer = (): void => {
    if (mirrorBuffer.length === 0) return
    const pending = mirrorBuffer.splice(0)
    for (const item of pending) {
      projectionAppend(windows, item.type, item.data, item.surface, scopeInfo)
    }
  }
  // 本回合区块的闸门释放（幂等）：缓冲全量落盘 + 合成收口 turn/end + 直播
  // end 帧放行。只在节点审结（finally）调用——轮内 steer 重试的中间回合不
  // 触发释放，整轮（含重试）折进同一段落。最后一轮仍以 error 收口的，落一条
  // 归属错误行（前端 femo-turn-head 渲染在该演员名字下方；官方 turnError 行
  // 按物理 seq 定位，par 交错下会挂错演员名下，镜像实锤）。
  let sectionReleased = false
  let lastErrorReason: { message: string; code: string } | undefined
  const releaseSection = (): void => {
    if (sectionReleased) return
    sectionReleased = true
    projTrace('node', `段落释放(commit) actor=${actor} turn=${t4(baseTurn)} node=${nodeName} 缓冲行数=${mirrorBuffer.length}`)
    sectionGate.commit(sid, baseTurn, actorKey, () => {
      if (lastErrorReason !== undefined) {
        mirrorBuffer.push({
          type: 'dsh-femo/chat',
          data: {
            kind: 'error',
            actor,
            text: `⚠️ 本轮运行失败：${lastErrorReason.message}${lastErrorReason.code ? `（${lastErrorReason.code}）` : ''}`,
            turn: baseTurn,
            seq: Date.now(),
          },
          surface: undefined,
        })
      }
      mirrorBuffer.push({ type: 'turn/end', data: { turn: baseTurn, reason: { kind: 'completed' } }, surface: undefined })
      flushMirrorBuffer()
      projTrace('node', `落盘完成 actor=${actor} turn=${t4(baseTurn)} → 发清桶帧(闭轮)`)
      broadcastSse('femo_stream', { kind: 'end', sid, node_name: nodeName, actor, turn: baseTurn })
    })
  }

  // ── 角色占用采样（与旧路径同款：request/context + usage → 内存表/SSE/落盘）──
  const usageCurrent: { provider?: string; model?: string; contextWindow?: number; usedTokens?: number } = {}
  const usageRecord = (): ActorUsageRecord => ({
    provider: usageCurrent.provider ?? '',
    model: usageCurrent.model ?? '',
    contextWindow: usageCurrent.contextWindow ?? 1_000_000,
    usedTokens: usageCurrent.usedTokens ?? 0,
    updatedAt: Date.now(),
  })
  const publishActorUsage = (): void => {
    if (usageCurrent.usedTokens === undefined) return
    let byActor = actorUsageBySession.get(sid)
    if (byActor === undefined) {
      byActor = new Map()
      actorUsageBySession.set(sid, byActor)
    }
    byActor.set(actorKey, usageRecord())
    broadcastSse('femo_actor_usage', { sid, actorKey, ...usageRecord() })
  }
  /** usage 落地（assistant/message 事件与 0.1.3 原生流帧两条来源共用）。 */
  const applyUsage = (usage: unknown): void => {
    if (usage === undefined || typeof usage !== 'object') return
    const u = usage as { inputTokens?: unknown; cacheReadTokens?: unknown; cacheWriteTokens?: unknown }
    usageCurrent.usedTokens = (typeof u.inputTokens === 'number' ? u.inputTokens : 0)
      + (typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0)
      + (typeof u.cacheWriteTokens === 'number' ? u.cacheWriteTokens : 0)
    publishActorUsage()
  }
  const captureActorUsage = (event: SessionEvent): void => {
    if (event.type === 'request/context') {
      const d = (event.data ?? {}) as { provider?: unknown; model?: unknown; contextWindow?: unknown }
      if (typeof d.provider === 'string') usageCurrent.provider = d.provider
      if (typeof d.model === 'string') usageCurrent.model = d.model
      if (typeof d.contextWindow === 'number' && d.contextWindow > 0) usageCurrent.contextWindow = d.contextWindow
      return
    }
    const data = (event.data ?? {}) as { chunk?: { type?: unknown; usage?: unknown }; usage?: unknown }
    applyUsage(event.type === 'assistant/chunk' && data.chunk?.type === 'usage'
      ? data.chunk.usage
      : event.type === 'assistant/message' ? data.usage : undefined)
  }
  const persistActorUsage = (): void => {
    if (usageCurrent.usedTokens === undefined) return
    void mergeActorUsageFile(resolved.femoRoot, sid, actorKey, usageRecord()).catch((error: unknown) => {
      console.log(`[dsh-femo][native] write actor-usage failed: ${String(error)}`)
    })
  }

  // ── 回合收口追踪（复用子代理没有 run.result，回合边界=turn/end）────────
  // per-actor 锁保证我们 send 时子代理空闲，故「send 之后到达的第一个本子代理
  // turn/end」就是本节点回合。baseline=投递前已收口的 turn 数（防用户经官方
  // composer 插话产生的历史收口被误认），FIFO 取第 baseline 个之后的收口。
  const settledTurns: number[] = []
  let baselineCount = 0
  const childTurnEvents = new Map<number, SessionEvent[]>()
  const allChildEvents: SessionEvent[] = []
  const pendingTurn: { slot: Array<{ resolve: (turn: number) => void; reject: (e: unknown) => void }> } = { slot: [] }
  const resolvePendingTurn = (turn: number): void => {
    const waiter = pendingTurn.slot.shift()
    if (waiter === undefined) return
    waiter.resolve(turn)
  }
  const rejectPendingTurn = (error: unknown): void => {
    for (const waiter of pendingTurn.slot.splice(0)) waiter.reject(error)
  }
  const waitTurnAfterBaseline = (): Promise<number> => {
    if (settledTurns.length > baselineCount) {
      return Promise.resolve(settledTurns[baselineCount])
    }
    return new Promise<number>((resolve, reject) => {
      pendingTurn.slot.push({ resolve, reject })
    })
  }

  // ── 骨架合成（【2026-09-10 v7】骨架改入区块缓冲：随整段落盘，不再即时）──
  let turnStarted = false
  let currentStep = -1
  const ensureTurnStart = (): void => {
    if (turnStarted) return
    // 幂等兜底（与旧路径同款 O(1) 结构键查重）。
    const dup = dedupeIndexFor(session).structKeys.has(`turn/start:${baseTurn}`)
    if (dup) {
      turnStarted = true
      return
    }
    turnStarted = true
    mirrorBuffer.push({ type: 'turn/start', data: { turn: baseTurn }, surface: undefined })
    let scopes = turnScopesBySession.get(sid)
    if (scopes === undefined) {
      scopes = new Map()
      turnScopesBySession.set(sid, scopes)
    }
    scopes.set(baseTurn, scopeInfo ?? [])
    void writeTurnScopeFile(resolved.femoRoot, sid, scopes).catch((error: unknown) => {
      console.log(`[dsh-femo][native] write turn-scope file failed: ${String(error)}`)
    })
  }
  const ensureStepStart = (step: number): void => {
    if (currentStep === step) return
    let dup = false
    if (windows.god !== undefined) {
      dup = dedupeIndexFor(windows.god).structKeys.has(`step/start:${baseTurn}:${step}`)
    }
    if (dup) {
      currentStep = step
      return
    }
    currentStep = step
    ensureTurnStart()
    mirrorBuffer.push({ type: 'step/start', data: { turn: baseTurn, step }, surface: undefined })
  }

  // ── 子代理事件监听：镜像 + 回合追踪 + 看门狗再武装（先于建/发注册）──────
  // childId 在 ensure 阶段才确定；监听器经 ref 读取。
  const childIdRef: { id: string } = { id: '' }
  const onChildEvent = (watched: Session, watchedEvent: SessionEvent): void => {
    if (String(watched.id) !== childIdRef.id || childIdRef.id === '') return
    armIdle()
    captureActorUsage(watchedEvent)
    allChildEvents.push(watchedEvent)
    // 回合事件按原始子代理 turn 号归档；turn/end 推进收口队列。
    // 【v7.1】状态行不在此熄灭：节点内 steer 重试会让子代理再开回合，
    // 「Deep diving」要贯穿整轮（含轮内 steer），熄灭权威在节点审结处。
    // 回合事件按原始子代理 turn 号归档；turn/end 推进收口队列。
    const rawTurn0 = (watchedEvent.data ?? {}) as { turn?: unknown }
    if (typeof rawTurn0.turn === 'number') {
      let bucket = childTurnEvents.get(rawTurn0.turn)
      if (bucket === undefined) {
        bucket = []
        childTurnEvents.set(rawTurn0.turn, bucket)
      }
      bucket.push(watchedEvent)
      if (watchedEvent.type === 'turn/end') {
        settledTurns.push(rawTurn0.turn)
        resolvePendingTurn(rawTurn0.turn)
      }
    }
    if (!FORWARD_CHILD_EVENTS.has(watchedEvent.type) && watchedEvent.type !== 'assistant/chunk') return
    const isChunk = watchedEvent.type === 'assistant/chunk'
    const chunkWrap = isChunk
      ? (watchedEvent.data as {
          chunk?: { type?: string; index?: number; blockType?: string; text?: unknown; name?: unknown; argumentsDelta?: unknown; block?: { type?: string } }
          turn?: unknown
          step?: unknown
        })
      : undefined
    const chunk = chunkWrap?.chunk
    const raw = (watchedEvent.data ?? {}) as Record<string, unknown>
    const mappedTurn = mapTurn(raw.turn)
    const mappedStep = typeof raw.step === 'number' ? raw.step : 0
    if (watchedEvent.type === 'turn/start' || isChunk
      || watchedEvent.type === 'assistant/message' || watchedEvent.type === 'step/end'
      || watchedEvent.type === 'step/start') {
      ensureTurnStart()
      if (watchedEvent.type !== 'turn/start') ensureStepStart(mappedStep)
    }
    // 流式直播（SSE，零落盘）——与旧路径同帧词汇。【0.1.3 注】本段在原生构建
    // 下恒不触发（0.1.3 无 assistant/chunk 会话事件，增量走 agent 级瞬时帧），
    // 直播由下方 stream-frames 的帧桥承担；此处保留为旧宿主形态的存量护栏。
    if (isChunk && chunk !== undefined) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
        broadcastSse('ai_token', { node_name: nodeName, actor, token: chunk.text })
        broadcastSse('femo_stream', { kind: 'delta', sid, node_name: nodeName, actor, blockKind: 'text', index: chunk.index, step: mappedStep, text: chunk.text })
      } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
        broadcastSse('femo_stream', { kind: 'delta', sid, node_name: nodeName, actor, blockKind: 'reasoning', index: chunk.index, step: mappedStep, text: chunk.text })
      } else if (chunk.type === 'tool-call-delta') {
        const name = typeof chunk.name === 'string' && chunk.name.length > 0 ? chunk.name : undefined
        const argsDelta = typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
        if (name !== undefined || argsDelta.length > 0) {
          broadcastSse('femo_stream', {
            kind: 'delta', sid, node_name: nodeName, actor, blockKind: 'toolcall', index: chunk.index, step: mappedStep,
            ...name !== undefined ? { name } : {},
            text: argsDelta,
          })
        }
      } else if (chunk.type === 'block-start' && (chunk.blockType === 'text' || chunk.blockType === 'reasoning')) {
        broadcastSse('femo_stream', { kind: 'start', sid, node_name: nodeName, actor, blockKind: chunk.blockType, index: chunk.index, step: mappedStep })
      } else if (chunk.type === 'block-end' && (chunk.block?.type === 'text' || chunk.block?.type === 'reasoning' || chunk.block?.type === 'tool-call')) {
        broadcastSse('femo_stream', {
          kind: 'block_end', sid, node_name: nodeName, actor, index: chunk.index, step: mappedStep, retain: true,
          blockKind: chunk.block?.type === 'tool-call' ? 'toolcall' : chunk.block?.type,
        })
      }
    }
    if (watchedEvent.type === 'tool/call') {
      if (typeof raw.callId === 'string' && typeof raw.name === 'string') {
        toolNamesByCallId.set(raw.callId, raw.name)
      }
    } else if (watchedEvent.type === 'tool/result') {
      const msg = (watchedEvent.data as {
        message?: {
          source?: { callId?: unknown }
          content?: Array<{ content?: Array<{ type?: unknown; text?: unknown }> }>
        }
      }).message
      const callId = typeof msg?.source?.callId === 'string' ? msg.source.callId : undefined
      let text = ''
      for (const part of msg?.content ?? []) {
        for (const inner of part?.content ?? []) {
          if (inner?.type === 'text' && typeof inner.text === 'string' && inner.text.length > 0) {
            text = inner.text
            break
          }
        }
        if (text.length > 0) break
      }
      const name = callId !== undefined ? toolNamesByCallId.get(callId) : undefined
      broadcastSse('femo_stream', {
        kind: 'tool_result', sid, node_name: nodeName, actor, step: mappedStep,
        ...(name !== undefined ? { name } : {}),
        text: text.length > 2000 ? `${text.slice(0, 2000)}…` : text,
      })
    }
    if (!FORWARD_CHILD_EVENTS.has(watchedEvent.type)) return
    if (isChunk) {
      if (chunk?.type !== 'block-start' && chunk?.type !== 'block-end') return
    }
    appendSpeakerLine()
    appendShowpromptLine()
    const structural = watchedEvent.type === 'turn/start' || watchedEvent.type === 'turn/end'
      || watchedEvent.type === 'step/start' || watchedEvent.type === 'step/end'
    let data = structural
      ? { ...raw }
      : { ...raw, _srcSeq: `${childIdRef.id}#${Number(watchedEvent.seq)}` }
    if ('turn' in data) data.turn = mappedTurn
    if ('step' in data && typeof data.step === 'number') data.step = data.step
    // 【2026-09-10 v7.1 回合失败行归属 + 单回合折叠】子代理的 turn/end 不再
    // 镜像：整段只有一个回合，收口 turn/end 由 releaseSection 在节点审结时
    // 合成（轮内 steer 重试的中间回合不落盘、不触发区块释放）。error 收口记
    // 下原因（重试成功会被后续回合的 completed 覆盖），审结时若最终仍是
    // error 才落归属错误行。
    if (watchedEvent.type === 'turn/end') {
      const reason = (raw as { reason?: { kind?: string; error?: { message?: unknown; code?: unknown } } }).reason
      if (reason?.kind === 'error') {
        lastErrorReason = {
          message: typeof reason.error?.message === 'string' ? reason.error.message : '',
          code: typeof reason.error?.code === 'string' ? reason.error.code : '',
        }
      } else {
        lastErrorReason = undefined
      }
      return
    }
    const surfaceOp = SURFACE_OP_EVENTS.has(watchedEvent.type)
      ? ({ surfaceOp: 'append' } as Record<string, unknown>)
      : undefined
    if (BUFFERED_CHILD_EVENTS.has(watchedEvent.type)
      || watchedEvent.type === 'turn/start' || watchedEvent.type === 'step/start') {
      // 【2026-09-10 v7】骨架（原生子代理会发真实的 turn/start、step/start）
      // 与内容一样入区块缓冲——走即时写窗会绕过闸门，段落顺序又漂移。合成件
      // 与真实件的重复由 projectionAppend 结构等价查重拦截（先入者落盘）。
      mirrorBuffer.push({ type: watchedEvent.type, data, surface: surfaceOp })
    } else {
      projectionAppend(windows, watchedEvent.type, data, surfaceOp, scopeInfo)
    }
  }
  const disposeListener = ctx.on('session/event', onChildEvent)

  // ── 0.1.3 原生流帧直播（打字机本体）────────────────────────────────────
  // 本子代理的模型增量经 agent/assistant-stream 到达（会话事件里没有 chunk），
  // 按既有 femo_stream 词汇转出 → god/stage/角色投影窗实时逐字渲染；看门狗同步
  // 再武装（0.1.3 生成长回合期间没有任何会话事件，只有帧——不接这条会让满负荷
  // 生成的节点被空闲超时误杀）。
  const liveFrames = new LiveStreamFrames(
    { sid, node_name: nodeName, actor, turn: baseTurn },
    chunk => { if (chunk.type === 'usage') applyUsage(chunk.usage) },
  )
  const disposeFrameListener = onAssistantStreamFrames(ctx, ({ agent, frame }) => {
    if (frame === undefined || childIdRef.id === '') return
    if (String(agent?.id ?? agent?.session?.id ?? '') !== childIdRef.id) return
    armIdle()
    projTrace('frame', `收原生帧 type=${frame.type ?? '-'} step=${String(frame.step ?? '-')} → 直播位 actor=${actor} turn=${t4(baseTurn)}`)
    liveFrames.frame(frame)
  })

  // ── 子代理 ensure：复用或创建（Job×角色 身份钉子）───────────────────────
  let entry = actorChildren.get(actorRegistryKey(sid, jobId, actorKey))
  const wasNew = entry === undefined
  let created = false
  try {
    if (entry !== undefined) {
      // 复用既有条目：把本节点调用的推理档位交给钩子 holder。
      entry.reasoning.actorThinking = actorThinking
      childIdRef.id = entry.childId
    } else {
      const childId = nativeChildId(sid, jobId, actorKey)
      childIdRef.id = childId
      const persistence = ctx.get('sessionPersistence') as
        | { stat?(id: SessionId, options?: unknown): Promise<unknown> }
        | undefined
      let persisted = false
      try {
        persisted = (await persistence?.stat?.(SessionId(childId))) !== undefined
      } catch (statError: unknown) {
        console.log(`[dsh-femo][native] persistence stat(${childId}) failed: ${String(statError)} — treating as absent`)
      }
      const newEntry: NativeActorEntry = { childId, actor, jobId, reasoning: { actorThinking }, hooked: false }
      // 档位钉法落盘备查（user_data/debug-effort-hook.log）。
      debugEffortLog(resolved, 'create',
        `child=${childId} actor=${JSON.stringify(actor)} actor_thinking=${JSON.stringify(actorThinking)}`
        + ` source=${JSON.stringify(String(request.source ?? ''))}`)
      if (!persisted) {
        // 首建：durably continuable child，初始 prompt 随建随投（官方 inbox 接受）。
        const mainModel = resolveMainModel(parent as unknown as Parameters<typeof resolveMainModel>[0], defaultModel)
        const sourceOptions = resolveSourceModel(resolved, request.source, mainModel)
        // thinking 档位在**建子代理时**就钉进 agentOptions（2026-09-10 修）：
        // 初始 prompt 这一轮不经过 agent/request 钩子（钩子在 startContinuable
        // 之后才装，见下方 setupChildAgent），旧代码只给钩子钉档位、建的时候
        // 不给，于是首轮继承主会话的 reasoningEffort（本机 = deepseek + high），
        // 非推理模型（local/gemma-3-4b-it）当场 400 UNSUPPORTED_REASONING_EFFORT。
        // 语义（与剧本解析一致：不写 thinking = default = 不下发档位）：
        // 声明了 → 显式钉该档位；没声明 → 不带字段，由模型/部署自决。
        //
        // 注意不能写 `{ agentOptions: { ...sourceOptions.agentOptions, reasoningEffort } }`
        // ——reasoningEffort 为 undefined 时键仍存在、会盖掉 dsh
        // resolveChildAgentOptions 的「换模型即删继承 effort」语义，故用条件展开。
        const agentOptions = {
          ...sourceOptions.agentOptions,
          ...actorThinking !== undefined ? { reasoningEffort: actorThinking } : {},
        }
        await subagents.startContinuable({
          provider: resolved.subagentProvider,
          label: actor,
          childId: SessionId(childId),
          request: {
            prompt: [{ type: 'text', text: prompt }],
            parent,
            persona: soulPersona,
            agentOptions,
            ...toolFilterOf(resolved, request),
          },
          signal: controller.signal,
        })
        created = true
        setupChildAgent(ctx, childId, newEntry.reasoning, resolved, defaultModel, true)
        newEntry.hooked = true
        console.log(`[dsh-femo][native] actor child created: ${childId} (${actor}, job=${jobId})`)
      } else {
        // 上一进程留下的持久子代理：本轮 sendMessage 自动冷恢复；agent/request
        // 钩子不持久，投递后对新 Agent 实例重装（见下方 needsHookInstall）。
        console.log(`[dsh-femo][native] actor child persisted from previous process: ${childId} (${actor}, job=${jobId}) — will cold-resume on send`)
      }
      entry = newEntry
      actorChildren.set(actorRegistryKey(sid, jobId, actorKey), entry)
    }
  } catch (error: unknown) {
    disposeListener()
    disposeFrameListener()
    activeSubagents.delete(activeEntry)
    releaseLock()
    // 闸门登记清账（空 runner 按序释放），防队列头卡死同角色后续节点。
    sectionGate.commit(sid, baseTurn, actorKey, () => {})
    throw error
  }
  const childId = entry.childId
  // interrupt 通路（首建与复用统一在此接线；abortAll/abortJob 与看门狗共用）。
  interruptRef.fn = (): void => {
    try {
      subagents.interrupt(SessionId(childId), { kind: 'user', parentSessionId: SessionId(sid) })
    } catch { /* 未物化/已释放：官方语义 no-op 或可吞的授权错误 */ }
  }

  // api-retry / node-retry 登记（与旧路径同款：早于任何慢层失败判定/重试信号）。
  activeChildRuns.set(childId, { mainSid: sid, node: nodeName, jobId })
  const steerChild = (text: string): void => {
    const live = ctx.agents.get(SessionId(childId)) as NativeChildAgent | undefined
    if (live?.steer !== undefined) {
      // 0.1.5 起 steer 可能抛（inbox 改 session projection、投影未激活即抛）——
      // 走 safeSteer 兜底，失败就落到下面的官方 sendMessage 面，不往上炸。
      const delivered = safeSteer(live, {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'dsh-femo' },
      }, `child ${childId}`)
      if (delivered) return
    }
    // 非驻留（冷恢复期）或 steer 投递失败：官方 sendMessage 面投递（steer 语义）。
    void subagents.sendMessage(parent, SessionId(childId), [{ type: 'text', text }], { signal: controller.signal })
      .catch(() => undefined)
  }
  broker.register({
    waitKey,
    nodeName,
    kind: 'subagent',
    jobId,
    mainSessionId: sid,
    controller,
    steer: steerChild,
  })

  // 回传给引擎的模型标识（usage 采样喂给，与旧路径同款）。
  const modelIdNow = (): string => {
    const actualProvider = typeof usageCurrent.provider === 'string' ? usageCurrent.provider : ''
    const actualModel = typeof usageCurrent.model === 'string' ? usageCurrent.model : ''
    return actualProvider && actualModel
      ? `${actualProvider}/${actualModel}`
      : (actualModel || actualProvider || '')
  }

  // abort → 回合等待者立刻失败：被掐断的回合不会再有 turn/end（旧路径由
  // run.result 的 rejection 承担同一语义），不接这条，等待协程会永久挂死。
  const onAbortReject = (): void => {
    const reason = controller.signal.reason
    rejectPendingTurn(reason instanceof Error ? reason : new Error(String(reason ?? 'aborted')))
  }
  controller.signal.addEventListener('abort', onAbortReject)

  try {
    armIdle()
    // 投递：首建回合已随 startContinuable 起跑；复用/冷恢复经 sendMessage。
    if (!created) {
      // 官方注释：空闲目标开新回合。锁保证此刻空闲；驻留代理若仍有残余活动
      // （如用户经官方 composer 触发的回合），best-effort 等它收口再投递。
      const live = ctx.agents.get(SessionId(childId)) as NativeChildAgent | undefined
      if (live?.whenIdle !== undefined) {
        await Promise.race([
          live.whenIdle(),
          new Promise<void>(resolve => { setTimeout(resolve, 30_000) }),
          new Promise<void>((_resolve, reject) => {
            controller.signal.addEventListener('abort', () => reject(new Error('aborted while waiting for idle')), { once: true })
          }),
        ])
        armIdle()
      }
      baselineCount = settledTurns.length
      await subagents.sendMessage(parent, SessionId(childId), [{ type: 'text', text: prompt }], { signal: controller.signal })
      // 冷恢复路径：sendMessage 内部已把持久子代理物化为新 Agent 实例——
      // agent/request 钩子不持久，这里补装（委派权限钉子已随日志 fold 恢复，
      // 不重复 append）。
      if (entry.hooked !== true) {
        setupChildAgent(ctx, childId, entry.reasoning, resolved, defaultModel, false)
        entry.hooked = true
      }
    }
    console.log(`[dsh-femo][native] node dispatched to actor child ${childId}: node=${nodeName} created=${String(created)} reused=${String(!wasNew)}`)

    // 等本节点回合收口 → 组装回传（与旧路径同款 trajectory 词汇）。
    let output = ''
    let steps: TranscriptStep[] = []
    const turnObserveFrom = allChildEvents.length   // 本节点回合的观测起点（历史回合不参与错误判定）
    const firstTurn = await waitTurnAfterBaseline()
    const built = buildTranscript(childTurnEvents.get(firstTurn) ?? [])
    output = built.output
    steps = built.steps
    if (output.length === 0) {
      // 兜底（仅取整段日志的最终 assistant 输出，不取 steps——复用会话的历史
      // 回合不属于本节点）：逐 turn 归档漏采时的最后防线。
      const live = ctx.agents.get(SessionId(childId)) as NativeChildAgent | undefined
      output = live?.session !== undefined
        ? buildTranscript(readSessionEvents(live.session as unknown as Session)).output
        : ''
    }
    if (steps.length === 0 && output.length > 0) {
      steps = [{ step: 0, cot: '', reply: output, tool_calls: [], tool_results: [] }]
    }
    // 回合以 error 收场（执行体层面失败：provider 拒绝/协议错/网关错）→ 上报
    // 执行失败信封，而不是伪装成空台词交卷（2026-09-10）。引擎按
    // FEMOActorExecutionError 裁决：通知作者 + 节点挂起保留断点，续跑换执行体。
    // 只认「本节点投递之后观察到的」回合，不拿复用会话的历史回合顶罪。
    const firstTurnError = childTurnError(allChildEvents.slice(turnObserveFrom))
    if (firstTurnError !== undefined && output.length === 0) {
      console.log(`[dsh-femo][native] 子代理回合以 error 收场（node=${nodeName}）：${firstTurnError.detail}`)
      await sendActorFailure(bridge, jobId, waitKey, firstTurnError.kind, firstTurnError.detail)
      return
    }
    // 首轮交卷（与旧路径同款 body；空产出也交，优劣由引擎校验裁决）。
    await bridge.send('human_input', {
      job_id: jobId,
      wait_key: waitKey,
      body: { output, steps, model_id: modelIdNow() },
    })

    // 停靠（与旧路径同语义：首次交卷≠审结，node_retry 经租约 steer 续跑）。
    if (!runControlAborted.has(controller)) {
      if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined }
      let verdict = await broker.park(waitKey)
      while (verdict.kind === 'retry') {
        armIdle()
        // 重试取答前必须重定基线：baselineCount 停在首投递前，旧基线下
        // waitTurnAfterBaseline 会瞬间返回旧回合，误判重试回合零产出。
        baselineCount = settledTurns.length
        const snapshotLen = allChildEvents.length
        // 轮内 steer 重试：先清上一尝试的直播残留（(index,step) 同键，不清
        // 会把两次尝试的文字拼进同一块），「Deep diving」状态行保持常亮
        // （整轮未结，熄灭权威在节点审结处）。
        broadcastSse('femo_stream', { kind: 'end', sid, node_name: nodeName, actor, turn: baseTurn })
        projTrace('node', `轮内重试清桶 actor=${actor} turn=${t4(baseTurn)} attempt=${verdict.attempt}`)
        steerChild(RETRY_STEER_TEXT(verdict.attempt, verdict.feedback))
        const retryTurn = await waitTurnAfterBaseline()
        const retryEvents = allChildEvents.slice(snapshotLen)
        const builtRetry = buildTranscript(retryEvents.some(e => e.type === 'turn/end')
          ? childTurnEvents.get(retryTurn) ?? retryEvents
          : retryEvents)
        // 重试回合也以 error 收场 → 同样上报执行失败（与首轮同款，2026-09-10）。
        const retryError = childTurnError(retryEvents)
        if (retryError !== undefined && builtRetry.output.length === 0) {
          console.log(`[dsh-femo][native] 重试回合以 error 收场（node=${nodeName}）：${retryError.detail}`)
          await sendActorFailure(bridge, jobId, waitKey, retryError.kind, retryError.detail).catch(() => undefined)
          break
        }
        if (!retryEvents.some(e => e.type === 'turn/end') && builtRetry.steps.length === 0 && builtRetry.output.length === 0) {
          console.log(`[dsh-femo][native] 节点重试回合未观测到 turn/end 且零产出（node=${nodeName}），上报执行体失败`)
          await sendActorFailure(bridge, jobId, waitKey, 'turn_timeout', '重试回合超时且零产出').catch(() => undefined)
          break
        }
        output = builtRetry.output
        steps = builtRetry.steps.length > 0 ? builtRetry.steps
          : output.length > 0 ? [{ step: 0, cot: '', reply: output, tool_calls: [], tool_results: [] }] : []
        await bridge.send('human_input', { job_id: jobId, wait_key: waitKey, body: { output, steps, model_id: modelIdNow() } })
        if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined }
        verdict = await broker.park(waitKey)
      }
      if (verdict.kind === 'aborted' && !runControlAborted.has(controller)) {
        await sendActorFailure(bridge, jobId, waitKey, 'park_timeout',
          '停靠等待超时（15min），执行体未在时限内交出重试回合').catch(() => undefined)
      }
    }
    console.log(`[dsh-femo][native] subagent node done: ${nodeName} child=${childId} output=${output.length}ch steps=${steps.length}`)
    if (output.length > 0) {
      console.log(`[dsh-femo][native] subagent output head: ${output.slice(0, 300).replace(/\n/g, '\\n')}`)
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    if (runControlAborted.has(controller)) {
      console.log(`[dsh-femo][native] subagent stopped by run-control: ${nodeName} ${message}`)
    } else {
      recordError(session.id, `子 agent 中断：${message}`)
      console.log(`[dsh-femo][native] subagent interrupted: ${nodeName} ${message}`)
      await sendActorFailure(bridge, jobId, waitKey, 'executor_error', message).catch((sendError: unknown) => {
        console.log(`[dsh-femo][native] 执行失败信号回传失败: ${String(sendError)}`)
      })
    }
  } finally {
    activeSubagents.delete(activeEntry)
    activeChildRuns.delete(childId)
    broker.unregister(waitKey)
    apiRetry.clearChild(childId)
    persistActorUsage()
    appendSpeakerLine()
    appendShowpromptLine()
    // 【2026-09-10 v7】区块释放（幂等；正常路径已在主回合 turn/end 处释放过）：
    // 缓冲全量落盘 + 合成 turn/end 兜底 + 直播 end 帧放行——顺序由段落闸门裁决
    // （更早开跑的区块先落），不再即时写窗。
    releaseSection()
    // 节点收尾兜底熄状态行（幂等；正常路径已在本节点 turn/end 处熄过）。
    liveFrames.endTurn()
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    controller.signal.removeEventListener('abort', onAbortReject)
    disposeListener()
    disposeFrameListener()
    rejectPendingTurn(new Error('node settled'))
    releaseLock()
    // 与旧路径的关键差异：不 dispose（复用前提——子代理继续驻留）、不归档、
    // 不移出会话树。常驻执行体的冷恢复依赖持久化；它不对用户展示（目录里
    // ban），观看面是 femo-proj 角色投影窗。
    console.log(`[dsh-femo][native] subagent node settled (child kept alive): ${nodeName} child=${childId}`)
  }
}

/** 子代理一次性设置：委派权限钉子 + 官方澄清段 + 推理档位钩子。与旧路径
 *  （subagent.ts runAiSubagent 中段）语义逐条对齐；钩子闭包经 holder 读
 *  「最近一次节点调用」的 actor thinking（跨节点更新由注册表条目承担）。
 *  @param policyAppends - true=首建（append 沙箱/审批钉子）；false=冷恢复
 *  重装（钉子已随日志 fold 恢复，只补 agent-scoped 的钩子与澄清段）。 */
function setupChildAgent(
  ctx: Context,
  childId: string,
  reasoningHolder: { actorThinking?: string },
  resolved: ResolvedConfig,
  defaultModel?: { currentSelection(): unknown },
  policyAppends: boolean = true,
): void {
  const agent = ctx.agents.get(SessionId(childId)) as
    | { session?: { append(type: string, data: unknown, surface?: unknown): void }; ctx?: Context }
    | undefined
  if (agent === undefined) {
    console.log(`[dsh-femo][native] child agent ${childId} not live after creation — delegation/reasoning setup skipped`)
    return
  }
  if (policyAppends && agent.session !== undefined) {
    // 委派权限（与旧路径同款：标准模式 workspace-write + ask；fold 最后写胜出）。
    appendActorPolicyPins(agent.session)
  }
  const childSystemPrompt = (agent.ctx as unknown as {
    systemPrompt?: { context(c: { name: string; order: number; text: string }): () => void }
  } | undefined)?.systemPrompt
  childSystemPrompt?.context({
    name: 'femo:child-scope',
    order: 121,
    text: FEMO_CHILD_SCOPE_TEXT,
  })
  // 推理档位钩子（2026-09-10 与剧本解析对齐）：
  //   - 演员声明了 thinking（femo 已把显式 default 归一化为"未声明"）→ 钉该档位；
  //   - 没声明 → **不下发 reasoningEffort 字段**（= 宿主/部署自决，语义同模型
  //     选择器的 Default 项）。旧代码在这里回落到插件 subagentReasoning 或全局
  //     默认模型档位，会把主会话的 high 硬塞给"没声明档位"的演员——非推理模型
  //     （local/gemma-3-4b-it）直接 400。档位一律由演员声明决定，不猜。
  // 剥离继承 effort 仍是必须的：dsh 会把父会话最近一次请求的 effort 复制给子
  // 代理，不清就会漏给下游模型。
  agent.ctx?.on('agent/request', async (_payload: unknown, next: (p: unknown) => Promise<Record<string, unknown>>) => {
    const resolvedCall = await next(_payload)
    const effort = reasoningHolder.actorThinking
    const { reasoningEffort: _inherited, ...withoutInherited } = resolvedCall
    return {
      ...withoutInherited,
      ...effort !== undefined && effort.length > 0 ? { reasoningEffort: effort } : {},
    } as Record<string, unknown>
  })
}

/**
 * 本回合是否以「执行体错误」收场（而非正常答完）。
 *
 * 背景（2026-09-10 gemma 空台词事故）：子代理回合可以以
 * `turn/end{reason:{kind:'error'}}` 结束（如 provider 400
 * UNSUPPORTED_REASONING_EFFORT）。旧代码对这种回合照样回一个
 * `human_input{output:''}`，引擎只看到"空台词、无赋值错误"，于是静默跳过
 * 节点——宿主明明知道执行体失败了，作者（用户/主模型）却什么也收不到，
 * 违反"不许静默吞错"红线。
 *
 * 返回错误描摹；非错误回合返回 undefined。
 */
function childTurnError(events: readonly SessionEvent[]): { kind: string; detail: string } | undefined {
  for (const event of events) {
    if (event.type !== 'turn/end') continue
    const reason = (event.data as { reason?: { kind?: unknown; error?: { message?: unknown; code?: unknown } } }).reason
    if (reason === undefined || reason.kind !== 'error') continue
    const message = typeof reason.error?.message === 'string' ? reason.error.message : ''
    const code = typeof reason.error?.code === 'string' ? reason.error.code : ''
    const detail = [message, code.length > 0 ? `(${code})` : ''].filter(Boolean).join(' ')
    return { kind: 'executor_error', detail: detail.length > 0 ? detail : '子代理回合以 error 收场（无错误详情）' }
  }
  return undefined
}
