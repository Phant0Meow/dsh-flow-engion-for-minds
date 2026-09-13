/**
 * safe-steer.ts — agent.steer 的统一兜底（2026-09-10）。
 *
 * 背景：dsh 0.1.5 起 agent 的 inbox 从**内存对象**改成 **session projection**——
 * 0.1.1 的 `Inbox` 在 agent 构造函数里 `new Inbox(session, …)`，永不抛；0.1.5 换成
 * ReactLoopInbox，`current()` 读 `projections.stateOf(session, 'inbox')`，读不到就
 * 直接抛 `cannot read inbox state: its projection registration is not active`。
 * 对"进程内挂着但投影未激活"的会话（冷恢复期/未被 GUI 进入的窗口）steer 就会抛，
 * 而 femo 的 steer 调用点分布在引擎事件回调、停靠经纪人、子代理闭包里——任一处
 * 未捕获都会顺着调用栈往上炸（femo 装了 process 级 uncaughtException 所以进程不死，
 * 但那一次投递静默失败、上层流程卡住；meow-memory 的同类问题直接把宿主进程带走过）。
 *
 * 语义：true = 投递成功；false = 没有可用的 steer 方法，或投递抛错（已记日志）。
 * 调用方按业务决定降级路径（子代理落官方 sendMessage 面、停靠经纪人只记日志不空转）。
 * 该兜底对旧版本零影响（0.1.1 的 steer 永不抛），因此不需要按版本号分支。
 *
 * @param target - 持有 steer 的 agent / 租约对象。
 * @param message - 交给 steer 的消息对象。
 * @param tag - 日志用来源标识（如 `child femo-xxx`、`lease wk-1`）。
 * @returns 是否投递成功。
 */
export function safeSteer(target: unknown, message: unknown, tag: string): boolean {
  const steer = (target as { steer?: (m: unknown) => void } | undefined)?.steer
  if (typeof steer !== 'function') return false
  try {
    steer.call(target, message)
    return true
  } catch (error: unknown) {
    const text = error instanceof Error ? error.message : String(error)
    console.log(`[dsh-femo] steer failed (${tag}): ${text}`)
    return false
  }
}
