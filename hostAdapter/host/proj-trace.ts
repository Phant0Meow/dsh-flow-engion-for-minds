/**
 * proj-trace.ts — 投影窗诊断埋点（2026-09-11 并发乱序排查专用，临时件）。
 *
 * 全部落点复用既有 diag-feed 三路（内存环形 + SSE femo_diag + debug-diag-feed.log），
 * 右上角 log 窗直接可看、事后可 grep 文件。
 *
 * 摘除方式：删掉本文件 + 全局 grep `projTrace(` 删除调用点即可，无残留状态。
 */

import { pushDiag } from './diag-feed'

let enabled = true

/** 全局开关（排查结束后可置 false 静默，不必删调用点）。 */
export function setProjTraceEnabled(on: boolean): void {
  enabled = on
}

export function projTrace(tag: string, msg: string): void {
  if (!enabled) return
  try {
    pushDiag(tag, msg)
  } catch {
    /* 观测绝不反噬主路 */
  }
}

/** 紧凑事件描摹：只取关心的键，tool/大文本截断。 */
export function brief(data: Record<string, unknown> | undefined, max = 60): string {
  if (data === undefined) return '-'
  const parts: string[] = []
  for (const key of ['turn', 'step', 'kind', 'actor', 'seq', 'reason', '_srcSeq']) {
    const v = data[key]
    if (v === undefined) continue
    if (key === 'reason' && typeof v === 'object' && v !== null) {
      parts.push(`reason=${String((v as { kind?: unknown }).kind ?? '?')}`)
      continue
    }
    parts.push(`${key}=${typeof v === 'string' ? v.slice(0, 24) : String(v)}`)
  }
  const text = data.text
  if (typeof text === 'string' && text.length > 0) parts.push(`text=${JSON.stringify(text.slice(0, max))}`)
  return parts.join(' ')
}

/** 轮号可读化：演员轮是大时间戳，取末 4 位便于肉眼比对。 */
export function t4(turn: unknown): string {
  return typeof turn === 'number' ? `…${String(turn).slice(-4)}` : String(turn)
}
