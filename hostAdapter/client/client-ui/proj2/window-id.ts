/**
 * client-ui/proj2/window-id.ts — 投影窗 id 解析（一处分身，处处同源）。
 *
 * 窗 id 规则（宿主 projection.ts projectionId）：`femo-proj-<主会话id>-<actorKey>`，
 * actorKey 不含 '-'（非 [A-Za-z0-9_-] 字符编码成 _<hex>），故末段必属 actorKey。
 * 旧链路里这段推导在 chat-node / turn-nodes / director-node 各写了一遍，v9 收在一处。
 */

export interface ProjectionWindow {
  /** 主会话 id（SSE 帧的 sid 就是它）。 */
  readonly mainSid?: string
  /** 窗身份段：god / stage / <角色 actorKey>。 */
  readonly winActorKey?: string
}

export function projectionWindowOf(sessionId: string | undefined): ProjectionWindow {
  if (sessionId === undefined || !sessionId.startsWith('femo-proj-')) return {}
  const suffix = sessionId.slice('femo-proj-'.length)
  const cut = suffix.lastIndexOf('-')
  if (cut <= 0) return {}
  return { mainSid: suffix.slice(0, cut), winActorKey: suffix.slice(cut + 1) }
}

/** 本窗是否该渲染该角色的轮（god/stage 全显；角色窗只认自己的 actorKey）。 */
export function windowShowsActor(winActorKey: string | undefined, actorKey: string): boolean {
  if (winActorKey === undefined) return false
  return winActorKey === 'god' || winActorKey === 'stage' || winActorKey === actorKey
}
