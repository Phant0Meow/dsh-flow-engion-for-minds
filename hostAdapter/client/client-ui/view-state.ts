/**
 * client-ui/view-state.ts — 视角状态 store（per session）。
 *
 * 'god' shows everything; `@actor` filters chat lines to what that actor's
 * scope can see. Module-level per-session store + tiny subscribe, so both the
 * header button and the chat-line renderer share one source of truth.
 * （2026-08-26 结构整理自 client.tsx 原样迁出，行为零变化；
 * 新增只读访问器 getView——view-button 的「当前视角」推导直接读表用，
 * 纯封装等价于原 viewBySession.get。）
 */

import { useEffect, useState } from 'react'

const viewBySession = new Map<string, string>()
const viewListeners = new Map<string, Set<() => void>>()

function currentView(sessionId: string | undefined): string {
  if (sessionId === undefined) return 'god'
  const stored = viewBySession.get(sessionId)
  if (stored !== undefined) return stored
  // 默认视图：投影窗=femo-proj- 前缀）=上帝视角全显；主会话=戏外（纯 DSH
  // 原生 user+主模型页面，femo 行全隐藏——含旧版本写进主会话的历史残留行）。
  return sessionId.startsWith('femo-proj-') ? 'god' : 'offstage'
}

/** 只读访问器：查某会话已存储的视角（无记录返回 undefined，与 useView 默认推导分离）。 */
export function getView(sessionId: string): string | undefined {
  return viewBySession.get(sessionId)
}

export function setView(sessionId: string, view: string): void {
  viewBySession.set(sessionId, view)
  const listeners = viewListeners.get(sessionId)
  if (listeners === undefined) return
  for (const listener of listeners) listener()
}

function subscribeView(sessionId: string | undefined, listener: () => void): () => void {
  if (sessionId === undefined) return () => {}
  let listeners = viewListeners.get(sessionId)
  if (listeners === undefined) {
    listeners = new Set()
    viewListeners.set(sessionId, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) viewListeners.delete(sessionId)
  }
}

/** React hook: the session's current view, re-rendering on switches. */
export function useView(sessionId: string | undefined): string {
  const [view, setLocal] = useState(currentView(sessionId))
  useEffect(() => {
    if (sessionId === undefined) return
    setLocal(currentView(sessionId))
    return subscribeView(sessionId, () => setLocal(currentView(sessionId)))
  }, [sessionId])
  return view
}
