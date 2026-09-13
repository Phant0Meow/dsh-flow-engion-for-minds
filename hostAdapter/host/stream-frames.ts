/**
 * stream-frames.ts — 0.1.3 原生 assistant 流帧 → femo_stream 直播帧桥（2026-09-10）。
 *
 * 背景（0.1.3 实测根因，2026-09-10）：0.1.x 官方把「模型流式增量」从会话事件
 * 改成了 agent 级瞬时帧——agent-loop 的 AssistantStreamAttempt 每收一个 chunk
 * 就 emit 一发 agent/assistant-stream（core/agent-loop/src/agent.ts +
 * assistant-stream.ts），持久层只留一条把整段 stream 折叠进 data.stream 的
 * assistant/message（v2 会话格式），KNOWN_SESSION_EVENT_TYPES 里已无
 * assistant/chunk。于是本插件三条直播链路（AI 演员/主模型下场/导演）原先挂在
 * session/event 的 assistant/chunk 上的广播全部空转：投影窗失去打字机，内容只
 * 能在 turn/end 原子缓冲落地时一次性出现（「非得等 AI 全说完才猛一下出全文」的
 * 真凶）。本模块把这套帧按【既有 femo_stream 帧词汇】原样转出，前端 stream-store
 * 零改动（chunk 词汇没变：text-delta/reasoning-delta/tool-call-delta/
 * block-start/block-end，与旧 chunk 路径逐帧同形）。
 *
 * 另转出回合状态帧（turn_status，running=true/false）：前端据此在**各演员自己
 * 的块末行**点亮/熄灭「Deep diving…」状态行——与主窗口同规则（首次请求一起就
 * 显示，不等首 token；整 turn 常亮，工具执行/后续 react 步都不闪；回合收口才灭）。
 *
 * 【两条路径互斥，无需版本开关】旧版（meow fork 0.1.1-rc.2）只有会话事件
 * assistant/chunk、源码里没有 agent/assistant-stream；0.1.3 只有本帧、没有
 * chunk 会话事件（两版源码实证）。故同一宿主上不可能同时生效，不会重复广播。
 */

import type { Context } from '@deepseek-ai/cordis'
import { broadcastSse } from './http'
import { projTrace, t4 } from './proj-trace' // 【诊断 2026-09-11 临时】不可达帧自动落 diag 日志

/** llm StreamChunk 的消费面（与各调用点既有鸭子类型一致）。 */
export interface FemoStreamChunk {
  type?: string
  index?: number
  blockType?: string
  text?: unknown
  name?: unknown
  argumentsDelta?: unknown
  usage?: unknown
  block?: { type?: string }
}

/** 0.1.3 官方 AssistantStreamFrame 的消费面（start/chunk/end 三态）。 */
export interface AssistantStreamFrame {
  type?: string
  turn?: unknown
  step?: unknown
  chunk?: FemoStreamChunk
  outcome?: { kind?: string; eventType?: string }
}

/** agent/assistant-stream 载荷（官方 `{ agent, frame }`）。 */
export interface AssistantStreamPayload {
  agent?: { id?: unknown; session?: { id?: unknown; header?: { parentSession?: unknown } } }
  frame?: AssistantStreamFrame
}

/** 直播帧身份（与旧 chunk 路径同词汇：sid + 演员 + 步号）。
 *  【诊断 2026-09-11】新增可选 `turn`——排查"桶只有演员名没有轮次"用；
 *  目前只有 actor 路径会带（subagent-native 传 baseTurn），其余来源为空。 */
export interface FemoStreamBase {
  sid: string
  node_name: string
  actor: string
  step?: number
  turn?: number
}

/** 【诊断 2026-09-11 临时】帧自动埋点：先抓"谁在发帧、有没有轮次"。
 *  去重交给终端，这里按 (kind|actor|turn|step) 折叠。 */
const frameTraceSeen = new Map<string, number>()
function traceFrame(kind: string, base: FemoStreamBase, extra?: string): void {
  const key = [kind, base.actor, base.turn === undefined ? '-' : t4(base.turn), base.step ?? '-', base.node_name].join('|')
  const n = frameTraceSeen.get(key) ?? 0
  frameTraceSeen.set(key, n + 1)
  if (n > 0) return
  projTrace('frame', `出帧 kind=${kind} sid=${base.sid.slice(-8)} actor=${base.actor} turn=${base.turn === undefined ? '(无)' : t4(base.turn)} step=${base.step ?? '-'} node=${base.node_name || '-'}${extra === undefined ? '' : ` ${extra}`}`)
}

/** 【诊断 2026-09-11 临时】出帧留痕（不去重，每帧一条，带毫秒时间戳）：
 *  用于和前端"收帧"时间对齐，判定重复投递是"宿主发了两遍"还是"链路/浏览器重投"。
 *  只记录身份与 kind，不记正文。 */
const EMIT_LOG_CAP = 4000
let emitLogCount = 0
function traceEmit(kind: string, base: FemoStreamBase): void {
  if (emitLogCount >= EMIT_LOG_CAP) return
  emitLogCount += 1
  projTrace('emit', `emit#${emitLogCount} ${kind} actor=${base.actor} turn=${base.turn === undefined ? '-' : t4(base.turn)} sid=${base.sid.slice(-8)}`)
}

/** 按旧 chunk 路径逐帧同形的词汇广播一个流式块。 */
export function broadcastStreamChunk(base: FemoStreamBase, chunk: FemoStreamChunk): void {
  if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
    traceFrame('delta-text', base, `len=${chunk.text.length} idx=${chunk.index ?? '-'}`)
    traceEmit('delta-text', base)
    broadcastSse('femo_stream', { kind: 'delta', ...base, blockKind: 'text', index: chunk.index, text: chunk.text })
  } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
    traceFrame('delta-reasoning', base, `len=${chunk.text.length} idx=${chunk.index ?? '-'}`)
    broadcastSse('femo_stream', { kind: 'delta', ...base, blockKind: 'reasoning', index: chunk.index, text: chunk.text })
  } else if (chunk.type === 'tool-call-delta') {
    const name = typeof chunk.name === 'string' && chunk.name.length > 0 ? chunk.name : undefined
    const argsDelta = typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
    if (name !== undefined || argsDelta.length > 0) {
      traceFrame('delta-tool', base, `name=${name ?? '-'}`)
      broadcastSse('femo_stream', {
        kind: 'delta', ...base, blockKind: 'toolcall', index: chunk.index,
        ...name !== undefined ? { name } : {}, text: argsDelta,
      })
    }
  } else if (chunk.type === 'block-start' && (chunk.blockType === 'text' || chunk.blockType === 'reasoning')) {
    traceFrame(`block-start-${chunk.blockType}`, base, `idx=${chunk.index ?? '-'}`)
    broadcastSse('femo_stream', { kind: 'start', ...base, blockKind: chunk.blockType, index: chunk.index })
  } else if (chunk.type === 'block-end'
    && (chunk.block?.type === 'text' || chunk.block?.type === 'reasoning' || chunk.block?.type === 'tool-call')) {
    traceFrame(`block-end-${chunk.block?.type}`, base, `idx=${chunk.index ?? '-'}`)
    traceEmit(`block-end-${chunk.block?.type}`, base)
    broadcastSse('femo_stream', {
      kind: 'block_end', ...base, index: chunk.index, retain: true,
      blockKind: chunk.block?.type === 'tool-call' ? 'toolcall' : chunk.block?.type,
    })
  }
}

/** 清一个直播位的块（客户端按 sid+actorKey 清块：内容交接/孤儿 attempt 专用；
 *  条目与状态行保留——状态行的生杀权在 turn_status 帧）。 */
export function clearLiveBucket(base: FemoStreamBase): void {
  traceFrame('clear', base, '(清桶帧，带轮号时只清本轮的位)')
  traceEmit('clear', base)
  broadcastSse('femo_stream', {
    kind: 'end', sid: base.sid, node_name: base.node_name, actor: base.actor,
    ...base.turn === undefined ? {} : { turn: base.turn },
  })
}

/**
 * 订阅宿主原生 assistant 流帧（`ctx.on('agent/assistant-stream', …)`）。
 *
 * 事件名与载荷由 @deepseek-ai/dsh-agent 声明，本插件不依赖该包的类型面，故与
 * 官方消费方（api/session-controller/src/history.ts）同款手工注册：名字 + 鸭子
 * 类型载荷。`global` 与「未打标签监听器对 scope 事件全局可见」的 scope 语义一致
 * （packages/core/scope/src/index.ts scopeTarget），显式写上以防上层被包进 scope。
 *
 * @param ctx - 插件上下文（监听随插件 fiber 卸载）。
 * @param handler - 每帧回调（自行按 agent 身份过滤）。
 * @returns 注销函数。
 */
export function onAssistantStreamFrames(
  ctx: Context,
  handler: (payload: AssistantStreamPayload) => void,
): () => void {
  const on = ctx.on as unknown as (
    name: string,
    listener: (payload: AssistantStreamPayload) => void,
    options?: { global?: boolean },
  ) => () => void
  return on.call(ctx, 'agent/assistant-stream', handler, { global: true })
}

/**
 * 一个直播位（一个演员 / 一轮主模型下场 / 一条导演流）的帧折叠器。
 *
 * 除逐帧转出外，负责孤儿清屏：attempt 以 abandoned/<非 message> 收口时它的文字
 * 永远不会落进会话日志（落地的只有 assistant/message），若不清桶，客户端会在同
 * 一个 (index, step) 块上把两次尝试的 delta 拼成一坨。
 */
export class LiveStreamFrames {
  private orphan = false

  /**
   * @param base - 直播帧身份（sid/actor/node_name；step 逐帧覆盖）。
   * @param onChunk - 每个 chunk 帧的旁挂（如占用采样），不参与广播。
   */
  constructor(
    private readonly base: FemoStreamBase,
    private readonly onChunk?: (chunk: FemoStreamChunk) => void,
  ) {}

  /** 折叠一帧；非 chunk 帧只维护孤儿状态与回合状态行。 */
  frame(frame: AssistantStreamFrame): void {
    if (frame.type === 'start') {
      // 上一次尝试没交出 message（失败重试/中止）→ 清掉它的残留再重新开始。
      if (this.orphan) this.clear()
      traceFrame('attempt-start', this.base, `orphan 清理=${String(this.orphan)}`)
      // 首次请求即点亮，此后整 turn 常亮（react 多步之间工具执行期不灭——与
      // 官方 ChatView TurnStatus「rides the whole running turn」同规则）；
      // 熄灭权威在回合收口（endTurn，各路径在自己的 turn/end 处调用）。
      this.broadcastTurnStatus(true)
      return
    }
    if (frame.type === 'end') {
      // attempt 收口不熄状态行：turn 可能还有下一步（工具执行中）。
      const outcome = frame.outcome
      if (outcome?.kind === 'abandoned') { this.clear(); return }
      this.orphan = outcome?.eventType === 'assistant/attempt'
      return
    }
    if (frame.type !== 'chunk' || frame.chunk === undefined) return
    this.onChunk?.(frame.chunk)
    broadcastStreamChunk(this.baseFor(frame.step), frame.chunk)
  }

  /** 回合收口 → 熄灭本直播位的状态行（各路径在自己的 turn/end 处调用；幂等）。 */
  endTurn(): void {
    traceFrame('turn-status-off', this.base)
    this.broadcastTurnStatus(false)
  }

  /** 状态帧（前端按直播位点亮/熄灭「Deep diving…」）。【2026-09-11 v8】带上
   *  轮号：状态行与内容同属一轮，必须落进同一个轮次位——否则状态行退化成
   *  "按演员"的老位置，会画不出或画到别的块上。 */
  private broadcastTurnStatus(running: boolean): void {
    traceFrame(running ? 'turn-status-on' : 'turn-status-off', this.base)
    traceEmit(running ? 'turn-status-on' : 'turn-status-off', this.base)
    broadcastSse('femo_stream', {
      kind: 'turn_status', running, sid: this.base.sid, node_name: this.base.node_name, actor: this.base.actor,
      ...this.base.turn === undefined ? {} : { turn: this.base.turn },
    })
  }

  /** 清本直播位（客户端删桶）。 */
  clear(): void {
    this.orphan = false
    clearLiveBucket(this.base)
  }

  /** 帧自带步号优先（0.1.3 帧恒带 turn/step）；缺省回落本直播位的步号。 */
  private baseFor(step: unknown): FemoStreamBase {
    const resolved = typeof step === 'number' ? step : this.base.step
    return resolved === undefined ? this.base : { ...this.base, step: resolved }
  }
}
