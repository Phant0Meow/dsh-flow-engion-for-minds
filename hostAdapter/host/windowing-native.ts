/**
 * windowing-native.ts — 原生 DSH（0.1.3+ stock 构建）投影窗适配层。
 *
 * 与原 projection.ts 投影窗并存：meow fork（有 registerSessionEventType）走原
 * 路径，行为逐字节不变；原生构建走本层。原 projection.ts 一行未改——切换在
 * 调用处（broadcastCompat/projectedCompat，内部按版本 if 分流）与 index.ts
 * 的安装点完成。
 *
 * 原生版核心事实（2026-09-08 vanilla-0.1.3-alpha.2 实测，探针
 * probe-ignorable.mjs 3/3）：
 *  - 只有 agent-loop 创建事务开的写句柄才落盘（core/session src/index.ts：
 *    "a session published outside that lifecycle persists nothing"）。投影窗
 *    是裸 sessions.create ⇒【永不落盘】：自定义事件不会被持久层拒绝（无砖、
 *    无 ignorable 需求），代价是窗内容重启即失。
 *  - 主会话走 ctx.agents.create（agent-loop 事务）⇒ 有 writer：原生持久层按
 *    KNOWN_SESSION_EVENT_TYPES 白名单拒载未知类型。官方 stock 没有本插件事件
 *    ⇒ 主会话不能写 dsh-femo/chat（写入后下次冷恢复即拒载，且 id 被
 *    SessionAlreadyExistsError 占死）；【2026-09-09 深夜改版】部署可给白名单
 *    打补丁（本实验室 3083 构建已打）——安装时运行时探测白名单，补丁在 =
 *    主会话 sys/role 行为与旧版完全一致；不在 = 仅窗侧降级（信息不丢，
 *    位置变）。
 *    原生版写入侧没有打 ignorable 标记的 API（官方 2026-08-30 notes 明示
 *    production 面未提供，注册面方案已被否决），白名单补丁是唯一通道。
 *
 * 窗历史跨重启：镜像（femoRoot/proj-mirror/<windowId>.jsonl）挂在全局
 * session/event 钩子上记每一行；重启后窗同 id 重建（session/created 钩子）时
 * 整窗重放——渲染走原有 femo/chat 节点，视觉与旧投影窗一致。重放走
 * projection.ts 导出的 appendEvent，去重索引天然防重；重放期间镜像暂记避免
 * 自复制。
 */
import { createRequire } from 'node:module'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { appendChatBroadcast, appendChatProjected, appendEvent, type ProjectionRegistry } from './projection'
import { readSessionEventCount, readSessionEvents } from './session-events'
import { nativeState } from './native-state'

const WINDOW_ID_PREFIX = 'femo-proj-'
const DESCRIPTOR_TYPE = 'subagent/descriptor'
const FEMO_CHAT_TYPE = 'dsh-femo/chat'
/** 2026-09-12 femo 改名：存量会话日志里仍存在的本插件 legacy 事件类型
 *  （turn-scope 文件化改造前的旧事件；chat 存量已随改名全量迁移，主类型
 *  之外只需放行 turn-scope）。与 FEMO_CHAT_TYPE 一并进白名单，旧日志才能
 *  过持久化读取门的 KNOWN_SESSION_EVENT_TYPES 检查。 */
const LEGACY_FEMO_EVENT_TYPES: readonly string[] = ['dsh-femo/turn-scope']
/** dsh surface-eligible 事件全集（session.append 强制要求 surfaceOp 标记）。
 *  与 subagent.ts 的 SURFACE_OP_EVENTS 不同：这里还含 user/message（god-mirror
 *  会把主会话用户行镜像进上帝窗）。本地重声明避免模块环。 */
const SURFACE_ELIGIBLE_TYPES: ReadonlySet<string> = new Set(['user/message', 'assistant/message', 'tool/result'])

/** meow fork（0.1.x）暴露 registerSessionEventType；原生 0.1.3 stock 没有。 */
export function isNativeDshBuild(sessionNamespace: unknown): boolean {
  return (sessionNamespace as { registerSessionEventType?: unknown } | undefined)
    ?.registerSessionEventType === undefined
}

/** 原生模式开关与白名单探测结果：安装时写入 nativeState（共享单一事实源，
 *  projection.ts 等模块经 ./native-state 读取，避免循环依赖）。 */
export function isNativeMode(): boolean {
  return nativeState.native
}

/** 原生模式下主会话写 dsh-femo/chat 是否安全（白名单已含本插件事件）。 */
export function isMainSessionChatSafe(): boolean {
  return nativeState.mainChatSafe
}

// ── 镜像存储（per-window JSONL，追加式）────────────────────────────────────

/** 重放中的窗：session/event 镜像钩子对它们暂不记（防自复制）。 */
const replaying = new Set<string>()
/** per-file 写串行化：镜像行顺序即重放顺序。 */
const mirrorWrites = new Map<string, Promise<void>>()

function mirrorFile(mirrorDir: string, windowId: string): string {
  const safe = windowId.replace(/[^\w.-]/g, '_')
  return join(mirrorDir, `${safe}.jsonl`)
}

function mirrorEnqueue(mirrorDir: string, windowId: string, event: SessionEvent): void {
  const file = mirrorFile(mirrorDir, windowId)
  // surfaceOp 不读 event.surfaceOp（运行时事件对象上不可靠，2026-09-09 实测
  // 重放整批被拒）——按事件类型重算：surface-eligible 必带 append 标记。
  const surfaceOp = SURFACE_ELIGIBLE_TYPES.has(event.type) ? { surfaceOp: 'append' } : undefined
  const row = {
    type: event.type,
    data: event.data,
    ...(surfaceOp === undefined ? {} : { surfaceOp }),
  }
  const prev = mirrorWrites.get(file) ?? Promise.resolve()
  const next = prev
    .then(() => appendFile(file, `${JSON.stringify(row)}\n`, 'utf8'))
    .catch((error: unknown) => {
      console.log(`[dsh-femo][native] mirror write failed for ${windowId}: ${String(error)}`)
    })
  mirrorWrites.set(file, next)
}

async function mirrorReadAll(mirrorDir: string, windowId: string): Promise<Array<{ type: string; data: unknown; surfaceOp?: unknown }>> {
  try {
    const raw = await readFile(mirrorFile(mirrorDir, windowId), 'utf8')
    return raw.split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as { type: string; data: unknown; surfaceOp?: unknown })
  } catch {
    return []
  }
}

// ── 重放（窗重建后恢复历史）───────────────────────────────────────────────

async function replayWindow(window: Session, mirrorDir: string): Promise<void> {
  const windowId = String(window.id)
  const rows = await mirrorReadAll(mirrorDir, windowId)
  if (rows.length === 0) return
  replaying.add(windowId)
  try {
    // 【持久化投影窗】冷装载后的窗已含持久化日志事件（count>0）——重放改为
    // 「并集合并」：按 (type|_srcSeq|turn|step|data.seq|kind|index|actor) 身份
    // 键去重，只补镜像里多出的行；裸窗（count=0）维持整窗重放。
    const durable = readSessionEventCount(window) > 0
    const seen = new Set<string>()
    if (durable) {
      for (const e of readSessionEvents(window)) {
        seen.add(replayKey(e.type, (e.data ?? {}) as Record<string, unknown>))
      }
    }
    let replayed = 0
    for (const row of rows) {
      // descriptor 由建窗路径按需补（projectionHasDescriptor），重放会重复。
      if (row.type === DESCRIPTOR_TYPE) continue
      if (durable) {
        const key = replayKey(row.type, (row.data ?? {}) as Record<string, unknown>)
        if (seen.has(key)) continue
        seen.add(key)
      }
      // 旧镜像行缺 surfaceOp 标记的 surface-eligible 事件补 append 兜底
      // （镜像记录口径修复前的存量文件）。
      const surface = row.surfaceOp !== undefined
        ? row.surfaceOp
        : SURFACE_ELIGIBLE_TYPES.has(row.type) ? { surfaceOp: 'append' } : undefined
      try {
        appendEvent(window, row.type, row.data, surface)
        replayed += 1
      } catch (error: unknown) {
        console.log(`[dsh-femo][native] replay row skipped (${row.type}): ${String(error).slice(0, 120)}`)
      }
    }
    if (replayed > 0) console.log(`[dsh-femo][native] window ${windowId} restored from mirror: ${replayed} rows`)
  } finally {
    replaying.delete(windowId)
  }
}

/** 重放去重键：type + data 里最具区分度的稳定字段（_srcSeq/turn/step/data.seq/
 *  kind/index/actor）。文件行与镜像行同构，键一致即视为同一事件。 */
function replayKey(type: string, d: Record<string, unknown>): string {
  return [
    type,
    String(d._srcSeq ?? ''),
    typeof d.turn === 'number' ? String(d.turn) : '',
    typeof d.step === 'number' ? String(d.step) : '',
    String(d.seq ?? ''),
    String(d.kind ?? ''),
    typeof d.index === 'number' ? String(d.index) : '',
    String(d.actor ?? ''),
  ].join('|')
}

// ── 安装点（index.ts 在 apply 内调用一次）─────────────────────────────────

/** 【0.1.3 运行时白名单注册（替代文件补丁，升级免重打）】把 dsh-femo/chat
 *  加进【宿主进程】加载的那份 KNOWN_SESSION_EVENT_TYPES——与持久化协调器
 *  同一实例（createRequire(宿主入口) 解析出的文件，URL 缓存同实例）。机制
 *  与旧版 registerSessionEventType 完全相同（上游只是收了 API，Set 仍在）。
 *  进程内存级、幂等：每次插件加载自动注册，dsh 升级后无需任何手工补丁。
 *  注册链：宿主入口（argv[1]）解析优先 → 本插件模块副本兜底（legacy 部署
 *  两本一致；纯官方部署上插件副本无谓，注册结果以宿主视图复核为准）。 */
function registerRuntimeWhitelist(): { ok: boolean; hostPath?: string } {
  const candidates: Array<() => unknown> = []
  let hostPath: string | undefined
  if (process.argv[1] !== undefined && process.argv[1].length > 0) {
    try {
      const req = createRequire(process.argv[1])
      hostPath = req.resolve('@deepseek-ai/dsh-session')
      candidates.push(() => req('@deepseek-ai/dsh-session'))
    } catch { /* 宿主入口解析失败，走兜底 */ }
  }
  candidates.push(() => createRequire(import.meta.url)('@deepseek-ai/dsh-session'))
  for (const load of candidates) {
    try {
      const mod = load() as { KNOWN_SESSION_EVENT_TYPES?: Set<string> }
      const set = mod?.KNOWN_SESSION_EVENT_TYPES
      if (set !== undefined && typeof set.add === 'function') {
        set.add(FEMO_CHAT_TYPE)
        for (const legacy of LEGACY_FEMO_EVENT_TYPES) set.add(legacy)
        const ok = set.has(FEMO_CHAT_TYPE)
        console.log(`[dsh-femo][native] runtime whitelist registration: dsh-femo/chat ${ok ? 'registered' : 'failed'}${hostPath !== undefined ? ` (host copy: ...${hostPath.slice(-60)})` : ' (plugin-local copy)'} (+${LEGACY_FEMO_EVENT_TYPES.length} legacy femo types)`)
        return { ok, hostPath }
      }
    } catch { /* 下一候选 */ }
  }
  console.log('[dsh-femo][native] runtime whitelist registration unavailable; persistence gate stays conservative')
  return { ok: false, hostPath: undefined }
}

/** ESM 视图复核：require(esm) 与 import 的缓存一致性随 Node 版本有差异，
 *  双视图都确认已注册才允许持久化路线（防"注册到了错误实例"的假阳性）。 */
async function verifyHostWhitelistView(hostPath?: string): Promise<boolean> {
  if (hostPath === undefined) return true // 无宿主解析（legacy 同实例部署），以注册结果为准
  try {
    const { pathToFileURL } = await import('node:url')
    const ns = (await import(pathToFileURL(hostPath).href)) as { KNOWN_SESSION_EVENT_TYPES?: Set<string> }
    const ok = ns?.KNOWN_SESSION_EVENT_TYPES?.has(FEMO_CHAT_TYPE) === true
    if (!ok) console.log('[dsh-femo][native] ESM view of the whitelist lacks dsh-femo/chat — downgrading persistence gate')
    return ok
  } catch {
    return true // 复核不可用不降级（注册动作本身已成功）
  }
}

export function installNativeWindowing(
  ctx: Context,
  opts: { native: boolean; mirrorDir: string },
): void {
  nativeState.native = opts.native
  if (!opts.native) return
  const registration = registerRuntimeWhitelist()
  nativeState.mainChatSafe = registration.ok
  void mkdir(opts.mirrorDir, { recursive: true }).catch((error: unknown) => {
    console.log(`[dsh-femo][native] mirror dir create failed: ${String(error)}`)
  })
  if (registration.ok) {
    void verifyHostWhitelistView(registration.hostPath).then((ok) => {
      if (!ok) {
        nativeState.mainChatSafe = false
        console.log('[dsh-femo][native] persistence gate downgraded to window-only (ESM view mismatch)')
      }
    })
  }
  // 每一行窗事件（引擎行/镜像的模型事件）落 femo 自有镜像。
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (!String(session.id).startsWith(WINDOW_ID_PREFIX)) return
    if (replaying.has(String(session.id))) return
    mirrorEnqueue(opts.mirrorDir, String(session.id), event)
  })
  // 重启后窗同 id 重建 → 从镜像重放。冷装载窗（count>0，宿主只有持久层
  // 少量事件）与裸窗（count=0）都走 replayWindow：前者按「并集合并」只补
  // 镜像多出的行，后者整窗重放。【2026-09-09 深夜五轮】此前这里的
  // `count>0 → return` 守卫把并集合并整段短路——冷装载窗永远只有持久层
  // 基线、镜像内容回不来，客户端 history 首拉即空 → 官方 blank 语义隐藏
  // header/body =「白屏」（实测根因，非猜测）。
  ctx.on('session/created', (session: Session) => {
    if (!String(session.id).startsWith(WINDOW_ID_PREFIX)) return
    void replayWindow(session, opts.mirrorDir)
  })
  console.log(`[dsh-femo][native] native dsh build: projection windows ${nativeState.mainChatSafe ? 'durable (agent-loop created, native persistence)' : 'live-only + mirror-restored'}; main-session dsh-femo/chat ${nativeState.mainChatSafe ? 'allowed (event type whitelisted in this build)' : 'suppressed (event type NOT in persistence whitelist)'}`)
}

// ── compat 层（调用处入口）────────────────────────────────────────────────
// legacy（meow fork，有 registerSessionEventType）：直通旧路径，行为逐字节
// 不变。native：是否写主会话由【运行时白名单注册】（mainChatSafe）裁决——
// 注册成功（任意官方构建，进程内注册）走旧版同款「主会话+投影窗」双写；
// 注册不可得才降级为仅窗侧。

/** 运行回执广播（剧本已开始/跑完/停止/出错等 sys 行）。 */
export function broadcastCompat(
  ctx: Context,
  session: Session,
  projections: ProjectionRegistry,
  text: string,
): void {
  if (nativeState.native && !nativeState.mainChatSafe) {
    appendChatProjected(ctx, session, projections, text, 'sys')
    return
  }
  appendChatBroadcast(ctx, session, projections, text)
}

/** 定向剧本行。alsoMainSession=true（llmBridge 直连 role 行）仅在主会话可
 *  承载本插件事件时生效，否则降级为仅窗侧。 */
export function projectedCompat(
  ctx: Context,
  session: Session,
  projections: ProjectionRegistry,
  text: string,
  kind: 'role' | 'notice' | 'human_wait' | 'prompt' | 'error' | 'thinking',
  actor?: string,
  visible?: string[],
  alsoMainSession = false,
): void {
  const mainAllowed = !nativeState.native || nativeState.mainChatSafe
  appendChatProjected(ctx, session, projections, text, kind, actor, visible, alsoMainSession && mainAllowed)
}
