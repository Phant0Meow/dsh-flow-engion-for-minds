/**
 * client-ui/proj2/turn-view.tsx — 显示层 v9 的唯一渲染器（头 / 直播尾两段）。
 *
 * 一轮 = 一个身份（turn）+ 两个渲染位，两个位共用同一份台账（ledger.ts）：
 *
 *   femo2-turn       轮头：showprompt📢 + 角色名 + 失败条。**本段落盘后才露面**
 *                   （锚=段首内容 seq−0.5）——流式期由直播尾承担，避免"名字和
 *                   内容分家"（那种"甲头 乙头 甲内容"的错位正是旧链路病症）。
 *   femo2-turn-live  直播尾：showprompt + 角色名 + 直播块（cot/工具/回答）+ Deep
 *                   diving。锚=1e12+开轮 seq（窗底，按激活顺序排列，并发不穿插）。
 *                   段落落盘（turn/end）即永久隐藏，内容交给官方区块。
 *
 * 「身」（cot / 工具调用 / 回答 / 轮内 steer）不由本文件画——那是官方渲染器
 * 按段落闸门整段落盘的原生事件画的。本文件只画 femo 自己的 meta（📢/名字/失败）
 * 与零落盘的直播流。这条分工是 v9 能"不再打架"的前提。
 */

import { useMemo } from 'react'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatNodeViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  femo2TurnHeadAnchor, femo2TurnHeadVisible, femo2TurnLiveAnchor, femo2TurnLiveVisible,
  femo2TurnMatch, femo2TurnStart, femo2TurnUpdate, femo2TurnVisibleTo,
  type Femo2TurnState,
} from './ledger'
import { useFemo2Live } from './frame-router'
import { projectionWindowOf, windowShowsActor } from './window-id'
import { FemoStreamLive, FemoTurnStatus } from '../femo-stream-live'
import { useView } from '../view-state'
import { actorColor, LeadingIconText } from '../chat-node'
import { femoProjectionActorKey } from '../stream-store'

/** 轮头渲染载荷。 */
export interface Femo2TurnData {
  readonly turn: number
  readonly actor: string
  readonly showprompt?: string
  readonly error?: string
  readonly visible?: readonly string[]
}

/** 直播尾渲染载荷。 */
export interface Femo2TurnLiveData {
  readonly turn: number
  readonly actor: string
  readonly actorKey: string
  readonly showprompt?: string
  readonly visible?: readonly string[]
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ChatNodeDataMap {
    'femo2-turn': Femo2TurnData
    'femo2-turn-live': Femo2TurnLiveData
  }
}

// ── 轮头 ──────────────────────────────────────────────────────────────────

export const femo2TurnDefinition: ConversationNodeDefinition<Femo2TurnState> = {
  kind: 'femo2-turn',
  target: 'chat',
  match: femo2TurnMatch,
  start: (_context, match) => femo2TurnStart(match),
  update: femo2TurnUpdate,
  publication: () => 'immediate',
  buildViewNode: (context) => {
    const state = context.state
    // ⚠️【2026-09-11 Job 790 实锤】**发布过的 target 绝不能再 return null**——
    // 官方装配器 buildTargetUpserts 对"已物化节点被撤回"直接抛错：
    //   "withdrew materialized target 'chat'; return the same key with hidden visibility instead"
    // 流式期本节点不露面，改成"同 key + visibility:'hidden'"。只有从未 start
    // （state undefined，从未发布过）才允许返回 null。
    if (state === undefined) return null
    const shown = state.actor !== '' && femo2TurnHeadVisible(state)
    return {
      key: context.key,
      kind: 'femo2-turn',
      id: context.id,
      target: 'chat',
      anchorSeq: femo2TurnHeadAnchor(context),
      location: { kind: 'unresolved' },
      visibility: shown ? 'visible' : 'hidden',
      data: {
        turn: state.turn,
        actor: state.actor,
        ...state.showprompt !== undefined ? { showprompt: state.showprompt } : {},
        ...state.error !== undefined ? { error: state.error } : {},
        ...state.visible !== undefined ? { visible: state.visible } : {},
      },
    }
  },
}

/** 📢 showprompt 条（样式与 femo-role 的 prompt 行同款）。 */
function ShowpromptBar({ text }: { text: string }) {
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
      <LeadingIconText iconSize={11} text={text.startsWith('📢') ? text : `📢 ${text}`} />
    </div>
  )
}

/** 角色名行（名字彩色，非气泡）。 */
function ActorLine({ actor }: { actor: string }) {
  return (
    <div style={{ fontWeight: 700, fontSize: '12.5px', color: actorColor(actor) }}>
      {actor}
    </div>
  )
}

export function Femo2TurnNodeView({ node, useSession, t: _t }: ChatNodeViewProps<'femo2-turn'>) {
  const sessionId = useSession(snapshot => snapshot.sessionId)
  const view = useView(sessionId)
  const { actor, showprompt, error, visible } = node.data
  if (view === 'offstage') return null
  if (!femo2TurnVisibleTo(view, visible)) return null
  return (
    <div style={{ margin: '8px 0 2px' }}>
      {showprompt !== undefined && <ShowpromptBar text={showprompt} />}
      <ActorLine actor={actor} />
      {error !== undefined && (
        <div style={{
          margin: '2px 0 4px',
          color: 'var(--dsw-alias-state-error-primary, #e5484d)',
          fontSize: '12px',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}>
          <LeadingIconText iconSize={11} text={error} />
        </div>
      )}
    </div>
  )
}

// ── 直播尾 ────────────────────────────────────────────────────────────────

export const femo2TurnLiveDefinition: ConversationNodeDefinition<Femo2TurnState> = {
  kind: 'femo2-turn-live',
  target: 'chat',
  match: femo2TurnMatch,
  start: (_context, match) => femo2TurnStart(match),
  update: femo2TurnUpdate,
  publication: () => 'immediate',
  buildViewNode: (context) => {
    const state = context.state
    // 同轮头：发布过的节点只能"隐藏"不能"撤回"（官方装配器会抛错，见文件头注释）。
    if (state === undefined) return null
    // 本段一落盘（turn/start 到达）直播尾当场退场：官方区块已在窗内就位、
    // 轮头已接棒，此处再画就是同一轮两个名字。判据见 femo2TurnLiveVisible
    // （不再依赖 turn/end 是否被装配器喂进来——Job 787 实测它可能被投递链路
    // 吞掉，导致空名字行赖着不走 25 秒）。
    const shown = state.actor !== '' && femo2TurnLiveVisible(state)
    return {
      key: context.key,
      kind: 'femo2-turn-live',
      id: context.id,
      target: 'chat',
      anchorSeq: femo2TurnLiveAnchor(context),
      location: { kind: 'unresolved' },
      visibility: shown ? 'visible' : 'hidden',
      data: {
        turn: state.turn,
        actor: state.actor,
        actorKey: femoProjectionActorKey(state.actor),
        ...state.showprompt !== undefined ? { showprompt: state.showprompt } : {},
        ...state.visible !== undefined ? { visible: state.visible } : {},
      },
    }
  },
}


export function Femo2TurnLiveNodeView({ node, useSession, t }: ChatNodeViewProps<'femo2-turn-live'>) {
  const sessionId = useSession(snapshot => snapshot.sessionId)
  const view = useView(sessionId)
  const win = useMemo(() => projectionWindowOf(sessionId), [sessionId])
  const { turn, actor, actorKey, showprompt, visible } = node.data
  const inWindow = windowShowsActor(win.winActorKey, actorKey)
  const eligible = view !== 'offstage' && inWindow && femo2TurnVisibleTo(view, visible) && win.mainSid !== undefined
  const live = useFemo2Live(eligible ? win.mainSid : undefined, eligible ? turn : undefined)
  // 【2026-09-11 v9.3 修正·用户实测】必须"**有内容 或 在飞**"才露面——不能"锚一到就画"。
  // 开轮锚点由宿主在 turn/start 写下，而主模型可能还在思考/调工具（几十秒没有输出），
  // 此时飘一个孤零零的名字行会看起来像"上一轮末尾又冒出个导演"（用户原话：复制点赞
  // 那堆按钮之前怎么又出现一个导演）。窗底本来就有官方的 turn-tail 做"进行中"指示，
  // 我们不需要挂空壳。
  const showLive = live.blocks.length > 0 || live.running

  return (
    <div style={{ margin: '10px 0 4px' }}>
      {showprompt !== undefined && <ShowpromptBar text={showprompt} />}
      <ActorLine actor={actor} />
      {live.blocks.length > 0 && <FemoStreamLive blocks={live.blocks} t={t} />}
      {live.running && <FemoTurnStatus startTime={live.since} />}
    </div>
  )
}
