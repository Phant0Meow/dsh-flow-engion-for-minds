/**
 * client-ui/femo-stream-live.tsx — 直播块渲染件 + Deep diving 状态行。
 *
 * speaker 锚点与导演锚点共用同一套视觉：reasoning 块走 FemoReasoningRow 折叠行、
 * toolcall 块走单行 ⚙ 摘要、正文走官方 MarkdownText 打字机（2026-08-26 拆除
 * 自绘闪烁光标：官方流式输出无 caret 装饰，Deep diving 状态行已是进行中信号）。
 * FemoTurnStatus 是官方 ChatView TurnStatus 的同款转写，由调用方按 open-turn
 * 条件渲染在流末尾（2026-08-26 二次修正：不再内嵌于 FemoStreamLive——官方语义
 * 是"骑整个 running turn 全程"，而非"有直播块才显示"）。
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
// MarkdownText：官方正文渲染器（基线件，shell 同一实例）——投影窗流式方案B
// 的打字机正文与原生消息像素同款的关键。DisclosureRow/StateDot/变体图标同
// 理（build.mjs 把 primitives 列为 external，require 解析到 shell 同一实例，
// 自带样式已在页面）——官方工具行的骨架件零转写直接用真件。
import {
  DisclosureRow, MarkdownText, StateDot,
  IconApiOutline14, IconBrowseOutline16, IconCodeOutline16, IconEditOutline16,
  IconSearchOutline16, IconSparkle16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { FemoReasoningRow } from '../femo-reasoning-row'
import { type FemoStreamBlock } from './stream-store'

/**
 * 官方 ChatView runningTurnStartTime 同款 + open-turn 存在性判定。
 * 投影窗是无 agent 镜像会话（官方 running 永 false），"演出中"由落盘事件
 * 推导：timeline 存在 status==='open' 的 turn 即进行中；startTime=最近一个
 * open turn 的 turn/start 时间（中途打开/重启后计时仍真实）。
 */
export function openTurnInfo(timeline: unknown): { hasOpen: boolean; startTime: number | null } {
  const turns = (timeline as { turns?: Map<string, { status?: string; start?: { time?: number } }> } | undefined)?.turns
  if (turns === undefined) return { hasOpen: false, startTime: null }
  let latest: number | null = null
  let hasOpen = false
  for (const turn of turns.values()) {
    if (turn?.status !== 'open') continue
    hasOpen = true
    if (turn.start !== undefined && typeof turn.start.time === 'number') {
      latest = turn.start.time
    }
  }
  return { hasOpen, startTime: latest }
}

/**
 * 官方 ChatView TurnStatus 同款转写（2026-08-26 对齐官方语义）：品牌蓝流光
 * "Deep diving..."，15 秒起追加耗时计时。官方行为（源码注释 "rides the whole
 * running turn"）：用户消息落地即出现（不等首 token，告知"已收到正在处理"，
 * 免得用户以为卡死）、位置恒在消息流末尾、整个 turn 结束才消失（首 token/
 * 工具执行/流式全程不闪烁）。显示条件由调用方给（open turn 存在），本组件
 * 只负责视觉与计时。startTime=open turn 的 turn/start 时间（官方
 * runningTurnStartTime 同源；null 回退挂载时刻）。
 */
export function FemoTurnStatus({ startTime }: { startTime: number | null }) {
  const [mountedAt] = useState(() => Date.now())
  // Anchored to turn/start so a mid-turn reload keeps the real elapsed time.
  const anchor = startTime ?? mountedAt
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - anchor))
  useEffect(() => {
    const tick = (): void => { setElapsedMs(Math.max(0, Date.now() - anchor)) }
    tick()
    const id = setInterval(tick, 1000)
    return () => { clearInterval(id) }
  }, [anchor])
  // 官方同款阈值：短回合只留纯文案，跑够 15 秒才出现计时。
  const showClock = elapsedMs >= 15_000
  const total = Math.max(0, Math.floor(elapsedMs / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return (
    <div className="femo-turn-status" role="status" aria-live="polite">
      Deep diving...
      {showClock && (
        <span className="femo-turn-status-clock" aria-hidden>
          {minutes > 0 ? `${minutes}分${String(seconds).padStart(2, '0')}秒` : `${seconds}秒`}
        </span>
      )}
    </div>
  )
}

// ── 官方工具行（2026-08-30 V6.1，猫猫拍板"流式就显示官方版样子"）────────
// 照抄对象：ui-tool ToolRow/GenericToolCard/tool-call-model。骨架件
// （DisclosureRow/StateDot/变体图标）= primitives 真件；行级样式（running
// sweep 流光/sep 点/summary 截断/IN-OUT 卡）在 styles.ts 按 ToolRow.module.css
// 逐属性转写（femo-toolrow-*，--dsw token 原样→深浅色/第三方主题自动跟随）。
// 未转写部分（terminal/read/search/diff/web 专用卡片、fileLink 打开件、
// Inspect 轨迹跳转）等 turn 落地由官方原生行接管——直播桶只做通用行。
type FemoToolVariant = 'search' | 'read' | 'bash' | 'write' | 'edit' | 'code' | 'others'

/** Figma 行标题字面量（tool-call-model VARIANT_TITLES 原表）。 */
const FEMO_TOOL_VARIANT_TITLES: Record<FemoToolVariant, string> = {
  search: 'Search', read: 'Read', bash: 'Bash',
  write: 'Write', edit: 'Edit', code: 'Code', others: 'Tool call',
}

/** 已知工具名 → 变体（tool-call-model TOOL_VARIANTS 原表；cordis_* 不在——
 * femo 桶里不会出现，且缺省即 others 通用行）。 */
const FEMO_TOOL_VARIANTS: Record<string, FemoToolVariant> = {
  bash: 'bash', pwsh: 'bash', read: 'read', web_fetch: 'read',
  web_search: 'search', grep: 'search', glob: 'search',
  write: 'write', edit: 'edit', run_code: 'code',
}

/** 摘要键偏好（tool-call-model SUMMARY_KEYS 原表）。 */
const FEMO_TOOL_SUMMARY_KEYS: Record<FemoToolVariant, readonly string[]> = {
  bash: ['description', 'command'],
  read: ['path', 'file_path', 'url'],
  search: ['query', 'pattern', 'url'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  code: ['description'],
  others: [],
}

/** 变体前置图标（GenericToolCard VARIANT_ICONS 原表，14px 于 16px 槽）。 */
const FEMO_TOOL_VARIANT_ICONS: Record<FemoToolVariant, ReactNode> = {
  search: <IconSearchOutline16 size={14} />,
  read: <IconBrowseOutline16 size={14} />,
  bash: <IconApiOutline14 size={14} />,
  write: <IconEditOutline16 size={14} />,
  edit: <IconEditOutline16 size={14} />,
  code: <IconCodeOutline16 size={14} />,
  others: <IconSparkle16 size={14} />,
}

function femoToolFirstLine(text: string): string {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

function femoToolPick(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = args[key]
    if (typeof v === 'string' && v !== '') return v
  }
  return undefined
}

/** 摘要推导（tool-call-model deriveSummary 原逻辑，含流中截断 JSON 的
 * firstLine 回退——与官方 running 行为一致）。 */
function femoToolDeriveSummary(variant: FemoToolVariant, argsRaw: string): string {
  let parsed: unknown
  try { parsed = JSON.parse(argsRaw) } catch { return femoToolFirstLine(argsRaw) }
  if (typeof parsed !== 'object' || parsed === null) return femoToolFirstLine(argsRaw)
  const args = parsed as Record<string, unknown>
  const picked = femoToolPick(args, FEMO_TOOL_SUMMARY_KEYS[variant])
  if (picked !== undefined) return femoToolFirstLine(picked)
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v !== '') return femoToolFirstLine(v)
  }
  return femoToolFirstLine(argsRaw)
}

/** 展开 IN 正文（tool-call-model deriveBody 原逻辑：可解析=pretty JSON，
 * 不可解析=原文，code 变体取 program 本体）。 */
function femoToolDeriveBody(variant: FemoToolVariant, argsRaw: string): string | null {
  if (argsRaw === '') return null
  let parsed: unknown
  try { parsed = JSON.parse(argsRaw) } catch { return argsRaw }
  if (variant === 'code' && typeof parsed === 'object' && parsed !== null) {
    const code = (parsed as Record<string, unknown>).code
    if (typeof code === 'string' && code !== '') return code
  }
  return JSON.stringify(parsed, null, 2)
}

/** 一行官方工具行：收起=[图标|StateDot] 标题 · 摘要（running 流光），展开=
 * IN args / OUT result 卡。result!==undefined → ok 态；无参异常路径由
 * stream-store 以空参完成态块兜底。 */
function FemoToolRow({ name, args, result, t }: {
  name: string | undefined
  args: string
  result: string | undefined
  t: (key: string) => string
}) {
  const [open, setOpen] = useState(false)
  const toolName = name ?? ''
  const variant: FemoToolVariant = FEMO_TOOL_VARIANTS[toolName] ?? 'others'
  const running = result === undefined
  const base = femoToolDeriveSummary(variant, args)
  // others 变体把真实工具名放进摘要槽（官方原逻辑）；参数未到流时以工具名
  // 单独占位（官方此态是 callId，桶里无 callId → 退化工具名）。
  const summary = variant === 'others' && toolName !== ''
    ? (base === '' ? toolName : `${toolName} · ${base}`)
    : base
  const body = femoToolDeriveBody(variant, args)
  const output = result !== undefined && result !== '' ? result : null
  const expandable = body !== null || output !== null
  return (
    <div className="femo-toolrow" data-variant={variant} data-tool={toolName} data-state={running ? 'running' : 'ok'}>
      {running && <span className="femo-toolrow-sr">{t('row.running')}</span>}
      <DisclosureRow
        rowClassName="femo-toolrow-row"
        leadingClassName="femo-toolrow-leading"
        titleClassName="femo-toolrow-title"
        chevronClassName="femo-toolrow-chevron"
        icon={FEMO_TOOL_VARIANT_ICONS[variant]}
        title={FEMO_TOOL_VARIANT_TITLES[variant]}
        open={open && expandable}
        expandable={expandable}
        expandOnRowClick
        keepContentWhenOpen
        onToggle={() => { setOpen(v => !v) }}
        collapsedContent={summary !== '' && (
          <>
            <span className="femo-toolrow-sep" aria-hidden />
            <span className="femo-toolrow-summary">{summary}</span>
          </>
        )}
      >
        <div className="femo-toolrow-bodywrap">
          {(body !== null || output !== null) && (
            <div className="femo-toolrow-iocard">
              {body !== null && (
                <div className="femo-toolrow-iosection">
                  <span className="femo-toolrow-iolabel">IN</span>
                  <span className="femo-toolrow-iotext">{body}</span>
                </div>
              )}
              {body !== null && output !== null && <span className="femo-toolrow-iodivider" aria-hidden />}
              {output !== null && (
                <div className="femo-toolrow-iosection">
                  <span className="femo-toolrow-iolabel">OUT</span>
                  <span className="femo-toolrow-iotext">{output}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </DisclosureRow>
    </div>
  )
}

export function FemoStreamLive({ blocks, t }: { blocks: readonly FemoStreamBlock[]; t: unknown }) {
  const safeT = typeof t === 'function' ? (t as (key: string) => string) : (key: string): string => key
  const codeLabels = useMemo(() => ({ copyLabel: safeT('copy'), copiedLabel: safeT('copied') }), [safeT])
  return (
    <div className="femo-stream-root">
      {blocks.map((block, i) => block.kind === 'reasoning'
        ? (
          <FemoReasoningRow
            key={i}
            text={block.text}
            running={i === blocks.length - 1}
            runningLabel={safeT('row.running')}
          />
        )
        : block.kind === 'toolcall'
          ? (
            <FemoToolRow
              key={i}
              name={block.name}
              args={block.text}
              result={block.result}
              t={safeT}
            />
          )
          : <MarkdownText key={i} text={block.text} streaming codeLabels={codeLabels} />)}
    </div>
  )
}
