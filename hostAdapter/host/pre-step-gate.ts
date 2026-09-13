/**
 * pre-step-gate.ts — agent/pre-step 门卫的裁决面（2026-09-11 自 engine-events
 * 抽出为纯函数：tests/pre-step-gate.test.mjs 用真 AgentLoop 直接驱动它回归）。
 *
 * 为什么必须按「轮」裁决，而不是按「步」：
 * dsh 的 agent/pre-step **每个 ReAct 步都跑一次**（agent.ts 的 turn 循环
 * `while (true) { await this.preStep(target, {turn, step}) ... }`），每步各自
 * `inbox.claim()`：
 *   - 轮首步（step=1）claim = 全部 next-step + 1 条 next-turn（那条用户消息）；
 *   - 之后各步（工具续跑所在步）claim = 只有 next-step，实测为空批次
 *     （dsh-agent-loop 自家 tests/interception.spec.ts 断言
 *     `[{turn:1,step:1,messages:1},{turn:1,step:2,messages:0}]`；工具结果本身
 *     是 `tool/result` 事件、`source.kind==='tool'`，只有工具给的
 *     additionalContexts 才进 next-step）。
 * 而 reject 的语义是「本批已 claim 的消息整批丢弃 + **整个 turn 以
 * reason=blocked 收场**」（`if (decision.kind === 'reject') { turnEnds =
 * {kind:'blocked'}; return false }`）。于是「运行中仅放行含真实用户输入的
 * 批次」这条判定一旦按步做，轮首步放行后的续跑步必被 reject —— 主模型在
 * 剧本运行中于主窗口说话时**只调得动一轮工具**（工具结果落盘了、模型再也
 * 拿不到，回合直接 blocked）。2026-09-11 用户实测症状即此。
 *
 * 裁决口径（2026-09-11 定稿）：
 *  ①后继步（step>1）不属于门卫裁决面：一轮既已开跑，归属就已定（轮首步
 *    判过），后继步只做演员噪音过滤、一律放行——工具续跑要的正是一个
 *    「不唤醒的空批次」，与主窗口原生聊天完全同构；
 *  ②轮首步（step=1）才裁决：
 *    - 整批演员噪音 → reject（不唤醒主模型、也不落盘）；
 *    - main 节点在飞（isMainAnswerPending）→ 放行（主模型在剧中说话的方式）；
 *    - 引擎未跑 → 放行（主窗口=原生聊天）；
 *    - 批次含真实用户输入（source.kind==='user'）→ 放行（主窗口任何时候=
 *      原生聊天：User 找主模型说话就是完整的一轮，含全部工具续跑步）；
 *    - 其余（运行中的 plugin 来源注入）→ reject（引擎拥有会话）。
 */

/** 门卫认的消息面：只用到 source（噪音判定；不依赖 dsh-session 类型，
 *  以便测试里塞纯字面量）。 */
export interface GateMessage {
  source?: { kind?: string; senderSessionId?: unknown }
}

/** 本步裁决结果（enter 的 messages 保持调用方泛型，原样回传）。 */
export type GateDecision<M extends GateMessage> =
  | { kind: 'enter'; messages: M[] }
  | { kind: 'reject' }

export interface GateFacts<M extends GateMessage> {
  /** 本步 claim 的原始批次（含演员噪音）。 */
  messages: readonly M[]
  /** 拟进入的步号（payload.step；1 = 轮首步）。 */
  step: number
  /** 本会话是否有在飞的 main 节点注入（isMainAnswerPending）。 */
  mainAnswerPending: boolean
  /** 本会话绑定的 Job 是否引擎活跃 Job（isSessionRunning）。 */
  running: boolean
  /** 日志用会话标识（宿主为 agent.session.id；日志行格式与抽出前逐字一致，
   *  既有日志 grep 口径不变）。 */
  tag: string
}

/** 演员子代理流出的「噪音消息」（不该进主模型上下文）：
 *  - subagent-settled：dsh 子代理运行时对常驻子代理自然收口的通告
 *    （每个节点跑完都会发一条，还会唤醒主模型）；
 *  - agent-message：子代理经 send_message 直接回父的消息。
 *  两者仅当 senderSessionId 属于本插件的常驻执行体（femo-actor- 前缀）时成立；
 *  用户自己拉的子代理与真实用户输入一律不受影响。 */
export function isActorChildNoise(message: GateMessage): boolean {
  const source = message.source
  if (source === undefined) return false
  if (source.kind !== 'subagent-settled' && source.kind !== 'agent-message') return false
  return typeof source.senderSessionId === 'string' && source.senderSessionId.startsWith('femo-actor-')
}

/** 轮首步裁决 + 后续步放行（口径见文件头）。 */
export function gatePreStep<M extends GateMessage>(facts: GateFacts<M>): GateDecision<M> {
  const { messages, mainAnswerPending, running, tag } = facts
  const who = typeof tag === 'string' && tag.length > 0 ? tag : '(unknown session)'
  // step 非正数/缺失（老宿主 payload 无该字段）保守当轮首步：宁可维持旧口径，
  // 也不凭空放开一个轮次未知的注入（门卫的安全网语义优先）。
  const step = Number.isFinite(facts.step) && facts.step > 0 ? facts.step : 1
  const admitted = messages.filter((message) => !isActorChildNoise(message))
  if (admitted.length !== messages.length) {
    console.log(`[dsh-femo] pre-step dropped ${messages.length - admitted.length} actor-child notice(s) for ${who}`)
    // 整批噪音且是轮首步：不唤醒主模型（旧行为逐字保留）。后继步绝不可走
    // 这里——噪音恰好落在完轮后的补步上时，reject 会把 completed 改判 blocked。
    if (admitted.length === 0 && step === 1) return { kind: 'reject' }
  }
  // ①后继步：只过滤噪音，不裁决（reject = 整轮 blocked，主模型只能调一轮工具）。
  if (step > 1) return { kind: 'enter', messages: admitted }
  // ②轮首步：
  if (mainAnswerPending) return { kind: 'enter', messages: admitted }
  if (!running) return { kind: 'enter', messages: admitted }
  if (admitted.some((message) => message.source?.kind === 'user')) return { kind: 'enter', messages: admitted }
  console.log(`[dsh-femo] pre-step REJECTED for running femo agent ${who} (engine owns the conversation)`)
  return { kind: 'reject' }
}
