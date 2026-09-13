/**
 * femo-reasoning-row.tsx — 官方 ReasoningRow 的 fork（2026-08-24 投影窗流式
 * 方案B）。官方组件是 ui-conversation 内部实现、无公共导出；本 fork 复用其
 * 观感与行为，底层件 DisclosureRow / IconThinkOutline14 全部来自基线库
 * ui-primitives（shell 同一实例），文字渲染同款。差异只有两处：
 *  ①样式不走 css module（构建链不注入），由 client.tsx 注入的同名规则表
 *    （.femo-rr-* 前缀）承载——rc 升级时需对照官方 ReasoningRow.module.css
 *    重放本文件与那份规则表；
 * ②locale 简化为 runningLabel 字符串 prop（官方只用到 t('row.running')）。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { DisclosureRow, IconThinkOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'

/** Frame-throttled scheduling for non-essential visual alignment.
 * （官方 use-throttled-visual-update.ts 原样拷贝。） */
function useThrottledVisualUpdate(update: () => void, intervalFrames = 3): () => void {
  const updateRef = useRef(update)
  updateRef.current = update
  const pendingFrameRef = useRef<number | null>(null)

  useLayoutEffect(() => () => {
    if (pendingFrameRef.current === null) return
    cancelAnimationFrame(pendingFrameRef.current)
    pendingFrameRef.current = null
  }, [])

  return useCallback(() => {
    if (pendingFrameRef.current !== null) return
    let remainingFrames = intervalFrames
    const advance = (): void => {
      remainingFrames -= 1
      if (remainingFrames > 0) {
        pendingFrameRef.current = requestAnimationFrame(advance)
        return
      }
      pendingFrameRef.current = null
      updateRef.current()
    }
    pendingFrameRef.current = requestAnimationFrame(advance)
  }, [intervalFrames])
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

function latestLine(text: string): string {
  const visible = text.trimEnd()
  const newline = visible.lastIndexOf('\n')
  return newline === -1 ? visible : visible.slice(newline + 1)
}

/**
 * Render one assistant reasoning block as the Think disclosure row.
 * @param props.text - complete or streaming reasoning text.
 * @param props.running - whether this block is the streaming tail.
 * @param props.runningLabel - conversation locale t('row.running') 文案。
 */
export function FemoReasoningRow({ text, running, runningLabel }: {
  text: string
  running: boolean
  runningLabel: string
}) {
  const [expanded, setExpanded] = useState(false)
  const summaryRef = useRef<HTMLSpanElement>(null)
  const summary = running ? latestLine(text) : firstLine(text)
  const scheduleSummaryScroll = useThrottledVisualUpdate(() => {
    const element = summaryRef.current
    if (element === null) return
    element.scrollLeft = running ? element.scrollWidth - element.clientWidth : 0
  })
  useEffect(() => {
    scheduleSummaryScroll()
  }, [running, scheduleSummaryScroll, summary])

  return (
    <div className="femo-rr-root" data-variant="think" data-state={running ? 'running' : 'ok'}>
      {running && <span className="femo-a11y-hidden">{runningLabel}</span>}
      <DisclosureRow
        rowClassName="femo-rr-row"
        leadingClassName="femo-rr-leading"
        titleClassName="femo-rr-title"
        chevronClassName="femo-rr-chevron"
        icon={<IconThinkOutline14 size={14} />}
        title="Think"
        open={expanded}
        expandable
        expandOnRowClick
        onToggle={() => { setExpanded(value => !value) }}
        collapsedContent={(
          <>
            <span className="femo-rr-separator" aria-hidden />
            <span ref={summaryRef} className="femo-rr-summary" data-follow-end={running || undefined}>{summary}</span>
          </>
        )}
      >
        <div className="femo-rr-think-body">{text}</div>
      </DisclosureRow>
    </div>
  )
}
