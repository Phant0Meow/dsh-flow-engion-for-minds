// 双兼容会话事件读取（2026-09-04，DSH 0.1.2-rc.1 接入）。
// 背景：rc.1 起 Session 的 events 数组属性被移除，替代 API =
//   snapshotEvents(from?, to?)——全量日志（含 fork 继承前缀），内部缓存快照；
//   ownEvents()——排除 fork 继承前缀的子会话自有段。
// rc.2（0.1.1-rc.2）及更早只有 events 属性。
// femo 的全部读点（主会话水位补齐/去重索引/preset 回放/子代理轨迹转写）
// 语义上都要全量日志，统一走本 helper：snapshotEvents() 优先，events 兜底，
// 两者皆缺时返回空数组（fail-closed 不崩，与旧 events 缺失行为对齐）。

export interface FemoSessionEventLike {
  type: string
  seq: unknown
  data: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Read the full event log of a Session across dsh 0.1.1-rc.2 / 0.1.2-rc.1.
 * @param session - Session-like object (live, prepared, or subagent-local).
 * @returns frozen readonly array of events (never undefined).
 */
export function readSessionEvents(session: unknown): readonly FemoSessionEventLike[] {
  const s = session as {
    snapshotEvents?: () => readonly unknown[]
    events?: readonly unknown[]
  }
  try {
    if (typeof s.snapshotEvents === 'function') {
      return s.snapshotEvents() as readonly FemoSessionEventLike[]
    }
  } catch (error: unknown) {
    // snapshotEvents 抛错时退回属性探测：宁可空数组也不让水位/索引链路崩
    console.log(`[dsh-femo] readSessionEvents snapshotEvents() failed: ${String(error)}`)
  }
  return (s.events ?? []) as readonly FemoSessionEventLike[]
}

/**
 * Event count helper for diagnostics that only need the length.
 * @param session - Session-like object.
 * @returns number of events in the full log.
 */
export function readSessionEventCount(session: unknown): number {
  return readSessionEvents(session).length
}
