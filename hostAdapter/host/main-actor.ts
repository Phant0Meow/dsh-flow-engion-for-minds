/**
 * main-actor.ts — 主模型下场（source:main）· 主窗口回答制。
 *
 * 最终方案（2026-08-31 定稿；旧"分身直调"方案已废弃回滚，备份见
 * MEOW_backups/main-actor.ts.bak-20260831-rollback）：
 *  - main 节点不拉子代理、不直调 LLM。宿主把「增量 main 可见剧内发言 + 节点
 *    提醒」以 steer 注入发进主窗口；主模型在主窗口正常回答（流式主屏，
 *    thinking/tools 全保留——天使降临人间还是有魔法的）；宿主捕获被注入唤起
 *    的这一整轮（多步 react），经 human_input 协议交卷——引擎按 AI 节点规则
 *    落库（prompt/showprompt→dialog、回答→react_steps，soul_id=main、
 *    model_id=main）并继续流程。台词来源变了，落库路径零特例。
 *  - 主窗口=主模型视角窗：全剧只有一个上下文，剧内事件以消息流进主窗口——
 *    KV 缓存（消息追加=前缀追加）、记忆带出（台词天然在主窗口历史里）、
 *    user 开黑插话（穿插）全部自然成立。
 *  - 上帝窗：god-mirror 现成镜像主会话，零改动（主模型发言天然流失到上帝窗）。
 *    角色窗/戏内窗：v1 role 行灰框投影已于 2026-09-01 按猫猫拍板整体移除
 *    （god 窗重复塞入=画蛇添足；stage/角色窗的 main 发言之后复用投影窗自己的
 *    镜像/流式逻辑另做，不在此处塞 UI 行）。
 *  - 【V6.3 2026-09-01】stage/角色窗 main 轮戏内投影（猫猫拍板"复用之前成功
 *    的投影方法"）：mainSessionEventHook 轮次捕获点上同步挂 V6 同款投影——
 *    原生骨架（turn/start、step/start，主会话轮自带真实结构）即时落盘 →
 *    speaker/📢 showprompt 行（带 turn 归属，V6.2 同款，渲染位由 femo-turn-head
 *    决定）→ 内容（chunk 块边界/message/tool/call/tool/result/step/end）进
 *    投影缓冲，turn/end 原子落地成连续区块（「日志顺序即容器」，与其他节点
 *    零交错）；chunk 全量旁路广播 femo_stream（actor=main 演员名，block_end 带
 *    retain——V6 演员直播语义，前端直播桶 turn 关闭即隐藏）。分发=stage 全量
 *    + 节点 scope 命中的角色窗，**god 窗 skipGod 零写入**（god-mirror 已覆盖，
 *    2026-08-31 回滚教训：重复骨架=孤儿事件、裸 _srcSeq 撞 god 去重——本次
 *    物理隔离+_srcSeq 独立命名空间 `main#<seq>` 双保险）。前端零改动：head/
 *    stream 节点与 useFemoStream 均按 turn/actor 通用机制工作。
 *
 * 状态全部内存态（按主会话 sid 键控）：剧本运行是进程内活动，重启即重跑
 * （fresh_start），水位/流水无需持久化。
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { FemoBridge } from './bridge'
import type { ResolvedConfig } from './config'
import { broadcastSse } from './http'
import { broadcastStreamChunk, LiveStreamFrames, onAssistantStreamFrames, type FemoStreamChunk } from './stream-frames'
import { steerMainAgent } from './engine-events'
import { projectionAppend, projectionActorKey, type ProjectionRegistry, type ProjectionWindows } from './projection'
import { sectionGate } from './section-gate' // 【步3】main 轮并入统一段落闸门（按开跑顺序整段落盘）
import { sendActorFailure } from './bridge'
import { buildTranscript } from './engine-transcript'
import { broker, SET_VARIABLE_TEACHING } from './node-retry'
import { apiRetry } from './api-retry'
import { projTrace, t4 } from './proj-trace' // 【诊断 2026-09-11 临时】main 轮埋点
import { appendDebugLog } from './debug-log'
import { MainDeliveryQueue } from './main-delivery-queue'
import { pushDiag } from './diag-feed'

/** 分身调试日志（排错观测点，host console 不可见故落文件）。 */
export function debugLogMainActor(resolved: ResolvedConfig, line: string): void {
  appendDebugLog(resolved.femoRoot, 'debug-main-actor.log',
    '[' + new Date().toISOString() + '] ' + line)
}

// ── 运行态（按主会话 sid 键控，内存态）──────────────────────────────────────

/** 在飞注入：已 steer 进主窗口、等待主模型回合回答的 main 节点。 */
interface PendingAnswer {
  waitKey: string
  nodeName: string
  /** 所属 Job（human_input 交卷带 job_id——协议要求，§9.2）。 */
  jobId: number
  /** 演员名（ai_name，如 @天使）。 */
  actor: string
  /** 本节点 scope（可见角色 actor 名；空=未限定全可见）。 */
  scopes: string[]
  /** 回合事件缓冲（assistant/message、tool/call、tool/result）。 */
  buffer: SessionEvent[]
  /** 已见到本回合 turn/start（防止误捕上一回合尾部事件）。 */
  sawTurnStart: boolean
  settled: boolean
  resolve: () => void
  /** 【V6.3】节点 showprompt（context_ready 暂存；引擎对所有 AI 节点统一发，
   *  main 节点同样有值；缺失=不落 📢 行）。 */
  showprompt?: string
  /** 【V6.3】本回合主会话原生 turn 号（turn/start 时记录；speaker/📢 行
   *  带此 turn 归属，合成 turn/end 兜底也用它）。 */
  turn?: number
  /** 【V6.3】戏内投影缓冲（与 subagent mirrorBuffer 同构）：内容镜像事件
   *  排队，turn/end 原子落地成连续区块。 */
  projBuffer: Array<{ type: string; data: Record<string, unknown>; surface: Record<string, unknown> | undefined }>
  /** 【V6.3】tool/call 的 callId→name 登记（tool_result 直播帧取名）。 */
  toolNames: Map<string, string>
}

/** surface-eligible 事件（assistant/message、tool/result）要求 surfaceOp——
 *  与 subagent SURFACE_OP_EVENTS 同款语义（本地副本，避免跨模块导出私有常量）。 */
const MAIN_SURFACE_OP_EVENTS = new Set(['assistant/message', 'tool/result'])

/** 一次待交付的 main 节点注入（首轮上场通知 / 重试反馈信同构）。 */
interface MainDelivery {
  waitKey: string
  nodeName: string
  actor: string
  scopes: string[]
  jobId: number
  showprompt?: string
  /** 交付文案：首轮 = stageNotice，重试轮 = mainRetrySteerText。 */
  text: string
  /** 交付来源（日志/诊断：'首轮' | '重试'）。 */
  via: string
  /** 首轮交卷槽（重试轮无——其交卷由停靠循环重新 park 承担）。 */
  resolve?: () => void
}

const pending = new Map<string, PendingAnswer>()
/** 【2026-09-11】主会话轮开闭 + 戏内注入排队（戏内戏外不掺一轮；状态机走
 *  main-delivery-queue.ts，纯函数可测）。 */
const deliveries = new MainDeliveryQueue<MainDelivery>()
/** main 演员名集（ai_request source=main 的 ai_name）。 */
const mainActorNames = new Map<string, Set<string>>()
/** main 可见剧内发言流水（非 main 演员的、节点 scope 含 main 演员的发言）。 */
interface FlowLine { actor: string; text: string }
const flows = new Map<string, FlowLine[]>()
/** 已注入水位（flows 的已消费条数）。 */
const waterMarks = new Map<string, number>()
const playNames = new Map<string, string>()
/** 注入串行队列（par 多 main 节点排队，一次只让主模型答一个节点）。 */
const queues = new Map<string, Promise<void>>()

/** 【步3.5 2026-09-11】god-mirror 写主会话开轮锚点时反查：这个 turn 是不是
 *  戏内下场轮？是 → 返回戏内演员名（god 窗名字行用戏内名字，用户拍板：
 *  "戏内节点的话应该用戏内的名字，戏外主模型发言才是导演"）。
 *  时序说明：本函数在 turn/start 镜像时被调，此时 p.turn 可能尚未被本模块的
 *  事件钩子写上（ctx.on 执行顺序无保证，Job 796 教训）——注入发出后 p 就在，
 *  第一个开的主会话轮必是下场轮，故 p.turn 未定时也认。空轮误标无害：前端
 *  对"无内容的主会话轮"不画名字行（v9.4）。 */
export function mainActorSceneActor(sid: string, turn: number): string | undefined {
  const p = pending.get(sid)
  // settled=已交卷（后续主会话轮归导演）；未在飞=不存在下场轮。
  if (p === undefined || p.settled) return undefined
  // p.turn 已定时必须对上号；未定时（钩子还没跑到，ctx.on 顺序无保证）——
  // 注入发出后第一个开的主会话轮必是下场轮，认。
  if (p.turn !== undefined && p.turn !== turn) return undefined
  return p.actor
}

/** flow_start 清场：上一场的流水/水位/在飞全部作废；记剧本名 + 登记 main
 * 演员静态名单（编译期声明，开跑即知——运行时登记会漏首个 main 节点之前
 * 的发言，1005 场实测教训）。 */
export function clearMainPlayState(sid: string, name: string, mainActors?: string[]): void {
  pending.delete(sid)
  mainActorNames.delete(sid)
  flows.delete(sid)
  waterMarks.delete(sid)
  queues.delete(sid)
  // 【2026-09-11】换场：排队中的下场注入（上一场的）与轮开闭记录一并作废。
  dropMainDeliveries(sid, '换场清场', undefined, true)
  if (name.trim().length > 0) playNames.set(sid, name.trim())
  else playNames.delete(sid)
  if (mainActors !== undefined && mainActors.length > 0) {
    const set = new Set<string>()
    for (const n of mainActors) if (n.length > 0) set.add(n)
    if (set.size > 0) mainActorNames.set(sid, set)
  }
}

/** ai_request(source=main) 登记演员名（后续 scope 判定用）。 */
export function noteMainActor(sid: string, aiName: string): void {
  if (aiName.length === 0) return
  let set = mainActorNames.get(sid)
  if (set === undefined) { set = new Set(); mainActorNames.set(sid, set) }
  set.add(aiName)
}

/** 某节点的发言是否 main 可见：scope 未限定=全可见；否则 scope 含任一 main 演员。 */
function isMainVisible(sid: string, scopes: string[] | undefined): boolean {
  if (scopes === undefined || scopes.length === 0) return true
  const mains = mainActorNames.get(sid)
  if (mains === undefined) return false
  return scopes.some(name => mains.has(name))
}

/** 剧内发言入流水（ai_done / human 输入时调用；main 演员本人发言不入——
 * 台词天然在主窗口历史里，注入回自己没有意义）。返回入账后流水总条数
 * （-1=未入账，观测判定用）。 */
export function noteFlowLine(
  sid: string,
  actor: string,
  text: string,
  scopes: string[] | undefined,
): number {
  if (text.length === 0) return -1
  if (mainActorNames.get(sid)?.has(actor)) return -1
  if (!isMainVisible(sid, scopes)) return -1
  let list = flows.get(sid)
  if (list === undefined) { list = []; flows.set(sid, list) }
  list.push({ actor, text })
  return list.length
}

/** 主模型是否正在回答 main 注入（pre-step 放行 + 输入桥豁免的判定源）。 */
export function isMainAnswerPending(sid: string): boolean {
  return pending.has(sid)
}

/** main 在飞注入的节点名（api-retry 通知/错误表定位用；不在飞返回 ''）。 */
export function pendingNodeName(sid: string): string {
  return pending.get(sid)?.nodeName ?? ''
}

/** 重臂在飞注入（2026-09-05 Step D，施工清单 v4 §7.1）：main 节点停靠重试轮的
 *  租约前半段——重置回合捕获状态（buffer/projBuffer/toolNames 清空、
 *  sawTurnStart=false、settled=false、showprompt 沿用），让 mainSessionEventHook
 *  的既有捕获对新回合自然生效。resolve 槽为 no-op：停靠循环的唯一同步锚是
 *  broker.park（引擎 node_retry/node_settled 都在收到交卷后才发，时序天然
 *  闭合），新回合的交卷由 hook 的 turn/end 分支（settleMainAnswer）承担，
 *  无人 await 新 promise。
 *  ⚠️ 时序关键：必须先于 steerMainAgent 调用——pre-step 门卫对运行中 femo
 *  agent 的放行豁免判定源是 isMainAnswerPending（engine-events），steer 唤起
 *  的新回合若在 pending 缺席时进 pre-step 会被 reject 吞掉（反馈丢失）。 */
function rearmPending(
  sid: string,
  fields: { waitKey: string; nodeName: string; actor: string; scopes: string[]; jobId: number; showprompt?: string },
  /** 交卷槽（2026-09-11）：缺省 no-op（重试轮调用面）；首轮交付传自己的
   *  `answer` resolve，交卷时唤醒它。 */
  resolve?: () => void,
): void {
  pending.set(sid, {
    waitKey: fields.waitKey,
    nodeName: fields.nodeName,
    actor: fields.actor,
    jobId: fields.jobId,
    scopes: fields.scopes,
    buffer: [],
    sawTurnStart: false,
    settled: false,
    resolve: resolve ?? (() => { /* no-op：见 docstring，停靠循环以 broker.park 为同步锚 */ }),
    ...(fields.showprompt !== undefined ? { showprompt: fields.showprompt } : {}),
    projBuffer: [],
    toolNames: new Map<string, string>(),
  })
}

// ── 交付面（排队 / 交付 / 轮收口放行 / 作废）───────────────────────────────

/** 交付一条 main 节点注入：pending 登记（=rearm 语义：重置回合捕获，先于
 *  steer——pre-step 门卫放行豁免的时序要求）+ steer 主模型。 */
function deliverMain(ctx: Context, sid: string, d: MainDelivery): void {
  rearmPending(sid, {
    waitKey: d.waitKey,
    nodeName: d.nodeName,
    actor: d.actor,
    scopes: d.scopes,
    jobId: d.jobId,
    ...(d.showprompt !== undefined ? { showprompt: d.showprompt } : {}),
  }, d.resolve)
  steerMainAgent(ctx, sid, d.text)
}

/** 排队或立即交付（2026-09-11 用户拍板：**戏内戏外不掺一轮**）：主会话有轮在飞
 *  （用户正在跟主模型说话、可能多步调工具）时不插进去——dsh 的 steer 会在下
 *  一个 step 边界被那一轮消费，用户回合里就混进戏内通知、回答还会被捕获成交卷。
 *  排到该轮 turn/end 之后，作为新一轮的开头交付（见 main-delivery-queue.ts）。 */
function queueOrDeliverMain(ctx: Context, resolved: ResolvedConfig, sid: string, d: MainDelivery): void {
  if (deliveries.offer(sid, d)) {
    debugLogMainActor(resolved, `交付注入(via=${d.via}): node=${d.nodeName}（无在飞轮 → 立即 steer）`)
    deliverMain(ctx, sid, d)
    return
  }
  const open = deliveries.openTurn(sid)
  const line = `注入排队(via=${d.via}): node=${d.nodeName} 等主会话第 ${open ?? '?'} 轮收口（队列 ${deliveries.queuedCount(sid)} 条）`
  console.log(`[dsh-femo] ${line}`)
  debugLogMainActor(resolved, line)
  pushDiag('main-actor', `剧本节点「${d.nodeName}」等主模型把当前这轮说完（第 ${open ?? '?'} 轮收口后登场，via=${d.via}）`)
}

/** 主模型 agent 取用（状态判定用；与 steerMainAgent 同款查找面）。 */
function mainAgentOf(ctx: Context, sid: string): { status?: unknown } | undefined {
  const bag = ctx as unknown as {
    agents?: { get(id: string): { status?: unknown } | undefined }
    get?(name: string): { get(id: string): { status?: unknown } | undefined } | undefined
  }
  return bag.agents?.get(sid) ?? (typeof bag.get === 'function' ? bag.get('agents')?.get(sid) : undefined)
}

/** 主会话轮收口（turn/end）后的交付尝试。三道时序门（全部实测得来）：
 *  ① **跳出本轮 append 发布**：dsh 里 steer 会写会话投影（inbox splice →
 *     session append），在 turn/end 的 append 发布中同步再入会抛
 *     `session append cannot reenter while another append is being published`；
 *  ② **等 driver 转 idle**：dsh 的 steer 对非 idle driver 只做 latch
 *     （`wakeDriver`：除 maintenance/wakeAfterAbort 外不记 wakeRequested）——
 *     已过认领点但还没转 idle 的窗口里投递会被**静默停放**（注入进了 inbox，
 *     新回合却起不来）。等 status=idle 再 steer；
 *  ③ **用户又开了一轮就继续等**：等的过程里用户又发了话（openTurn 又有值）
 *     → 不交付，留给那一轮的 turn/end（队首不动，顺序与作废语义都不受影响）。
 *  队列是唯一真源：全程先 peek 后 take——期间 abandonMainAnswer/节点收尾把
 *  它剔掉了就自然不再交付（不会对空气说话）。 */
function flushNextMainDelivery(ctx: Context, resolved: ResolvedConfig, sid: string): void {
  if (deliveries.queuedCount(sid) === 0) return
  tryDeliverNext(ctx, resolved, sid, 0)
}

function tryDeliverNext(ctx: Context, resolved: ResolvedConfig, sid: string, tries: number): void {
  queueMicrotask(() => {
    const next = deliveries.peek(sid)
    if (next === undefined) return
    const agent = mainAgentOf(ctx, sid)
    const status = agent?.status
    if (typeof status === 'string' && status !== 'idle') {
      if (tries < 40) {
        setTimeout(() => tryDeliverNext(ctx, resolved, sid, tries + 1), 50)
      } else {
        // 极端长忙（driver 一直不空闲）：不硬塞（会被静默停放），留给下一次轮收口。
        debugLogMainActor(resolved, `交付等待 driver 空闲超时（${tries}×50ms）: node=${next.nodeName}`)
      }
      return
    }
    if (deliveries.openTurn(sid) !== undefined) return // 用户又开了一轮 → 等它的 turn/end
    // 交付前活性复核（2026-09-11）：runMainModelTurn 是异步起跑的（microtask 才
    // 走到登记/排队），引擎可能在同一 tick 里就 flow_paused/flow_error 了——
    // 那次 abandon 早于本条入队，谁也作废不到它。停靠登记（broker）是节点还在
    // 等答案的唯一权威凭据：登记没了 = 剧本已停/节点已收尾，本条直接作废，
    // 绝不对着已死的引擎交卷（否则会以空 output 落到旧 wait_key 上）。
    if (!broker.has(next.waitKey)) {
      const dropped = deliveries.dropWhere(sid, d => d === next)
      for (const d of dropped) d.resolve?.()
      const line = `排队注入作废（节点已收尾/停演）: node=${next.nodeName} wait_key=${next.waitKey}`
      console.log(`[dsh-femo] ${line}`)
      debugLogMainActor(resolved, line)
      return
    }
    const taken = deliveries.takeNext(sid)
    if (taken === undefined) return
    debugLogMainActor(resolved, `轮收口 → 交付排队注入(via=${taken.via}): node=${taken.nodeName}`)
    pushDiag('main-actor', `轮收口 → 剧本节点「${taken.nodeName}」登场（via=${taken.via}）`)
    deliverMain(ctx, sid, taken)
  })
}

/** 作废本会话排队件（剧本暂停/出错/换场/卸载）：resolve 交卷槽防
 *  runMainModelTurnInner 悬挂在 `await answer`（其后的 broker.park 因 parker
 *  已被 abortJob 清除而立即 aborted 收场，整条收尾链不卡）。
 *  @param forgetTurn - 连轮开闭状态一起清（换场 flow_start / 卸载用；剧本
 *  暂停时用户可能还在说话，不clear，等它自己的 turn/end）。 */
function dropMainDeliveries(sid: string, reason: string, resolved?: ResolvedConfig, forgetTurn = false): number {
  const dropped = forgetTurn ? deliveries.forget(sid) : deliveries.dropAll(sid)
  for (const d of dropped) d.resolve?.()
  if (dropped.length > 0) {
    const line = `排队注入作废(${reason}): ${dropped.length} 条 [${dropped.map(d => d.nodeName).join(', ')}]`
    console.log(`[dsh-femo] ${line}`)
    if (resolved !== undefined) debugLogMainActor(resolved, line)
  }
  return dropped.length
}

/** HMR/插件卸载：清全部排队件与轮开闭状态（幂等）。 */
export function disposeMainDeliveries(): void {
  deliveries.clear()
}

/** flow_paused/flow_error：作废在飞注入（引擎已死，交卷无处可去；主模型
 * 那轮回答就当普通戏外回答留在主窗口）。被作废者不回传引擎、不写错误表。
 * 【V6.3】投影兜底：turn/start 已落（骨架+名字已在 stage/角色窗）而 turn/end
 * 不会再来——flush 半截内容+合成 turn/end 收整成块（与 subagent finally 同款；
 * 结构键幂等，turn/end 不带 _srcSeq）。骨架都没落（主模型尚未开始回答）→
 * 零投影零合成。 */
export function abandonMainAnswer(
  sid: string,
  reason: string,
  projections?: ProjectionRegistry,
): boolean {
  // 【2026-09-11】排队中的下场注入一并作废（可能在飞注入都没有：节点还排在队里）。
  dropMainDeliveries(sid, reason)
  const p = pending.get(sid)
  if (p === undefined) return false
  const proj = projections !== undefined ? projections.get(sid) : undefined
  if (proj !== undefined && p.sawTurnStart && p.turn !== undefined) {
    // 步3：合成 turn/end 同样走闸门（骨架+内容已全部在缓冲里，此处一次性放行）。
    p.projBuffer.push({ type: 'turn/end', data: { turn: p.turn }, surface: undefined })
    const turn = p.turn
    sectionGate.commit(sid, turn, projectionActorKey(p.actor), () => flushProjection(proj, p))
  }
  pending.delete(sid)
  p.settled = true
  p.resolve()
  console.log(`[dsh-femo] main-actor answer abandoned: node=${p.nodeName} (${reason})`)
  return true
}

// ── 注入组装 ────────────────────────────────────────────────────────────────

/** main 专属重试反馈文案（2026-09-05 Step D，施工清单 v4 §7.2）：带戏内身份
 *  （剧名/节点/扮演的演员）——与 subagent 的 RETRY_STEER_TEXT（node-retry.ts，
 *  通用措辞）分立：主模型在主窗口有"演员是谁、在演什么"的上下文值得点名，
 *  两者不共用避免 node-retry 长出 main 依赖。 */
function mainRetrySteerText(
  play: string,
  nodeName: string,
  actor: string,
  attempt: number,
  feedback: string,
): string {
  return `[dsh-femo·节点重试] 剧本《${play}》节点「${nodeName}」（你扮演 ${actor}）的上一轮输出未通过剧本校验（第 ${attempt} 次反馈）：\n${feedback}\n请重新输出该节点的台词（${SET_VARIABLE_TEACHING}）。`
}

function stageNotice(sid: string, nodeName: string, actor: string, prompt: string, delta: FlowLine[], final: boolean, context = ''): string {
  const play = playNames.get(sid)
  const parts = final
    ? [`[dsh-femo·剧终补遗] 剧本《${play ?? '剧本'}》已跑完，以下是最后一截你可见的剧中发言。`]
    : [`[dsh-femo·上场] 剧本《${play ?? '剧本'}》进行到节点「${nodeName}」，轮到 ${actor} 说话。`]
  // 场上信息优先 Block Collector 产物（2026-09-12）：`[名字]：\n内容` 排版、
  // 含人类发言、scope 过滤与其他节点同语义。旧引擎 payload 无 context 或为空
  // 时退回本地流水行（原行为）；剧终补遗无 request 恒走流水行。
  const flowLines = delta.map(l => `${l.actor}：${l.text}`).join('\n')
  const field = context.trim().length > 0 ? context : flowLines
  if (field.length > 0) parts.push(`〖场上信息〗\n${field}`)
  if (!final) parts.push(`〖本节点指令〗\n${prompt}`)
  if (!final) parts.push(`〖要求〗现在轮到你的剧中回合：只输出台词正文。${SET_VARIABLE_TEACHING}。`)
  return parts.join('\n\n')
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

/** 引擎 ai_request(source:main) 的回答入口（串行队列包装）。 */
export function runMainModelTurn(
  ctx: Context,
  resolved: ResolvedConfig,
  bridge: FemoBridge,
  session: Session,
  request: Record<string, unknown>,
  recordError: (sessionId: SessionId, text: string) => void,
  projections?: ProjectionRegistry,
  nodeScopes?: ReadonlyMap<string, string[]>,
  nodeShowprompts?: ReadonlyMap<string, string>,
  jobId: number = -1,
): Promise<void> {
  const sid = String(session.id)
  const prev = queues.get(sid) ?? Promise.resolve()
  const call = prev.catch(() => undefined).then(() =>
    runMainModelTurnInner(ctx, resolved, bridge, session, request, recordError, projections, nodeScopes, nodeShowprompts, jobId),
  )
  queues.set(sid, call.catch(() => undefined))
  return call
}

async function runMainModelTurnInner(
  ctx: Context,
  resolved: ResolvedConfig,
  bridge: FemoBridge,
  session: Session,
  request: Record<string, unknown>,
  recordError: (sessionId: SessionId, text: string) => void,
  projections?: ProjectionRegistry,
  nodeScopes?: ReadonlyMap<string, string[]>,
  nodeShowprompts?: ReadonlyMap<string, string>,
  jobId: number = -1,
): Promise<void> {
  const sid = String(session.id)
  const waitKey = String(request.wait_key ?? '')
  const nodeName = String(request.node_name ?? '')
  const actor = typeof request.ai_name === 'string' && request.ai_name.length > 0 ? request.ai_name : `@${nodeName}`
  const blocks = (request.blocks as Record<string, unknown> | undefined) ?? undefined
  const prompt = typeof blocks?.prompt === 'string' ? String(blocks.prompt) : ''
  // 【2026-09-12】场上信息改走 Block Collector 产物：引擎对 main 节点与其他
  // 节点走同一条 collect_blocks（first_full_then_incremental + actors_def 双名
  // 制），blocks.context 即「[名字]：\n内容」排版的标准上下文——替换原流水行
  // 拼装（半角冒号名行+无标签 markdown 块，用户实测太乱）。缺/空时 stageNotice
  // 内部退回流水行。
  const fieldContext = typeof blocks?.context === 'string' ? String(blocks.context) : ''
  const scopes = nodeScopes?.get(nodeName)
  debugLogMainActor(resolved, `[宿主] main 节点进入: node=${nodeName} actor=${actor} wait_key=${waitKey} 场上信息=BC(${fieldContext.length}ch) 流水=${flows.get(sid)?.length ?? 0}条 水位=${waterMarks.get(sid) ?? 0}`)

  if (waitKey.length === 0) {
    debugLogMainActor(resolved, `!! wait_key 为空，放弃（引擎将等待超时）`)
    return
  }

  // 增量注入：流水按水位取增量，注入后推进水位（场上信息走 BC context 后，
  // 流水水位仍照常推进——剧终补遗的"自上次注入起的尾巴"语义依赖它）。
  const all = flows.get(sid) ?? []
  const mark = waterMarks.get(sid) ?? 0
  const delta = all.slice(mark)
  waterMarks.set(sid, all.length)
  const notice = stageNotice(sid, nodeName, actor, prompt, delta, false, fieldContext)
  debugLogMainActor(resolved, `注入组装完成: 增量=${delta.length}条 BC=${fieldContext.length}ch 通知=${notice.length}ch`)

  // node-retry 持久登记（2026-09-05 Step D，施工清单 v4 §7.1）：在登记 pending
  // 之前——早于任何交卷，与门卫豁免时序对齐（登记永远早于引擎可能发出的
  // 第一个 node_retry，不存在"信号到了没人接"的窗口）。租约=重试轮的"继续
  // 跑"翻译：先 rearmPending（pre-step 门卫豁免源 isMainAnswerPending 先就绪）
  // 再 steerMainAgent，时序物理封装在租约内。
  broker.register({
    waitKey,
    nodeName,
    kind: 'main',
    jobId,
    mainSessionId: sid,
    steer: (text) => {
      // 【2026-09-11】重试轮的"继续跑"同样过队列：它不是新节点（waitKey/节点
      // 身份不变，交付后照旧 park 等裁决），但若此刻主模型正在跟用户说话，
      // 也不能插进那一轮（捕获面 sawTurnStart 永假 → 既污染用户回合又交不上卷）。
      // 排队只推迟交付时点，节点边界不变。
      queueOrDeliverMain(ctx, resolved, sid, {
        waitKey, nodeName, actor, scopes: scopes ?? [], jobId,
        ...(nodeShowprompts?.get(nodeName) !== undefined ? { showprompt: nodeShowprompts.get(nodeName) } : {}),
        text, via: '重试',
      })
    },
  })
  // 登记在飞（先登记再 steer——pre-step 放行判定必须在回合唤醒前就绪）。
  // 【V6.3】showprompt 从 context_ready 暂存取（引擎对所有 AI 节点统一发
  // context_ready，main 节点同款）；投影缓冲/工具名表随登记对象初始化。
  // 【2026-09-11】交付过队列：主模型正在跟用户说话（有轮在飞）时先排队，
  // 等那一轮彻底结束再作为新一轮的开头交付（戏内戏外不掺一轮）。pending 登记
  // 与 steer 都在交付那一刻发生——在飞期间 isMainAnswerPending 为假，捕获面
  // 不会把用户那轮当成交卷内容。
  const delivery: MainDelivery = {
    waitKey, nodeName, actor, scopes: scopes ?? [], jobId, text: notice, via: '首轮',
    ...(nodeShowprompts?.get(nodeName) !== undefined ? { showprompt: nodeShowprompts.get(nodeName) } : {}),
  }
  const answer = new Promise<void>((resolve) => { delivery.resolve = resolve })
  try {
    queueOrDeliverMain(ctx, resolved, sid, delivery)
    debugLogMainActor(resolved, `注入已投递（若主模型在飞则排队），等待主模型回合...`)
    await answer
    debugLogMainActor(resolved, `回合结束，交卷完成`)
    // ── 停靠循环（2026-09-05 Step D，施工清单 v4 §7.2）────────────────────
    // 首次交卷≠节点审结：引擎校验失败发 node_retry（broker deliverRetry 解析
    // 为 retry verdict）。retry → 经租约 steer（rearmPending+steerMainAgent 都
    // 封装在租约回调里，循环体零特殊）→ 主模型新回合 → mainSessionEventHook
    // 既有捕获（turn/start 重置逻辑天然多轮兼容）→ turn/end → settleMainAnswer
    // 交卷 → 再次 park。done（node_settled ok/gave_up）或 aborted（暂停/出错/
    // bridge 死亡/15min 超时）→ 收尾。flows/水位不动（v4 §7.2）：流水已在首轮
    // 注入（水位已推进），反馈自带节点/演员身份，重注=重复刷屏。
    let verdict = await broker.park(waitKey)
    while (verdict.kind === 'retry') {
      debugLogMainActor(resolved, `停靠重试: node=${nodeName} attempt=${verdict.attempt} feedback=${verdict.feedback.length}ch`)
      broker.steerLease(waitKey, mainRetrySteerText(playNames.get(sid) ?? '剧本', nodeName, actor, verdict.attempt, verdict.feedback))
      verdict = await broker.park(waitKey)
    }
    debugLogMainActor(resolved, `停靠结束: node=${nodeName} verdict=${verdict.kind}`)
  } catch (error: unknown) {
    debugLogMainActor(resolved, `!! 异常: ${error instanceof Error ? error.message : String(error)}`)
    pending.delete(sid)
    recordError(SessionId(sid), `主模型下场注入失败：${error instanceof Error ? error.message : String(error)}`)
    await sendActorFailure(bridge, jobId, waitKey, 'main_executor_error',
      error instanceof Error ? error.message : String(error)).catch(() => undefined)
  } finally {
    // 停靠登记与 API 慢层计数兜底清（幂等；done/aborted/异常全路径都到这，
    // 与 subagent.ts finally 同款）。flows/水位不动（v4 §7.2 收尾语义）。
    // 【2026-09-11】本 waitKey 还排着队的交付件一并剔除：等它的停靠循环已经
    // 收场（done/aborted/异常），再交付=对空气说话（还会拿旧 wait_key 交卷）。
    const stale = deliveries.dropWhere(sid, d => d.waitKey === waitKey)
    if (stale.length > 0) {
      debugLogMainActor(resolved, `排队注入随节点收尾剔除: wait_key=${waitKey} 条=${stale.length}`)
      for (const d of stale) d.resolve?.()
    }
    broker.unregister(waitKey)
    apiRetry.clearChild(sid)
  }
}

// ── 主会话事件钩子（轮次捕获 + V6.3 戏内投影）───────────────────────────────

/** 投影缓冲原子落地（全同步，与 subagent flushMirrorBuffer 同款时序保证：
 *  中途不可能插入其他事件 ⇒ 区块连续性是结构保证）。分发=stage 全量+scope
 *  命中角色窗，god 窗 skipGod 零写入。 */
function flushProjection(proj: ProjectionWindows, p: PendingAnswer): void {
  if (p.projBuffer.length === 0) return
  const items = p.projBuffer.splice(0)
  for (const item of items) {
    projectionAppend(proj, item.type, item.data, item.surface, p.scopes, { skipGod: true })
  }
}

/** main 轮 chunk 直播帧（V6 演员同款语义：delta/start/block_end，block_end 带
 *  retain=true——块保留在前端直播桶里直到 turn 落地接管）。actor=main 演员名，
 *  与导演直播帧（actor='导演'）分桶互不干扰。
 *  @param step - 本帧所属 react 步号（旧路径取事件 data.step，0.1.3 原生帧自带）。 */
function broadcastMainChunk(
  p: PendingAnswer,
  sid: string,
  step: number,
  chunk: FemoStreamChunk,
): void {
  broadcastStreamChunk({ sid, node_name: p.nodeName, actor: p.actor, step }, chunk)
}

/** main 轮 tool_result 直播帧（V6.1 演员同款：合并进前端同名 toolcall 块，
 *  正文截 2000 防病态巨型结果刷屏）。 */
function broadcastMainToolResult(p: PendingAnswer, sid: string, raw: Record<string, unknown>): void {
  const msg = (raw.message ?? undefined) as
    | { source?: { callId?: unknown }; content?: Array<{ content?: Array<{ type?: unknown; text?: unknown }> }> }
    | undefined
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
  const name = callId !== undefined ? p.toolNames.get(callId) : undefined
  broadcastSse('femo_stream', {
    kind: 'tool_result', sid, node_name: p.nodeName, actor: p.actor,
    step: typeof raw.step === 'number' ? raw.step : 0,
    ...(name !== undefined ? { name } : {}),
    text: text.length > 2000 ? `${text.slice(0, 2000)}…` : text,
  })
}

// ── 0.1.3 原生流帧直播桥（主模型下场）─────────────────────────────────────

/** per-sid 直播位（演员名随节点变：actor 变了换桶，旧桶由 turn 关闭回收）。 */
const mainLiveFrames = new Map<string, { actor: string; frames: LiveStreamFrames }>()

/** 订阅宿主原生 assistant 流帧，把在飞 main 节点的模型增量转成 femo_stream
 *  直播帧（stage/角色窗的打字机）。与旧 chunk 路径互斥（0.1.3 无 chunk 会话
 *  事件、旧版无本帧——见 stream-frames 头注释），不会重复广播。 */
export function installMainActorStreamBridge(ctx: Context): void {
  onAssistantStreamFrames(ctx, ({ agent, frame }) => {
    if (frame === undefined) return
    const sid = String(agent?.session?.id ?? agent?.id ?? '')
    if (sid.length === 0) return
    const p = pending.get(sid)
    // 只有「本会话有在飞 main 节点且本回合已开」的增量属于下场轮（其余归导演
    // 桥/原生渲染）；门控与旧 chunk 分支同款。
    if (p === undefined || p.settled || !p.sawTurnStart) return
    let live = mainLiveFrames.get(sid)
    if (live === undefined || live.actor !== p.actor) {
      live = { actor: p.actor, frames: new LiveStreamFrames({ sid, node_name: p.nodeName, actor: p.actor, turn: p.turn }) }
      mainLiveFrames.set(sid, live)
      projTrace('frame', `建立 main 直播位 actor=${p.actor} turn=${p.turn === undefined ? '(未定)' : t4(p.turn)} node=${p.nodeName}`)
    }
    projTrace('frame', `收 main 原生帧 type=${frame.type ?? '-'} → actor=${p.actor} turn=${p.turn === undefined ? '(未定)' : t4(p.turn)}`)
    live.frames.frame(frame)
  })
}

/** engine-events 的 session/event 订阅转发进来：缓冲回答事件，turn/end 交卷；
 *  【V6.3】同一捕获点上同步挂 stage/角色窗戏内投影（骨架即时、内容缓冲
 *  turn/end 原子落地、chunk 旁路直播帧）。god 窗零写入（skipGod——god-mirror
 *  已覆盖主模型发言，2026-08-31 回滚教训：再写=孤儿骨架+去重撞车）。 */
export function mainSessionEventHook(
  ctx: Context,
  session: Session,
  event: SessionEvent,
  bridge: FemoBridge,
  resolved: ResolvedConfig,
  projections?: ProjectionRegistry,
): void {
  const sid = String(session.id)
  // ── 主会话轮开闭跟踪（2026-09-11）────────────────────────────────────────
  // 戏内注入的排队判定源（见 main-delivery-queue.ts / queueOrDeliverMain）。
  // 必须先于 pending 早退：戏外轮（用户跟主模型说话）没有 pending，但它恰恰
  // 是"不能插进戏内通知"的那一轮。turn/end 时要做的两件事：
  //  ①登记轮收口（此后交付立即放行）；
  //  ②把排队中的下一节点作为新一轮开头交付——放在本 hook 末尾（本轮的
  //    交卷先做完再放行下一个，见下方两处 flush 调用点）。
  if (event.type === 'turn/start') {
    const turn = (event.data as { turn?: unknown } | undefined)?.turn
    if (typeof turn === 'number') deliveries.noteTurnStart(sid, turn)
  } else if (event.type === 'turn/end') {
    deliveries.noteTurnEnd(sid)
  }
  const p = pending.get(sid)
  if (p === undefined || p.settled) {
    // 本轮没有在飞注入（用户戏外轮收口 / 已交卷轮）：放行排队中的下一节点。
    if (event.type === 'turn/end') flushNextMainDelivery(ctx, resolved, sid)
    return
  }
  // 投影窗引用（登记在飞但窗未建=理论不可达，静默跳过零抛错）。
  const proj = projections !== undefined ? projections.get(sid) : undefined
  if (event.type === 'turn/start') {
    p.sawTurnStart = true
    p.buffer = []
    // 【步3 2026-09-11】主模型下场轮并入显示层 v9 的统一轮机制：
    //  · **开轮锚点**（kind='live'，带 turn）即时落——它是前端轮身份与排序键
    //    （orderSeq=激活时间）；主会话轮自带原生小 turn 号，与演员轮的
    //    TURN_BASE_EPOCH 大数天然不撞，同池排序成立；
    //  · **骨架与内容全部进闸门缓冲**，turn/end 时按开跑顺序整段落盘
    //    （sectionGate，与演员轮 v7 同款）。旧实现"骨架即时 + 内容缓冲"两头
    //    不讨好——骨架抢在别的演员区块前落、内容落在其后，于是主模型发言
    //    插在演员块中间、名字与内容分家（用户 2026-09-11 现场症状）。
    //  · god 窗仍 skipGod（god 窗由 god-mirror 覆盖；god 侧的"主 Agent 轮"
    //    锚点由 engine-events 的主会话钩子统一写，避免双份）。
    if (proj !== undefined) {
      const turn = (event.data as { turn?: unknown } | undefined)?.turn
      if (typeof turn === 'number') p.turn = turn
      if (p.turn !== undefined) {
        const visible = p.scopes.length > 0 ? { visible: p.scopes } : {}
        projectionAppend(proj, 'dsh-femo/chat', {
          // scene:true = 戏内下场轮（前端按演员轮公式贴段首定位；戏外主会话轮
          // 走 v9.2 的"首个回答"公式，两者分开——用户 2026-09-11 拍板）。
          kind: 'live', actor: p.actor, turn: p.turn, main: true, scene: true, ...visible, seq: Date.now(),
        }, undefined, p.scopes, { skipGod: true })
        sectionGate.begin(sid, p.turn, projectionActorKey(p.actor))
        p.projBuffer.push({
          type: 'turn/start',
          data: { ...((event.data ?? {}) as Record<string, unknown>) },
          surface: undefined,
        })
        p.projBuffer.push({
          type: 'dsh-femo/chat',
          data: { kind: 'speaker', actor: p.actor, text: p.actor, turn: p.turn, ...visible, seq: Date.now() },
          surface: undefined,
        })
        if (p.showprompt !== undefined) {
          p.projBuffer.push({
            type: 'dsh-femo/chat',
            data: { kind: 'prompt', text: `📢 ${p.showprompt}`, turn: p.turn, ...visible, seq: Date.now() },
            surface: undefined,
          })
        }
      }
    }
    return
  }
  if (event.type === 'step/start') {
    // 原生 step/start 进缓冲（步3：不再即时落盘，随整段由闸门放行）。
    if (proj !== undefined && p.sawTurnStart && p.turn !== undefined) {
      p.projBuffer.push({
        type: 'step/start',
        data: { ...((event.data ?? {}) as Record<string, unknown>) },
        surface: undefined,
      })
    }
    return
  }
  if (event.type === 'assistant/chunk') {
    if (!p.sawTurnStart) return
    const raw = (event.data ?? {}) as Record<string, unknown>
    const chunk = raw.chunk as FemoStreamChunk | undefined
    if (chunk === undefined) return
    // 直播帧全量旁路（纯 SSE 零落盘）；落盘镜像裁剪=只取块边界（与 subagent
    // 同款：delta/usage 不落日志，历史重放由 block-end 完整块+message 兜底）。
    // 【0.1.3 注】本段在原生构建下恒不触发（无 assistant/chunk 会话事件），
    // 直播由 installMainActorStreamBridge 的原生帧桥承担。
    broadcastMainChunk(p, sid, typeof raw.step === 'number' ? raw.step : 0, chunk)
    if (proj !== undefined && (chunk.type === 'block-start' || chunk.type === 'block-end')) {
      p.projBuffer.push({
        type: 'assistant/chunk',
        data: { ...raw, _srcSeq: `main#${Number(event.seq)}` },
        surface: undefined,
      })
    }
    return
  }
  if (event.type === 'assistant/message' || event.type === 'tool/call' || event.type === 'tool/result') {
    if (!p.sawTurnStart) return
    p.buffer.push(event)
    if (proj !== undefined) {
      // 进投影缓冲（surface-eligible 事件带 surfaceOp）；tool/call 登记
      // callId→name 供结果帧取名；tool_result 照 V6.1 广播结果帧。
      p.projBuffer.push({
        type: event.type,
        data: { ...(event.data as Record<string, unknown>), _srcSeq: `main#${Number(event.seq)}` },
        surface: MAIN_SURFACE_OP_EVENTS.has(event.type) ? ({ surfaceOp: 'append' } as Record<string, unknown>) : undefined,
      })
      if (event.type === 'tool/call') {
        const d = event.data as { callId?: unknown; name?: unknown }
        if (typeof d.callId === 'string' && typeof d.name === 'string') p.toolNames.set(d.callId, d.name)
      } else if (event.type === 'tool/result') {
        broadcastMainToolResult(p, sid, event.data as Record<string, unknown>)
      }
    }
    return
  }
  if (event.type === 'step/end') {
    // 进投影缓冲（V6 演员同款：step/end 属内容事件；结构键幂等，不带 _srcSeq）。
    if (proj !== undefined && p.sawTurnStart) {
      p.projBuffer.push({
        type: 'step/end',
        data: { ...(event.data as Record<string, unknown>) },
        surface: undefined,
      })
    }
    return
  }
  if (event.type === 'turn/end') {
    if (!p.sawTurnStart) return // 上一回合的尾部，不属于本注入
    // 【2026-09-10】回合收口 → 熄灭本演员状态行（整 turn 常亮；attempt 级 end
    // 帧不熄，工具执行期不闪）。
    mainLiveFrames.get(sid)?.frames.endTurn()
    // 【V6.3】turn/end 进缓冲 → 由闸门按开跑顺序整段落盘（步3：与演员轮同款，
    // 先落窗再交卷——交卷失败不影响已落窗数据）。turn/end 结构事件不带
    // _srcSeq（迁移器红线）。
    if (proj !== undefined && p.turn !== undefined) {
      p.projBuffer.push({ type: 'turn/end', data: { ...(event.data as Record<string, unknown>) }, surface: undefined })
      const turn = p.turn
      sectionGate.commit(sid, turn, projectionActorKey(p.actor), () => flushProjection(proj, p))
      projTrace('node', `main 段落释放(commit) actor=${p.actor} turn=…${String(turn).slice(-4)} node=${p.nodeName} 缓冲行数=${p.projBuffer.length}`)
    }
    pending.delete(sid)
    p.settled = true
    p.resolve()
    void settleMainAnswer(ctx, session, p, bridge, resolved, projections).catch((error: unknown) => {
      debugLogMainActor(resolved, `!! 交卷异常: ${error instanceof Error ? error.message : String(error)}`)
      recordEmpty(p, bridge)
    })
    // 【2026-09-11】本节点交卷已发起（buffer 已同步取走）——若还有节点在排队
    // （主模型跟用户说话期间引擎又走到下一个 main 节点），此刻作为新一轮开头
    // 交付：戏内每个节点各占一轮，绝不与上一节点/用户那轮同轮。
    flushNextMainDelivery(ctx, resolved, sid)
  }
}

/** 交卷（纯引擎落库，零 UI 投影）：台词经 human_input 交引擎落库。
 * 【2026-09-01 猫猫拍板】v1 的 role 行灰框投影整体移除——god 窗由 god-mirror
 * 镜像天然覆盖主模型发言（重复塞入=画蛇添足）；stage/角色窗的 main 内容之后
 * 复用投影窗自己的镜像/流式逻辑另做（本轮只删 UI，轮次捕获/交卷判定保留复用）。
 * 【2026-08-31 回滚注】合成镜像组实验（speaker/showprompt/turn 骨架+内容重映射）
 * 已撤销——无 _srcSeq 的骨架事件写进了 god 窗（孤儿骨架污染上帝视角），带
 * _srcSeq 的内容反被 god 窗去重拦截（stage 长度 185→185 铁证）。god 窗里的
 * 孤儿骨架数据未清理（用户拍板：先不管窗数据）。 */
async function settleMainAnswer(
  ctx: Context,
  session: Session,
  p: PendingAnswer,
  bridge: FemoBridge,
  resolved: ResolvedConfig,
  projections?: ProjectionRegistry,
): Promise<void> {
  const { output, steps } = buildTranscript(p.buffer)
  debugLogMainActor(resolved, `交卷: node=${p.nodeName} output=${output.length}ch steps=${steps.length} buffer=${p.buffer.length}事件`)
  await bridge.send('human_input', {
    job_id: p.jobId,
    wait_key: p.waitKey,
    body: { output, steps },
  })
}

// ── 剧终补遗 ────────────────────────────────────────────────────────────────

function recordEmpty(p: PendingAnswer, bridge: FemoBridge): void {
  // 交卷回传本身失败（B5）：显式上报执行失败，不伪装空台词。
  void sendActorFailure(bridge, p.jobId, p.waitKey, 'deliver_error',
    '主模型回合交卷异常（回传失败）').catch(() => undefined)
}

// ── 剧终补遗 ────────────────────────────────────────────────────────────────

/** flow_done：把剩余未注入的 main 可见发言补进主窗口（有则发，无则静默）。 */
export function flushMainFinalDelta(ctx: Context, sessionId: string | SessionId, resolved: ResolvedConfig): void {
  const sid = String(sessionId)
  const all = flows.get(sid) ?? []
  const mark = waterMarks.get(sid) ?? 0
  const delta = all.slice(mark)
  waterMarks.set(sid, all.length)
  if (delta.length === 0) return
  const notice = stageNotice(sid, '', '', '', delta, true)
  steerMainAgent(ctx, sid, notice)
  debugLogMainActor(resolved, `剧终补遗注入: ${delta.length}条 ${notice.length}ch`)
}
