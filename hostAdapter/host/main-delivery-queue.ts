/**
 * main-delivery-queue.ts — 戏内 main 节点注入的「等本轮收口」队列（2026-09-11）。
 *
 * 语义（用户拍板）：**戏内戏外不掺一轮**。主模型正在主窗口跟用户对话（可能
 * 多步调工具、一轮还没结束）时，剧本走到 main 节点、轮到主模型下场——这条
 * 注入不能插进用户那一轮（dsh 的 steer 会在下一个 step 边界被消费，用户那轮
 * 里就混进了戏内通知，回答还会被当成主模型"下场"交卷给引擎）。正确做法：
 * 等该轮彻底结束，再把它作为**新一轮的开头**交付。
 *
 * 判定源 = 主会话轮开闭（mainSessionEventHook 的 turn/start / turn/end）：
 *  · 没有轮在飞 → 立即交付（现状不变——剧本跑本时主模型通常空闲）；
 *  · 有轮在飞 → 排队；该轮 turn/end 时交付队首一条（多节点排队一次一条，
 *    每节点各占一轮：前一节点的回答交卷、下一轮才开始）。
 *
 * 「下一个节点的开始」这个信号就是 `ai_request(source=main)` 的注入时点
 * （engine-events → runMainModelTurn）。同一节点的**重试**（引擎 node_retry →
 * node-retry broker 租约 steer）也是交付件，但语义上不是新节点：沿用同一
 * waitKey/节点身份，交付后照旧 park 等下一次裁决——排队只推迟交付时点，不改
 * 节点边界（重试循环完整）。为什么重试也排队：若重试 steer 落进用户那轮，
 * 捕获面 `sawTurnStart` 永假（该轮早已开轮）——那次重试既污染用户回合、
 * 又交不上卷（park 15min 超时收场）。
 *
 * DSH 侧 API 错误重试（api-retry 的 agent/request-error 瀑布 → `{kind:'retry'}`
 * = 同 turn 同 step 原地重跑）根本不走注入面，天然不受本队列影响。
 *
 * 纯状态机（无 ctx / 无 agent 依赖）——tests/main-delivery-queue.test.mjs 直接驱动。
 */

export class MainDeliveryQueue<T> {
  /** 主会话最近一次 turn/start 记下的轮号（有轮在飞；turn/end 删条目）。 */
  private readonly open = new Map<string, number>()
  /** 排队中的交付件（FIFO，按会话）。 */
  private readonly queued = new Map<string, T[]>()

  /** turn/start：本会话有轮在飞。 */
  noteTurnStart(sid: string, turn: number): void {
    this.open.set(sid, turn)
  }

  /** turn/end：轮收口（此后交付立即放行，直到下一次 turn/start）。 */
  noteTurnEnd(sid: string): void {
    this.open.delete(sid)
  }

  /** 在飞轮号（无 → undefined；日志/诊断用）。 */
  openTurn(sid: string): number | undefined {
    return this.open.get(sid)
  }

  /** 排队条数。 */
  queuedCount(sid: string): number {
    return this.queued.get(sid)?.length ?? 0
  }

  /** 投递一条交付件：true = 立即交付（无轮在飞），false = 已排队等本轮收口。 */
  offer(sid: string, item: T): boolean {
    if (this.open.get(sid) === undefined) return true
    let q = this.queued.get(sid)
    if (q === undefined) {
      q = []
      this.queued.set(sid, q)
    }
    q.push(item)
    return false
  }

  /** 队首只读（交付前窥视：等待期间被 drop/abandon 作废 → 自然不再交付）。 */
  peek(sid: string): T | undefined {
    return this.queued.get(sid)?.[0]
  }

  /** 轮收口：取队首一条（无 → undefined）。一次只放一条——每节点各占一轮。 */
  takeNext(sid: string): T | undefined {
    const q = this.queued.get(sid)
    if (q === undefined || q.length === 0) return undefined
    const next = q.shift()!
    if (q.length === 0) this.queued.delete(sid)
    return next
  }

  /** 作废本会话排队件（剧本停止/出错）：返回被丢弃条目——调用方负责 resolve
   *  其交卷槽，防 runMainModelTurnInner 悬挂在 `await answer`。轮开闭状态**不动**
   *  （用户可能还在说话；下一次 turn/start 自会刷新）。 */
  dropAll(sid: string): T[] {
    const q = this.queued.get(sid)
    this.queued.delete(sid)
    return q ?? []
  }

  /** 按条件剔除排队件（节点收尾兜底：等它的那个人已经走了——停靠超时/异常
   *  收场后再交付=对空气说话，还会拿旧 wait_key 去交卷）。返回被剔除条目。 */
  dropWhere(sid: string, match: (item: T) => boolean): T[] {
    const q = this.queued.get(sid)
    if (q === undefined || q.length === 0) return []
    const kept: T[] = []
    const dropped: T[] = []
    for (const item of q) (match(item) ? dropped : kept).push(item)
    if (kept.length === 0) this.queued.delete(sid)
    else this.queued.set(sid, kept)
    return dropped
  }

  /** 彻底遗忘本会话（换场 flow_start / 插件卸载）：队列 + 轮开闭状态全清。 */
  forget(sid: string): T[] {
    const dropped = this.dropAll(sid)
    this.open.delete(sid)
    return dropped
  }

  /** 全清（HMR/插件卸载）。 */
  clear(): void {
    this.queued.clear()
    this.open.clear()
  }
}
