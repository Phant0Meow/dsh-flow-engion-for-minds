/**
 * client-ui/stream-store.ts — femo_stream 直播缓冲（2026-08-24 方案B：SSE 旁路零落盘）。
 *
 * host 的 runAiSubagent 把演员 chunk 旁路广播到 /dsh-femo/events；这里按
 * 「主会话 id + actorKey」分桶缓冲，speaker 锚点行在名字正下方渲染官方同
 * 款打字机。【V6 2026-08-30】块完成（block_end+retain）后【保留】在桶里——
 * 宿主 turn 原子缓冲下镜像行要等 turn/end 落地才接管，即删会文字闪空；桶
 * 的清空权威 = turn 关闭（节点隐藏）+ run 结束（end 帧整桶清）。导演路径
 * （无 retain 帧）维持原「落地即移除」语义。全部内存态，不写任何会话日志。
 *
 * 2026-08-26 结构整理自 client.tsx 原样迁出（行为零变化）；femoProjectionActorKey
 * 是投影窗 id 的 actorKey 消毒（与宿主 projection.ts projectionActorKey 同算法，
 * 前端比对用——浏览器无法 import host 代码，两端改动必须同步）。
 *
 * 【2026-09-10 回合状态行】0.1.3 宿主桥（host stream-frames.ts）另发 turn_status
 * 帧（running=true/false）：本店按同款 (sid, actorKey) 直播位记 running/since，
 * 供各演员直播块末行的「Deep diving…」状态行——首次请求点亮、整 turn 常亮
 * （工具执行/后续 react 步不闪）、回合收口才灭；内容帧的 end（清块）不动它。
 */

import { useEffect, useState } from 'react'

export interface FemoStreamBlock {
  kind: 'text' | 'reasoning' | 'toolcall'
  text: string
  /** toolcall 块：工具名（首帧带 name 的 delta 合并进来）。 */
  name?: string
  /** 源 chunk index（llm StreamChunk 每块独立编号）——同 step 并行工具调用
   * （多 tool-call 块 delta 交错）按 index 分块聚合。2026-08-29 前按「最后
   * 一个同类块」聚合且假设同 step 工具串行，GLM 并行工具会把多工具参数拼
   * 进同一块。宿主旧广播帧无 index → 回退 findLast 行为。 */
  index?: number
  /** V6：帧所属 react 步号。块保留在桶里后 index 跨步复用，匹配必须限定
   * 同 step（宿主旧帧无 step → undefined，与旧块 undefined 对 undefined 匹配）。 */
  step?: number
  /** V6 官方工具行：tool_result 帧合并进同名 toolcall 块后的展平结果文本
   * （官方一次调用一行：收起=摘要行，展开=IN args/OUT result 卡）。undefined
   * =调用还在跑（running 流光态）。 */
  result?: string
}

interface FemoStreamMsg {
  kind: 'start' | 'delta' | 'block_end' | 'end' | 'tool_result' | 'turn_status'
  sid?: unknown
  actor?: unknown
  blockKind?: unknown
  index?: unknown
  step?: unknown
  text?: unknown
  name?: unknown
  /** 【诊断 2026-09-11】宿主帧若带了轮次（actor 路径已带），前端原样转发/消费。 */
  turn?: unknown
  /** turn_status 帧：本演员回合是否在飞（true=点亮状态行，false=回合收口熄灭）。 */
  running?: unknown
  /** V6 演员路径 block_end 专用：块保留在桶里（缓冲下镜像行 turn 落地才
   * 接管，即删会文字闪空）；导演路径不带此标记，维持落地即移除。 */
  retain?: unknown
}

export const EMPTY_FEMO_BLOCKS: readonly FemoStreamBlock[] = []

/** 帧携带的源块编号（缺省/非法 = 旧宿主广播，回退按 kind 找块）。 */
function msgIndex(msg: FemoStreamMsg): number | undefined {
  return typeof msg.index === 'number' ? msg.index : undefined
}

/** 帧携带的 react 步号（V6）：undefined = 旧宿主广播，与 undefined 块匹配。 */
function msgStep(msg: FemoStreamMsg): number | undefined {
  return typeof msg.step === 'number' ? msg.step : undefined
}

function sameStep(blockStep: number | undefined, frameStep: number | undefined): boolean {
  return blockStep === frameStep
}

/** 按 (index, step) 从后往前定位块；无 index 时回退「最后一个同类块」。
 * 从后往前：同 (index,step) 理论唯一，防御性容忍异常帧序列。 */
function findBlockAt(
  blocks: readonly FemoStreamBlock[],
  idx: number | undefined,
  step: number | undefined,
  kind: FemoStreamBlock['kind'],
): number {
  if (idx !== undefined) {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]
      if (b?.index === idx && sameStep(b.step, step) && b.kind === kind) return i
    }
    return -1
  }
  return findLastFemoBlock(blocks, kind)
}

/** 主会话id + 直播位键 → 该位的未落地直播块序列（copy-on-write）。
 *  【2026-09-11 v8 轮次隔离】直播位键 = `t<轮号>`（宿主帧带的 turn），
 *  **不再按演员名共享**——同一演员的每一轮有独立桶，于是"两块同时长字"
 *  在数据层就不可能发生（投影窗乱序的根治）。无轮号的旧宿主帧/导演帧回退
 *  `a<actorKey>` 位（行为与旧版一致）。 */
export interface FemoStreamEntry {
  readonly blocks: readonly FemoStreamBlock[]
  /** 该演员当前回合是否在飞（0.1.3 原生 turn_status 帧驱动；旧版恒 false，
   *  状态行仍走 timeline 的 open turn 推导）。 */
  readonly running: boolean
  /** 本回合首次请求的时刻（Deep diving 计时起点；不在飞时 null）。 */
  readonly since: number | null
}
const IDLE_FEMO_ENTRY: FemoStreamEntry = { blocks: EMPTY_FEMO_BLOCKS, running: false, since: null }
const femoStreams = new Map<string, Map<string, FemoStreamEntry>>()
const femoStreamListeners = new Set<() => void>()
let femoStreamRaf = 0

/** 直播位键：帧带轮号 → 轮次位；缺轮号（旧宿主/导演帧）→ 演员位。 */
function femoBucketKey(actorKey: string, turn: unknown): string {
  return typeof turn === 'number' ? `t${turn}` : `a${actorKey}`
}

/** 帧/读取的轮号（非数字=无）。 */
function turnOf(turn: unknown): number | undefined {
  return typeof turn === 'number' ? turn : undefined
}

function femoStreamNotify(): void {
  if (femoStreamRaf !== 0) return
  femoStreamRaf = requestAnimationFrame(() => {
    femoStreamRaf = 0
    for (const listener of [...femoStreamListeners]) listener()
  })
}

/** 读某一轮（或无轮次位）的直播块。 */
function femoStreamEntry(sid: string, key: string): FemoStreamEntry {
  return femoStreams.get(sid)?.get(key) ?? IDLE_FEMO_ENTRY
}

/** 写某一轮（或无轮次位）的直播块；turn 存在时顺手清掉同演员其它轮的残桶
 *  （轮次隔离：新轮开跑，旧轮的桶立即失效，绝不让旧位继续长新字）。 */
function femoStreamPatch(sid: string, key: string, actorKey: string, turn: number | undefined, patch: Partial<FemoStreamEntry>): void {
  // ★ 自建缺失的 sid Map（2026-08-25 崩溃级修复）：此前用可选链
  //   femoStreams.get(sid)?.set(...)，Map 不存在时写入被【静默跳过】且无人
  //   创建它——所有 femo_stream 帧进黑洞，直播层永远空白、零报错。
  let byKey = femoStreams.get(sid)
  if (byKey === undefined) {
    byKey = new Map()
    femoStreams.set(sid, byKey)
  }
  if (turn !== undefined) {
    for (const existing of [...byKey.keys()]) {
      if (existing !== key && existing.startsWith('t') && femoActorOfBucket.get(existing) === actorKey) byKey.delete(existing)
    }
    femoActorOfBucket.set(key, actorKey)
  }
  byKey.set(key, { ...femoStreamEntry(sid, key), ...patch })
  femoStreamNotify()
}

/** 桶键 → 所属 actorKey（仅用于"新轮开跑清旧桶"）。 */
const femoActorOfBucket = new Map<string, string>()

/** 【v8.1】`sid\0actorKey` → 该演员本场见过的最大轮号（陈旧帧防御用）。
 *  轮号单调递增且不复用，条目只增不删（数量=演员数×会话数，可忽略）。 */
const femoMaxTurnSeen = new Map<string, number>()

function findLastFemoBlock(blocks: readonly FemoStreamBlock[], kind: FemoStreamBlock['kind']): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]?.kind === kind) return i
  }
  return -1
}

/** 投影窗 id 的 actorKey 消毒（与宿主 projectionActorKey 同算法，前端比对用）。 */
export function femoProjectionActorKey(actor: string): string {
  return Array.from(actor).map(ch => (/[A-Za-z0-9_-]/.test(ch) ? ch : `_${(ch.codePointAt(0) ?? 0).toString(16)}`)).join('')
}

/** 应用一条宿主广播；未知形态静默忽略（通道宽松前向兼容）。 */
function femoStreamApply(msg: FemoStreamMsg): void {
  const sid = typeof msg.sid === 'string' ? msg.sid : ''
  const actor = typeof msg.actor === 'string' ? msg.actor : ''
  if (sid.length === 0 || actor.length === 0) return
  const blockKind = msg.blockKind === 'reasoning'
    ? 'reasoning' as const
    : msg.blockKind === 'toolcall' ? 'toolcall' as const : 'text' as const
  const actorKey = femoProjectionActorKey(actor)
  const turn = turnOf(msg.turn)
  const bucket = femoBucketKey(actorKey, msg.turn)
  // 【2026-09-11 v8.2 陈旧帧防御（按场隔离版）】同一演员见过的最大轮号记下来，
  // 收到更小轮号的帧直接丢——免疫投递链路的重投（实测同一批帧会被重投一次）。
  // ⚠️ 关键：轮号**按 Job 重置**（TURN_BASE_EPOCH+100n），所以"最大轮号"必须
  // **按场清零**，否则新一场的轮号小于上一场最大值时会被整场误丢
  // （症状=屏幕上只剩零散气泡、角色标签全无）。清零信号：①kind='start'（宿主开局
  // 必广播 run_state running）；②轮号比既有最大值骤降（>500）也视为换场。
  const seenKey = `${sid}\u0000${actorKey}`
  if (msg.kind === 'start') {
    femoMaxTurnSeen.delete(seenKey)
  }
  if (turn !== undefined) {
    const max = femoMaxTurnSeen.get(seenKey)
    if (max !== undefined && turn < max && max - turn < 500) {
      return
    }
    if (max === undefined || turn > max || max - turn >= 500) femoMaxTurnSeen.set(seenKey, turn)
  }
  // 【诊断 2026-09-11】每帧补采一次"屏幕内容"（乱局是逐帧变化的，只定期采样会漏）。
  if (msg.kind === 'end') {
    // 只清块、**不熄状态行、不删条目**：块交接是内容层（native 消息落地/turn
    // 关闭要清掉直播留存），状态行是回合层——由 turn_status 帧单独裁决，否则
    // 多步 react 每步 assistant/message 落地都会把「Deep diving…」闪断。
    // 【v8】带轮号的闭轮帧只清自己那一轮；无轮号（旧宿主/导演清屏）仍清演员位。
    if (femoStreamEntry(sid, bucket).blocks.length > 0) {
      femoStreamPatch(sid, bucket, actorKey, turn, { blocks: EMPTY_FEMO_BLOCKS })
    }
    return
  }
  // ── 回合状态行（0.1.3 原生帧）：首次请求点亮、整 turn 常亮，回合收口才熄。
  if (msg.kind === 'turn_status') {
    const running = msg.running === true
    const prevRunning = femoStreamEntry(sid, bucket).running
    if (running === prevRunning) return
    femoStreamPatch(sid, bucket, actorKey, turn, {
      running,
      // 计时起点=本回合首次请求（回合中途的后续 step 不重置，与官方 turn 计时一致）。
      since: running ? (prevRunning ? femoStreamEntry(sid, bucket).since : Date.now()) : null,
    })
    return
  }
  const prev = femoStreamEntry(sid, bucket).blocks
  const idx = msgIndex(msg)
  const step = msgStep(msg)
  if (msg.kind === 'start') {
    // 重复 start 幂等（同 index+step 块已存在则忽略）。
    if (idx !== undefined && prev.some(b => b.index === idx && sameStep(b.step, step))) return
    femoStreamPatch(sid, bucket, actorKey, turn, {
      blocks: [...prev, {
        kind: blockKind, text: '',
        ...(idx !== undefined ? { index: idx } : {}),
        ...(step !== undefined ? { step } : {}),
      }],
    })
    return
  }
  if (msg.kind === 'delta') {
    const text = typeof msg.text === 'string' ? msg.text : ''
    const name = typeof msg.name === 'string' && msg.name.length > 0 ? msg.name : undefined
    // 定位：index+step 匹配优先；无 index（旧宿主广播）回退「最后一个同类块」。
    let at = findBlockAt(prev, idx, step, blockKind)
    if (at < 0) {
      // 该块的首个 delta：toolcall 无 start 帧、text/reasoning 空文本不建块。
      if (blockKind === 'toolcall' || text.length > 0) {
        femoStreamPatch(sid, bucket, actorKey, turn, {
          blocks: [...prev, {
            kind: blockKind, text,
            ...name !== undefined ? { name } : {},
            ...(idx !== undefined ? { index: idx } : {}),
            ...(step !== undefined ? { step } : {}),
          }],
        })
      }
      return
    }
    const target = prev[at] as FemoStreamBlock
    const next = prev.slice()
    next[at] = {
      ...target,
      text: target.text + text,
      ...name !== undefined && !target.name ? { name } : {},
    }
    femoStreamPatch(sid, bucket, actorKey, turn, { blocks: next })
    return
  }
  if (msg.kind === 'tool_result') {
    // V6 官方工具行语义：一次调用一行——结果帧合并进最近一个同名未完成
    // toolcall 块（IN=流式参数，OUT=结果），块由 running 变 ok。无在流参数
    // 块（异常路径）时以完成态空参行兜底，不丢结果。step 同源匹配（并行
    // 同名调用不串线）。
    const name = typeof msg.name === 'string' && msg.name.length > 0 ? msg.name : undefined
    const text = typeof msg.text === 'string' ? msg.text : ''
    if (name === undefined && text.length === 0) return
    let at = -1
    for (let i = prev.length - 1; i >= 0; i--) {
      const b = prev[i]
      if (b?.kind !== 'toolcall' || b.result !== undefined) continue
      if (name !== undefined && b.name !== name) continue
      if (step !== undefined && b.step !== undefined && b.step !== step) continue
      at = i
      break
    }
    if (at >= 0) {
      const next = prev.slice()
      next[at] = { ...(prev[at] as FemoStreamBlock), result: text }
      femoStreamPatch(sid, bucket, actorKey, turn, { blocks: next })
    } else {
      femoStreamPatch(sid, bucket, actorKey, turn, {
        blocks: [...prev, {
          kind: 'toolcall', text: '',
          ...(name !== undefined ? { name } : {}),
          ...(step !== undefined ? { step } : {}),
          result: text,
        }],
      })
    }
    return
  }
  if (msg.kind === 'block_end') {
    // V6：retain 帧（演员路径）块保留在桶里——缓冲下镜像行要等 turn/end
    // 落地才接管，即删会文字闪空；桶的清空权威 = turn 关闭（节点隐藏）+
    // run 结束 end 帧。无 retain（导演路径）维持原语义：原生工具卡落地即
    // 移除 ⚙ 行防双份。
    if (msg.retain === true) return
    let at = findBlockAt(prev, idx, step, blockKind)
    if (at < 0) return
    const next = prev.slice()
    next.splice(at, 1)
    femoStreamPatch(sid, bucket, actorKey, turn, { blocks: next })
  }
}

// SSE 单例（引用计数 + 可见性门控）：【2026-09-05 连接池修复】从「apply() 页面
// 级预开常驻」改为按需连接——consumer 挂载期间各自 acquire、卸载 release。
// 【2026-09-05 晚·Stage2】连接需求分两池：
//  - 前台池（投影窗直播锚点/角色圆环）：只在页面可见时需要——「看哪个窗连哪个
//    窗」。投影内容的状态完整性由 mux+会话日志回放保证（host 照写 log，切回
//    按 seq 补齐），SSE 只服务前台打字机观感：切后台断、切回连，丢的只有看不
//    见的那段逐字动画。
//  - 后台池（编辑器）：tab 打开即持有、不看可见性——AI 工具随时可能操作
//    femoGen（script_changed 实时响应是编辑器的硬需求）。
// 连接开启条件 = 后台池>0 || (前台池>0 && 页面可见)。普通（非 femo）页面零
// femo 长连接：官方每页已有 events.mux/events.host 两条 ws，浏览器 HTTP/1.1
// 每域 6 连接池很紧（同源多标签饿死教训，见 2026-09-05 修复）。
// 2026-08-26：控制事件（script_changed；【Job 模型】run_request 已退役 §11.4）
// 也搭这条全局 SSE 便车（subscribeControlEvents）——与 femo_stream 共用一个
// 连接，避免第二条长连接。
let femoStreamEs: EventSource | undefined
let foregroundRefs = 0
let backgroundRefs = 0
let pageVisible = typeof document === 'undefined' || document.visibilityState !== 'hidden'
let visibilityBound = false

/** 连接意愿 = 后台池>0（编辑器常驻）或 前台池>0 且页面可见。 */
function femoStreamWanted(): boolean {
  return backgroundRefs > 0 || (foregroundRefs > 0 && pageVisible)
}

/** 按意愿开/关连接（幂等）：创建时挂 onmessage，关闭即清理。 */
function syncFemoStreamConnection(): void {
  if (femoStreamWanted() && femoStreamEs === undefined) {
    femoStreamEs = new EventSource('/dsh-femo/events')
    femoStreamEs.onmessage = (ev: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(ev.data) as { type?: string; data?: Record<string, unknown> }
        if (msg.type === 'femo_stream') femoStreamApply((msg.data ?? {}) as unknown as FemoStreamMsg)
        // 【v8.2】开局清"陈旧帧守卫"的最高轮号：轮号按 Job 重置，跨场残留会让新一场
        // 的帧被误丢（症状：屏幕上只剩零散气泡、角色标签全无）。
        if (msg.type === 'run_state') {
          const d = msg.data ?? {}
          if (d.state === 'running') {
            femoMaxTurnSeen.clear()
          }
        }
        // 角色占用增量（2026-08-31 角色窗圆环）：宿主子代理采样帧，last-wins 入表。
        if (msg.type === 'femo_actor_usage') actorUsageApply(msg.data ?? {})
        // 控制事件转发给单页宿主（script_changed 等）。
        if (controlHandlers.size > 0) {
          for (const h of [...controlHandlers]) {
            try { h(msg) } catch { /* 单个处理器异常不影响广播 */ }
          }
        }
      } catch {
        // 非 JSON SSE 行忽略
      }
    }
    return
  }
  if (!femoStreamWanted() && femoStreamEs !== undefined) {
    femoStreamEs.close()
    femoStreamEs = undefined
  }
}

function ensureVisibilityGate(): void {
  if (visibilityBound || typeof document === 'undefined') return
  visibilityBound = true
  document.addEventListener('visibilitychange', () => {
    pageVisible = document.visibilityState !== 'hidden'
    syncFemoStreamConnection()
  })
}

/** 控制事件订阅（editor-page 单页宿主用）：全局 SSE 收到的每条消息都会转发。 */
const controlHandlers = new Set<(msg: { type?: string; data?: Record<string, unknown> }) => void>()

export function subscribeControlEvents(h: (msg: { type?: string; data?: Record<string, unknown> }) => void): () => void {
  controlHandlers.add(h)
  return () => { controlHandlers.delete(h) }
}

/**
 * 获取一条 SSE 依赖（引用计数）。
 * @param opts.background - true = 后台池（编辑器）：tab 打开即持有、不看可见性；
 *   缺省 = 前台池：页面切后台自动断、切回自动重连。
 * @returns 释放函数（卸载时调用，恰好一次）。
 */
export function femoStreamAcquire(opts?: { background?: boolean }): () => void {
  ensureVisibilityGate()
  if (opts?.background === true) backgroundRefs += 1
  else foregroundRefs += 1
  syncFemoStreamConnection()
  return () => {
    if (opts?.background === true) backgroundRefs -= 1
    else foregroundRefs -= 1
    syncFemoStreamConnection()
  }
}

// ── 角色上下文占用（2026-08-31 角色窗圆环）────────────────────────────────
// 宿主 subagent.ts 从子代理会话事件流采样（request/context 分母 + provider
// usage 分子——该角色上一次发言时发给 API 的完整 prompt 实报 token 量），
// SSE femo_actor_usage 实时推送 + user_data/host-history/projections/actor-usage/<sid>.json 档案。
// key=消毒后的 actorKey（与投影窗 id 尾段同算法，前端从 sessionId 解析）。

export interface ActorUsage {
  provider: string
  model: string
  contextWindow: number
  usedTokens: number
  updatedAt: number
}

/** 主 sid → (actorKey → 最近一次演出占用)。内存缓存，SSE 增量 + GET 全量合并。 */
const actorUsages = new Map<string, Map<string, ActorUsage>>()
const actorUsageListeners = new Set<() => void>()

function actorUsageApply(d: Record<string, unknown>): void {
  const sid = typeof d.sid === 'string' ? d.sid : undefined
  const actorKey = typeof d.actorKey === 'string' ? d.actorKey : undefined
  if (sid === undefined || actorKey === undefined) return
  let byActor = actorUsages.get(sid)
  if (byActor === undefined) {
    byActor = new Map()
    actorUsages.set(sid, byActor)
  }
  byActor.set(actorKey, {
    provider: typeof d.provider === 'string' ? d.provider : '',
    model: typeof d.model === 'string' ? d.model : '',
    contextWindow: typeof d.contextWindow === 'number' && d.contextWindow > 0 ? d.contextWindow : 1_000_000,
    usedTokens: typeof d.usedTokens === 'number' ? d.usedTokens : 0,
    updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : Date.now(),
  })
  for (const l of [...actorUsageListeners]) {
    try { l() } catch { /* 单个订阅者异常不影响其他 */ }
  }
}

/**
 * 读某主会话某角色的最近一次演出占用（角色窗圆环数据源）。挂载期间维持
 * SSE 连接接收增量；首次另发一次 GET 全量拉取（SSE 断线/重启后宿主内存
 * 空时由宿主读档案文件兜底）。
 */
export function useActorUsage(mainSid: string | undefined, actorKey: string | undefined): ActorUsage | undefined {
  const [value, setValue] = useState<ActorUsage | undefined>(undefined)
  useEffect(() => {
    if (mainSid === undefined || actorKey === undefined) {
      setValue(undefined)
      return
    }
    let alive = true
    const read = (): void => { setValue(actorUsages.get(mainSid)?.get(actorKey)) }
    read()
    void fetch(`/dsh-femo/actor-usage?sessionId=${encodeURIComponent(mainSid)}`)
      .then(response => response.json() as Promise<{ ok?: boolean; actors?: Record<string, ActorUsage> }>)
      .then((data) => {
        if (!alive || data?.ok !== true || data.actors === undefined || typeof data.actors !== 'object') return
        let byActor = actorUsages.get(mainSid)
        if (byActor === undefined) {
          byActor = new Map()
          actorUsages.set(mainSid, byActor)
        }
        for (const [key, rec] of Object.entries(data.actors)) {
          if (rec !== null && typeof rec === 'object') byActor.set(key, rec)
        }
        read()
      })
      .catch(() => { /* 拉取失败静默：SSE 增量仍会到达 */ })
    const release = femoStreamAcquire()
    actorUsageListeners.add(read)
    return () => {
      alive = false
      actorUsageListeners.delete(read)
      release()
    }
  }, [mainSid, actorKey])
  return value
}

/** 直播位快照（块序列 + 在飞请求状态行）。 */
export interface FemoStreamState {
  readonly blocks: readonly FemoStreamBlock[]
  /** 该演员当前回合是否在飞（0.1.3 原生 turn_status 帧驱动；旧版恒 false）。 */
  readonly running: boolean
  /** 本回合首次请求的时刻（Deep diving 计时起点；不在飞时 null）。 */
  readonly since: number | null
}

/** React hook：读某主会话某一轮（turn）的完整直播位；挂载期间维持 SSE 连接
 *  并随帧刷新。【v8 轮次隔离】投影窗的直播节点一律用本 hook，用自己的轮号
 *  精确取桶——同一演员的其它轮永远不可能画到自己头上。turn 缺省=无轮次位
 *  （旧宿主帧/导演帧），退化为旧版"按演员"行为。 */
export function useFemoStreamForTurn(
  mainSid: string | undefined,
  actorKey: string | undefined,
  turn: number | undefined,
): FemoStreamState {
  const bucket = actorKey === undefined ? undefined : femoBucketKey(actorKey, turn)
  const [state, setState] = useState<FemoStreamState>(IDLE_FEMO_ENTRY)
  useEffect(() => {
    if (mainSid === undefined || bucket === undefined) return
    const read = (): void => { setState(femoStreamEntry(mainSid, bucket)) }
    read()
    const release = femoStreamAcquire()
    femoStreamListeners.add(read)
    return () => {
      femoStreamListeners.delete(read)
      release()
    }
  }, [mainSid, bucket])
  return state
}

/** React hook：读某主会话某演员**无轮次位**的直播（导演路径等旧调用面）。
 *  签名与 v8 之前完全一致：actorKey 现在映射到 `a<actorKey>` 位。 */
export function useFemoStreamState(mainSid: string | undefined, actorKey: string | undefined): FemoStreamState {
  const bucket = actorKey === undefined ? undefined : femoBucketKey(actorKey, undefined)
  const [state, setState] = useState<FemoStreamState>(IDLE_FEMO_ENTRY)
  useEffect(() => {
    if (mainSid === undefined || bucket === undefined) return
    const read = (): void => { setState(femoStreamEntry(mainSid, bucket)) }
    read()
    const release = femoStreamAcquire()
    femoStreamListeners.add(read)
    return () => {
      femoStreamListeners.delete(read)
      release()
    }
  }, [mainSid, bucket])
  return state
}

/** React hook：只取块序列（旧调用面）。 */
export function useFemoStream(mainSid: string | undefined, actorKey: string | undefined): readonly FemoStreamBlock[] {
  return useFemoStreamState(mainSid, actorKey).blocks
}
