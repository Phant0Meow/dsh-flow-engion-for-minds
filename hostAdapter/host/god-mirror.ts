/**
 * god-mirror.ts — 主会话 → 上帝窗镜像（上帝视角=全视视角：戏外+戏内全部对话）。
 *
 * 上帝窗此前只收剧本内事件，主模型对话永远缺席（2026-08-22 bug）。两条
 * 通路补齐：① 实时镜像监听器——上帝窗存在期间逐事件转发；
 * ② 水位补齐 ensureGodMirrorUpToDate——重启后 registry 是内存态，缝隙期
 * 的主会话对话在 flow_start / 视角菜单拉取时按水位一次性补写。
 * 水位取 max（实时与补齐并发推进，防旧值覆盖新值导致重复 append）。
 * （2026-08-23 重构自原 apply() 闭包工厂化；2026-08-26 结构整理自
 * projection.ts 原样迁出本文件，行为零变化；appendEvent 仍从 projection
 * 单向引用，无环。）
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import { appendEvent, dedupeIndexFor, dedupeStructKey, type ProjectionRegistry } from './projection'
import { readSessionEvents } from './session-events'
import { projTrace } from './proj-trace' // 【诊断】主 Agent 开轮锚点写入留痕

/** 主会话 → 上帝窗镜像白名单：主模型对话（用户输入/思考/工具/回答）进上帝
 * 窗，上帝视角=全视视角（戏外+戏内全部对话）。turn 号保持主会话原号
 * （1,2,3…），子代理镜像 turn 从 100001 起，天然不冲突。
 * 2026-08-23 移除 'assistant/chunk'：大会话（2000+ seq）全量镜像 chunk 后
 * 前端 conversation 折叠渲染把浏览器主线程堵死（复现：进 god 窗纯白→二次
 * 进入冻死 F12 都不出）。assistant/message 已携带完整 content（text/reasoning/
 * tool-call 块）作整块兜底，历史显示不受影响；实时流式走 SSE ai_token 通道
 * （方案丁精神：live 流式 + 整块存历史）。 */
const MIRROR_MAIN_EVENTS = new Set([
  'turn/start', 'step/start', 'step/end', 'turn/end',
  'assistant/message', 'tool/call', 'tool/result',
  'user/message',
])

export interface GodMirror {
  /** 镜像一条主会话事件进上帝窗（chunk 裁剪到块边界 + surfaceOp 重包装透传）。 */
  mirrorMainEventToGod(sid: string, event: SessionEvent): void
  /** 按水位把主会话缺失段补写进上帝窗（幂等：水位以下的跳过；per-sid 串行）。 */
  ensureGodMirrorUpToDate(sid: string): Promise<void>
  /** 注册实时镜像监听器（主会话事件白名单转发进上帝窗）。 */
  registerRealtimeListener(ctx: Context): void
}

export function createGodMirror(deps: {
  femoRoot: string
  sessionsStore?: { get(id: SessionId): Session | undefined }
  projections: ProjectionRegistry
  /** 戏内下场轮反查（main-actor 提供；注入而非 import，避免 main-actor →
   *  engine-events → god-mirror 的循环依赖）。 */
  mainActorSceneActor?: (sid: string, turn: number) => string | undefined
}): GodMirror {
  const { femoRoot, sessionsStore, projections } = deps

  /** 上帝窗镜像水位（sid → 已镜像的主会话最大 seq）。内存缓存 + user_data 落盘。 */
  const godMirrorSeqs = new Map<string, number>()

  function godMirrorPath(sid: string): string {
    return join(femoRoot, 'user_data', 'host-history', 'projections', 'god-mirror', `${sid}.json`)
  }

  async function loadGodMirrorSeq(sid: string): Promise<number> {
    const cached = godMirrorSeqs.get(sid)
    if (cached !== undefined) return cached
    try {
      const { readFile } = await import('node:fs/promises')
      const parsed = JSON.parse(await readFile(godMirrorPath(sid), 'utf8')) as { seq?: number }
      const seq = typeof parsed.seq === 'number' ? parsed.seq : 0
      godMirrorSeqs.set(sid, seq)
      return seq
    } catch {
      godMirrorSeqs.set(sid, 0)
      return 0
    }
  }

  function markGodMirrorSeq(sid: string, seq: number): void {
    const prev = godMirrorSeqs.get(sid) ?? 0
    if (seq <= prev) return
    // 内存水位同步推进（实时镜像与补齐并发时取 max 防重复）；落盘异步。
    godMirrorSeqs.set(sid, seq)
    void import('node:fs/promises').then(({ mkdir, writeFile }) =>
      mkdir(join(godMirrorPath(sid), '..'), { recursive: true })
        .then(() => writeFile(godMirrorPath(sid), JSON.stringify({ sessionId: sid, seq }, null, 2), 'utf8'))
        .catch((error: unknown) => console.log(`[dsh-femo] god-mirror watermark write failed: ${String(error)}`)),
    )
  }

  /** 镜像一条主会话事件进上帝窗（chunk 裁剪到块边界 + surfaceOp 重包装透传）。
   * 内存 SessionEvent.surfaceOp 是裸值（如 'append'），session.append 第三参
   * 要 { surfaceOp } 包装——直传裸值会被校验拒绝（user/message、assistant/
   * message 等 surface-eligible 事件全部丢失）。
   *
   * 幂等三层（2026-08-23 两轮 bug 后定稿）：
   * ①源 seq 对账（最强）：写入时 data 注入 _srcSeq=主会话事件 seq；落窗前查
   *   god 窗内是否已有同 _srcSeq 事件——无论水位文件丢失、多客户端并发触发、
   *   冷加载重放，同一主会话事件绝不会被写第二遍（user/message 也是
   *   "一消息一 start"节点，重复同样炸历史加载）；
   * ②结构 start 查重：turn/start、step/start 落窗前查同 turn(:step) 是否已
   *   存在——覆盖 dsh 会话系统对 surface append 的自动 turn 管理（auto 补的
   *   start 不带 _srcSeq，只能按结构识别）；
   * ③per-sid catch-up 串行（见 ensureGodMirrorUpToDate）。 */
  function mirrorMainEventToGod(sid: string, event: SessionEvent): void {
    const windows = projections.get(sid)
    if (windows?.god === undefined) return
    const srcSeq = Number(event.seq)
    // 窗内可能存有子代理镜像的「id#seq」字符串复合键（2026-08-24 命名空间隔离），
    // 与本处裸数字键永不相等，天然互不干扰；类型随之放宽为 number | string。
    // ★ O(1) 去重索引（2026-08-26 性能修复）：旧实现每次事件都对 god 窗 events
    // 做最多 5 次 .some() 全量扫描——13.7 万事件级会话下 O(n²) 秒级卡死（实证
    // event-loop stall 2514~10274ms）。索引经全局 session/event 钩子增量维护，
    // 与旧查重语义完全等价（同 _srcSeq / 同 type+turn(:step) → 判重）。
    const idx = dedupeIndexFor(windows.god)
    const dupBySrc = idx.srcSeqs.has(srcSeq)
    if (dupBySrc) return
    const mTurn = (event.data as { turn?: number }).turn
    const mStep = (event.data as { step?: number }).step
    if (event.type === 'turn/start' && typeof mTurn === 'number') {
      if (idx.structKeys.has(`turn/start:${mTurn}`)) return
    }
    if (event.type === 'step/start' && typeof mTurn === 'number' && typeof mStep === 'number') {
      if (idx.structKeys.has(`step/start:${mTurn}:${mStep}`)) return
    }
    // end 侧结构查重（与 start 侧对称）：结构事件不再注入 _srcSeq（见下）后，
    // 源级对账对它们失效，end 重复全靠这里拦——重复的 turn:end 同样破坏
    // react-loop 结构。turn/step 号单调递增不复用，无误杀场景。
    if (event.type === 'turn/end' && typeof mTurn === 'number') {
      if (idx.structKeys.has(`turn/end:${mTurn}`)) return
    }
    if (event.type === 'step/end' && typeof mTurn === 'number' && typeof mStep === 'number') {
      if (idx.structKeys.has(`step/end:${mTurn}:${mStep}`)) return
    }
    const rawSurface = (event as { surfaceOp?: unknown }).surfaceOp
    const surface = rawSurface === undefined ? undefined : { surfaceOp: rawSurface }
    // 结构事件（dsh react-loop 骨架）绝不注入 _srcSeq：session-persistence
    // 迁移器对 turn/end 强制 hasOnlyKeys(['turn','reason'])，第三键即判
    // "malformed pre-react-loop turn/end" 冷加载拒载整窗（2026-08-23 三投影窗
    // 中毒根因）。对账缺口由 end 侧结构查重 + 水位文件补齐。
    const structural = event.type === 'turn/start' || event.type === 'turn/end'
      || event.type === 'step/start' || event.type === 'step/end'
    const data = structural
      ? { ...(event.data as Record<string, unknown>) }
      : { ...(event.data as Record<string, unknown>), _srcSeq: srcSeq }
    // 【步3 2026-09-11 修正·Job 796 实锤】主 Agent 轮的开轮锚点必须**先于**镜像的
    // turn/start 落盘：装配器硬规矩是"start 必须是该 context 收到的第一个事件"，
    // 锚晚一步就会抛 `received an update before its start Match`、整轮装配失败
    // （导演轮画不出来）。
    // ⚠️ 不要靠"把钩子注册在 god-mirror 之前"来实现顺序——实测 ctx.on 的执行顺序
    // **不保证等于注册顺序**（Job 795 前移注册后锚仍晚 1 位）；只有同一段代码里的
    // 先后才可靠，所以锚就写在镜像 turn/start 的紧前面。
    if (event.type === 'turn/start' && typeof mTurn === 'number') {
      const anchorKey = `live-main:${mTurn}`
      if (!idx.structKeys.has(anchorKey)) {
        // 【步3.5 2026-09-11】下场轮反查戏内演员名（用户拍板：god 窗里戏内节点
        // 的发言用戏内名字，"导演"只给戏外发言）。scene:true 让前端走演员轮的
        // 贴段首定位公式，与戏外轮的 v9.2 公式分开。
        const sceneActor = deps.mainActorSceneActor?.(sid, mTurn)
        try {
          appendEvent(windows.god, 'dsh-femo/chat', {
            kind: 'live', actor: sceneActor ?? '导演', turn: mTurn, main: true,
            ...(sceneActor !== undefined ? { scene: true } : {}), seq: Date.now(),
          })
          idx.structKeys.add(anchorKey)
          projTrace('proj', `写主 Agent 开轮锚点(god) turn=…${String(mTurn).slice(-4)} sid=${sid.slice(-8)} actor=${sceneActor ?? '导演'}（先于镜像 turn/start）`)
        } catch (error: unknown) {
          console.log(`[dsh-femo] main->god anchor(${mTurn}) failed: ${String(error)}`)
        }
      }
    }
    try {
      appendEvent(windows.god, event.type, data, surface)
      // append 成功后补键（索引增量维护；结构性事件查重键与 start/end 两侧对称）。
      if (!structural) idx.srcSeqs.add(srcSeq)
      const sk = dedupeStructKey(event.type, data)
      if (sk !== undefined) idx.structKeys.add(sk)
    } catch (error: unknown) {
      console.log(`[dsh-femo] main->god mirror(${event.type}) failed: ${String(error)}`)
      return
    }
    markGodMirrorSeq(sid, srcSeq)
  }

  /** 按水位把主会话缺失段补写进上帝窗（幂等：水位以下的跳过）。
   * per-sid inflight 串行：flow_start 与 projection-windows API 可能并发触发，
   * 并发实例各自持有独立遍历游标会把同一段历史写两遍（2026-08-23 上帝窗
   * 头部双份的成因之一），此处与 ProjectionRegistry.ensure 同款串行化。 */
  const catchUpInflight = new Map<string, Promise<void>>()
  function ensureGodMirrorUpToDate(sid: string): Promise<void> {
    const prev = catchUpInflight.get(sid) ?? Promise.resolve()
    const task = prev.then(() => catchUpNow(sid)).catch((error: unknown) => {
      console.log(`[dsh-femo] god-mirror catch-up ${sid} failed: ${String(error)}`)
    })
    catchUpInflight.set(sid, task)
    const cleanup = (): void => {
      if (catchUpInflight.get(sid) === task) catchUpInflight.delete(sid)
    }
    void task.then(cleanup, cleanup)
    return task
  }

  async function catchUpNow(sid: string): Promise<void> {
    const windows = projections.get(sid)
    if (windows?.god === undefined) return
    const main = sessionsStore?.get(SessionId(sid))
    if (main === undefined) return
    const t0 = Date.now()
    let last = await loadGodMirrorSeq(sid)
    let wrote = 0
    // 2026-09-04 双兼容：rc.1 移除 events 数组属性（snapshotEvents() 替代），经 helper 统一读取
    const events = readSessionEvents(main)
    for (const event of events) {
      const seq = Number(event.seq)
      if (seq <= last) continue
      last = seq
      if (!MIRROR_MAIN_EVENTS.has(event.type)) continue
      mirrorMainEventToGod(sid, event)
      wrote += 1
    }
    // [femo-diag] 事件循环 stall 排查：全量遍历+镜像写入耗时量化。
    console.log(`[dsh-femo][diag] god-mirror catch-up ${sid}: ${Date.now() - t0}ms, scanned=${events.length}, wrote=${wrote}, watermark->${last}`)
  }

  /** 实时镜像：主会话事件白名单转发进上帝窗。投影窗自身与子代理会话都带
   * parentSession（header），在此天然排除——无递归、无重复（子代理 → 投影窗
   * 由 runAiSubagent 的 onChildEvent 负责，两条监听互不重叠）。 */
  function registerRealtimeListener(ctx: Context): void {
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (session.header.parentSession !== undefined) return
      if (!MIRROR_MAIN_EVENTS.has(event.type)) return
      mirrorMainEventToGod(String(session.id), event)
    })
  }

  return { mirrorMainEventToGod, ensureGodMirrorUpToDate, registerRealtimeListener }
}
