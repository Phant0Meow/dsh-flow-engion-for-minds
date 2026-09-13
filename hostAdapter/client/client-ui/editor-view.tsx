/**
 * client-ui/editor-view.tsx — 「Femo 编辑器」标签页锚点（conversation.view）。
 *
 * 2026-08-26 架构 v3：编辑器不再是本标签页的私有儿子——它变成「单页常驻
 * 宿主」（editor-page.tsx，body 级隐藏容器里永远挂着一个 FEMOEditor 实例）
 * 的**锚点**：本组件只在「Femo 编辑器」tab 激活时挂载（conversation.view
 * only: active.id），此时把宿主容器的 DOM 挪进自己内部显示；tab 切走时注销，
 * 宿主容器挪回隐藏位——编辑器本体从头到尾不卸载（状态/dirty/SSE 全部存活）。
 * proj 窗（femo-proj-*）挂母会话 id，与主窗指回同一个编辑器实例。
 *
 * 遗留说明（行为零变化）：tab 激活时隐藏底部 composer、`data-conversation-
 * composer-overlay` 高度契约（dsh 本体 CSS 依赖）都保留在本锚点。
 */

import { useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react'
import { editorPageRegisterAnchor, editorPageUnregisterAnchor } from './editor-page'

export interface ScriptViewInjected {
  listScripts(): Promise<string[]>
  readScript(path: string): Promise<string>
  /** sessionId 带上则 host 顺写会话记录 {path, text}（导出/覆盖保存统一格式）。 */
  saveScript(name: string, content: string, sessionId?: string): Promise<string>
  /** Play a script on the CURRENT session (must be Femo mode). */
  runScript(sessionId: string, scriptPath?: string): Promise<void>
  /** Hard-pause the session's running Job (§8.4 B3：sessionId 归属解析必填)；
   *  the checkpoint stays for resume. jobId 显式指定时宿主按引擎档案 host_ref
   *  裁决归属（内存镜像滞后也能停——2026-09-06 暂停失效事故的正解路径）。
   *  resolve 值带宿主回执（paused:false=该会话无活跃剧本，前端据此复位按钮）。 */
  pauseScript(sessionId: string, jobId?: number): Promise<{ paused?: boolean } | undefined>
  fetchErrors(sessionId: string): Promise<Array<{ ts: number; text: string }>>
  /** 打开 dsh 侧边栏（手机版 femoGen 返回键回调）。 */
  toggleSidebar(): void
}

type FemoScriptViewProps = { sessionId: string } & ScriptViewInjected

/** 画布可视化编辑器（femoGen 插件模式）单页宿主的锚点：
 *  挂载时注册锚点（母会话 id → 本容器 DOM）→ 单页宿主把编辑器 DOM 挪进来；
 *  卸载时注销 → 编辑器 DOM 挪回隐藏位（状态不丢）。 */
export function FemoEditorView(props: FemoScriptViewProps & {
  /** 会话槽标准 share（运行时对 session-scoped 槽位必传）：proj 窗解析母会话用。 */
  useSessions?: (sel: (s: { byId: Record<string, { parentId?: string } | undefined> }) => string | undefined) => string | undefined
}) {
  // proj 窗入口（2026-08-23）：编辑器数据全部挂主会话——剧本记录/断点/运行态
  // 都在主 sid 名下。母 id 从会话表 parentId 取（proj id 的角色键可含 - ，字符串
  // 反解不可逆）；在主会话本体打开时原样使用自身 id。
  const rawSessionId = props.sessionId
  const motherId = props.useSessions?.((s) => {
    const summary = s.byId[rawSessionId]
    return typeof summary?.parentId === 'string' ? summary.parentId : undefined
  })
  const sessionId = typeof rawSessionId === 'string'
    && rawSessionId.startsWith('femo-proj-')
    && typeof motherId === 'string'
    ? motherId
    : rawSessionId
  const anchorRef = useRef<HTMLDivElement | null>(null)

  // 锚点注册/注销：useLayoutEffect 保证卸载时（DOM 移除前）先把编辑器 DOM
  // 挪回隐藏位。宿主侧 applyPagePlacement 幂等（跨会话切换/快速切 tab 安全）。
  useLayoutEffect(() => {
    const el = anchorRef.current
    if (el === null) return
    editorPageRegisterAnchor(sessionId, el)
    return () => { editorPageUnregisterAnchor(sessionId, el) }
  }, [sessionId])

  // 「Femo 编辑器」标签页激活时隐藏底部 composer，切走时恢复。
  // conversation.view 只渲染激活的视图（only: active.id），所以本组件挂载
  // ⇔ 该标签页激活。不做 composer 链 takeover：其 select 只在渲染时调用，
  // 无法感知 tab 切换，而改 dsh 本体（ComposerChainProps 加字段）会破坏
  // 插件自包含。composer seat / scroll body 的 data 属性是 dsh web 的稳定
  // DOM 契约（skeleton 测试依赖 data-composer-seat）。
  useEffect(() => {
    const scrollBody = document.querySelector('[data-conversation-scroll]')
    const seat = scrollBody?.querySelector<HTMLElement>('[data-composer-seat]') ?? null
    if (seat === null) return
    seat.style.display = 'none'
    return () => { seat.style.display = '' }
  }, [])

  return (
    // data-conversation-composer-overlay：dsh 本体 CSS 据此给 viewArea
    // 确定高度（flex: 1 1 0 + min-height: 0 + overflow: hidden），宿主编辑
    // 器 DOM 以 absolute inset:0 落在本容器内。
    <div ref={anchorRef} data-conversation-composer-overlay="" style={{ position: 'relative', height: '100%' } as CSSProperties} />
  )
}
