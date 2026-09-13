/**
 * client-ui/chat-node.tsx — dsh-femo/chat 会话节点（定义 + 渲染视图）。
 *
 * 每个 dsh-femo/chat 事件渲染为一行聊天：speaker 名字行（兼流式直播锚点）、
 * role 气泡、notice/sys 居中灰字、prompt 舞台提示条、human_wait 高亮框、
 * error 红行、tool_call 单行摘要。视角过滤（offstage/god/角色 scope）在
 * 渲染层完成。
 * （2026-08-26 结构整理自 client.tsx 原样迁出，行为零变化。）
 */

import { type CSSProperties } from 'react'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
// 【2026-09-11 步2】本行不再订阅直播（V6 stream-host 位已删）——直播由
// proj2 的 femo2-turn-live 负责；这里只剩纯行渲染，故 import 全部收起。
import { useView } from './view-state'
import {
  FaBullhorn, FaCircleCheck, FaCirclePlay, FaCircleStop, FaCircleXmark,
  FaClapperboard, FaMasksTheater, FaTriangleExclamation, FaWrench,
} from '../fa-icons'

/** One rendered dsh-femo/chat line. */
export interface FemoChatData {
  readonly actor?: string
  readonly text: string
  readonly kind: 'role' | 'notice' | 'human_wait' | 'prompt' | 'error' | 'thinking' | 'tool_call' | 'speaker' | 'stream-host' | 'sys'
  /**
   * Actor names this line is visible to (the action's scope). Absent =
   * visible to everyone (role/prompt/human_wait with unknown scope);
   * notice/error/thinking lines never carry it and are god-view only.
   */
  readonly visible?: readonly string[]
  readonly seq: number
  /** stream-host 专属：锚定的镜像 turn 号（重映射后），Deep diving 按
   * 该 turn 的 open 状态显示（多演员并发时各自 turn 各自判定）。 */
  readonly turn?: number
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    'femo-role': FemoChatData
  }
}

/** Stable color per actor name (simple string hash -> HSL). */
export function actorColor(actor: string): string {
  let hash = 0
  for (let i = 0; i < actor.length; i++) {
    hash = (hash * 31 + actor.charCodeAt(i)) >>> 0
  }
  return `hsl(${hash % 360} 65% 45%)`
}

/** 人类节点发言的 role 行 actor 名（与 host 侧 projection-input.ts
 * feedHumanNode 广播时的 '人类' 对应——源码两端不共享（tsconfig.host exclude
 * client-ui），字面量双处锚定，改名须同步）。此行渲染为 dsh user 气泡样式。 */
const HUMAN_ROLE_ACTOR = '人类'

// ── 首缀 emoji → FA 图标（2026-09-06 猫猫拍板：聊天行不用 emoji，太丑）────
// 消息文本原样存储（emoji 前缀是内容契约：AI 上下文/搜索/历史记录都不动），
// 仅渲染层把已知的首缀 emoji 换成 Font Awesome 图标——历史记录重放同样美化。
// ⚠/▶/⏹ 存两种形态（带/不带 U+FE0F 变体选择符），键各放一份。
const LEADING_ICON_MAP: Record<string, (props: { size?: number; style?: CSSProperties }) => JSX.Element> = {
  '🎭': FaMasksTheater,
  '✅': FaCircleCheck,
  '⏹': FaCircleStop,
  '⏹️': FaCircleStop,
  '❌': FaCircleXmark,
  '🎬': FaClapperboard,
  '▶': FaCirclePlay,
  '▶️': FaCirclePlay,
  '⚠': FaTriangleExclamation,
  '⚠️': FaTriangleExclamation,
  '📢': FaBullhorn,
  '🔧': FaWrench,
}

/** 解析文本首缀 emoji（含 surrogate pair 与可选 U+FE0F），命中映射则返回
 * 图标组件与剥掉前缀的余文；未命中原样返回 null。 */
function matchLeadingIcon(text: string): { Icon: (props: { size?: number; style?: CSSProperties }) => JSX.Element; rest: string } | null {
  if (text.length === 0) return null
  const first = String.fromCodePoint(text.codePointAt(0)!)
  let head = first
  if (text.charCodeAt(first.length) === 0xFE0F) head += '\uFE0F'
  const Icon = LEADING_ICON_MAP[head]
  if (Icon === undefined) return null
  return { Icon, rest: text.slice(head.length).replace(/^ /, '') }
}

/** 行内首图标 + 余文（图标继承文字色 currentColor，基线微调对齐中文字号）。
 *  导出供 turn-nodes 的 showprompt 条复用（同款聊天行观感）。 */
export function LeadingIconText({ text, iconSize = 12 }: { text: string; iconSize?: number }) {
  const leading = matchLeadingIcon(text)
  if (leading === null) return <>{text}</>
  return (
    <>
      <leading.Icon size={iconSize} style={{ marginRight: 5, verticalAlign: '-1px' }} />
      {leading.rest}
    </>
  )
}

/** Single-event node: every dsh-femo/chat event is one chat row. */
export const femoChatDefinition: ConversationNodeDefinition<FemoChatData> = {
  kind: 'femo-role',
  target: 'chat',
  match: (event) => {
    // 'dsh-femo/chat' = pre 2026-09-12 femo→femo rename history; kept
    // renderable so old session logs display identically to new ones.
    if (event.type === 'dsh-femo/chat' || event.type === 'dsh-femo/chat') {
      const d = event.data as FemoChatData
      // 【V5 让位】带 turn 的新版 speaker 由 femo-turn-head 节点接管渲染
      // （head 动态吸附段落头，恒贴内容）；无 turn 的旧 speaker 保留本行渲染。
      if (d.kind === 'speaker' && typeof (event.data as { turn?: unknown }).turn === 'number') return null
      // 【V6.2 让位】带 turn 的新版 prompt（AI 节点 showprompt）同样由
      // femo-turn-head 接管（📢 条渲染在名字行上方，永不分离）；无 turn 的
      // 旧数据与 human 节点 prompt（无 turn 语义）保留本行渲染。
      if (d.kind === 'prompt' && typeof (event.data as { turn?: unknown }).turn === 'number') return null
      // 【2026-09-10 让位】带 turn 的回合失败行由 femo-turn-head 接管（名字行
      // 下方红色失败条，归属恒正确——官方 turnError 行在 par 交错下会挂错
      // 演员名下）；无 turn 的 error 行（引擎通知等）保留本行渲染。
      if (d.kind === 'error' && typeof (event.data as { turn?: unknown }).turn === 'number') return null
      // 【2026-09-10 v7 让位】kind='live' 轻锚是 femo-live-tail 的 start 事件
      // （窗底直播区的定位锚），自身永不渲染为聊天行。
      if (d.kind === 'live') return null
      return { id: String(event.seq), role: 'start' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'dsh-femo/chat') {
      throw new Error('femo-role start requires dsh-femo/chat')
    }
    const d = match.event.data
    const turnOf = typeof (d as { turn?: unknown }).turn === 'number' ? (d as unknown as { turn: number }).turn : undefined
    return {
      ...d.actor === undefined ? {} : { actor: d.actor },
      text: d.text,
      kind: d.kind,
      ...d.visible === undefined ? {} : { visible: d.visible },
      ...turnOf !== undefined ? { turn: turnOf } : {},
      seq: match.event.seq,
    }
  },
  update: (context) => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: 'femo-role',
      id: context.id,
      target: 'chat',
      anchorSeq: context.start?.event.seq ?? context.matches[0]?.event.seq ?? 0,
      location: { kind: 'unresolved' },
      visibility: 'visible',
      data: context.state,
    }
  },
}

/** Render one dsh-femo/chat line. */
export function FemoChatNodeView({ node, useSession, t }: ChatNodeViewProps<'femo-role'>) {
  const { actor, text, kind, visible } = node.data
  const sessionId = useSession(snapshot => snapshot.sessionId)
  const view = useView(sessionId)
  // 【2026-09-11 步2】本行原有的 V6 直播位（kind='stream-host'，2026-08-29 ～）
  // 已整体删除：直播渲染权归显示层 v9 的 femo2-turn-live（按轮入桶）。
  // stream-host 早已无写入方（subagent.ts 2026-08-30 起不再落该行），这里只留
  // 一句显式忽略，防历史残留数据被当成 role 气泡画出来。
  if (kind === 'stream-host') return null
  // View-perspective filter: in a role view, meta lines (notice/error/
  // thinking) are god-only, and dialogue lines show only when the actor's
  // scope includes this viewer. Absent `visible` = visible to everyone.
  if (view === 'offstage') {
    // 戏外视角：主会话=纯 DSH 原生页面（user+主模型），femo 行全部隐藏
    // （角色行/名字行/引擎通知/等待提示都属戏内，上帝窗承载；也遮住旧版本
    // 写进主会话的历史残留行）。唯一例外=sys 运行回执（femo-run 动作成功
    // 的状态条，属戏外系统消息而非戏内内容，host 只写主会话不进投影窗）。
    if (kind !== 'sys') return null
  } else if (view !== 'god') {
    if (kind === 'notice' || kind === 'error' || kind === 'thinking' || kind === 'tool_call') return null
    // speaker 名字行不做 scope 过滤：角色视角也能看到所有角色的名字
    // （内容 turn 由 CSS 按视角隐藏）。
    if (kind !== 'speaker' && visible !== undefined && !visible.includes(view)) return null
  }
  if (kind === 'speaker') {
    // 子代理 turn 首行：发言者名字（V3 起随 turn 骨架落地，紧跟内容；cot/
    // 工具调用/回答由镜像 turn 节点从下一行开始渲染）。直播块已迁 stream-host
    // 节点（镜像流内），本行回归纯名字行。
    return (
      <div>
        <div style={{
          margin: '8px 0 2px',
          fontWeight: 700,
          fontSize: '12.5px',
          color: actorColor(actor ?? 'AI'),
        }}>
          {actor ?? 'AI'}
        </div>
      </div>
    )
  }
  // (kind === 'thinking' 的自绘折叠思考链已按用户要求删除：思考链统一用 dsh 原生 assistant-step 折叠渲染，不再自绘。)
  if (kind === 'tool_call') {
    // Subagent tool invocation line: text is JSON {kind:'call'|'result', name, args?, result?}.
    // Parsing failure falls back to plain text (older sessions).
    let tool: { kind?: string; name?: string; args?: string; result?: string } | null = null
    try { tool = JSON.parse(text) as { kind?: string; name?: string; args?: string; result?: string } } catch { tool = null }
    const name = tool?.name ?? '工具调用'
    const body = tool?.kind === 'result' ? (tool?.result ?? '') : (tool?.args ?? '')
    const MAX_BODY = 400
    const clipped = body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n…（截断，共 ${body.length} 字符）` : body
    return (
      <div style={{
        margin: '2px 0',
        fontSize: '11px',
        fontFamily: 'JetBrains Mono, monospace',
        color: 'var(--dsw-alias-label-tertiary, #999)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        lineHeight: 1.5,
      }}>
        <LeadingIconText iconSize={11} text={tool?.kind === 'result' ? `🔧 ${name} 结果：${clipped}` : `🔧 ${name} 调用：${clipped}`} />
      </div>
    )
  }
  if (kind === 'error') {
    // Engine error: red system-like line (meta, but shown in the transcript).
    return (
      <div style={{
        textAlign: 'left',
        color: 'var(--dsw-alias-state-error-primary, #e5484d)',
        fontSize: '12px',
        padding: '4px 0',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        <LeadingIconText text={text} />
      </div>
    )
  }
  if (kind === 'notice' || kind === 'sys') {
    // sys=femo-run 动作成功的用户回执（只存在于主会话表面），与引擎 notice
    // 共用居中灰字样式；角色视角不过滤它（运行状态对各视角都有效）。
    return (
      <div style={{
        textAlign: 'center',
        color: 'var(--dsw-alias-label-tertiary, #999)',
        fontSize: '12px',
        padding: '6px 0',
      }}>
        <LeadingIconText text={text} />
      </div>
    )
  }
  if (kind === 'prompt') {
    // Announcement / node-hint bar: not a speech bubble, a stage note.
    return (
      <div style={{
        margin: '6px 0',
        padding: '6px 12px',
        borderRadius: '6px',
        borderLeft: '3px solid var(--dsw-alias-button-info-fill, #4a9eff)',
        background: 'color-mix(in srgb, var(--dsw-alias-button-info-fill, #4a9eff) 6%, transparent)',
        color: 'var(--dsw-alias-label-secondary, #666)',
        fontSize: '12px',
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        <LeadingIconText text={text} />
      </div>
    )
  }
  if (kind === 'human_wait') {
    return (
      <div style={{
        margin: '6px 0',
        padding: '8px 12px',
        borderRadius: '8px',
        background: 'color-mix(in srgb, var(--dsw-alias-button-info-fill, #4a9eff) 12%, transparent)',
        border: '1px solid color-mix(in srgb, var(--dsw-alias-button-info-fill, #4a9eff) 40%, transparent)',
        color: 'var(--dsw-alias-label-primary, #222)',
        fontSize: '13px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        <LeadingIconText text={text} />
      </div>
    )
  }
  // role bubble（名字已由 turn 首行的 speaker 行显示，这里只保留文本块）
  if (actor === HUMAN_ROLE_ACTOR) {
    // 【2026-09-06 猫猫拍板】人类节点发言 UI=dsh 原生 user 气泡样式：右对齐、
    // specific-bubble 底色、22px 圆角——与主窗口 user 消息同观感。语义不变
    // （仍是戏内 role 行=喂人类节点的发言，非主模型 user 消息）。样式照抄
    // ui-conversation chat/MessageItem.module.css 的 userRow+bubble，token 全
    // --dsw（主题自动跟随）；字号沿用投影窗对话流 13px（16px 原值在投影窗
    // 密度下突兀），形状/颜色/对齐与原生一致。
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        margin: '6px 0',
      }}>
        <div style={{
          maxWidth: 'min(525px, 82%)',
          background: 'var(--dsw-specific-bubble, var(--dsw-alias-bg-layer-2, #f0f0f0))',
          borderRadius: '22px',
          padding: '10px 16px',
          color: 'var(--dsw-alias-label-primary, #222)',
          fontSize: '13px',
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          <LeadingIconText text={text} />
        </div>
      </div>
    )
  }
  return (
    <div style={{
      margin: '6px 0',
      padding: '8px 12px',
      borderRadius: '8px',
      background: 'var(--dsw-alias-bg-layer-2, #f5f5f5)',
      color: 'var(--dsw-alias-label-primary, #222)',
      fontSize: '13px',
      lineHeight: 1.6,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    }}>
      {text}
    </div>
  )
}
