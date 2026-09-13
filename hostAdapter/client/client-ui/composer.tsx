/**
 * client-ui/composer.tsx — 投影窗 composer（角色/上帝视角的可输入输入框）。
 *
 * dsh 对 origin=subagent 会话默认挂 SubagentReadOnlyComposer（只读）；
 * 投影窗（femo-proj-*）需要可输入。输入 → POST /dsh-femo/projection-input，
 * 由 host 按运行状态路由（2026-08-24 定稿）：剧本未跑→steer 直达主模型；
 * 人类节点等待→喂引擎 wait_key；跑本中其他时候→本窗留痕（插话待实现）。
 *
 * 2026-08-26 视觉重做：官方 InputBar 同款胶囊卡片（styles.ts FEMO_COMPOSER_CSS
 * 逐属性转写，全 --dsw/--dsh token → 深浅色与第三方主题自动跟随主窗口）。
 * 不能直接复用官方 InputBar 组件的原因（调研结论）：①跨包 import 被客户端
 * 导出纪律禁止；②投影窗 descriptor 是 mode:'one-shot'，client-runtime 对
 * one-shot 会话的 prompt 在浏览器本地直接拒绝（subagent-not-resumable），
 * 官方提交链路到不了 host；③官方语义=给本会话 agent 发消息，与三路路由冲突。
 *
 * 2026-08-26 二期：左下权限菜单 + 卡片下统计行——都是**主会话**的真数据：
 *  - 权限菜单：读主会话 permissions projection（ISession.projections.faceOf，
 *    官方公开面），切换=对主会话发 `/permission <id>` 斜杠命令（与主窗口
 *    PermissionSelect 同一语义；Full access 保留风险二次确认）。菜单体与
 *    风险弹窗直接用 ui-primitives 的 Menu / RiskConfirmation 官方组件。
 *  - 统计行：主会话 sessionStats / tokenUsage projection，格式化与拼装逻辑
 *    照抄 rc.2 StatsLine.tsx / message-chrome.ts 纯函数；projection 缺失时整行
 *    不渲染（不做 nodes fold 回退，待议）。文案沿用官方中文词典原文。
 *  - 主会话 id 解析与 host projection-input.ts 同语义：femo-proj- 前缀剥除后
 *    去掉最后一个 '-' 右侧的 actorKey（actorKey 只含 [A-Za-z0-9_]）。
 *
 * 官方行为对齐清单：mirror 双层自增高（14 行封顶滚动）、IME composition
 * guard、Enter 发送/Shift+Enter 原生换行、e.repeat 防连发、按钮 mousedown
 * 保焦点、autofocus(preventScroll)、失败 toast 条（4s 自愈）、busy 只读态、
 * primaryStops——主会话 running 时发送钮变方块 Stop，点击中断主模型当前
 * 回合（mainFace.cancel()，官方 ISession 公开动词；剧本运行控制不在本框）、
 * 草稿持久化——官方 chat store persist 同构复刻：单 key JSON 进 localStorage，
 * 切窗保留、刷新恢复、提交成功清除（mount-seed + 实时 mirror 同官方两段式）。
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { IconChevronDownOutline14, Menu, RiskConfirmation, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { femoStreamAcquire, useActorUsage, subscribeControlEvents } from './stream-store'
import { LeadingIconText } from './chat-node'

/** 提交失败的提示条状态：seq 保证连续同文错误也会重开计时。 */
interface ComposerError {
  seq: number
  text: string
}

// ── 主会话 face（鸭子类型：官方 ISession 公开面中我们用到的成员）──────────

/** ProjectionValueStore 的单 key observable face（identity-stable，见 contract/session.ts ProjectionsFace）。 */
interface ProjectionValueFace {
  getSnapshot(): unknown
  subscribe(fn: () => void): () => void
}

/** 我们消费的主会话 outward face 子集（SessionFace = ISession & ObservableSnapshot）。 */
interface MainSessionFace {
  readonly projections?: { faceOf(key: string): ProjectionValueFace }
  command?(line: string): Promise<{ ok?: boolean; value?: { matched?: boolean } }>
  /** 中断主会话当前回合（官方 primaryStops 的 Stop 语义；one-shot 才会被拒，
   * 主会话是普通会话不受影响）。 */
  cancel?(): Promise<unknown>
  /** ObservableSnapshot 半边：对话快照订阅（running 等会话级事实的来源）。 */
  subscribe?(fn: () => void): () => void
  getSnapshot?(): unknown
}

/** client.tsx 注入 face：按会话 id 解析主会话 outward face（sessions.binding）。 */
export interface ProjectionComposerInjected {
  getSessionFace?: (sid: string) => MainSessionFace | undefined
}

interface PermissionOption {
  name: string
  value: string
  description?: string
}

/** ui-permission-presets 推送的 permissions projection 值形状（消费子集）。 */
interface PermissionValue {
  currentValue: string
  options: PermissionOption[]
}

/** dsh-token-meter 的 tokenUsage projection 消费子集。 */
interface TokenUsageProjection {
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

/** dsh-session-stats 的 sessionStats projection 形状（rc.2 StatsLine WindowStats）。 */
interface SessionStatsProjection {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
}

// ── 工具 ──────────────────────────────────────────────────────────────────

// ── 草稿持久层 ──
// 官方 chat store persist（'dsh.conversation.chat' 整值 JSON 进 localStorage）
// 的轻量同构复刻：单 key 按 sessionId 存对象。切窗回来草稿还在、页面刷新也
// 在；提交成功即清除（官方 submit 后 machine adopt('') 镜像写空的同语义）。
const DRAFT_STORE_KEY = 'dsh-femo.composer.drafts'

function readDrafts(): Record<string, string> {
  try {
    const raw = localStorage.getItem(DRAFT_STORE_KEY)
    if (raw === null) return {}
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, string> : {}
  } catch {
    return {} // 损坏数据当无草稿；localStorage 缺席（隐私模式）同样降级
  }
}

function writeDraft(sid: string, text: string): void {
  try {
    const drafts = readDrafts()
    if (text === '') delete drafts[sid]
    else drafts[sid] = text
    localStorage.setItem(DRAFT_STORE_KEY, JSON.stringify(drafts))
  } catch {
    // localStorage 不可用：退化为纯内存态（本次挂载内仍有效），不提示
  }
}

/**
 * 订阅任意会话 face 的一个 projection key（useSyncExternalStore 适配）。
 * faceOf 是 identity-stable bare observable（官方契约），subscribe/getSnapshot
 * 引用稳定；face 缺失时恒定 undefined 快照。
 * @param face - 主会话 face（undefined = 主会话不在前端 store）。
 * @param key - projection key。
 * @returns 当前快照值（无数据为 undefined）。
 */
function useProjectionValue(face: MainSessionFace | undefined, key: string): unknown {
  const subscribe = useCallback((onChanged: () => void): (() => void) => {
    return face?.projections?.faceOf(key).subscribe(onChanged) ?? (() => { /* 无 face：空订阅 */ })
  }, [face, key])
  const getSnapshot = useCallback((): unknown => {
    return face?.projections?.faceOf(key).getSnapshot() ?? undefined
  }, [face, key])
  return useSyncExternalStore(subscribe, getSnapshot)
}

/**
 * 订阅主会话 conversation 快照（ObservableSnapshot<ConversationSnapshot> 半边，
 * useSession 绑定的同一数据源），读 running 等会话级事实。face 引用按会话
 * identity-stable，deps 稳定不重订阅。
 * @param face - 主会话 face。
 * @returns 快照对象（无 face 为 undefined）。
 */
function useMainSnapshot(face: MainSessionFace | undefined): { running?: boolean } | undefined {
  const subscribe = useCallback((onChanged: () => void): (() => void) => {
    return face?.subscribe?.(onChanged) ?? (() => { /* 无 face：空订阅 */ })
  }, [face])
  const getSnapshot = useCallback((): { running?: boolean } | undefined => {
    return face?.getSnapshot?.() as { running?: boolean } | undefined
  }, [face])
  return useSyncExternalStore(subscribe, getSnapshot)
}

// ── 统计格式化（照抄 rc.2 StatsLine.tsx / message-chrome.ts 纯函数）────────

/** Compact token count: 517 / 12.2K / 517K / 1.2M（rc.2 StatsLine formatTokens）。 */
function formatTokens(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/** 45.2s under a minute, 2m42s from there on（rc.2 StatsLine formatDuration）。 */
function formatDuration(ms: number): string {
  const s = ms / 1_000
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

/** Whole tokens from ten up, one decimal below（rc.2 message-chrome formatTokensPerSecond）。 */
function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps)
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10)
}

/** Sum the three disjoint prompt-side billing buckets（rc.2 StatsLine billedInputTokens）。 */
function billedInputTokens(usage: TokenUsageProjection): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/** Round a cache-read ratio to an integer percentage, positive ties up（rc.2 StatsLine）。 */
function roundedIntegerPercent(cacheReadTokens: number, denominator: number): number {
  const denominatorQuotient = Math.floor(denominator / 200)
  const denominatorRemainder = denominator % 200
  let lower = 0
  let upper = 100
  while (lower < upper) {
    const candidate = Math.floor((lower + upper + 1) / 2)
    const factor = candidate * 2 - 1
    const threshold = factor * denominatorQuotient
      + Math.ceil(factor * denominatorRemainder / 200)
    if (cacheReadTokens >= threshold) {
      lower = candidate
      continue
    }
    upper = candidate - 1
  }
  return lower
}

/** Display-ready cache-hit share（rc.2 StatsLine cacheHitPercent）。 */
function cacheHitPercent(usage: TokenUsageProjection): string | null {
  const denominator = billedInputTokens(usage)
  if (denominator === 0) return null
  const missedInputTokens = usage.uncachedInputTokens + usage.cacheWriteTokens
  if (missedInputTokens === 0) return '100'

  const integerPercent = roundedIntegerPercent(usage.cacheReadTokens, denominator)
  if (integerPercent < 100) return String(integerPercent)

  let decimalPlaces = 1
  let scaledDoubleGap = missedInputTokens * 200
  const denominatorTens = Math.floor(denominator / 10)
  while (scaledDoubleGap <= denominatorTens) {
    scaledDoubleGap *= 10
    decimalPlaces += 1
  }
  const denominatorOnes = denominator % 10
  let roundedLoss = 5
  for (let loss = 1; loss < 5; loss++) {
    const factor = loss * 2 + 1
    const threshold = factor * denominatorTens + Math.floor(factor * denominatorOnes / 10)
    if (scaledDoubleGap <= threshold) {
      roundedLoss = loss
      break
    }
  }
  return `99.${'9'.repeat(decimalPlaces - 1)}${10 - roundedLoss}`
}

// ── 统计行（主会话 sessionStats + tokenUsage）──────────────────────────────

// 官方 conversation 词典中文原文（locales.ts L58-64），不走 locale seat 直接常量。
const STATS_COUNTS = '{turns} 轮 · {steps} 步'
const STATS_LLM = 'LLM {duration}'
const STATS_TOOL = '工具调用 {duration}'
const STATS_TTFT = '首 token 平均 {duration}'
const STATS_TPS = '{throughput} tok/s'
const STATS_CACHE_HIT = '缓存命中 {percent}%'
const STATS_TOKENS = '输入 {input} tok · 输出 {output} tok'

function fill(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/gu, (_, name: string) => params[name] ?? '')
}

/**
 * 卡片下方统计行：显示主会话的轮次/步数/耗时/吞吐与计费数据。
 * 数据全缺（两组都拼不出来）时返回 null——与官方 groups.length===0 行为一致。
 */
function StatsRow({ face }: { face: MainSessionFace | undefined }) {
  const stats = useProjectionValue(face, 'sessionStats') as SessionStatsProjection | undefined
  const usage = useProjectionValue(face, 'tokenUsage') as TokenUsageProjection | undefined

  const groups: string[] = []
  if (stats !== undefined && typeof stats === 'object' && stats.steps > 0) {
    groups.push(fill(STATS_COUNTS, { turns: String(stats.turns), steps: String(stats.steps) }))
    const durations: string[] = []
    if (stats.llmMs > 0) durations.push(fill(STATS_LLM, { duration: formatDuration(stats.llmMs) }))
    if (stats.toolMs > 0) durations.push(fill(STATS_TOOL, { duration: formatDuration(stats.toolMs) }))
    if (durations.length > 0) groups.push(durations.join(' · '))
    const speeds: string[] = []
    if (stats.ttftSteps > 0) speeds.push(fill(STATS_TTFT, { duration: formatDuration(stats.ttftMs / stats.ttftSteps) }))
    if (stats.decodeMs > 0) {
      speeds.push(fill(STATS_TPS, { throughput: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000)) }))
    }
    if (speeds.length > 0) groups.push(speeds.join(' · '))
  }
  if (usage !== undefined && typeof usage === 'object'
    && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)) {
    const cacheHit = cacheHitPercent(usage)
    if (cacheHit !== null) groups.push(fill(STATS_CACHE_HIT, { percent: cacheHit }))
    groups.push(fill(STATS_TOKENS, {
      input: formatTokens(billedInputTokens(usage)),
      output: formatTokens(usage.outputTokens),
    }))
  }

  if (groups.length === 0) return null
  return (
    <div className="femo-comp-stats">
      {groups.map((group, i) => (
        <span key={group}>
          {i > 0 && <><span className="femo-comp-stats-sep" aria-hidden>|</span>{' '}</>}
          {group}
        </span>
      ))}
    </div>
  )
}

// ── 上下文占用圆环（官方 ContextMeter 视觉/交互 1:1 转写）──────────────────

/** dsh-token-meter 的 contextPressure projection 消费子集（rc.2 原样）。 */
interface ContextPressureProjection {
  pressureTokens?: number
  projectedTokens?: number
  contextWindow?: number
}

/** dsh-token-meter 的 contextBreakdown projection 消费子集（rc.2 原样）。 */
interface ContextBreakdownProjection {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
}

/** 圆环数据源的抽象：上帝窗传主会话 face（projection 读取），角色窗传
 * actor-usage 快照。两组件共用 ContextRing 渲染。 */
interface ContextRingData {
  percent: number
  usedTokens: number
  contextWindow: number
  /** 面板三色分段（system/tools/messages）；undefined=单色整条（官方 fallback）。 */
  breakdown?: ContextBreakdownProjection
  /** 面板附加说明行（角色窗显示模型名）；undefined=不显示。 */
  note?: string
}

/** 近似上下文占用（rc.2 StatsLine contextOccupancy 原样转写）：分子=projectedTokens
 * （provider 样本+其后表面增量的启发式重估，压缩立即可见），缺该字段回退
 * pressureTokens；分母与分子任一缺失 → null（官方同款不渲染）。 */
function contextOccupancy(pressure: ContextPressureProjection | undefined): ContextRingData | null {
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  if (usedTokens === undefined || pressure?.contextWindow === undefined) return null
  return {
    percent: Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)),
    usedTokens,
    contextWindow: pressure.contextWindow,
  }
}

/** 圆环几何（官方同款）：14px viewBox，2px 描边。 */
const METER_RADIUS = 5.5
const METER_CIRCUMFERENCE = 2 * Math.PI * METER_RADIUS

/** 面板图例行（官方 ROWS 转写；tint class 对应 femo-comp-meter-tint-*）。 */
const METER_ROWS = [
  { key: 'systemTokens', label: '系统提示词', tintClass: 'femo-comp-meter-tint-system' },
  { key: 'toolsTokens', label: '工具', tintClass: 'femo-comp-meter-tint-tools' },
  { key: 'messageTokens', label: '对话消息', tintClass: 'femo-comp-meter-tint-messages' },
] as const

/** 官方 conversation 词典中文原文（locales.ts L53）。 */
const METER_ARIA = '上下文已用 {percent}'

/**
 * 圆环渲染体（官方 ContextMeter 同款 SVG 与面板结构）。
 * 交互全对齐官方：hover tooltip（面板开时停用）、点击开合、外部点击/Escape
 * 关闭、数据失效自动收面板。
 */
function ContextRing({ data }: { data: ContextRingData }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const percent = data.percent
  const reading = `${percent}%`
  const aria = fill(METER_ARIA, { percent: reading })

  // 外部点击 / Escape 关闭（官方 Menu 的单监听器模式）。数据失效由调用方
  // 直接卸载本组件（GodContextRing/角色窗守卫），无需组件内收面板逻辑。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target) === true) return
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // 分段（官方同款）：breakdown 缺失或全零 → 单色整条；有 → 按三色占比。
  const breakdown = data.breakdown
  const breakdownTotal = breakdown === undefined
    ? 0
    : breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
  const parts = breakdown === undefined || breakdownTotal === 0
    ? [{ key: 'total', tintClass: undefined, width: percent }]
    : METER_ROWS.map(row => ({ key: row.key, tintClass: row.tintClass, width: percent * breakdown[row.key] / breakdownTotal }))
  const segments = parts.filter(part => part.width > 0)

  return (
    <span ref={rootRef} className="femo-comp-meter">
      <Tooltip label={aria} side="top" delayMs={200} disabled={open}>
        <button
          type="button"
          className="femo-comp-meter-trigger"
          aria-label={aria}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => { setOpen(!open) }}
        >
          <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
            <circle className="femo-comp-meter-track" cx="7" cy="7" r={METER_RADIUS} />
            <circle
              className="femo-comp-meter-fill"
              cx="7"
              cy="7"
              r={METER_RADIUS}
              strokeDasharray={`${METER_CIRCUMFERENCE * percent / 100} ${METER_CIRCUMFERENCE}`}
              transform="rotate(-90 7 7)"
            />
          </svg>
        </button>
      </Tooltip>
      {open && (
        <div className="femo-comp-meter-panel" role="dialog" aria-label={fill(METER_ARIA, { percent: '' }).trim()}>
          <div className="femo-comp-meter-header">
            <span className="femo-comp-meter-headline">上下文已用</span>
            <span className="femo-comp-meter-percent">{reading}</span>
            <span className="femo-comp-meter-figures">
              {`~${formatTokens(data.usedTokens)} / ${formatTokens(data.contextWindow)}`}
            </span>
          </div>
          <div className="femo-comp-meter-bar">
            {segments.map(segment => (
              <div
                key={segment.key}
                className={segment.tintClass === undefined ? 'femo-comp-meter-segment' : `femo-comp-meter-segment ${segment.tintClass}`}
                style={{ width: `${segment.width}%` }}
              />
            ))}
          </div>
          {data.note !== undefined && (
            <div className="femo-comp-meter-headline">{data.note}</div>
          )}
          {breakdown !== undefined && (
            <dl className="femo-comp-meter-rows">
              {METER_ROWS.map(row => (
                <div key={row.key} className="femo-comp-meter-row">
                  <dt>
                    <span className={`femo-comp-meter-swatch ${row.tintClass}`} aria-hidden />
                    {row.label}
                  </dt>
                  <dd>{`~${formatTokens(breakdown[row.key])}`}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </span>
  )
}

/** 上帝窗圆环：读主会话 contextPressure/contextBreakdown projection（与主
 * 窗口圆环同源同算法）；数据不全不渲染（官方同款）。 */
function GodContextRing({ face }: { face: MainSessionFace | undefined }) {
  const pressure = useProjectionValue(face, 'contextPressure') as ContextPressureProjection | undefined
  const breakdown = useProjectionValue(face, 'contextBreakdown') as ContextBreakdownProjection | undefined
  const data = contextOccupancy(pressure)
  if (data === null) return null
  return <ContextRing data={breakdown === undefined ? data : { ...data, breakdown }} />
}

/** 角色窗圆环：actor-usage 数据源（host 从子代理会话事件采样——该角色上次
 * 发言时发给 API 的完整 prompt 的 provider 实报 token 量 / 模型窗口容量，
 * 容量缺失 host 已按 1M 兜底）。面板 note 显示模型名；无数据不渲染。 */
function ActorContextRing({ mainSid, actorKey }: { mainSid: string; actorKey: string }) {
  const usage = useActorUsage(mainSid, actorKey)
  if (usage === undefined || usage.contextWindow <= 0) return null
  return (
    <ContextRing data={{
      percent: Math.min(100, Math.round(usage.usedTokens / usage.contextWindow * 100)),
      usedTokens: usage.usedTokens,
      contextWindow: usage.contextWindow,
      note: usage.model.length > 0 ? `模型 ${usage.model}` : undefined,
    }} />
  )
}

// ── 权限菜单（主会话 access mode；视觉与交互照抄官方 PermissionSelect）──────

const FULL_ACCESS = 'danger-full-access'

/* Shield glyphs（照抄 rc.2 PermissionSelect.tsx design set 1556）。 */
const SHIELD_OUTLINE = 'M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z'

const permissionGlyphs: Record<string, JSX.Element> = {
  'read-only': (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d={SHIELD_OUTLINE} stroke="currentColor" strokeWidth="1.31831" strokeLinejoin="round" />
      <path d="M12.1654 5.7552L8.9447 9.41475C8.73044 9.65816 8.53628 9.8804 8.35774 10.0423C8.1713 10.2114 7.94235 10.3717 7.64016 10.4254C7.48207 10.4535 7.32 10.4552 7.16151 10.4294C6.85843 10.3801 6.62728 10.2223 6.43836 10.0559C6.25752 9.89653 6.06037 9.67732 5.84264 9.43705L4.72925 8.20897L5.63557 7.38707L6.74897 8.61594C6.98603 8.87755 7.12974 9.03533 7.24673 9.13839C7.31033 9.19443 7.34485 9.21476 7.35823 9.22122C7.38068 9.22484 7.40352 9.22515 7.42593 9.22122C7.40522 9.22502 7.42893 9.23294 7.53583 9.136C7.65132 9.03126 7.79316 8.87139 8.02643 8.60638L11.2479 4.94763L12.1654 5.7552Z" fill="currentColor" />
    </svg>
  ),
  'workspace-write': (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8.08887 0.251709C8.20479 0.23085 8.32486 0.241168 8.43652 0.282959L15.0215 2.75171C15.2787 2.84819 15.4492 3.09414 15.4492 3.3689V7.0105C15.4492 7.10986 15.4441 7.2081 15.4414 7.30542C15.0285 7.07175 14.5905 6.87695 14.1309 6.73022V3.82495L8.20508 1.60327L2.2793 3.82495V7.0105C2.27936 9.7171 3.4745 11.5379 5.02734 12.7947C5.01025 12.9942 5 13.1962 5 13.4001C5.00001 13.7617 5.02722 14.1169 5.08008 14.4636C2.91555 13.0393 0.961014 10.752 0.960938 7.0105V3.3689C0.960938 3.09417 1.13146 2.84821 1.38867 2.75171L7.97461 0.282959L8.08887 0.251709Z" fill="currentColor" />
      <path d="M11.3525 5.64688V6.85688H5V5.64688H11.3525Z" fill="currentColor" />
      <path d="M9.5824 8.29376V9.50376H5V8.29376H9.5824Z" fill="currentColor" />
      <path d="M14.6647 15.6852H10.0338C10.3878 15.3751 10.7567 15.0517 11.0772 14.7706C11.2531 14.6164 11.4144 14.4746 11.5511 14.3547H14.6647V15.6852Z" fill="currentColor" />
      <path d="M8.14852 14.1308L7.33925 15.4976C7.22458 15.6912 7.42245 15.9194 7.63037 15.8333L9.09785 15.2254L15.0399 10.0719L14.0905 8.97733L8.14852 14.1308Z" fill="currentColor" />
    </svg>
  ),
  [FULL_ACCESS]: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d={SHIELD_OUTLINE} stroke="currentColor" strokeWidth="1.31831" strokeLinejoin="round" />
      <path d="M9.10094 4.5V8.75939H7.59888V4.5H9.10094Z" fill="currentColor" />
      <path d="M9.10094 9.8114V11.5H7.59888V9.8114H9.10094Z" fill="currentColor" />
    </svg>
  ),
}

/** kebab-case 机器名转标题式显示名；非 kebab 的宿主配置名原样透传（照抄官方 displayName）。 */
function displayName(name: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/u.test(name)) return name
  return name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

function optionLabel(option: PermissionOption): string {
  return option.value === FULL_ACCESS ? 'Full access' : displayName(option.name)
}

// 官方 conversation 词典中文原文（locales.ts L27/L69-73）。
const ACCESS_CONFIRM_TITLE = '确认启用 Full access？'
const ACCESS_CONFIRM_DESCRIPTION = '启用 Full access 后，agent 将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。'
const ACCESS_CONFIRM_ACKNOWLEDGE = '我已了解风险，并愿意继续'
const ACCESS_CONFIRM_CANCEL = '取消'
const ACCESS_CONFIRM_ENABLE = '启用 Full access'

/**
 * 左下角访问模式菜单：显示并切换**主会话**的权限模式。
 * permissions projection 缺失（宿主无该能力）时渲染 null——与官方一致。
 */
function PermissionMenu({ face, disabled }: { face: MainSessionFace | undefined; disabled: boolean }) {
  const value = useProjectionValue(face, 'permissions') as PermissionValue | undefined
  const [open, setOpen] = useState(false)
  const [pick, setPick] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)

  useEffect(() => {
    if (!disabled && value !== undefined) return
    setOpen(false)
    setAcknowledged(false)
    setConfirmation(null)
  }, [disabled, value])

  // hooks 全部在条件返回之前（React 规则）；value 缺失=官方同款渲染 null。
  if (value === undefined || typeof value !== 'object' || face?.command === undefined) return null

  const currentValue = pick ?? value.currentValue
  const current = value.options.find(option => option.value === currentValue)
  const busy = pick !== null || confirmation !== null

  const items: MenuEntry[] = value.options
    .filter(option => option.value !== 'custom')
    .map(option => {
      const icon = permissionGlyphs[option.value]
      return { id: option.value, label: optionLabel(option), ...(icon === undefined ? {} : { icon }) }
    })

  const submit = (id: string): void => {
    setPick(id)
    void face.command?.(`/permission ${id}`)
      .catch(() => false)
      .then(() => { setPick(null) })
  }

  const choose = (id: string): void => {
    setOpen(false)
    if (id === value.currentValue) return
    if (id === FULL_ACCESS) {
      setAcknowledged(false)
      setConfirmation(id)
      return
    }
    submit(id)
  }

  const closeConfirmation = (): void => {
    setAcknowledged(false)
    setConfirmation(null)
  }

  const confirmFullAccess = (): void => {
    if (disabled || !acknowledged || confirmation === null) return
    const id = confirmation
    closeConfirmation()
    submit(id)
  }

  return (
    <>
      <Menu
        open={open}
        items={items}
        selectedId={currentValue}
        onSelect={choose}
        onClose={() => { setOpen(false) }}
        side="top"
        anchor={
          <button
            type="button"
            className="femo-comp-perm-trigger"
            aria-label={fill('访问模式，当前：{name}', { name: current === undefined ? displayName(currentValue) : optionLabel(current) })}
            title={current?.description}
            disabled={disabled || busy}
            onClick={() => { setOpen(!open) }}
          >
            {permissionGlyphs[currentValue] !== undefined && (
              <span className="femo-comp-perm-icon" aria-hidden>{permissionGlyphs[currentValue]}</span>
            )}
            <span className="femo-comp-perm-label">{current === undefined ? displayName(currentValue) : optionLabel(current)}</span>
            <span className="femo-comp-perm-chevron" data-open={open} aria-hidden>
              <IconChevronDownOutline14 />
            </span>
          </button>
        }
      />
      <RiskConfirmation
        open={confirmation !== null}
        title={ACCESS_CONFIRM_TITLE}
        description={ACCESS_CONFIRM_DESCRIPTION}
        acknowledgeLabel={ACCESS_CONFIRM_ACKNOWLEDGE}
        cancelLabel={ACCESS_CONFIRM_CANCEL}
        confirmLabel={ACCESS_CONFIRM_ENABLE}
        acknowledged={acknowledged}
        disabled={disabled}
        onAcknowledgedChange={setAcknowledged}
        onCancel={closeConfirmation}
        onConfirm={confirmFullAccess}
      />
    </>
  )
}

// ── 主组件 ────────────────────────────────────────────────────────────────

/** 投影窗 composer 主按钮的三态（2026-09-06 猫猫拍板：与主模型发言状态解耦，
 * 按「窗型×剧本态」统一控制）。 */
type ComposerButtonState = 'send' | 'stop' | 'disabled'

/** 剧本运行状态快照（host projection-state 接口/SSE projection_state 同形）。 */
interface FemoRunState {
  running: boolean
  waiting: boolean
  waitScope: string[]
  prompt?: string
}

const IDLE_RUN_STATE: FemoRunState = { running: false, waiting: false, waitScope: [] }

/**
 * 按钮状态机（各投影窗唯一的控制逻辑，2026-09-06 猫猫拍板的矩阵）：
 *  - AI 角色窗：永远 disabled（AI 演员收不到人类输入）；
 *  - 人类角色窗/戏内窗/上帝窗（剧本运行中）：轮到人类节点且（角色窗时）
 *    等待 scope 含本窗角色 → send，否则 disabled——人类发言发给节点，
 *    与主模型是否在说话无关；
 *  - 上帝窗（剧本未跑）：主模型说话=stop（点击中断主模型回合，dsh 原生
 *    primaryStops 语义），没说话=send；
 *  - 其余（角色/戏内窗剧本未跑）：disabled。
 * busy（提交中）与空文本只在 send 态禁用，不影响状态判定。
 */
function composerButtonState(args: {
  winKind: 'god' | 'stage' | 'actor' | 'none'
  actor: string | undefined
  run: FemoRunState
  mainRunning: boolean
}): ComposerButtonState {
  const { winKind, actor, run, mainRunning } = args
  if (winKind === 'god') {
    if (run.running) return run.waiting ? 'send' : 'disabled'
    return mainRunning ? 'stop' : 'send'
  }
  if (winKind === 'stage') {
    return run.running && run.waiting ? 'send' : 'disabled'
  }
  if (winKind === 'actor') {
    // AI 角色窗永远不在 human 节点 scope 里 → 天然恒 disabled；
    // 人类角色窗只在轮到自己时 enable。
    const humanTarget = actor !== undefined && run.waitScope.includes(actor)
    return run.running && run.waiting && humanTarget ? 'send' : 'disabled'
  }
  return 'disabled'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ProjectionComposer({ useSession, useSessions, getSessionFace }: any) {
  const sessionId = useSession((s: { sessionId?: string }) => s.sessionId) as string | undefined
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ComposerError | null>(null)
  // IME guard（官方同款）：composition 关闭事件在 Safari 晚于 keydown 一拍到达，
  // 延迟一 tick 复位，中文输入法回车选词不会误触发送。
  const composingRef = useRef(false)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const errorSeqRef = useRef(0)

  // 草稿装载（官方 ConversationSession mount-seed 同款：机器空 && 存储有 →
  // 回填）。切换投影窗时装载该窗自己的草稿；之后每次输入实时镜像落盘。
  useEffect(() => {
    if (sessionId === undefined) return
    setText(readDrafts()[sessionId] ?? '')
  }, [sessionId])

  /** 输入变更：state 与持久层同步写（官方 machine mirror 同语义）。 */
  const changeText = (next: string): void => {
    setText(next)
    if (sessionId !== undefined) writeDraft(sessionId, next)
  }

  // 主会话 id：sessions 列表 summary.parentId（host 建窗元数据，与
  // view-button 同款权威来源）。列表未就绪时返回 undefined——列表就绪后
  // selector 返回值变化（undefined → 'xxx'）触发重渲染，届时 face 解析成功；
  // 不用字符串兜底（会让 selector 恒定、列表就绪的重渲染不触发=刷新后缺
  // 权限按钮/统计行，2026-08-26 实测 bug）。
  const mainSid = useSessions((state: { byId?: Record<string, { parentId?: string } | undefined> } | undefined): string | undefined => {
    if (typeof sessionId !== 'string') return undefined
    const pid = state?.byId?.[sessionId]?.parentId
    return typeof pid === 'string' && pid.length > 0 ? pid : undefined
  })
  // binding 可解析的判据=官方 resolve() 的 eligible：会话在列表 ids 中（或恰为
  // 当前会话——composer 只挂在 femo-proj 窗上，永远走前者）。单独订阅它：
  // 「目录先于列表落地」的启动竞态下，byId[projSid] 由宿主 address walk 在
  // ids 还空着时先造出来，mainSid 首次非空那一刻 binding 返回 undefined 并被
  // 下面的 useMemo 永久缓存（inject face 引用稳定、mainSid 之后不再变化=
  // 永不重算）——刷新后权限按钮/统计行消失、切窗重挂才自愈（2026-08-29 探针
  // 确定性复现：session.list 比目录慢时必现，大会话变多后 list 变慢所致）。
  const mainListed = useSessions((state: { ids?: readonly string[] } | undefined): boolean =>
    typeof mainSid === 'string' && Array.isArray(state?.ids) && state.ids.includes(mainSid))
  // 主会话 face（投影窗是主会话的遥控器：权限菜单/统计行/停止钮都读它）。
  // binding() 官方注释明示 render-safe 纯解析且 per-session identity-stable；
  // useMemo 按 [mainSid, mainListed] 缓存即引用稳定——mainListed 翻真（列表
  // 落地）强制重算一次，清掉竞态窗口里缓存下来的失败解析。
  const mainFace = useMemo(
    () => (mainSid === undefined || !mainListed ? undefined : getSessionFace?.(mainSid)),
    [mainSid, mainListed, getSessionFace],
  )
  const mainSnapshot = useMainSnapshot(mainFace)
  // 官方 primaryStops 同语义：主模型回合进行中 → Stop（仅上帝窗剧本未跑时用）。
  const mainRunning = mainSnapshot?.running === true

  // ── 剧本运行状态（按钮状态机的输入）─────────────────────────────────────
  // 三重保障（2026-09-07：实时通道间歇失效的实测——落盘/广播都正常但浏览器
  // 侧偶发收不到，切窗重挂即恢复）：①基线=挂载时拉 projection-state；
  // ②增量=SSE projection_state（快照语义整体覆盖）；③兜底=周期轮询+页面
  // 聚焦即刷（轻量只读接口，保证按钮/横幅最终一致秒级收敛，不再依赖任何
  // 单通道的实时性）。
  const [run, setRun] = useState<FemoRunState>(IDLE_RUN_STATE)
  const [winInfo, setWinInfo] = useState<{ winKind: 'god' | 'stage' | 'actor' | 'none'; actor?: string }>({ winKind: 'none' })
  const applyState = useCallback((data: { ok?: boolean; winKind?: 'god' | 'stage' | 'actor' | 'none'; actor?: string; running?: boolean; waiting?: boolean; waitScope?: string[]; prompt?: string }) => {
    setWinInfo({ winKind: data.winKind ?? 'none', actor: data.actor })
    if (data.ok === true) {
      setRun({
        running: data.running === true,
        waiting: data.waiting === true,
        waitScope: Array.isArray(data.waitScope) ? data.waitScope : [],
        prompt: typeof data.prompt === 'string' ? data.prompt : undefined,
      })
    }
  }, [])
  const refreshRunState = useCallback((sessionIdValue: string): void => {
    void fetch(`/dsh-femo/projection-state?sessionId=${encodeURIComponent(sessionIdValue)}`)
      .then(r => r.json())
      .then((data: Parameters<typeof applyState>[0]) => { applyState(data) })
      .catch(() => { /* 接口失败降级为 idle 态（按钮灰，提交链路不受影响） */ })
  }, [applyState])
  useEffect(() => {
    if (sessionId === undefined || !sessionId.startsWith('femo-proj-')) {
      setWinInfo({ winKind: 'none' })
      return
    }
    refreshRunState(sessionId)
    // ③兜底：8s 轮询 + 切回本标签页立即刷（SSE 丢帧时最坏 8s 收敛）。
    const timer = window.setInterval(() => { refreshRunState(sessionId) }, 8000)
    const onVisible = (): void => { if (document.visibilityState === 'visible') refreshRunState(sessionId) }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [sessionId, refreshRunState])
  useEffect(() => {
    if (mainSid === undefined) return
    // 持后台 SSE 引用（编辑器同款：tab 开着就持有、不随切后台断）——没有
    // 直播/编辑器在开时也要能收 projection_state 增量。SSE 是引用计数单例，
    // 不新增连接数。
    return femoStreamAcquire({ background: true })
  }, [sessionId, mainSid])
  useEffect(() => {
    if (mainSid === undefined) return
    return subscribeControlEvents(msg => {
      if (msg.type !== 'projection_state') return
      const data = msg.data as { sid?: string; running?: boolean; waiting?: boolean; waitScope?: string[]; prompt?: string } | undefined
      if (data === undefined || data.sid !== mainSid) return
      setRun({
        running: data.running === true,
        waiting: data.waiting === true,
        waitScope: Array.isArray(data.waitScope) ? data.waitScope : [],
        prompt: typeof data.prompt === 'string' ? data.prompt : undefined,
      })
    })
  }, [mainSid])

  const buttonState = composerButtonState({ winKind: winInfo.winKind, actor: winInfo.actor, run, mainRunning })

  const submit = (): void => {
    const value = text.trim()
    if (value.length === 0 || busy || sessionId === undefined) return
    setBusy(true)
    const post = async (): Promise<Response> => fetch('/dsh-femo/projection-input', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, text: value }),
    })
    void (async (): Promise<void> => {
      try {
        let response = await post()
        let data = await response.json().catch(() => ({}) as { ok?: boolean; error?: string }) as { ok?: boolean; error?: string }
        // 【2026-09-11 修复·「刷新后提示窗口不存在」】宿主重启后本窗可能不在
        // store（只活在持久化里）：POST 落 404 并回 "session … not found"，
        // 旧实现把这句原话弹给用户（观感=「窗口不存在」）。现在 404 先借投影窗
        // 清单路由唤醒宿主（幂等；宿主顺带冷装载主会话与全窗），再发一次。
        if (data.ok !== true && response.status === 404 && sessionId.startsWith('femo-proj-')) {
          const mainSid0 = sessionId.slice('femo-proj-'.length).replace(/-[^-]*$/, '')
          const woken = mainSid0.length > 0
            ? await fetch(`/dsh-femo/projection-windows?sessionId=${encodeURIComponent(mainSid0)}`)
              .then(r => r.ok).catch(() => false)
            : false
          if (woken) {
            response = await post()
            data = await response.json().catch(() => ({}) as { ok?: boolean; error?: string }) as { ok?: boolean; error?: string }
          }
        }
        if (data.ok === true) {
          // 官方同语义：提交成功清空草稿（state + 持久层一起）。
          changeText('')
          return
        }
        errorSeqRef.current += 1
        setError({ seq: errorSeqRef.current, text: data.error ?? `发送失败（HTTP ${response.status}），草稿已保留` })
      } catch {
        errorSeqRef.current += 1
        setError({ seq: errorSeqRef.current, text: '发送失败，草稿已保留' })
      } finally {
        setBusy(false)
      }
    })()
  }

  // 错误条自动消失（官方 Toast 的 hold-then-fade 语义的轻量版）。
  useEffect(() => {
    if (error === null) return
    const timer = setTimeout(() => { setError(null) }, 4000)
    return () => { clearTimeout(timer) }
  }, [error])

  // 切换投影窗回焦输入框（官方 unlock effect 同款 preventScroll）。busy 只读态不抢。
  useEffect(() => {
    if (busy) return
    inputRef.current?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    // Shift+Enter 无条件原生换行（官方顺序：先于 IME 判定）。
    if (e.key === 'Enter' && e.shiftKey) return
    if (e.key !== 'Enter') return
    // keyCode 229 是引擎无 isComposing 时的 legacy IME 信号（官方注释）。
    const composing = composingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229
    if (composing) return
    e.preventDefault()
    if (e.repeat) return // 按住 Enter 不许连发
    submit()
  }

  // 按钮按下不夺走 textarea 焦点（官方 keepFocus：preventDefault 即可）。
  const keepFocus = (e: ReactMouseEvent<HTMLButtonElement>): void => {
    e.preventDefault()
    inputRef.current?.focus({ preventScroll: true })
  }

  return (
    <div className="femo-comp-root">
      {/* 等待横幅（2026-09-07）：轮到人类节点的实时提醒与按钮同源（run 状态），
          不依赖 dsh 会话事件流——聊天行的 human_wait 行仍照常落盘归档，但实时
          提醒改由本横幅承担（会话事件流间歇不到时不再漏提醒）。 */}
      {run.waiting && run.prompt !== undefined && (
        <div role="status" style={{
          margin: '0 0 6px',
          padding: '8px 12px',
          borderRadius: '8px',
          background: 'color-mix(in srgb, var(--dsw-alias-button-info-fill, #4a9eff) 12%, transparent)',
          border: '1px solid color-mix(in srgb, var(--dsw-alias-button-info-fill, #4a9eff) 40%, transparent)',
          color: 'var(--dsw-alias-label-primary, #222)',
          fontSize: '13px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          <LeadingIconText text={`🎭 ${run.prompt}`} />
        </div>
      )}
      {error !== null && (
        <div className="femo-comp-notice" role="status">{error.text}</div>
      )}
      {/* data 钩子对齐官方 InputBar 的 DOM 契约：meow-smooth 的失焦折叠/
          手机触摸豁免/软键盘避让全部委托 [data-composer-card] 与
          [data-input-scroll] 识别——不挂钩子这些适配层对我们失效。 */}
      <div className="femo-comp-card" data-composer-card="">
        <div className="femo-comp-scroll" data-input-scroll="">
          <div className="femo-comp-grow">
            <div aria-hidden className="femo-comp-mirror" data-input-mirror="">{`${text}\n`}</div>
            <textarea
              ref={inputRef}
              className="femo-comp-input"
              value={text}
              readOnly={busy}
              placeholder="输入消息…"
              rows={2}
              spellCheck={false}
              data-phase={busy ? 'submitting' : 'idle'}
              onChange={(e) => { changeText(e.currentTarget.value) }}
              onKeyDown={onKeyDown}
              onCompositionStart={() => { composingRef.current = true }}
              onCompositionEnd={() => {
                setTimeout(() => { composingRef.current = false }, 10)
              }}
            />
          </div>
        </div>
        <div className="femo-comp-row">
          {/* 左组：官方此处是 [+命令菜单] 与 [权限/Plan chips]；命令补全面板
              深绑官方草稿机无法正道复用（v1 不放死按钮），权限菜单位置与官方
              tools 区一致。 */}
          <PermissionMenu face={mainFace} disabled={busy} />
          <div className="femo-comp-trailing">
            {/* 圆环（官方 InputBar 同位：发送钮之前）。窗型判定（id 规则化
                femo-proj-<主sid>-<actorKey>）：god=上帝窗（主会话 projection，
                主窗口同源数据）；stage=戏内窗（归档窗无演员身份，无圆环）；
                其余=角色窗（actor-usage：该角色上次发言发给 API 的实报占用）。 */}
            {sessionId !== undefined && mainSid !== undefined && sessionId.startsWith(`femo-proj-${mainSid}-`) && (() => {
              const actorKey = sessionId.slice(`femo-proj-${mainSid}-`.length)
              if (actorKey === 'god') return <GodContextRing face={mainFace} />
              if (actorKey !== 'stage') return <ActorContextRing mainSid={mainSid} actorKey={actorKey} />
              return null
            })()}
            <button
              type="button"
              className="femo-comp-primary"
              aria-label={buttonState === 'stop' ? '停止' : buttonState === 'send' ? (busy ? '发送中' : '发送') : '当前不可发送'}
              disabled={buttonState === 'stop'
                ? mainFace?.cancel === undefined
                : buttonState !== 'send' || busy || text.trim().length === 0}
              onMouseDown={keepFocus}
              onClick={buttonState === 'stop'
                ? () => { void mainFace?.cancel?.()?.catch(() => { /* 失败经主会话快照 promptError 呈现（官方 stop 同语义） */ }) }
                : submit}
            >
              {/* 官方 InputBar 同款 glyph：stop=方块 Stop（primaryStops），
                  send/disabled=箭头 Send（箭头态由按钮 disabled 样式置灰）。 */}
              {buttonState === 'stop' ? (
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                  <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
                  <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
      {/* 卡片下方统计行（官方 StatsLine 挂 composer.dock 的同位语义）。 */}
      <StatsRow face={mainFace} />
    </div>
  )
}
