/**
 * client-ui/proj2/ledger.ts — 轮台账（投影窗显示层 v9 的唯一身份判据）。
 *
 * 【为什么要有这个文件】v5/v6/v7 四代渲染链路各自带一套"这块属于谁"的判据
 * （isNewestTurnStream / lastHostKeys / 桶空不空 / directorAnchors），谁先谁后
 * 一变画面就变样——"每次跑表现都不一样"的结构性病因。v9 的边界是：
 *
 *   一轮的身份 = 宿主写下的开轮锚点 `dsh-femo/chat{kind:'live', turn, actor}`
 *   的事件 seq（= 激活时间 = 排序键）。前端不做任何"谁最新/桶空不空/landed"
 *   推断：归属只看 turn（键），排序只看 orderSeq。
 *
 * 本文件是这套判据的**唯一实现**：头节点（femo2-turn）与直播尾节点
 * （femo2-turn-live）共用同一份 match/start/update/锚公式，于是"谁画这一轮"
 * 只有一个答案、不可能两处各画一份。
 *
 * 【start 的唯一性（装配器硬约束）】dsh 装配器对同一 context 的第二条 start
 * 直接抛错（acceptMatch: "received more than one start Match"），且 update 不得
 * 先于 start。故本台账只认**每轮恰好一条**的 kind='live' 开轮锚为 start，
 * 其余（speaker/prompt/error/turn/start/turn/end/内容事件）一律 update——同一
 * baseTurn 会有多条 turn/start（多个子 turn 映射到同一轮），它们绝不能再当
 * start。
 *
 * 【步1 范围】只接管 AI 演员轮；'human' / 'main' 两类轮的接入见步3（同池排序
 * 已在本文件的 kind/orderSeq 里预留）。
 */

import type { ConversationMatch, ConversationNodeContext } from '@deepseek-ai/dsh-client-runtime/client'

/** 轮的类别：三类轮同池排序（激活时间），渲染外观不同。 */
export type Femo2TurnKind = 'ai' | 'human' | 'main'

/** 一轮的全部前端状态（唯一数据源；头/尾两个渲染位共用）。 */
export interface Femo2TurnState {
  /** 轮号（宿主 baseTurn；本窗内唯一标识一轮）。 */
  readonly turn: number
  /** 角色显示名（开轮锚点带来）。 */
  readonly actor: string
  readonly kind: Femo2TurnKind
  /** 开轮锚点事件 seq = 激活时间；**排序键（唯一权威）**。 */
  readonly orderSeq: number
  /** AI 节点的 showprompt 旁白（📢 条；开轮锚点已带，流式期即可显示）。 */
  readonly showprompt?: string
  /** 本回合失败信息（带 turn 的 error 行）。 */
  readonly error?: string
  /** 本轮回合已收口（turn/end 到达）→ 直播尾永久隐藏。 */
  readonly landed: boolean
  /** 轮内首个已落地事件 seq（turn/start 也算）→ "本段已落盘"的硬信号（直播尾退场用）。 */
  readonly firstBodySeq?: number
  /** 轮内首个**非骨架**内容事件 seq（step/*、assistant/*、tool/*；不含 turn/start）
   *  —— "空轮"判据：只有骨架没有它 = 纯自动开合的空回合，名字行永不露面（v9.4）。 */
  readonly firstContentSeq?: number
  /** 轮内首个**回答类**事件 seq（assistant/message、step/start…；不含 turn/start 与 user/message）
   *  —— 主 Agent 轮的头锚贴在这里，跳过轮首的 user 消息（见 femo2TurnHeadAnchor）。 */
  readonly firstAnswerSeq?: number
  /** 轮内末个已落地事件 seq（诊断用）。 */
  readonly lastBodySeq?: number
  /** 本行可见的角色名（action scope）；缺失=全员可见。 */
  readonly visible?: readonly string[]
}

/** 归约后的事件形态（null = 与本台账无关，不属于任何一轮）。 */
export interface Femo2TurnEvent {
  readonly turn: number
  /** start 只给开轮锚点（kind='live'），每轮恰好一条。 */
  readonly role: 'start' | 'update'
  readonly actor?: string
  /** 开轮锚点的主 Agent 标记（god 窗的主会话轮）。 */
  readonly main?: boolean
  /** 开轮锚点的戏内下场标记（main:true 且非导演——god 窗的主模型下场轮、
   *  stage/角色窗的下场锚）。定位走演员轮公式，与戏外主会话轮分开。 */
  readonly scene?: boolean
  readonly showprompt?: string
  readonly error?: string
  readonly visible?: readonly string[]
  /** 事件是否计入"已落地"（头锚依据）：骨架/内容事件。 */
  readonly bodySeq?: number
  /** 该事件是否为非骨架内容（空轮判据；turn/start 不算内容）。 */
  readonly content?: boolean
  /** 该事件是否属"回答类"（判定主 Agent 轮名字行的落点用）。 */
  readonly answer?: boolean
  /** 回合收口（turn/end）。 */
  readonly end?: boolean
}

/** 落盘后由官方渲染器画成"身"的骨架/内容事件（带 turn 字段）。 */
const BODY_EVENT_TYPES = new Set([
  'turn/start',
  'step/start', 'step/end',
  'assistant/message', 'assistant/chunk',
  'tool/call', 'tool/result',
])

/** "回答类"事件：主 Agent 的名字行要贴在这类事件的第一个之前。
 *
 * 【2026-09-11 实测修正·第二版】只认 **assistant/message / assistant/chunk**——
 * 不能含 step/start、tool/*。原因：上帝窗里 `user/message` 的镜像是**后写**的
 * （实测 seq：锚2397 → turn/start2398 → step/start2399 → **user/message2400**
 * → assistant/message2401），而官方把 assistant 内容渲染在 2401 那个位置。
 * 用 step/start 算锚（2398.5）会落到用户消息(2400)前面 ⇒ 症状"导演名字行在
 * 用户气泡上面"；改用 assistant/message 算（2400.5）即得正确顺序：
 * 你的消息 → 导演 → 我的回复。演员轮轮内没有 user 消息，仍按最早落地事件贴。 */
const ANSWER_EVENT_TYPES = new Set([
  'assistant/message', 'assistant/chunk',
])

function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>
}

function turnOf(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function strOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function visibleOf(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value.filter((item): item is string => typeof item === 'string')
  return list.length === 0 ? undefined : list
}

/**
 * 事件 → 轮身份（唯一入口）。认得的形态：
 *  - `dsh-femo/chat{kind:'live', turn}` —— **开轮锚点**（start，每轮一条）
 *  - `dsh-femo/chat{kind:'speaker'|'prompt'|'error', turn}` —— 轮内归属行
 *  - `turn/start|step/*|assistant/*|tool/*`（带 turn）—— 落盘骨架/内容
 *  - `turn/end{turn}` —— 回合收口
 * 其余（notice/sys/human_wait/role 行、无 turn 的旧行、主会话镜像的无轮事件）不认。
 */
export function femo2TurnEventOf(event: ConversationMatch['event']): Femo2TurnEvent | null {
  const type = event.type
  if (type === 'dsh-femo/chat') {
    const d = asRecord(event.data)
    const turn = turnOf(d.turn)
    if (turn === undefined) return null
    const visible = visibleOf(d.visible)
    if (d.kind === 'live') {
      return {
        turn,
        role: 'start',
        ...strOf(d.actor) !== undefined ? { actor: strOf(d.actor)! } : {},
        ...strOf(d.showprompt) !== undefined ? { showprompt: strOf(d.showprompt)! } : {},
        ...d.main === true ? { main: true } : {},
        ...d.scene === true ? { scene: true } : {},
        ...visible !== undefined ? { visible } : {},
      }
    }
    if (d.kind === 'speaker') {
      return {
        turn,
        role: 'update',
        ...strOf(d.actor) !== undefined ? { actor: strOf(d.actor)! } : {},
        ...visible !== undefined ? { visible } : {},
      }
    }
    if (d.kind === 'prompt') {
      return {
        turn,
        role: 'update',
        ...strOf(d.text) !== undefined ? { showprompt: strOf(d.text)! } : {},
      }
    }
    if (d.kind === 'error') {
      return {
        turn,
        role: 'update',
        ...strOf(d.text) !== undefined ? { error: strOf(d.text)! } : {},
      }
    }
    return null
  }
  if (type === 'turn/end') {
    const turn = turnOf(asRecord(event.data).turn)
    return turn === undefined ? null : { turn, role: 'update', end: true }
  }
  if (BODY_EVENT_TYPES.has(type)) {
    const turn = turnOf(asRecord(event.data).turn)
    if (turn === undefined) return null
    return {
      turn,
      role: 'update',
      bodySeq: event.seq,
      ...type !== 'turn/start' ? { content: true } : {},
      ...ANSWER_EVENT_TYPES.has(type) ? { answer: true } : {},
    }
  }
  return null
}

/** definition 的 match：两个渲染位共用（同一轮 → 同一 id，两个 kind 各一个 context）。 */
export function femo2TurnMatch(event: ConversationMatch['event']): { id: string; role: 'start' | 'update' } | null {
  const shape = femo2TurnEventOf(event)
  if (shape === null) return null
  return { id: String(shape.turn), role: shape.role }
}

/** start（只在开轮锚点上调用）：本轮的身份证。 */
export function femo2TurnStart(match: ConversationMatch): Femo2TurnState {
  const shape = femo2TurnEventOf(match.event)
  return {
    turn: shape?.turn ?? 0,
    actor: shape?.actor ?? '',
    // 开轮锚点带 main 标记 ⇒ 主 Agent 轮（god 窗的主会话轮）；否则 AI 演员轮。
    kind: shape?.main === true ? 'main' : 'ai',
    orderSeq: match.event.seq,
    landed: false,
    ...shape?.showprompt !== undefined ? { showprompt: shape.showprompt } : {},
    ...shape?.scene === true ? { scene: true } : {},
    ...shape?.visible !== undefined ? { visible: shape.visible } : {},
  }
}

/** update：轮内一切后续事件归约进同一份状态（纯函数，无外部推断）。 */
export function femo2TurnUpdate(
  context: ConversationNodeContext<Femo2TurnState>,
  match: ConversationMatch,
): Femo2TurnState {
  const prev = context.state
  // 无 start 的轮（异常/旧数据）：状态建不起来，直接不产节点（安全降级）。
  if (prev === undefined) return femo2TurnStart(match)
  const shape = femo2TurnEventOf(match.event)
  if (shape === null) return prev
  let next = prev
  if (shape.actor !== undefined && shape.actor !== prev.actor) next = { ...next, actor: shape.actor }
  if (shape.showprompt !== undefined && shape.showprompt !== prev.showprompt) next = { ...next, showprompt: shape.showprompt }
  if (shape.error !== undefined && shape.error !== prev.error) next = { ...next, error: shape.error }
  if (shape.visible !== undefined && prev.visible === undefined) next = { ...next, visible: shape.visible }
  if (shape.bodySeq !== undefined) {
    const first = prev.firstBodySeq === undefined ? shape.bodySeq : Math.min(prev.firstBodySeq, shape.bodySeq)
    const last = prev.lastBodySeq === undefined ? shape.bodySeq : Math.max(prev.lastBodySeq, shape.bodySeq)
    if (first !== prev.firstBodySeq || last !== prev.lastBodySeq) {
      next = { ...next, firstBodySeq: first, lastBodySeq: last }
    }
  }
  // 非骨架内容的首个 seq（空轮判据：turn/start 不算内容，v9.4）。
  if (shape.content === true) {
    const fc = prev.firstContentSeq === undefined ? match.event.seq : Math.min(prev.firstContentSeq, match.event.seq)
    if (fc !== prev.firstContentSeq) next = { ...next, firstContentSeq: fc }
  }
  // 回答类事件的首个 seq（主 Agent 轮里 user 消息在轮首，名字行要跳过它）。
  if (shape.answer === true) {
    const ans = prev.firstAnswerSeq === undefined ? match.event.seq : Math.min(prev.firstAnswerSeq, match.event.seq)
    if (ans !== prev.firstAnswerSeq) next = { ...next, firstAnswerSeq: ans }
  }
  if (shape.end === true && !prev.landed) {
    next = { ...next, landed: true }
    // 【诊断】turn/end 有没有真的喂进本 context（"直播尾赖着不走"就靠这条判定：
    // 是事件没到，还是渲染判据错）。
  }
  return next
}

/**
 * 头锚：本轮已落地内容的首个事件 seq − 0.5（恒在本段所有官方节点之前）。
 *
 * 【v9.4 2026-09-11 Job 2945 用户拍板：戏内 / 戏外分开定位】
 *  · 戏内下场轮（scene:true，main:true 且非导演）→ **演员轮公式贴段首**
 *    （firstBody −0.5）。god 窗实测：锚在开场 user 消息之前的节点会被官方
 *    turn-process 呈现逻辑提升到"用户气泡之后、思考/工具过程行之前"
 *    （openingHumanAnchor 提升，rank2 按原始锚点稳定排序）——正是想要的
 *    「上场注入 → @戏内名 → 已思考 → 回答」。
 *  · 戏外主会话轮 → 保持 v9.2 已验收公式（首个回答 −0.5），一字不动：
 *    物理顺序是 锚→turn/start→step/start→user→assistant，用 step/start 算锚
 *    会把名字顶到用户气泡上面（v9.2 已修过的坑，别退回去）。
 *  · AI 演员轮轮内没有 user 消息，仍按最早落地事件贴。
 * 流式期（本段还没落盘）→ orderSeq + 0.5（贴窗底、在直播尾之前）。
 */
export function femo2TurnHeadAnchor(context: ConversationNodeContext<Femo2TurnState>): number {
  const state = context.state
  if (state === undefined) return 0
  if (state.kind === 'main' && state.scene === true) {
    if (state.firstBodySeq !== undefined) return state.firstBodySeq - 0.5
    return state.orderSeq + 0.5
  }
  if (state.kind === 'main' && state.firstAnswerSeq !== undefined) return state.firstAnswerSeq - 0.5
  if (state.firstBodySeq !== undefined) return state.firstBodySeq - 0.5
  return state.orderSeq + 0.5
}

/**
 * 直播尾锚：1e12 + orderSeq —— 恒在窗内一切已落盘内容之后，且多名并发演员
 * 按**激活顺序**（开轮锚点 seq）排列，互不穿插。
 */
export function femo2TurnLiveAnchor(context: ConversationNodeContext<Femo2TurnState>): number {
  const state = context.state
  if (state === undefined) return 1e12
  return 1e12 + state.orderSeq
}

/** 头节点是否该露面：本段已落盘（有骨架/内容事件）或已收口（空回合也要有名字）。
 *  主会话轮等"回答"落地——否则名字行会在用户消息旁空转。 */
export function femo2TurnHeadVisible(state: Femo2TurnState | undefined): boolean {
  if (state === undefined) return false
  if (state.kind === 'main') {
    // 【v9.4 Job 2945】已收口但连一个非骨架内容事件都没有 = 自动开合的空轮
    // （实测 turn=2：turn/start 与 turn/end 之间什么都没有）——名字行永不露面，
    // 否则就是"剧本已开始后多出来的孤立导演行"。landed 兜底保留给
    // "有内容但无 assistant/message"的轮（纯工具轮）。
    return state.firstAnswerSeq !== undefined || (state.landed && state.firstContentSeq !== undefined)
  }
  return state.firstBodySeq !== undefined || state.landed
}

/**
 * 直播尾是否还该露面：**本段一旦开始落盘就让位**（firstBodySeq 是宿主整段落盘
 * 的确定信号），不只看 turn/end。
 *
 * 【2026-09-11 实跑修正】Job 787 实测：闭轮帧到了、头节点也出现了，直播尾却还
 * 挂着一条空名字行 25 秒才消失（同一轮名字出现两次）。原因是 turn/end 是否被
 * 装配器喂进 context 取决于投递链路（同一批帧实测会被重投一次；装配器对
 * "非递增 seq"直接抛错，抛错即该轮 update 断流）——**不能再让渲染位的生死
 * 依赖某一条事件**。改用"本段已落盘"这个更早、更硬的信号：段落落盘是宿主
 * 闸门整段写的（turn/start 起、turn/end 收），turn/start 一到，官方区块已在
 * 窗内就位、轮头也已接棒，直播尾必须当场退场。
 */
export function femo2TurnLiveVisible(state: Femo2TurnState | undefined): boolean {
  if (state === undefined) return false
  if (state.landed) return false
  return state.firstBodySeq === undefined
}

/** 本轮在给定视角下是否可见（scope 过滤；visible 缺失=全员可见）。 */
export function femo2TurnVisibleTo(view: string, visible: readonly string[] | undefined): boolean {
  if (view === 'god') return true
  if (visible === undefined) return true
  return visible.includes(view)
}
