/**
 * projection-input.ts — 投影窗输入路由（2026-08-26 自 routes.ts 迁出）。
 *
 * 全插件最复杂的业务路由：投影窗 composer 发言按窗型×运行状态分发（2026-09-05
 * 语义拍板：直达主模型仅限上帝窗；角色/stage 窗任何时候都不发给主模型）——
 * ①上帝窗且剧本未跑/已暂停 → agent.followup 以真实用户消息（source kind
 *   'user'，与主窗口正门同款）进主会话对话流，上帝窗镜像自然映射；
 * ②跑本中且人类节点等待 → 喂引擎 human_input 并广播 role 行；
 * ③其他（含角色/stage 窗的任何时刻、上帝窗跑本中）→ 仅本窗留痕。
 * 附诊断文件日志（host stdout 不可见时的排障回路）。
 * （routes.ts 只留注册分发；本文件行为与迁出前逐字一致。）
 */

import { randomUUID } from 'node:crypto'
import { appendDebugLog } from './debug-log'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { FemoBridge } from './bridge'
import type { ResolvedConfig } from './config'
import { readBody, writeJson } from './http'
import type { RunState } from './engine-events'
import { activeJobOfSession } from './engine-events'
import type { JobMirror } from './engine-events'
import { appendEvent, appendChatProjected, GOD_ACTOR, type ProjectionRegistry } from './projection'
import { readTurnScopeFile } from './state-files'
import { pushDiag } from './diag-feed'

export interface ProjectionInputDeps {
  resolved: ResolvedConfig
  bridge: FemoBridge
  runState: RunState
  projections: ProjectionRegistry
  sessionsStore?: { get(id: SessionId): Session | undefined }
  /** 【2026-09-11】主会话不在 store 时按官方路径拉活（run-control 的
   *  ensureSessionLive：agents.resume + 挂 FEMO_PRESET）。重启后主会话与投影窗
   *  一起缺席，没有它 ensure 兜底只能空转（cwd 拿不到）→ 用户看到
   *  「404 窗不在 store」+ composer 报 session not found。 */
  ensureMainLive?: (mainSid: string) => Promise<Session | undefined>
}

/** POST /dsh-femo/projection-input — route one projection-window message. */
export async function handleProjectionInput(
  ctx: Context,
  deps: ProjectionInputDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { resolved, runState } = deps
  // 诊断轨迹（2026-08-25）：host stdout 不可见，路由全程写文件日志——
  // 每次调用的入参/分支/自调用结果全部落 cache/logs/debug-projection-input.log，
  // 排查「投影窗发言无反应」时直接读该文件即可分辨端内/端外问题。
  const debugLog = (line: string): void => {
    appendDebugLog(resolved.femoRoot, 'debug-projection-input.log',
      '[' + new Date().toISOString() + '] ' + line)
  }
  debugLog(`=== invoke ===`)
  // 投影窗输入路由（2026-09-05 语义拍板，替代 2026-08-24 三路口径）：
  // ①上帝窗且剧本未跑/暂停/已停止 → agent.followup 以真实用户消息
  //   （source kind 'user'）进入主会话对话流（与主窗口输入框默认 queue 同款）；
  //   上帝窗镜像自然映射，本窗不留痕；
  // ②跑本中且人类节点等待 → bridge human_input 喂引擎（wait_key），并广播 role 行进各投影窗；
  // ③其他 → 仅本窗留痕：角色/stage 窗任何时候都不发主模型（含 idle）；
  //   上帝窗跑本中也不发主模型。
  const raw = await readBody(req) as Record<string, unknown>
  const sessionId = typeof raw.sessionId === 'string' && raw.sessionId.trim().length > 0 ? raw.sessionId : ''
  const text = typeof raw.text === 'string' && raw.text.trim().length > 0 ? raw.text.trim() : ''
  debugLog(`payload: sessionId=${sessionId} textLen=${text.length}`)
  if (sessionId.length === 0 || text.length === 0) {
    writeJson(res, 400, { ok: false, error: 'sessionId and text are required' })
    return
  }
  const sessions = ctx.get('sessions') as { get(id: SessionId): Session | undefined } | undefined
  let win = sessions?.get(SessionId(sessionId))
  // 【2026-09-11 兜底·用户实测症状"刚打开/切窗口就奇奇怪怪"】宿主重启后投影窗
  // 不会自动回到 sessions store（只存在于持久化里）。此时窗口前端照样能显示历史
  // （从持久化读），但窗对象是"半死的"：`sessions.get` 返回 undefined ⇒ 在上帝窗
  // 发言直接 404 静默丢掉（实测 15:10:12 textLen=9 → 404 window not found）。
  // 这里在 404 之前按窗 id 反推主会话、借 ensure 冷装载一次（幂等），装好再路由。
  // 【2026-09-11 二修】主会话自己也可能不在 store（重启后同款缺席）——旧实现
  // 此时 ensure 兜底直接跳过（cwd 拿不到），404 照旧。现在先按官方路径把主会话
  // 拉活（deps.ensureMainLive），拿到 cwd 再 ensure；角色表从 turn_scopes 文件
  // 补齐（与 projection-windows 路由同源），保证被路由的那个角色窗也被建出来。
  if (win === undefined && sessionId.startsWith('femo-proj-')) {
    const mainSid0 = sessionId.slice('femo-proj-'.length).replace(/-[^-]*$/, '')
    let mainSession = mainSid0.length > 0 ? sessions?.get(SessionId(mainSid0)) : undefined
    if (mainSession === undefined && mainSid0.length > 0 && deps.ensureMainLive !== undefined) {
      debugLog(`ensure 兜底：主会话不在 store，先拉活 sid=${mainSid0}`)
      try {
        mainSession = await deps.ensureMainLive(mainSid0)
        debugLog(`ensure 兜底：主会话拉活结果=${mainSession === undefined ? '失败' : '成功'}`)
      } catch (error: unknown) {
        debugLog(`ensure 兜底：主会话拉活异常 ${String(error instanceof Error ? error.message : error)}`)
      }
    }
    const cwd = (mainSession?.header as { cwd?: string } | undefined)?.cwd
    if (mainSid0.length > 0 && typeof cwd === 'string' && cwd.length > 0) {
      debugLog(`ensure 兜底：窗不在 store，冷装载主会话的投影窗 sid=${mainSid0}`)
      try {
        const scopeMap = await readTurnScopeFile(resolved.femoRoot, mainSid0)
        const scopeActors = [...new Set(Object.values(scopeMap).flat())]
        await deps.projections.ensure(mainSid0, scopeActors, cwd)
        win = sessions?.get(SessionId(sessionId))
        debugLog(`ensure 兜底结果：${win === undefined ? '仍未装载（窗可能不存在）' : '已装载'}`)
      } catch (error: unknown) {
        debugLog(`ensure 兜底失败: ${String(error instanceof Error ? error.message : error)}`)
      }
    } else {
      debugLog(`ensure 兜底跳过：主会话不在 store 或缺 cwd（mainSid=${mainSid0 || '-'}）`)
    }
  }
  if (win === undefined) {
    debugLog(`result: 404 window not found in store（ensure 兜底后仍未装载）`)
    pushDiag('proj-input', `404 窗不在 store：sid=${sessionId.slice(-16)}（宿主重启后投影窗未装载；已尝试冷装载）`)
    writeJson(res, 404, { ok: false, error: `session ${sessionId} not found` })
    return
  }
  // 主会话 id：优先 parentSession 头；兜底从 femo-proj-<sid>-<actorKey> 尾段剥离
  //（actorKey 只含 [A-Za-z0-9_]，不含 '-'，故最后一个 '-' 右侧必是 actorKey）。
  const parentHeader = (win.header as { parentSession?: string } | undefined)?.parentSession
  const mainSid = typeof parentHeader === 'string' && parentHeader.length > 0
    ? parentHeader
    : (sessionId.startsWith('femo-proj-')
      ? sessionId.slice('femo-proj-'.length).replace(/-[^-]*$/, '')
      : '')
  // Job 化判定（§9.4）：owner 会话的 Job 镜像驱动 waiting/idle——
  // waiting=本会话 Job 是引擎活跃 Job 且 human 节点等输入；
  // idle=本会话 Job 非 running（挂起/完成/失败/不存在）。
  const job = activeJobOfSession(runState, mainSid)
  const waiting = job !== undefined && job.state === 'running'
    && runState.activeJobId === job.jobId && job.waitingHuman !== undefined
  const idle = job === undefined || job.state !== 'running'
    || runState.activeJobId !== job.jobId
  // 窗型判定（id 规则化 femo-proj-<主sid>-<actorKey>，尾段=actorKey）：①直达
  // 主模型仅限上帝窗（GOD_ACTOR）；角色/stage 窗落空到 ③ 本地留痕。
  const isGodWindow = sessionId.startsWith('femo-proj-')
    && sessionId.slice(sessionId.lastIndexOf('-') + 1) === GOD_ACTOR
  // 【诊断 2026-09-06】②③路径此前零文件日志（排查盲区）：判定要素逐项落盘。
  // 上帝窗人类发言 kept local 事故（waiting=false 但引擎在等）的直接证据源。
  debugLog(`judge: isGod=${isGodWindow} job=${job === undefined ? '-' : String(job.jobId)} state=${job?.state ?? '-'} active=${String(runState.activeJobId ?? '-')} waitHuman=${job?.waitingHuman === undefined ? '-' : JSON.stringify(job.waitingHuman)} => idle=${idle} waiting=${waiting}`)
  // 【诊断 2026-09-06】同款判定要素推前端诊断流——"发言为何没到人类节点"
  // 在右上角诊断窗直接可读（四条件逐项：job 存在/state=running/active 匹配/
  // waitingHuman 已登记）。
  pushDiag('proj-input', `judge isGod=${isGodWindow} job=${job === undefined ? '-' : String(job.jobId)} state=${job?.state ?? '-'} active=${String(runState.activeJobId ?? '-')} waitHuman=${job?.waitingHuman === undefined ? 'NONE' : JSON.stringify(job.waitingHuman)} => waiting=${waiting}`)
  if (idle && isGodWindow) {
    // ①直达主模型（2026-08-24 用户定稿反转 steer 注入方案；2026-09-05 起仅
    // 上帝窗进入本分支）：进程内直调 agents 服务把消息送进主会话。
    // 不做 HTTP 自调用：两次实败已证明不可靠——host 内 DSH_WEB_URL 可能指向
    // 另一实例（实测 :3080 session-not-found）；浏览器 Host 头可能是 Tailscale
    // https 隧道域（实测 :8443 http 自调 400）。
    // 2026-09-06 语义修正（猫猫拍板：无剧本时上帝窗发言=真实 user 消息）：
    // 原 agent.steer 带 plugin 来源——dsh 客端按 source.kind 分类，非 'user'
    // 一律渲染成"注入上下文"context 节点（ui-conversation message.ts），即
    // "工具注入"观感的根因；且 next-step 认领史会被标记成"插话（steering）"。
    // 改 source:{kind:'user'} + agent.followup（=主窗口默认 queue 正门语义）：
    // 空闲=立即开新回合，next-turn 在 turn 首步被 inbox.claim 消费（rc.2 与
    // 0.1.2 的 inbox.claim 源码实证，"queue 空闲永不消费"旧结论已过时）；
    // 主模型恰好忙碌时排队至当前回合结束，与主窗口默认行为一致。followup
    // 两版均返回 void，无 steer 的 outcome 甄别。pre-step 门卫本就放行
    // source.kind==='user' 批次（engine-events 真实用户输入条款），零交互。
    const bag = ctx as unknown as {
      agents?: { get(id: string): { followup?: unknown } | undefined }
      get?(name: string): { get(id: string): { followup?: unknown } | undefined } | undefined
    }
    const viaProp = bag.agents?.get(mainSid)
    const viaSvc = typeof bag.get === 'function' ? bag.get('agents')?.get(mainSid) : undefined
    const agent = (viaProp ?? viaSvc) as { followup?(message: unknown): unknown } | undefined
    debugLog(`branch① idle -> agent.followup mainSid=${mainSid}`)
    if (agent === undefined || typeof agent.followup !== 'function') {
      debugLog('branch① FAILED: main agent unavailable (agents service)')
      writeJson(res, 200, { ok: false, routed: 'main', error: 'main agent unavailable' })
      return
    }
    agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    debugLog(`branch① followup queued len=${text.length}`)
    console.log(`[dsh-femo] projection input -> main followup: sid=${mainSid} len=${text.length}`)
    writeJson(res, 200, { ok: true, routed: 'main', accepted: true })
    return
  }
  // ②③跑本中（及角色/stage 窗 idle）：投影窗本地留痕（用户自己说的话要看得见；
  // ①不需要——镜像已覆盖）
  if (waiting) {
    // ②人类节点发言：三窗（上帝/角色/戏内）轮到人类节点时行为一致，同源
    // feedHumanNode（2026-09-06 猫猫拍板抽函数——"发给人类节点"的唯一实现）。
    // 【UI 同日拍板】本窗不再写 user/message 留痕——role 行（全窗广播、渲染
    // 为 dsh user 气泡样式）就是人类发言的唯一显示面，避免发言窗同一段话
    // 双份（user/message 气泡 + role 行）。
    await feedHumanNode(ctx, deps, mainSid, job!, text, debugLog)
    writeJson(res, 200, { ok: true, routed: 'human-node' })
    return
  }
  // ③本地留痕（角色/stage 窗任何时刻、上帝窗跑本中非等待）：不路由，
  // 只在本窗留 user/message（没发出去的话用户要看得见；②无此留痕=已由
  // role 行广播显示）。
  appendEvent(win, 'user/message', {
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  pushDiag('proj-input', `branch③ kept-local sid=${sessionId.slice(-12)} waiting=${waiting}（waiting=false 且非 idle=引擎在跑但宿主无人类等待登记；idle=剧本非 running）`)
  console.log(`[dsh-femo] projection input kept local: len=${text.length}`)
  writeJson(res, 200, { ok: true, routed: 'interjection-todo' })
}

/** ②"发给人类节点"唯一实现（2026-09-06 自 handleProjectionInput 原样提取，
 * 行为零变化）：把等待中人类节点的发言喂给引擎（带 job_id——旧 waitKey 喂
 * 黑洞路径封死，B6 死于结构）+ 广播 role 行（全窗可见）。上帝/角色/戏内窗
 * 轮到人类节点时都走到这里——入口路由只负责判定 waiting，喂入动作三窗同源。
 * 返回引擎回执的 delivered（供调用方日志/未来 UI 反馈用）。 */
async function feedHumanNode(
  ctx: Context,
  deps: ProjectionInputDeps,
  mainSid: string,
  job: JobMirror,
  text: string,
  debugLog: (line: string) => void,
): Promise<boolean> {
  const { bridge, projections, sessionsStore } = deps
  const waitKeyUsed = String(job.waitingHuman?.waitKey ?? '')
  debugLog(`branch② feeding: job=${String(job.jobId)} wait_key=${waitKeyUsed} len=${text.length}`)
  const feedResult = await bridge.send('human_input', {
    job_id: job.jobId,
    wait_key: waitKeyUsed,
    body: { chat_text: text, variables: {} },
  }) as { delivered?: boolean } | undefined
  debugLog(`branch② feed result: ${JSON.stringify(feedResult)}`)
  pushDiag('proj-input', `branch② human_input delivered job=${String(job.jobId)} wait_key=${waitKeyUsed} → ${JSON.stringify(feedResult)}`)
  const main = sessionsStore?.get(SessionId(mainSid))
  if (main !== undefined) {
    appendChatProjected(ctx, main, projections, text, 'role', '人类')
  }
  return feedResult?.delivered ?? false
}
