/**
 * client-ui/editor-page.tsx — 「Femo 编辑器」单页常驻宿主（2026-08-26 架构 v3）。
 *
 * 用户拍板模型：内存里只有一个 femogen 网页（FEMOEditor 实例），内容跟随
 * 「打开的 Session」加载——打开哪个 Session 就加载哪个；切 Session 内容重载。
 * 网页挂在 body 级隐藏容器里（visibility:hidden 但保留视口尺寸，让编辑器
 * 布局计算与可见时一致），**永不卸载**：
 *   - tab 切换（对话↔Femo 编辑器）不卸载 → 画布状态/连接全程存活；
 *   - 「Femo 编辑器」tab 激活 = 锚点注册 → 隐藏容器被**移动到锚点内**（同一个
 *     DOM 节点，React 状态零丢失；锚点注销再移回 body）；
 *   - view-button 上报「当前打开的 femo 主会话」→ 页面内容跟随（打开哪个
 *     Session 加载哪个）。
 *
 * 单页（createRoot 于 body 级 div）——一万个 femo 会话也只占一份编辑器内存。
 * （编辑器实例内的一切状态逻辑：session-state 加载、定稿落盘+409 冲突弹窗、
 *   导出/导入、preflight、restore 报错横幅，全部从 editor-view.tsx 迁来——
 *   editor-view 只剩锚点。【Job 模型 §11.4】AI 触发 run 的 run_request/
 *   triggerRun/run-result 回传链已整体退役——AI 的 femo-run 直调 host
 *   job_start（B1 死于结构），前端只是纯显示者。）
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { femoStreamAcquire, subscribeControlEvents } from './stream-store'
import FEMOEditor from '../../../femoGen/src/FemoWorAuto'

/** 编辑器页需要的注入能力（原 ScriptViewInjected 语义——宿主注入给页面）。 */
export interface EditorPageInjected {
  listScripts(): Promise<string[]>
  readScript(path: string): Promise<string>
  /** sessionId 带上则 host 顺写会话记录 {path, text}（导出/覆盖保存统一格式）。 */
  saveScript(name: string, content: string, sessionId?: string): Promise<string>
  runScript(sessionId: string, scriptPath?: string): Promise<void>
  /** 暂停本会话的活跃 Job（§8.4 B3：pause 归属解析——sessionId 必填，
   *  只认本会话绑定，不再"停别家的戏"）。jobId 可选显式指定（宿主按引擎
   *  档案 host_ref 裁决）。resolve 值带回执：paused:false=该会话无活跃
   *  剧本（前端据此复位运行按钮，2026-09-06 反馈断链修复）；state=引擎侧
   *  Job 现态（paused:true 但 state 非 running=幂等无操作，前端知情提示）。
   *  失败原样 throw（2026-09-07：不再吞成 undefined——femoGen 可见报错）。 */
  pauseScript(sessionId: string, jobId?: number): Promise<{ paused?: boolean; state?: string } | undefined>
  fetchErrors(sessionId: string): Promise<Array<{ ts: number; text: string }>>
  /** 打开 dsh 侧边栏（手机版 femoGen 返回键回调）。 */
  toggleSidebar(): void
}

/**
 * 导入清单条目（导入过 / 导出过的 .femo）。
 * 形状与 host 侧 src/femo-files.ts 的 FemoFileEntry 对齐——刻意不 import 那个
 * 文件：它拉 node:path / node:fs，会把 node 内置模块拖进浏览器包。两处形状
 * 靠这条注释绑定，改一处记得改另一处。
 */
export interface FemoFileEntry {
  /** 绝对路径（清单条目的主键，回传给 /open-femo-file）。 */
  path: string
  /** basename，列表主标题。 */
  name: string
  /** 最近一次来源：导入（系统对话框选的）或导出（保存出来的）。 */
  source: 'import' | 'export'
  firstSeenAt: number
  lastUsedAt: number
  /** host 列清单时现算：文件此刻是否还在盘上（false=变灰不可点）。 */
  exists: boolean
  size?: number
  mtimeMs?: number
}

/**
 * 读 JSON 响应体，把「响应体为空 / 不是 JSON」翻译成人话。
 *
 * 2026-09-11 实测踩坑：dsh 的 webServer 对**未注册的路由**回 `405 Method Not
 * Allowed`，而且响应体是 0 字节——插件改了宿主侧代码但没重启 dsh 时，点导入
 * 就是这个下场。裸 `resp.json()` 会抛 `Failed to execute 'json' on 'Response':
 * Unexpected end of JSON input`，一句和导入八竿子打不着的 JS 报错，用户拿到
 * 完全无从下手（连是网络问题还是代码问题都看不出来）。
 * 这里统一改成「哪个动作 + HTTP 状态 + 最可能的原因」的口径。
 */
async function readJsonOrThrow<T>(resp: Response, what: string): Promise<T> {
  const text = await resp.text()
  if (text.trim().length === 0) {
    throw new Error(resp.status === 405
      ? `${what}失败：HTTP 405（该接口未注册）——宿主侧改动需要重启 dsh 进程才生效`
      : `${what}失败：HTTP ${resp.status}，响应体为空`)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${what}失败：HTTP ${resp.status}，响应不是 JSON：${text.slice(0, 200)}`)
  }
}

// ── 单页 store（模块级：一个页面一个状态，跨组件共享）─────────────────────

interface EditorPageSlice {
  /** 当前应加载内容的 femo 主会话 id（null=无 femo 会话打开）。 */
  target: string | null
  /** 当前激活的「Femo 编辑器」tab 锚点（会话 id + DOM 容器）。 */
  anchor: { sid: string; el: HTMLElement } | null
}

const pageState: EditorPageSlice = { target: null, anchor: null }
const pageListeners = new Set<() => void>()
/** 会话 id → 打开中的会话数（view-button 上报；投影窗与主窗同 sids 合并计数）。 */
const sessionRefs = new Map<string, number>()

function pageNotify(): void {
  for (const listener of [...pageListeners]) listener()
}

function pageSetTarget(sid: string | null): void {
  if (pageState.target === sid) return
  pageState.target = sid
  pageNotify()
}

/** view-button 上报：某 femo 主会话的窗口打开了（主会话/投影窗都算）。 */
export function editorPageOpenSession(sid: string): void {
  sessionRefs.set(sid, (sessionRefs.get(sid) ?? 0) + 1)
  pageSetTarget(sid)
}

/** view-button 上报：某 femo 主会话的窗口关掉了；最后一个关掉的清空目标。 */
export function editorPageCloseSession(sid: string): void {
  const n = (sessionRefs.get(sid) ?? 0) - 1
  if (n > 0) {
    sessionRefs.set(sid, n)
    return
  }
  sessionRefs.delete(sid)
  if (pageState.target === sid && pageState.anchor === null) pageSetTarget(null)
  // 有锚点（编辑器 tab 还开着）时不清：锚点是当前内容的事实来源。
}

/** 「Femo 编辑器」tab 锚点注册（tab 激活 ⇔ 编辑器视图挂载）。 */
export function editorPageRegisterAnchor(sid: string, el: HTMLElement): void {
  pageState.anchor = { sid, el }
  pageSetTarget(sid)
  pageNotify()
}

/** 锚点注销（tab 切走/会话切换/窗口关闭）。同名同元素才清，防多窗把新的误清。 */
export function editorPageUnregisterAnchor(sid: string, el: HTMLElement): void {
  if (pageState.anchor?.sid !== sid || pageState.anchor.el !== el) return
  pageState.anchor = null
  pageNotify()
}

// ── 全局控制 SSE（页面级常驻，管 script_changed）────────────────────────

/** 已挂载页面的 script_changed 重载钩子。 */
let pageReloadRef: (() => void) | null = null

function handleControlEvent(msg: { type?: string; data?: Record<string, unknown> }): void {
  const sid = typeof msg.data?.sessionId === 'string' ? msg.data.sessionId : ''
  if (sid.length === 0) return
  if (msg.type === 'script_changed') {
    // mount/定稿落盘广播：页面内容跟随（当前无目标时采纳；已是目标则重载）。
    console.log(`[femo-page] sse script_changed sid=${sid} target=${pageState.target} anchor=${pageState.anchor?.sid ?? 'none'}`)
    if (pageState.target === null) pageSetTarget(sid)
    if (pageState.target === sid) {
      // eslint-disable-next-line no-console
      console.log(`[femo-page] -> reload page (target match)`)
      pageReloadRef?.()
    }
    return
  }
}

// ── 页面根组件（createRoot 于 body 级隐藏容器）────────────────────────────

/** 页面根容器 DOM（body 级；锚点激活时被移动到锚点内）。 */
let pageRootEl: HTMLElement | null = null

/** 把页面根容器放到正确的位置：锚点内（激活）或 body 隐藏（未激活）。
 *  移动的是同一个 DOM 节点——React 端口/状态零丢失（createRoot 容器如何
 *  被挂接与 React 无关）。 */
function applyPagePlacement(): void {
  const rootEl = pageRootEl
  if (rootEl === null) return
  const anchor = pageState.anchor
  if (anchor !== null && anchor.el.isConnected) {
    if (rootEl.parentNode !== anchor.el) anchor.el.appendChild(rootEl)
    rootEl.style.visibility = 'visible'
    rootEl.style.pointerEvents = 'auto'
    rootEl.style.position = 'absolute'
    rootEl.style.inset = '0'
    // ★ 2026-08-26 「以为的屏幕」修正：隐藏态是 100vw×100vh（视口尺寸），
    // 移入锚点时宽度/高度必须切回 100%（锚点尺寸）——否则编辑器布局始终按
    // 视口算，内容右下超出实际容器（用户实拍「下方/右侧出框」真因）。
    rootEl.style.width = '100%'
    rootEl.style.height = '100%'
    console.log(`[femo-page] placement -> anchor (sid=${anchor.sid})`)
  } else {
    if (rootEl.parentNode !== document.body) document.body.appendChild(rootEl)
    rootEl.style.visibility = 'hidden'
    rootEl.style.pointerEvents = 'none'
    rootEl.style.position = 'fixed'
    rootEl.style.inset = '0'
    rootEl.style.width = '100vw'
    rootEl.style.height = '100vh'
    console.log('[femo-page] placement -> hidden')
  }
}

/** 挂载单页根（client.tsx apply() 调用一次）：body 级隐藏容器 + createRoot。 */
export function mountFemoEditorPage(createInjected: () => EditorPageInjected): void {
  if (pageRootEl !== null) return
  const el = document.createElement('div')
  el.setAttribute('data-femo-editor-page', '')
  el.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;visibility:hidden;pointer-events:none;z-index:0'
  document.body.appendChild(el)
  pageRootEl = el
  createRoot(el).render(<EditorPageRoot injectedFactory={createInjected} />)
  console.log('[femo-page] editor page root mounted (single-instance keep-alive)')
}

function EditorPageRoot({ injectedFactory }: { injectedFactory: () => EditorPageInjected }): JSX.Element {
  const [, force] = useState(0)
  // 渲染期读 target：target 变化经 pageNotify→force 重渲染，连接 effect 以它为
  // dep 按需启停。
  const target = pageState.target
  useEffect(() => {
    const listener = (): void => {
      applyPagePlacement()
      force(x => x + 1)
    }
    pageListeners.add(listener)
    applyPagePlacement()
    // target 变化（会话切换）后锚点可能仍挂着——内容跟随 target，重放位置。
    return () => {
      pageListeners.delete(listener)
    }
  }, [])
  useEffect(() => {
    // 控制事件搭全局 SSE 便车（stream-store 单例，不另开连接）。【2026-09-05
    // 连接池修复】只在页面有 femo 编辑目标时连接：target=null 的纯聊天页不占
    // 长连接。【2026-09-05 晚·Stage2】改走后台池（background: true）：编辑器
    // tab 打开即持有、不看页面可见性——AI 工具随时可能操作 femoGen（script_
    // changed 实时响应是编辑器硬需求），页面切后台也不能断。
    // target=null 期间 script_changed 的自动跟随不生效——AI 侧运行是 host
    // 行为不受影响，femo 会话/编辑器打开时连接已在。
    if (target === null) return
    const release = femoStreamAcquire({ background: true })
    const unsubscribe = subscribeControlEvents(handleControlEvent)
    return () => {
      unsubscribe()
      release()
    }
  }, [target])
  return (
    <div style={{ width: '100%', height: '100%', background: 'transparent' }}>
      {target !== null && (
        <FemoEditorPage
          key={target}
          sessionId={target}
          injected={injectedFactory()}
        />
      )}
    </div>
  )
}

// ── 编辑器页（单实例；key=sessionId 保证切 Session 全量重载）──────────────

type PageState = {
  hasScript: boolean
  script?: string
  scriptPath?: string
  rev?: number
  checkpoint: Record<string, string>
  running?: boolean
  /** 当前 Job 索引（宿主会话记录的 currentJobId）——femoGen 暂停/继续显式
   *  带号、断点覆盖层的数据源。 */
  jobId?: number
  /** 本会话激活过的全部 Job（历史场次回放/续跑候选）。 */
  jobIds?: number[]
  /** 草稿 vs 运行快照一致性（宿主比对）：false=草稿已改动，resume 会被
   *  引擎指纹关拒绝——femoGen 据此渲染"画布与运行快照不一致"横幅。 */
  /** 引擎冷启动（§八.15）：bridge 未就绪——前端"引擎启动中"加载态，
   *  运行按钮禁用，不显示"断点丢失"。 */
  pending?: boolean
  /** 引擎等待人类输入快照（human_wait SET 期间存在）：刷新页面后画布
   *  据此恢复人类输入气泡（不依赖 SSE 重放环覆盖）。 */
  waitingHuman?: {
    waitKey: string
    nodeName?: string
    context?: string
    memory?: string
    showprompt?: string
    prompt?: string
    outVars?: string[]
  }
  /** 上一个 failed Job 的存档错误（宿主重启后 SSE 重放环清空，报错只能
   *  从档案补）——恢复面只进调试窗日志，不拦画布、不弹横幅。 */
  lastError?: string
} | null

const conflictBtnStyle = {
  padding: '6px 14px',
  borderRadius: 8,
  cursor: 'pointer',
  fontSize: 13,
  background: 'var(--dsw-alias-bg-layer-3, #fff)',
  border: '1px solid var(--dsw-alias-border-l2, #ddd)',
} as const

function FemoEditorPage({ sessionId, injected }: { sessionId: string; injected: EditorPageInjected }): JSX.Element {
  const [state, setState] = useState<PageState>(null)
  /** 409 冲突弹窗：localFemo=被拒的本地文本；remoteRev=裁决用的服务端当前 rev。 */
  const [conflict, setConflict] = useState<{ localFemo: string; remoteRev: number } | null>(null)
  /** 编辑器恢复/解析失败横幅：用户可见 + 上报 host 并入 errors（主模型经 femo-mount/run 工具结果可见）。 */
  const [editorNotice, setEditorNotice] = useState<string | null>(null)
  /** 已上报过的 restore 错误（消息级去重）：同一条错误只报一次，避免多路
   *  触发（挂载/script_changed/remount）累积 N 条相同 POST。新记录载入时
   *  重置（剧本修复后再犯同错仍能重新上报）。 */
  const lastRestoreErrorRef = useRef<string | null>(null)

  const onRestoreError = useCallback((message: string): void => {
    if (lastRestoreErrorRef.current === message) return
    lastRestoreErrorRef.current = message
    setEditorNotice(message)
    void fetch('/dsh-femo/editor-error', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, message, source: 'restore' }),
    }).catch((error: unknown) => { console.warn('[dsh-femo] editor-error 上报失败:', error) })
  }, [sessionId])

  /** 拉取 record 侧的原文：「放弃修改直接跑」时作为定稿覆盖前端两处。 */
  const getRecordScript = useCallback(async (): Promise<string | undefined> => {
    try {
      const response = await fetch(`/dsh-femo/session-state?sessionId=${encodeURIComponent(sessionId)}`)
      const data = await response.json() as { ok?: boolean; script?: string }
      return data.ok === true ? data.script : undefined
    } catch {
      return undefined
    }
  }, [sessionId])

  const loadSessionState = useCallback(async (): Promise<void> => {
    console.log(`[femo-page] loadSessionState start sid=${sessionId}`)
    const response = await fetch(`/dsh-femo/session-state?sessionId=${encodeURIComponent(sessionId)}`)
    const data = await response.json() as { ok?: boolean; script?: string; scriptPath?: string; rev?: number; checkpoint?: Record<string, string>; running?: boolean; pending?: boolean; jobId?: number; jobIds?: number[]; lastError?: string; waitingHuman?: { waitKey: string; nodeName?: string; context?: string; memory?: string; showprompt?: string; prompt?: string; outVars?: string[] } }
    if (data.ok === true) {
      // 剧本载入新记录：上次的「恢复失败」横幅自动收起（若新剧本仍解析失败，
      // restore effect 会再次 onRestoreError 重新上报弹出——时序上在本次 setState
      // 之后，所以这里先清是安全的）。
      setEditorNotice(null)
      // 新记录载入=新的恢复上下文：清掉去重标记，剧本修复后再犯同错仍可上报。
      lastRestoreErrorRef.current = null
      setState(prev => {
        // 引用复用：script/checkpoint 内容未变则沿用旧引用，避免 initialScript/
        // initialCheckpoint prop 换新对象触发 restore effect 无谓重跑
        // （每重跑一次坏剧本就多上报一次，是重复 editor_errors 的温床）。
        const sameScript = prev !== null && data.script !== undefined && prev.script === data.script
        const sameCheckpoint = prev !== null && prev.checkpoint !== undefined
          && JSON.stringify(prev.checkpoint) === JSON.stringify(data.checkpoint ?? {})
        return {
          hasScript: data.script !== undefined,
          script: sameScript ? prev.script : data.script,
          scriptPath: data.scriptPath,
          rev: data.rev ?? 0,
          checkpoint: sameCheckpoint ? prev.checkpoint : (data.checkpoint ?? {}),
          running: data.running === true,
          jobId: data.jobId,
          ...(data.jobIds !== undefined ? { jobIds: data.jobIds } : {}),
          // 引擎冷启动（§八.15）：pending=true → FEMOEditor enginePending
          // → 运行按钮禁用+「引擎启动中」，不显示"断点丢失"。
          pending: data.pending === true,
          ...(data.waitingHuman !== undefined ? { waitingHuman: data.waitingHuman } : {}),
          ...(data.lastError !== undefined ? { lastError: data.lastError } : {}),
        }
      })
      console.log(`[femo-page] state loaded sid=${sessionId} script=${data.script === undefined ? 'undefined' : String(data.script.length) + 'ch'} rev=${String(data.rev ?? 0)} jobId=${String(data.jobId ?? '-')} pending=${data.pending === true}`)
    }
  }, [sessionId])

  /** 切 Session / 新目标：清态 + 重载（key=sessionId 已保证编辑器重挂载）。 */
  useEffect(() => {
    setState(null)
    setConflict(null)
    setEditorNotice(null)
    void loadSessionState().catch(() => { /* 编辑器仍可空白启动 */ })
    pageReloadRef = loadSessionState
    return () => { pageReloadRef = null }
  }, [sessionId, loadSessionState])

  // 断点位置：主流程分支优先，其次任一分支（画布按节点 label 匹配）。
  const checkpointNode = state === null
    ? undefined
    : state.checkpoint['__main__'] ?? Object.values(state.checkpoint)[0]

  const persistScript = (femo: string): void => {
    void fetch('/dsh-femo/session-script', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, femo, ...(state?.rev === undefined ? {} : { baseRev: state.rev }) }),
    })
      .then(async (response) => {
        if (response.status !== 409) return
        const data = await response.json().catch(() => null) as { ok?: boolean; record?: { rev?: number } } | null
        setConflict({ localFemo: femo, remoteRev: data?.record?.rev ?? 0 })
      })
      .catch((error: unknown) => {
        console.warn('[dsh-femo] persist write failed:', error)
      })
  }

  /** 冲突裁决·加载最新：丢弃本地文本，按服务端当前记录重载画布。 */
  const resolveConflictByReload = (): void => {
    setConflict(null)
    void loadSessionState()
      .catch((error: unknown) => { console.warn('[dsh-femo] conflict reload failed:', error) })
  }

  /** 冲突裁决·保留我的编辑：以服务端最新 rev 为基准强制重写本地文本。 */
  const resolveConflictByOverride = (): void => {
    if (conflict === null) return
    const femo = conflict.localFemo
    void fetch('/dsh-femo/session-script', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, femo, baseRev: conflict.remoteRev }),
    })
      .then(async (response) => {
        if (response.ok) {
          const data = await response.json().catch(() => null) as { ok?: boolean; rev?: number } | null
          setState(prev => prev === null ? prev : { ...prev, rev: data?.rev ?? prev.rev })
          setConflict(null)
          return
        }
        if (response.status === 409) {
          const data = await response.json().catch(() => null) as { record?: { rev?: number } } | null
          setConflict({ localFemo: femo, remoteRev: data?.record?.rev ?? conflict.remoteRev })
        }
      })
      .catch((error: unknown) => { console.warn('[dsh-femo] conflict override failed:', error) })
  }

  /** 预检：未保存（无剧本地址）时，剧本里的相对 file: 引用非法——只支持绝对地址。 */
  const preflightCheck = (femo: string): string | null => {
    if (state?.scriptPath !== undefined && state.scriptPath.length > 0) return null
    const refs: string[] = []
    const re = /(?:file|文件)[:：]\s*["'“”]([^"'“”]+)["'“”]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(femo)) !== null) refs.push(m[1])
    const isAbs = (p: string): boolean => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')
    const relative = refs.filter(p => !isAbs(p))
    if (relative.length === 0) return null
    return `剧本未保存：依赖文件只支持绝对地址。以下引用是相对路径：${relative.join('、')}。请先「导出 .FEMO」保存剧本（相对路径将基于剧本文件位置解析），或改用绝对路径。`
  }

  const onRun = async (femo: string, opts?: { reset?: boolean; jobId?: number }): Promise<void> => {
    const problem = preflightCheck(femo)
    if (problem !== null) throw new Error(problem)
    const response = await fetch('/dsh-femo/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        femo,
        ...(opts?.reset === true ? { reset: true } : {}),
        // 显式续跑目标 Job 号（femoGen「继续」按钮——续跑旧 Job 时不依赖
        // 宿主 currentJobId 指针；fresh 会忽略它）。
        ...(typeof opts?.jobId === 'number' && Number.isFinite(opts.jobId) ? { jobId: Math.trunc(opts.jobId) } : {}),
      }),
    })
    let message = `run HTTP ${response.status}`
    try {
      const data = await response.json() as { ok?: boolean; error?: string }
      if (data.ok === true) return
      message = data.error ?? message
    } catch {
      // non-JSON body: keep the status message
    }
    throw new Error(message)
  }
  const onPause = async (jobId?: number): Promise<{ paused?: boolean; state?: string } | undefined> => {
    // 回执透传（paused:false=无活跃剧本）——femoGen 据此复位运行按钮
    // （2026-09-06 反馈断链修复：此前该结果被静默吞掉，按钮卡死在"暂停"态）。
    // 【2026-09-07 214 事故收尾】失败不再吞成本函数 undefined（femoGen 零感知
    // 的静默链终点）——原样上抛，由画布的暂停反馈条可见报错。
    return await injected.pauseScript(sessionId, jobId)
  }

  /** 「未改动」提醒弹窗状态：onExport 挂起等待用户裁决（依然保存/另存为/返回画布）。 */
  const [saveReminder, setSaveReminder] = useState<{
    path: string
    resolve: (choice: 'save' | 'saveas' | 'back') => void
  } | null>(null)

  /** 导出（2026-08-30 三态行为，猫猫拍板）：
   *  无 path → 系统「保存文件」对话框选位置+命名保存（首次导出，2026-09-06
   *  起不再走选目录+前端拼名）；
   *  有 path 且文件内容与 Editor Text 一致 → 弹「未改动」提醒（依然保存/另存为/返回画布）；
   *  有 path 且不一致 → Editor Text 覆盖写入该文件 + 记录 {path, text} 同步更新
   *  （save-script 带 sessionId 一步完成文件+记录）。
   *  比对基准=path 文件内容（CRLF 归一）——它是「上次保存版本」的权威载体，
   *  对旧记录（纯 {path}）与运行时比对逻辑剥离 text 的情况都正确。
   *  返回 undefined = 用户选了「返回编辑画布」（未保存）。 */
  const onExport = async (femo: string, name: string): Promise<string | undefined> => {
    const norm = (s: string): string => s.replace(/\r\n/g, '\n')
    const currentPath = state?.scriptPath
    if (currentPath !== undefined && currentPath.length > 0) {
      let fileText: string | undefined
      try {
        fileText = await injected.readScript(currentPath)
      } catch {
        fileText = undefined // 文件被外部删除：视为「有改动」→ 覆盖保存即重建该文件
      }
      if (fileText !== undefined && norm(fileText) === norm(femo)) {
        const choice = await new Promise<'save' | 'saveas' | 'back'>((resolve) => {
          setSaveReminder({ path: currentPath, resolve })
        })
        if (choice === 'back') return undefined
        if (choice === 'save') {
          // 依然保存：内容相同也覆盖写回原地址（会话记录 {path, text} 一并刷新）。
          const saved = await injected.saveScript(currentPath, femo, sessionId)
          setState(prev => prev === null ? prev : { ...prev, scriptPath: saved, script: femo })
          return saved
        }
        // saveas → 落到下方另存为流程（新地址 + 记录跟随新地址）
      } else {
        const saved = await injected.saveScript(currentPath, femo, sessionId)
        setState(prev => prev === null ? prev : { ...prev, scriptPath: saved, script: femo })
        return saved
      }
    }
    // 首次保存/另存为：host 弹系统「保存文件」对话框（默认文件名=项目名，
    // 2026-09-06 起不再走「选目录+前端拼名」）。拿到完整路径后 saveScript
    // 直写（绝对路径 path 直写语义）。用户取消返回 undefined（未保存，与
    // 「返回画布」同口径——前端静默，不弹提示）。
    const safe = name.replace(/[\\/:*?"<>|]/g, '_').replace(/\.femo$/i, '')
    const pickResp = await fetch('/dsh-femo/pick-save-path', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: safe }),
    })
    const pickData = await readJsonOrThrow<{ ok?: boolean; path?: string | null; error?: string }>(pickResp, '保存对话框')
    if (pickData.ok !== true) {
      throw new Error(pickData.error ?? '保存对话框失败')
    }
    if (typeof pickData.path !== 'string' || pickData.path.length === 0) {
      return undefined
    }
    const saved = await injected.saveScript(pickData.path, femo, sessionId)
    setState(prev => prev === null ? prev : { ...prev, scriptPath: saved, script: femo })
    return saved
  }

  /** 打开一条剧本的收尾（引用式，2026-08-30 语义不变）：写会话记录 {path, text}
   *  + 更新本地状态。**两条入口共用这一段**——系统对话框选中的、清单里挑的，
   *  落点必须一模一样（画布、editor 文本、后台 scriptPath 全部跟上），否则
   *  「从清单打开」会变成一种与「直接打开」不同的半吊子状态。
   *  记录写 {path, text} 是 mount 同款并存格式，不再复制到 projects/。 */
  const recordAndLoad = async (path: string, content: string): Promise<{ path: string; content: string }> => {
    await fetch('/dsh-femo/session-script', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, scriptPath: path, femo: content }),
    })
    setState(prev => prev === null ? prev : { ...prev, scriptPath: path, script: content })
    return { path, content }
  }

  /** 导入·第二级（电脑端专属）：host 弹系统文件选择器（浏览器 FileReader 拿不到
   *  完整路径，引用式导入必须由 host 侧选）。用户取消返回 null。 */
  const onImport = async (): Promise<{ path: string; content: string } | null> => {
    const resp = await fetch('/dsh-femo/pick-script', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const data = await readJsonOrThrow<{ ok?: boolean; path?: string | null; content?: string; error?: string }>(resp, '导入（系统文件选择器）')
    if (data.ok !== true) throw new Error(data.error ?? 'pick-script failed')
    // 提取局部常量再守卫：属性窄化不保留进 setState 回调（TS2345 实测）。
    const pickedPath = data.path
    const pickedContent = data.content
    if (typeof pickedPath !== 'string' || pickedPath.length === 0 || pickedContent === undefined) return null
    return await recordAndLoad(pickedPath, pickedContent)
  }

  /** 导入·第一级：取「导入过 / 导出过」的历史清单（权威在 host 侧
   *  src/femo-files.ts 的账本）。手机端只有这一级——系统文件对话框开在电脑
   *  上，手机够不着，给了也是死路。 */
  const onListFemoFiles = async (): Promise<FemoFileEntry[]> => {
    const resp = await fetch('/dsh-femo/femo-files', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const data = await readJsonOrThrow<{ ok?: boolean; files?: FemoFileEntry[]; error?: string }>(resp, '读取导入清单')
    if (data.ok !== true) throw new Error(data.error ?? '读取导入清单失败')
    return data.files ?? []
  }

  /** 导入·从清单里选一条：host 读盘取正文 → 与「浏览选中」同一段收尾。 */
  const onPickFemoFile = async (path: string): Promise<{ path: string; content: string }> => {
    const resp = await fetch('/dsh-femo/open-femo-file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    const data = await readJsonOrThrow<{ ok?: boolean; path?: string; content?: string; error?: string }>(resp, '打开文件')
    if (data.ok !== true) throw new Error(data.error ?? '打开失败')
    const pickedPath = data.path
    const pickedContent = data.content
    if (typeof pickedPath !== 'string' || pickedPath.length === 0 || pickedContent === undefined) {
      throw new Error('打开失败：host 返回的文件数据不完整')
    }
    return await recordAndLoad(pickedPath, pickedContent)
  }

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <FEMOEditor
        plugin
        sessionId={sessionId}
        enginePending={state?.pending === true}
        onRun={onRun}
        onPause={onPause}
        onPersistScript={persistScript}
        getRecordScript={getRecordScript}
        onExport={onExport}
        onImport={onImport}
        onListFemoFiles={onListFemoFiles}
        onPickFemoFile={onPickFemoFile}
        onBackToShell={injected.toggleSidebar}
        savedPath={state?.scriptPath}
        initialScript={state?.script}
        initialCheckpoint={checkpointNode}
        initialRunning={state?.running === true}
        initialJobId={state?.jobId}
        jobIds={state?.jobIds}
        initialWaitingHuman={state?.waitingHuman}
        initialLastError={state?.lastError}
        onRestoreError={onRestoreError}
      />
      {conflict !== null && createPortal(
        <div style={{
          position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            maxWidth: 420, width: 'calc(100% - 48px)', padding: '18px 20px', borderRadius: 12,
            background: 'color-mix(in srgb, var(--dsw-alias-bg-layer-2, #f5f5f5) 96%, transparent)',
            border: '1px solid var(--dsw-alias-border-l2, #e0e0e0)', boxShadow: '0 8px 28px rgba(0,0,0,0.22)',
            fontSize: 13, lineHeight: 1.6,
          }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>⚔️ 剧本冲突</div>
            <div style={{ color: 'var(--dsw-alias-label-secondary, #666)', marginBottom: 14 }}>
              本窗口的编辑和其他窗口/设备的保存冲突了（对方先写入）。以哪个为准？
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={resolveConflictByReload} style={conflictBtnStyle}>加载最新版本</button>
              <button
                onClick={resolveConflictByOverride}
                style={{ ...conflictBtnStyle, color: '#fff', background: '#d96b2b', borderColor: '#d96b2b' }}
              >保留我的编辑</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {saveReminder !== null && createPortal(
        <div style={{
          position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            maxWidth: 420, width: 'calc(100% - 48px)', padding: '18px 20px', borderRadius: 12,
            background: 'color-mix(in srgb, var(--dsw-alias-bg-layer-2, #f5f5f5) 96%, transparent)',
            border: '1px solid var(--dsw-alias-border-l2, #e0e0e0)', boxShadow: '0 8px 28px rgba(0,0,0,0.22)',
            fontSize: 13, lineHeight: 1.6,
          }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>📤 你并未改动文本</div>
            <div style={{ color: 'var(--dsw-alias-label-secondary, #666)', marginBottom: 14, wordBreak: 'break-all' }}>
              当前编辑器文本和 {saveReminder.path} 里保存的版本一样。可以依然保存（覆盖写回原文件）、另存为新文件，或返回画布（若你是忘了先「图到文本」把画布改动应用过来）。
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => { const r = saveReminder; setSaveReminder(null); r.resolve('back') }}
                style={conflictBtnStyle}
              >返回编辑画布</button>
              <button
                onClick={() => { const r = saveReminder; setSaveReminder(null); r.resolve('saveas') }}
                style={conflictBtnStyle}
              >另存为</button>
              <button
                onClick={() => { const r = saveReminder; setSaveReminder(null); r.resolve('save') }}
                style={{ ...conflictBtnStyle, color: '#fff', background: '#d96b2b', borderColor: '#d96b2b' }}
              >依然保存</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
      {editorNotice !== null && createPortal(
        <div style={{
          position: 'fixed', left: 12, right: 12, bottom: 12, zIndex: 300,
          display: 'flex', gap: 8, alignItems: 'flex-start',
          padding: '10px 14px', borderRadius: 10, margin: '0 auto', maxWidth: 560,
          background: 'color-mix(in srgb, #fdecea 92%, transparent)',
          border: '1px solid #e5b3ad', boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
          fontSize: 12.5, lineHeight: 1.55,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, marginBottom: 2 }}>⚠️ 剧本恢复失败（已上报主模型）</div>
            <div style={{ color: 'var(--dsw-alias-label-secondary, #666)', whiteSpace: 'pre-wrap' }}>{editorNotice}</div>
          </div>
          <button
            onClick={() => setEditorNotice(null)}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 2 }}
            title="关闭"
          >✕</button>
        </div>,
        document.body,
      )}
    </div>
  )
}
