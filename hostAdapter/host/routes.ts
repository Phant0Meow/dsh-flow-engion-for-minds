/**
 * routes.ts — 前台接线员。
 *
 * 全部 HTTP 路由（/dsh-femo/*）的登记处：前端/femoGen 画布来什么请求就
 * 分发给对应模块的执行体，本文件不做业务逻辑（最复杂的 projection-input
 * 三路路由已于 2026-08-26 迁至 ./projection-input）。webServer 服务缺失时
 * 仅打日志。从 index.ts 原样迁出（2026-08-23 重构）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FemoBridge } from './bridge'
import type { ResolvedConfig } from './config'
import { readBody, writeJson, sseClients, broadcastSse } from './http'
import type { RunState, JobMirror } from './engine-events'
import { activeJobOfSession, isSessionRunning, jobMirrorSetState, jobMirrorPrearm, broadcastProjectionState, projectionStateOf } from './engine-events'
import { turnScopesBySession, actorUsageBySession } from './subagent'
import {
  readTurnScopeFile, readSessionScript, writeSessionScript,
  readSessionScriptText, readSessionCurrentJob, readSessionJobIds, readActorUsageFile,
} from './state-files'
import { handleCreateSession, handleRunOnSession, handleSaveScript, handleReadScript, collectLlmModels, ensureSessionLive } from './run-control'
import { listFemoFiles, readLedgerFemoFile, rememberFemoFile } from './femo-files'
import { handleProjectionInput } from './projection-input'
import { isNativeMode } from './windowing-native'
import { handleDebugRun } from './debug-run'
// （appendEvent/appendChatProjected 已随 projection-input 体迁至 ./projection-input；
//   GodMirror 仍被本文件 projection-windows 路由与 RoutesDeps 使用。）
import { type GodMirror } from './god-mirror'
import { type ProjectionRegistry, projectionActorKey, mainSessionIdOf } from './projection'
import { diagTail, pushDiag } from './diag-feed'

export interface RoutesDeps {
  resolved: ResolvedConfig
  bridge: FemoBridge
  runState: RunState
  projections: ProjectionRegistry
  sessionsStore?: { get(id: SessionId): Session | undefined }
  godMirror: GodMirror
  recordError(sessionId: string, text: string): void
}

/** 注册全部 /dsh-femo/* HTTP 路由（index.ts 总装调用一次）。 */
export function registerRoutes(ctx: Context, deps: RoutesDeps): void {
  const { resolved, bridge, runState, projections, sessionsStore, godMirror, recordError } = deps

  // HTTP routes: create-session + script listing (sidebar button calls these).
  const webServer = ctx.get('webServer') as { register(spec: unknown): void } | undefined
  if (webServer !== undefined && typeof webServer.register === 'function') {
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/create-session',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        void handleCreateSession(req, res, ctx, resolved, bridge, runState, projections).catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/run',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        void handleRunOnSession(req, res, ctx, resolved, bridge, runState, projections).catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/models',
      handler: (_req: IncomingMessage, res: ServerResponse): void => {
        // 前端 actor source 下拉数据源：dsh 当前可用 provider/模型列表。
        void collectLlmModels(ctx, resolved).then((payload) => {
          writeJson(res, 200, { ok: true, ...payload })
        }).catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/native-flag',
      handler: (_req: IncomingMessage, res: ServerResponse): void => {
        // 客户端版本分流信号（0.1.3+ 原生路径）：目录过滤链据此换用原生 fork
        // 组件（ban femo-proj/femo-actor 条目；旧版组件与历史行为见 client.tsx
        // registerLegacyCatalogUi）。旧版（meow fork）返回 native:false。
        writeJson(res, 200, { ok: true, native: isNativeMode() })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/debug-list-children',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        // 【诊断面 2026-09-09】宿主 listChildren 原始返回（排障用，随排障结束摘除）。
        const url = new URL(req.url ?? '/', 'http://localhost')
        const parent = url.searchParams.get('sessionId') ?? ''
        const subagents = ctx.get('subagents') as
          | { listChildren?(parentSessionId: SessionId, signal?: AbortSignal): Promise<unknown> }
          | undefined
        if (subagents?.listChildren === undefined || parent.length === 0) {
          writeJson(res, 400, { ok: false, error: 'listChildren unavailable or sessionId required' })
          return
        }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(new Error('debug timeout 20s')), 20_000)
        void subagents.listChildren(SessionId(parent), controller.signal).then((rows) => {
          clearTimeout(timer)
          writeJson(res, 200, { ok: true, rows })
        }).catch((error: unknown) => {
          clearTimeout(timer)
          writeJson(res, 500, { ok: false, error: String(error).slice(0, 400) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/debug-materialize',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        // 【诊断面 2026-09-09】试验持久化窗冷加载（排障用，随排障结束摘除）。
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = url.searchParams.get('sessionId') ?? ''
        if (id.length === 0) {
          writeJson(res, 400, { ok: false, error: 'sessionId required' })
          return
        }
        const persistence = ctx.get('sessionPersistence') as Record<string, unknown> | undefined
        const sessions = ctx.get('sessions') as unknown as
          | { prepare(id: SessionId, options?: unknown): Session; enter(session: Session): unknown; announce(session: Session): void }
        void (async () => {
          const out: Record<string, unknown> = {}
          if (persistence === undefined || typeof persistence.readStoredLog !== 'function') {
            writeJson(res, 400, { ok: false, error: 'persistence.readStoredLog unavailable' })
            return
          }
          const stored = await (async (): Promise<unknown> => {
            const locate = (persistence.locate as unknown as
              { call(self: unknown, meta: { cwd?: string; id: SessionId }): { path: string } | undefined } | undefined)
            const loc = typeof persistence.locate === 'function'
              ? (persistence.locate as (meta: { cwd?: string; id: SessionId }) => { path: string } | undefined).call(persistence, { cwd: 'D:\\myFiles\\dsh', id: SessionId(id) })
              : locate?.call(persistence, { cwd: 'D:\\myFiles\\dsh', id: SessionId(id) })
            out.locatedPath = loc?.path
            const read = (persistence.readStoredLog as (p: string, id: SessionId) => Promise<unknown>).bind(persistence)
            return await read(loc?.path ?? id, SessionId(id))
          })()
          const rec = stored as Record<string, unknown>
          out.storedKeys = rec !== null && typeof rec === 'object' ? Object.keys(rec) : null
          if (rec !== null && typeof rec === 'object') {
            for (const [k, v] of Object.entries(rec)) {
              if (Array.isArray(v)) out[`arr:${k}`] = `array(${v.length}) head=${JSON.stringify(v[0])?.slice(0, 200)}`
              else if (v !== null && typeof v === 'object') out[`obj:${k}`] = Object.keys(v as Record<string, unknown>).slice(0, 10)
              else out[k] = String(v).slice(0, 80)
            }
          }
          writeJson(res, 200, { ok: true, out })
        })().catch((error: unknown) => writeJson(res, 500, { ok: false, error: String(error).slice(0, 400) }))
      },
    })

    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/debug-live-events',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        // 【诊断面 2026-09-09 深夜五轮】宿主 live 会话事件计数（排障用，随排障结束摘除）。
        const url = new URL(req.url ?? '/', 'http://localhost')
        const id = url.searchParams.get('sessionId') ?? ''
        const session = id.length > 0
          ? (sessionsStore as unknown as
            | { get?(id: SessionId): { events?: readonly unknown[]; seq?: unknown; inheritedEventCount?: unknown; header?: { createdAt?: unknown } } | undefined }
            | undefined)?.get?.(SessionId(id))
          : undefined
        if (session === undefined) {
          writeJson(res, 404, { ok: false, error: 'session not live in host store' })
          return
        }
        writeJson(res, 200, {
          ok: true,
          id,
          eventCount: session.events?.length ?? -1,
          seq: session.seq,
          inheritedEventCount: session.inheritedEventCount,
          createdAt: session.header?.createdAt,
        })
      },
    })

    /** 读取会话事件数（诊断辅助）。 */
    function readSessionEventCountFor(ctx: Context, id: string): number {
      const sessions = ctx.get('sessions') as { get(id: SessionId): { events?: readonly unknown[] } | undefined } | undefined
      const s = sessions?.get(SessionId(id))
      return s?.events?.length ?? -1
    }
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/actor-usage',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        // 角色窗圆环数据源：主会话各角色最近一次演出的 provider 实报占用。
        // 内存表优先（实时权威），无（重启后未再演）读档案文件恢复。
        void (async () => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sid = url.searchParams.get('sessionId') ?? ''
          if (sid.length === 0) {
            writeJson(res, 400, { ok: false, error: 'sessionId is required' })
            return
          }
          const mem = actorUsageBySession.get(sid)
          if (mem !== undefined) {
            writeJson(res, 200, { ok: true, actors: Object.fromEntries(mem) })
            return
          }
          const actors = await readActorUsageFile(resolved.femoRoot, sid)
          writeJson(res, 200, { ok: true, actors: actors ?? {} })
        })().catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/souls',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        void (async () => {
          if (req.method !== 'POST') {
            writeJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const body = await readBody(req) as Record<string, unknown>
          const soul_id = typeof body.soul_id === 'string' ? body.soul_id.trim() : ''
          if (soul_id.length === 0) {
            writeJson(res, 400, { ok: false, error: 'soul_id is required' })
            return
          }
          // 插件模式 soul 创建：归属/创建者固定默认用户 u001（前端不再输入）。
          const result = await bridge.send('create_soul', {
            soul_id,
            soul_name: typeof body.soul_name === 'string' ? body.soul_name.trim() : '',
            description: typeof body.description === 'string' ? body.description : '',
            user_id: 'u001',
          }, 15000)
          writeJson(res, 200, { ok: true, soul_id, result })
        })().catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/stop',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        // Hard-stop the session's running Job (§8.4，B3 归属解析)：query 带
        // sessionId 必填——只认本会话绑定，不再"停别家的戏"。
        // 【2026-09-06】可选 jobId 参数：显式指定时归属裁决走引擎档案
        // host_ref（宿主内存镜像滞后/丢失——如 146 事故——也能正确停）。
        void (async () => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sessionId = url.searchParams.get('sessionId')
          if (sessionId === null || sessionId.length === 0) {
            writeJson(res, 400, { ok: false, error: 'sessionId is required' })
            return
          }
          const rawJobId = url.searchParams.get('jobId')
          const explicitJobId = rawJobId !== null && /^\d+$/.test(rawJobId) ? Number(rawJobId) : undefined
          if (explicitJobId !== undefined) {
            try {
              const st = await bridge.send('get_job_state', { job_id: explicitJobId }, 15000) as { host_ref?: string } | undefined
              if (st?.host_ref !== sessionId) {
                const denied = `Job ${explicitJobId} 不属于会话 ${sessionId}（归属 ${st?.host_ref ?? '?'}），拒绝停止`
                // 停止被拒=动作失败（非静默，2026-09-07 214 事故收尾）：错误面板
                // 留痕 + 诊断流，前端据非 2xx 在画布上可见报错。
                recordError(sessionId, `⏹ 停止失败：${denied}`)
                pushDiag('stop', `DENIED sid=${sessionId} job=${explicitJobId}（归属 ${st?.host_ref ?? '?'}）`)
                writeJson(res, 403, { ok: false, error: denied })
                return
              }
              // job_stop 发送超时 15s > 引擎侧强停兜底 join 10s+0.2s 退出缓冲——
              // 慢收场（强停路径）不等价于失败，回执总能赶上。
              const result = await bridge.send('job_stop', { job_id: explicitJobId }, 15000) as { stopped?: boolean; state?: string; confirmed?: boolean } | undefined
              console.log(`[dsh-femo] stop (explicit) sid=${sessionId} job=${explicitJobId} -> stopped=${result?.stopped === true} state=${String(result?.state ?? '-')} confirmed=${result?.confirmed === true}`)
              writeJson(res, 200, { ok: true, stopped: result?.stopped === true, state: result?.state, confirmed: result?.confirmed === true, job_id: explicitJobId })
            } catch (error: unknown) {
              const msg = String(error instanceof Error ? error.message : error)
              console.log(`[dsh-femo] stop (explicit) sid=${sessionId} job=${explicitJobId} FAILED: ${msg}`)
              // 214 事故主形态：bridge 无回应（超时）=引擎侧已不可达——错误面板
              // 留痕（此前仅 console.log，femoGen 里零感知）。
              recordError(sessionId, `⏹ 停止失败：引擎无响应（${msg}）。引擎可能已僵死，重启宿主后对账恢复`)
              pushDiag('stop', `FAILED (explicit) sid=${sessionId} job=${explicitJobId}: ${msg}`)
              writeJson(res, 404, { ok: false, error: msg })
            }
            return
          }
          const job = activeJobOfSession(runState, sessionId)
          const jobId = job?.state === 'running' && runState.activeJobId === job?.jobId
            ? job?.jobId
            : undefined
          console.log(`[dsh-femo] stop sid=${sessionId} mirrorJob=${String(job?.jobId ?? '-')} activeJobId=${String(runState.activeJobId ?? '-')} -> resolved=${String(jobId ?? 'none')}`)
          if (jobId === undefined) {
            writeJson(res, 200, { ok: true, stopped: false, note: '该会话无活跃剧本' })
            return
          }
          // 结构化消费：job_stop 幂等（suspended/finished/failed 照样回执），
          // 失败（no_such_job 等）原话上浮 + 错误面板留痕（非静默）——B5 死于结构。
          try {
            const result = await bridge.send('job_stop', { job_id: jobId }, 15000) as { stopped?: boolean; state?: string; confirmed?: boolean } | undefined
            console.log(`[dsh-femo] stop (mirror) sid=${sessionId} job=${jobId} -> stopped=${result?.stopped === true} state=${String(result?.state ?? '-')} confirmed=${result?.confirmed === true}`)
            writeJson(res, 200, { ok: true, stopped: result?.stopped === true, state: result?.state, confirmed: result?.confirmed === true, job_id: jobId })
          } catch (error: unknown) {
            const msg = String(error instanceof Error ? error.message : error)
            recordError(sessionId, `⏹ 停止失败：引擎无响应（${msg}）。引擎可能已僵死，重启宿主后对账恢复`)
            pushDiag('stop', `FAILED (mirror) sid=${sessionId} job=${jobId}: ${msg}`)
            writeJson(res, 500, { ok: false, error: msg })
          }
        })().catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/turn-scopes',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        // 主会话镜像 turn → scope 映射（前端视角过滤用）。
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = url.searchParams.get('sessionId')
        if (sessionId === null || sessionId.length === 0) {
          writeJson(res, 400, { ok: false, error: 'sessionId is required' })
          return
        }
        let scopes = turnScopesBySession.get(sessionId)
        if (scopes === undefined) {
          // 重启后内存 Map 已丢：从插件文件重建（user_data/turn_scopes/<sid>.json）。
          void readTurnScopeFile(resolved.femoRoot, sessionId).then((record) => {
            const rebuilt = new Map<number, string[]>()
            for (const key of Object.keys(record)) {
              const scope = record[key]
              if (Array.isArray(scope)) rebuilt.set(Number(key), scope)
            }
            if (rebuilt.size > 0) turnScopesBySession.set(sessionId, rebuilt)
            const out: Record<string, string[]> = {}
            for (const [turn, scope] of rebuilt) out[String(turn)] = scope
            writeJson(res, 200, { ok: true, scopes: out })
          }).catch((error: unknown) => {
            writeJson(res, 500, { ok: false, error: String(error) })
          })
          return
        }
        const out: Record<string, string[]> = {}
        for (const [turn, scope] of scopes) out[String(turn)] = scope
        writeJson(res, 200, { ok: true, scopes: out })
      },
    })
    // femoGen 画布控制面（Job 模型 §8.4）：pause/resume 路由整条退役（引擎无
    // 暂停语义 stop=suspended 覆盖；C3 死路由）——「继续」由画布运行按钮的
    // resume 语义（POST /run 不带 reset）与 femo-run resume 承担。human-input
    // 保留（human 节点输入）。
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/jobs',
      handler: (_req: IncomingMessage, res: ServerResponse): void => {
        // Job 清单（v1 吸收）：前端/AI 查历史挂起 Job 的 HTTP 出口
        // （幽灵书签可达性闭环——配 femo-run resume + job_id）。
        bridge.send('list_jobs', {}, 15000).then((result) => {
          const jobs = (result as { jobs?: unknown[] } | undefined)?.jobs ?? []
          writeJson(res, 200, { ok: true, jobs })
        }).catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/diag-tail',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        // 【诊断 2026-09-06】诊断窗打开时拉历史（此后实时流走 SSE femo_diag）。
        const url = new URL(req.url ?? '/', 'http://localhost')
        const n = Number(url.searchParams.get('n') ?? '300')
        writeJson(res, 200, { ok: true, lines: diagTail(n) })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/debug-run',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        // 零 token 调试干跑（2026-09-08）：femoGen「🐞 调试」按钮——
        // femo_debugger FakeHost 替 AI/human 发言，DebugLogBus 流水以
        // NDJSON 流式回传（每行一条）。与正式运行/job/SSE 全解耦。
        void handleDebugRun(req, res, ctx, resolved).catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/human-input',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        void (async () => {
          const raw = await readBody(req) as unknown as Record<string, unknown>
          const waitKey = typeof raw.wait_key === 'string' ? raw.wait_key : ''
          const chatText = typeof raw.chat_text === 'string' ? raw.chat_text : ''
          const variables = (raw.variables ?? {}) as Record<string, unknown>
          const hasVars = typeof variables === 'object' && variables !== null && Object.keys(variables).length > 0
          const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : ''
          if (waitKey.length === 0 || (chatText.length === 0 && !hasVars) || sessionId.length === 0) {
            writeJson(res, 400, { ok: false, error: 'sessionId, wait_key and chat_text/variables are required' })
            return
          }
          // B6 投递侧防线：sessionId → 活跃 Job，不盲投（无活跃 → 明确不投递）。
          const job = activeJobOfSession(runState, sessionId)
          if (job === undefined || job.state !== 'running' || job.waitingHuman === undefined) {
            // 【诊断 2026-09-06】画布 UI 不看 delivered 无条件标 human_done，
            // 此拦截此前静默——"画布显示已提交但引擎没收到"的直接证据源。
            pushDiag('canvas-input', `B6-INTERCEPT sid=${sessionId.slice(-12)} job=${job?.jobId ?? '-'} state=${job?.state ?? '-'} waitHuman=${job?.waitingHuman === undefined ? 'none' : 'set'} wait_key=${waitKey}`)
            console.log(`[dsh-femo] /human-input B6-intercept: sid=${sessionId} job=${job?.jobId ?? '-'} state=${job?.state ?? '-'} waitHuman=${job?.waitingHuman === undefined ? 'none' : 'set'} wait_key=${waitKey}`)
            writeJson(res, 200, { ok: true, delivered: false, note: 'no active job' })
            return
          }
          pushDiag('canvas-input', `feeding job=${job.jobId} wait_key=${waitKey} len=${chatText.length}`)
          const delivered = await bridge.send('human_input', {
            job_id: job.jobId,
            wait_key: waitKey,
            body: { chat_text: chatText, variables },
          })
          writeJson(res, 200, { ok: true, delivered: (delivered as { delivered?: boolean } | undefined)?.delivered ?? false })
        })().catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/scripts',
      handler: (_req: IncomingMessage, res: ServerResponse): void => {
        bridge.send('list_scripts', {}).then((result) => {
          const scripts = (result as { scripts?: unknown[] } | undefined)?.scripts ?? []
          writeJson(res, 200, { ok: true, scripts })
        }).catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/save-script',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        void handleSaveScript(req, res, resolved).catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/script',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        void handleReadScript(req, res).catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/errors',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = url.searchParams.get('sessionId')
        const list = sessionId === null ? [] : (runState.errors.get(sessionId) ?? [])
        writeJson(res, 200, { ok: true, errors: list })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/editor-error',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        void (async () => {
          // 编辑器前端解析/恢复失败上报：并入 errors 列表（用户可见）+ 可被
          // femo-mount/run 工具结果带回主模型，杜绝「静默吞错」。
          const raw = await readBody(req) as unknown as Record<string, unknown>
          const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : ''
          const message = typeof raw.message === 'string' ? raw.message.trim() : ''
          const source = typeof raw.source === 'string' && raw.source.length > 0 ? raw.source : 'editor'
          if (sessionId.length === 0 || message.length === 0) {
            writeJson(res, 400, { ok: false, error: 'sessionId and message are required' })
            return
          }
          recordError(sessionId, `[编辑器·${source}] ${message}`)
          writeJson(res, 200, { ok: true })
        })().catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    // 【run-result 路由退役（§8.4，§八.16）】AI 的 femo-run 直调 job_start
    // 后其唯一生产者消失——run_request 全链（index pending Map、本路由、
    // editor-page 触发链）整体退役，不退即死代码。
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/actors',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        // Script actors of one session's latest run, for the view menu.
        // 内存命中优先（flow_start 写入）；miss 时从 turn_scopes 文件回退——
        // runState 是内存态，3081 重启后为空会导致视角菜单丢失全部角色项
        // （2026-08-23 bug；与 projection-windows 的文件回退同源对称）。
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = url.searchParams.get('sessionId')
        if (sessionId === null || sessionId.length === 0) {
          writeJson(res, 200, { ok: true, actors: [] })
          return
        }
        const mem = runState.sessionActors.get(sessionId)
        console.log(`[dsh-femo][diag] GET /actors ${sessionId}: mem=${mem === undefined ? 'undefined' : JSON.stringify(mem)}`)
        if (mem !== undefined && mem.length > 0) {
          writeJson(res, 200, { ok: true, actors: mem })
          return
        }
        void readTurnScopeFile(resolved.femoRoot, sessionId).then((record) => {
          const actors = [...new Set(Object.values(record).flat())]
          console.log(`[dsh-femo][diag] GET /actors ${sessionId}: mem miss, turn_scopes fallback=${JSON.stringify(actors)}`)
          writeJson(res, 200, { ok: true, actors })
        }).catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/projection-state',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        // 【2026-09-06 猫猫拍板】投影窗 composer 发送/停止钮的权威状态源：
        // 按投影窗 sessionId（femo-proj-<主sid>-<actorKey>）返回窗型、本窗
        // 角色原始名、剧本运行/人类等待/waitScope。前端打开时拉一次建基线，
        // 之后由 SSE projection_state 增量覆盖（engine-events 各状态变化点
        // 广播）。角色名解析与 /actors 同源（sessionActors 内存优先，
        // turn_scopes 文件回退）。
        const url = new URL(req.url ?? '/', 'http://localhost')
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (sessionId.length === 0 || !sessionId.startsWith('femo-proj-')) {
          writeJson(res, 200, { ok: true, winKind: 'none' })
          return
        }
        const suffix = sessionId.slice('femo-proj-'.length)
        const mainSid = suffix.replace(/-[^-]*$/, '')
        const actorKey = suffix.includes('-') ? suffix.slice(suffix.lastIndexOf('-') + 1) : undefined
        if (actorKey === undefined || actorKey.length === 0) {
          writeJson(res, 200, { ok: true, winKind: 'none' })
          return
        }
        const winKind = actorKey === 'god' ? 'god' : actorKey === 'stage' ? 'stage' : 'actor'
        const state = projectionStateOf(runState, mainSid)
        const resolveActor = (actors: string[]): string | undefined =>
          actors.find(name => projectionActorKey(name) === actorKey)
        const mem = runState.sessionActors.get(mainSid)
        if (mem !== undefined && mem.length > 0) {
          writeJson(res, 200, { ok: true, sid: mainSid, winKind, actor: resolveActor(mem), ...state })
          return
        }
        void readTurnScopeFile(resolved.femoRoot, mainSid).then((record) => {
          const actors = [...new Set(Object.values(record).flat())]
          writeJson(res, 200, { ok: true, sid: mainSid, winKind, actor: resolveActor(actors), ...state })
        }).catch(() => {
          // 角色名解析失败不阻塞状态：actor undefined → 前端按 AI 角色窗降级（灰）
          writeJson(res, 200, { ok: true, sid: mainSid, winKind, actor: undefined, ...state })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/session-script',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        void (async () => {
          // 会话剧本记录写（2026-08-30 猫猫拍板统一为 mount 同款 {path,text}
          // 并存格式——导入/导出不再清原文，text 恒为最新版）：
          //  - {sessionId, femo}：画布编辑防抖的原文快照（保留已有地址）
          //  - {sessionId, femo, scriptPath}：导入/另存为 → 写 text + 地址覆盖为
          //    scriptPath（指向原始位置/新位置；显式动作，跳过乐观锁无条件写）
          const raw = await readBody(req) as unknown as Record<string, unknown>
          const sessionId = typeof raw.sessionId === 'string' && raw.sessionId.trim().length > 0 ? raw.sessionId.trim() : ''
          if (sessionId.length === 0) {
            writeJson(res, 400, { ok: false, error: 'sessionId is required' })
            return
          }
          const scriptPath = typeof raw.scriptPath === 'string' && raw.scriptPath.trim().length > 0 ? raw.scriptPath.trim() : ''
          const femo = typeof raw.femo === 'string' && raw.femo.trim().length > 0 ? raw.femo : ''
          const baseRev = typeof raw.baseRev === 'number' ? raw.baseRev : undefined
          const pageId = typeof raw.pageId === 'string' ? raw.pageId : ''
          if (femo.length === 0) {
            writeJson(res, 400, { ok: false, error: 'femo is required' })
            return
          }
          // 投影窗入口归一：保存/读取都以主会话记录为准（剧本数据面挂主会话名下）。
          const scriptMainSid = mainSessionIdOf(sessionId)
          const prev = await readSessionScript(resolved.femoRoot, scriptMainSid)
          const explicit = scriptPath.length > 0
          const result = await writeSessionScript(
            resolved.femoRoot,
            scriptMainSid,
            {
              ...(explicit ? { path: scriptPath } : prev?.path === undefined ? {} : { path: prev.path }),
              text: femo,
            },
            explicit ? undefined : baseRev,
          )
          if (!result.ok) {
            writeJson(res, 409, { ok: false, error: 'conflict', record: result.record })
            return
          }
          // 广播其他端重载（pageId=快照写者自身，前端跳过自己的广播防回环；
          // 显式保存不带 pageId=全端重载，与旧导出/导入行为一致）。
          broadcastSse('script_changed', explicit ? { sessionId: scriptMainSid } : { sessionId: scriptMainSid, pageId })
          writeJson(res, 200, { ok: true, rev: result.rev })
        })().catch((error: unknown) => {
          // 防御：响应已发出后再出错，绝不能二次 writeJson（ERR_HTTP_HEADERS_SENT
          // 会作为 unhandledRejection 把整个 dsh 进程带崩——2026-08-21 实测教训）。
          if (res.headersSent) {
            console.warn('[dsh-femo] session-script handler failed after response:', String(error))
            return
          }
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/session-state',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        void (async () => {
          // femoGen 恢复面（§8.4）：形状保持 {ok, hasScript, script, scriptPath,
          // rev, checkpoint, running}（前端无感）——checkpoint 来源从宿主
          // resume 块改为引擎 get_job_state 代理翻译（D1：checkpoint_labels
          // → 前端 label；state 字段一并返回）。
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sessionId = url.searchParams.get('sessionId')
          if (sessionId === null || sessionId.length === 0) {
            writeJson(res, 400, { ok: false, error: 'sessionId is required' })
            return
          }
          // 投影窗入口归一（mainSessionIdOf）：剧本记录/Job 档案挂主会话名下，
          // 从投影窗打开的 femoGen 读的是母会话的数据面。
          const mainSid = mainSessionIdOf(sessionId)
          const record = await readSessionScript(resolved.femoRoot, mainSid)
          const script = await readSessionScriptText(resolved.femoRoot, mainSid)
          // 冷启动窗口（§八.15）：bridge 延迟 spawn + Python 启动 2-3s——
          // 返回 pending:true（前端"引擎启动中"加载态，宿主不双写状态副本）。
          // jobId/jobIds 纯文件读，不依赖 bridge，冷启动也照常带出。
          const pendingJobId = await readSessionCurrentJob(resolved.femoRoot, mainSid)
          if (!bridge.alive) {
            const pendingJobIds = await readSessionJobIds(resolved.femoRoot, mainSid)
            writeJson(res, 200, {
              ok: true,
              pending: true,
              hasScript: script !== undefined,
              script: script ?? undefined,
              scriptPath: record?.path ?? undefined,
              rev: record?.rev ?? 0,
              jobId: pendingJobId,
              ...(pendingJobIds !== undefined ? { jobIds: pendingJobIds } : {}),
              checkpoint: {},
              running: false,
            })
            return
          }
          // 断点来自引擎档案（Job suspended 才有断点——B2 修复：前端不再给
          // "必假继续"）。checkpoint= 引擎 checkpoint_labels 翻译成前端 label
          // （前端画布按 label 匹配节点）。
          let checkpoint: Record<string, string> = {}
          let jobState: string | undefined
          let lastError: string | undefined
          const jobId = pendingJobId
          if (jobId !== undefined) {
            // 【2026-09-07 懒对账】打开 session 的这一问就是对账点：仅当该
            // session 归属本宿主（sessions store 里有）才让引擎顺带裁决这个
            // 唯一的 currentJobId（引擎侧 _bound 主人检查先行，活 Job 绝不
            // 误判）——别的进程/别的 session 的档案一个不碰（214 事故根因）。
            const sessionKnown = (() => {
              try { return sessionsStore?.get(SessionId(mainSid)) !== undefined } catch { return false }
            })()
            const state = await bridge.send('get_job_state', {
              job_id: jobId,
              ...(sessionKnown ? { reconcile_if_stale: true } : {}),
            }, 15000) as {
              error?: string; state?: string; checkpoints?: Record<string, string>; checkpoint_labels?: Record<string, string>
            } | undefined
            if (state !== undefined && state.state !== undefined) {
              // ⚠️ 判据是 state 字段而非 error（2026-09-10）：桥接恒 ok 后回执
              // 恒带档案原文——error:''=正常，非空=failed 场次的存档错误（是
              // 查询的答案，不是查询失败），state 缺失=no_such_job。按 error
              // 判会把 failed 场次整段跳过（存档错误毒倒画布恢复的实锤现场）。
              jobState = state.state
              if (jobState === 'failed' && state.error !== undefined && state.error.length > 0) {
                lastError = state.error
              }
              // 【状态不一致自动收口（2026-09-12 用户拍板）】引擎档案与宿主镜像
              // 对「running」的认定相左时，双侧一律收口为挂起：先发 job_stop
              // 停止信号（引擎侧真在跑=停下挂起、断点保留可续跑；已不在跑=
              // 幂等回执，档案不会被误写），再把宿主镜像对齐到引擎回执的终态。
              // 只走 API 不摸引擎档案文件；且仅限本宿主拥有的 session
              // （sessionsStore 里有）——别的进程/宿主的 Job 一个不碰（214 红线）。
              // 例外：引擎回执 finished/failed 时以引擎真相为准——终态档案没有
              // API 可以改写成挂起（job_stop 幂等原样回执），强行把镜像降成
              // 挂起反而反向制造不一致+「可续跑」假象。
              const mirror = runState.jobs.get(jobId)
              const mirrorRunning = mirror !== undefined && mirror.state === 'running'
              const engineRunning = jobState === 'running'
              // 镜像对齐收口（缺失则 prearm 补建再对齐——jobMirrorSetState 的
              // 变更广播照常拿到），并同步投影窗按钮状态。
              const settleMirror = (finalState: JobMirror['state']): void => {
                if (runState.jobs.get(jobId) === undefined) {
                  jobMirrorPrearm(runState, jobId, mainSid)
                }
                jobMirrorSetState(runState, jobId, finalState)
                if (finalState !== 'running' && runState.activeJobId === jobId) {
                  runState.activeJobId = undefined
                }
                broadcastProjectionState(runState, mainSid)
              }
              if (sessionKnown && mirrorRunning !== engineRunning) {
                console.log(`[dsh-femo] session-state 状态不一致收口: job=${jobId} sid=${mainSid.slice(-12)} 引擎=${jobState} 镜像=${mirror?.state ?? '无'} → 发送 job_stop`)
                pushDiag('session-state', `状态不一致 job=${jobId} 引擎=${jobState} 镜像=${mirror?.state ?? '无'} → job_stop 收口`)
                let stopState: string | undefined
                try {
                  const stop = await bridge.send('job_stop', { job_id: jobId }, 15000) as { stopped?: boolean; state?: string } | undefined
                  stopState = stop?.state
                } catch (error: unknown) {
                  // 停止信号失败（no_such_job/桥抖动）：按查询到的引擎状态对齐镜像
                  console.log(`[dsh-femo] session-state job_stop 收口失败，按查询状态对齐: ${String(error instanceof Error ? error.message : error)}`)
                }
                if (!engineRunning) {
                  // 宿主说跑、引擎说不跑：镜像落到引擎终态——suspended=两边同
                  // 挂起；finished/failed=引擎真相优先（见上方例外注释）。
                  const finalState = (stopState ?? jobState) as JobMirror['state']
                  settleMirror(finalState)
                  jobState = finalState
                } else if (stopState === 'running') {
                  // 引擎说跑、宿主不认（宿主重启后镜像丢失的僵尸场）：stop_job
                  // 的有挂靠路径回执时档案仍是 running（优雅停止在途）——prearm
                  // 认领镜像，让随后的 flow_stopped 走既有管道收口（suspended+
                  // 全窗通知+主模型 steer）。事件若丢，下次打开本接口再兜底。
                  settleMirror('running')
                } else {
                  // 无挂靠的直接落盘路径（stop_job 回执已带终态）或幂等回执：
                  // 引擎已终态化，镜像直接对齐。
                  const finalState = (stopState ?? 'suspended') as JobMirror['state']
                  settleMirror(finalState)
                  jobState = finalState
                }
              } else if (mirrorRunning && !engineRunning) {
                // 旧单向自愈保留（非本宿主 session，不发停止信号）：镜像
                // running、引擎已终态——以引擎为准降级并广播 run_state，只降
                // 不升：running 镜像不会从引擎旧终态"复活"。
                jobMirrorSetState(runState, jobId, jobState as JobMirror['state'])
              }
              const labels = state.checkpoint_labels ?? {}
              checkpoint = Object.fromEntries(
                Object.entries(state.checkpoints ?? {}).map(([tid, nid]) => [tid, labels[tid] ?? nid]),
              )
              // 【2026-09-07 B1 拆除】草稿 vs 运行快照的宿主比对退役：
              // 比对职责归位——femoGen 跑前用自身脏标志比对定版（runGuard），
              // 引擎 job_resume 第④关做 checkpoint 指纹裁决（原话上浮）。
              // 宿主只存草稿、只转发，不再复刻引擎解析器。
            } else if (state !== undefined) {
              // no_such_job（runs 档案没了，引擎无从停起）：镜像还咬定
              // running 的话降级为挂起——引擎侧无档案可改，宿主侧先说实话。
              const ghostMirror = runState.jobs.get(jobId)
              if (ghostMirror !== undefined && ghostMirror.state === 'running') {
                jobMirrorSetState(runState, jobId, 'suspended')
                if (runState.activeJobId === jobId) runState.activeJobId = undefined
                broadcastProjectionState(runState, mainSid)
                console.log(`[dsh-femo] session-state job=${jobId} no_such_job：残留 running 镜像降级 suspended`)
              }
            }
            // no_such_job / 无绑定 → checkpoint={}（引擎已终态化的 Job 断点作废）
          }
          const jobIds = await readSessionJobIds(resolved.femoRoot, mainSid)
          // 等待人类输入快照（2026-09-06）：mirror.waitingHuman 在 human_wait
          // SET / human_done 清——带出到前端，刷新页面后画布据此恢复人类
          // 输入气泡（不依赖 SSE 重放环覆盖）。
          const waitingMirror = jobId !== undefined ? runState.jobs.get(jobId) : undefined
          writeJson(res, 200, {
            ok: true,
            hasScript: script !== undefined,
            script: script ?? undefined,
            scriptPath: record?.path ?? undefined,
            rev: record?.rev ?? 0,
            jobId,
            ...(jobIds !== undefined ? { jobIds } : {}),
            checkpoint,
            state: jobState,
            running: isSessionRunning(runState, mainSid),
            ...(lastError !== undefined ? { lastError } : {}),
            ...(waitingMirror?.waitingHuman !== undefined ? { waitingHuman: waitingMirror.waitingHuman } : {}),
          })
        })().catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/job',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        // Job 档案透传（2026-09-06 job 快照改造）：femoGen 凭 job_id 直接问
        // 引擎——快照文本/地址、断点、状态全部以引擎档案为权威（宿主不再
        // 代问代译）。no_such_job 等引擎原话 404 上浮。
        void (async () => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const raw = url.searchParams.get('job_id')
          const jobId = raw !== null && /^\d+$/.test(raw) ? Number(raw) : undefined
          if (jobId === undefined) {
            writeJson(res, 400, { ok: false, error: 'job_id is required' })
            return
          }
          if (!bridge.alive) {
            writeJson(res, 503, { ok: false, error: '引擎启动中（bridge 未就绪）' })
            return
          }
          try {
            const job = await bridge.send('get_job_state', { job_id: jobId }, 15000) as { error?: string; state?: string } | undefined
            // 桥接恒 ok（2026-09-10）：404 语义改按档案缺失判（state 字段缺失
            // =no_such_job），引擎原话上浮；failed 场次档案照常 200——存档
            // error 是数据不是查询失败，快照/断点查询不受影响。
            if (job?.state === undefined) {
              writeJson(res, 404, { ok: false, error: String(job?.error ?? 'no_such_job') })
              return
            }
            writeJson(res, 200, { ok: true, job })
          } catch (error: unknown) {
            const msg = String(error instanceof Error ? error.message : error)
            writeJson(res, 404, { ok: false, error: msg })
          }
        })().catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/events',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        // SSE：引擎事件实时推送给 femoGen 可视化画布（呼吸灯/节点详情/流式文本）。
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        res.write(': connected\n\n')
        // 重放已发生的运行事件（运行中打开编辑器标签时画布立即呈现实时状态）。
        // 【2026-09-11 v8.1】**不重放 femo_stream 短命帧**：它是"此刻在飞的流式状态"
        // （start/delta/block_end/end 各帧只有瞬时意义），重放会让旧轮的 delta 再长
        // 一遍字、旧轮的 end 把正在流的新轮桶清掉——实测 Job784 11:57:40.984 整批
        // 帧原样重放一次，随后旧轮闭轮帧逐个清掉新轮桶，就是"每一秒都乱"的来源。
        // 【2026-09-11 v9】**重放帧打 replay 标记**：追平帧只恢复状态，绝不触发
        // 浮层。此前重放帧与新事件形状完全一致，前端无从分辨——挂起态刷新/手机
        // 切回重连时，整场历史 human_wait 被当成活事件逐条弹输入气泡（"走马灯
        // 弹一遍"）；运行态接通同理应只弹"当前在跑的节点"（由 /session-state
        // 快照裁决，不由历史帧裁决）。标记在信封顶层（data 内容零改动，消费方
        // 各自的数据解析不受影响）。
        for (const event of runState.lastEvents) {
          if (event.type === 'femo_stream') continue
          res.write(`data: ${JSON.stringify({ type: event.type, data: event.data ?? {}, replay: true })}\n\n`)
        }
        sseClients.add(res)
        const cleanup = (): void => { sseClients.delete(res) }
        req.on('close', cleanup)
        res.on('close', cleanup)
        // 心跳注释行：防代理/浏览器把空闲连接判死。
        const heartbeat = setInterval(() => {
          try {
            res.write(': ping\n\n')
          } catch {
            clearInterval(heartbeat)
          }
        }, 15_000)
        res.on('close', () => clearInterval(heartbeat))
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/pick-directory',
      handler: (_req: IncomingMessage, res: ServerResponse): void => {
        void (async () => {
          // 导出流程：让用户选剧本保存目录（dsh directory-picker seam：
          // native=系统目录选择对话框 / browse=应用内浏览）。返回目录绝对路径。
          const picker = ctx.get('directoryPicker') as
            | { capability(): { kind: string; pick?(signal: AbortSignal): Promise<string | null>; list?(path?: string): Promise<unknown> } }
            | undefined
          if (picker === undefined) {
            writeJson(res, 500, { ok: false, error: 'directoryPicker service unavailable' })
            return
          }
          const cap = picker.capability()
          if (cap.kind === 'native' && typeof cap.pick === 'function') {
            const dir = await cap.pick(new AbortController().signal)
            writeJson(res, 200, { ok: true, directory: dir })
          } else {
            // browse 后端无系统对话框：让前端填路径（此处仅声明能力不足）。
            writeJson(res, 501, { ok: false, error: 'directoryPicker backend is browse; path entry unsupported yet', kind: cap.kind })
          }
        })().catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/femo-files',
      handler: (_req: IncomingMessage, res: ServerResponse): void => {
        void (async () => {
          // 导入清单（2026-09-11）：导入过/导出过的 .femo 历史，导入的第一级
          // 界面（第二级才是系统文件对话框，电脑端专属）。见 ./femo-files。
          const files = await listFemoFiles(resolved.femoRoot)
          writeJson(res, 200, { ok: true, files })
        })().catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/open-femo-file',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        void (async () => {
          // 从清单里选一条打开：读盘 → 正文回给前端（前端随后走与「浏览选中」
          // 完全相同的收尾：写会话记录 {path, text} + 载入画布）。
          // 只认账本里记过的路径（femo-files 里守卫），不是任意文件读取端点。
          const raw = await readBody(req) as unknown as Record<string, unknown>
          const path = typeof raw.path === 'string' ? raw.path.trim() : ''
          if (path.length === 0) {
            writeJson(res, 400, { ok: false, error: 'path is required' })
            return
          }
          let content: string
          try {
            content = await readLedgerFemoFile(resolved.femoRoot, path)
          } catch (error) {
            // 文件被移走/删掉是常见情况（外接盘、改名），原样上屏给用户判断
            writeJson(res, 404, { ok: false, error: `打不开该文件：${String(error)}` })
            return
          }
          // 打开成功也算一次使用，把它顶到清单最前
          await rememberFemoFile(resolved.femoRoot, path, 'import')
          writeJson(res, 200, { ok: true, path, content })
        })().catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/pick-script',
      handler: (_req: IncomingMessage, res: ServerResponse): void => {
        void (async () => {
          // 导入流程（2026-08-30 猫猫拍板「导入=引用」）：host 弹系统打开文件
          // 对话框，拿到用户所选剧本的**原始位置完整路径**——浏览器 FileReader
          // 出于安全只给文件名不给路径，引用式导入必须由 host 侧选文件。
          // 适用前提与 pick-directory 的 native 后端一致：操作者坐在宿主屏幕前。
          // 实现说明：dsh 本体 directoryPicker seam 只有目录选择（native 后端
          // 写死 FOS_PICKFOLDERS，无文件选择变体），插件内用 powershell
          // WinForms OpenFileDialog 自包含实现（零新依赖、不碰本体）。
          // PS 脚本 ASCII-only（PS5.1 无 BOM 按 ANSI 读的教训）；所选路径经
          // UTF-8 OutputEncoding 写 stdout（用户目录可能含中文）。
          // 约定：退出码 0=已选（stdout=路径）；2=用户取消；1/其他=出错。
          const { spawn } = await import('node:child_process')
          const ps = [
            "$ErrorActionPreference='Stop'",
            '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
            'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
            // 与 pick-save-path 同款：TopMost 隐形 owner 强制对话框置顶——
            // 无 owner 时对话框压在 dsh 主窗口后，用户只见请求悬挂。
            '$o = New-Object System.Windows.Forms.Form',
            '$o.TopMost = $true',
            '$d = New-Object System.Windows.Forms.OpenFileDialog',
            "$d.Title = 'Import FEMO Script'",
            "$d.Filter = 'FEMO Script (*.femo)|*.femo|All Files (*.*)|*.*'",
            'if ($d.ShowDialog($o) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) } else { exit 2 }',
          ].join('; ')
          const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true })
          let out = ''
          let err = ''
          child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8') })
          child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8') })
          // 用户可能中途走开：10 分钟无裁决杀掉对话框，避免请求僵尸悬挂。
          const timer = setTimeout(() => { try { child.kill() } catch { /* already gone */ } }, 600_000)
          const code = await new Promise<number>((resolve) => {
            child.on('close', (c) => { clearTimeout(timer); resolve(c ?? 1) })
            child.on('error', () => { clearTimeout(timer); resolve(-1) })
          })
          const picked = out.trim()
          if (code === 0 && picked.length > 0) {
            const { readFileSync } = await import('node:fs')
            let content: string
            try {
              content = readFileSync(picked, 'utf8')
            } catch (error) {
              writeJson(res, 500, { ok: false, error: `cannot read ${picked}: ${String(error)}` })
              return
            }
            // 入账（2026-09-11）：系统对话框选中的也进导入清单，下次手机端
            // 直接在清单里挑同一个文件，不必再把对话框打到电脑屏幕上。
            await rememberFemoFile(resolved.femoRoot, picked, 'import')
            writeJson(res, 200, { ok: true, path: picked, content })
            return
          }
          if (code === 2) {
            writeJson(res, 200, { ok: true, path: null })
            return
          }
          writeJson(res, 500, { ok: false, error: `pick-script failed (exit ${String(code)})${err.trim().length > 0 ? `: ${err.trim().slice(-400)}` : ''}` })
        })().catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/pick-save-path',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        void (async () => {
          // 导出·首次保存/另存为（2026-09-06）：host 弹系统「保存文件」对话框
          // （带默认文件名）。此前无 path 导出走 pick-directory（选目录+前端
          // 拼名），与用户预期的标准保存文件框不符。实现与 pick-script 同构：
          // dsh directoryPicker seam 只有目录选择（FOS_PICKFOLDERS），插件内
          // powershell WinForms SaveFileDialog 自包含（零新依赖、不碰本体）。
          // OverwritePrompt 默认开=覆盖已有文件前系统先确认。
          // PS 脚本 ASCII-only；默认名嵌入前转义单引号（PS 单引号串规则）；
          // 所选路径经 UTF-8 OutputEncoding 写 stdout（路径可能含中文）。
          // 约定：退出码 0=已选（stdout=路径）；2=用户取消；1/其他=出错。
          const raw = await readBody(req) as unknown as Record<string, unknown>
          const rawName = typeof raw.name === 'string' ? raw.name : ''
          const base = (rawName.split(/[\\/]/).pop() ?? '').trim() || 'flow'
          const { spawn } = await import('node:child_process')
          const ps = [
            "$ErrorActionPreference='Stop'",
            '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
            'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
            // 无 owner 的对话框会被压在 dsh 主窗口后面（用户只见「保存中」永转圈）。
            // 造一个 TopMost 隐形窗当 owner（从不 Show，不占任务栏），强制对话框置顶。
            '$o = New-Object System.Windows.Forms.Form',
            '$o.TopMost = $true',
            '$d = New-Object System.Windows.Forms.SaveFileDialog',
            "$d.Title = 'Save FEMO Script'",
            "$d.Filter = 'FEMO Script (*.femo)|*.femo|All Files (*.*)|*.*'",
            `$d.FileName = '${base.replace(/\.femo$/i, '').replace(/'/g, "''")}.femo'`,
            'if ($d.ShowDialog($o) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) } else { exit 2 }',
          ].join('; ')
          const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true })
          let out = ''
          let err = ''
          child.stdout.on('data', (c: Buffer) => { out += c.toString('utf8') })
          child.stderr.on('data', (c: Buffer) => { err += c.toString('utf8') })
          // 用户可能中途走开：10 分钟无裁决杀掉对话框，避免请求僵尸悬挂。
          const timer = setTimeout(() => { try { child.kill() } catch { /* already gone */ } }, 600_000)
          const code = await new Promise<number>((resolve) => {
            child.on('close', (c) => { clearTimeout(timer); resolve(c ?? 1) })
            child.on('error', () => { clearTimeout(timer); resolve(-1) })
          })
          const picked = out.trim()
          if (code === 0 && picked.length > 0) {
            writeJson(res, 200, { ok: true, path: picked })
            return
          }
          if (code === 2) {
            writeJson(res, 200, { ok: true, path: null })
            return
          }
          writeJson(res, 500, { ok: false, error: `pick-save-path failed (exit ${String(code)})${err.trim().length > 0 ? `: ${err.trim().slice(-400)}` : ''}` })
        })().catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/debug-log',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        // 前端诊断上报通道（2026-08-23 视角切换卡死调查）：前端在关键链路
        // （pickView/openSession/menu 等）调用本路由，把足迹落进 host 日志，
        // 使「前端卡死时到底走到哪一步」在 host 侧可见。
        const url = new URL(req.url ?? '/', 'http://localhost')
        const msg = (url.searchParams.get('msg') ?? '').slice(0, 300)
        console.log(`[dsh-femo][front] ${msg}`)
        writeJson(res, 200, { ok: true })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/projection-windows',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        // 视角菜单数据源：主会话的上帝窗 + 角色窗 id 列表。
        // 返回前先按水位补齐上帝窗缺失的主会话对话（重启缝隙），打开即全。
        void (async () => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sessionId = url.searchParams.get('sessionId')
          if (sessionId === null || sessionId.length === 0) {
            writeJson(res, 400, { ok: false, error: 'sessionId is required' })
            return
          }
          // 重启后 registry 是内存态（空）：投影窗 id 规则化可推导，从持久化
          // 会话 + turn_scopes 文件（历史演员名单）重建注册表，视角菜单重启
          // 即可用，不依赖"再跑一次剧本"。新旧版行为归一（2026-09-09 晚改版）：
          // 原生版角色投影窗回归——ensure 一并补建 femo-proj 角色窗（内容由
          // windowing-native 镜像重放恢复），角色项=投影窗 id。
          let windows = projections.get(sessionId)
          if (windows === undefined) {
            // 主会话未加载时不建窗：cwd 绝不能落到 process.cwd()——否则投影窗
            // 会建进错误的 workspace 分组，与原窗形成 duplicate session id，
            // 整个 workspace 拒绝加载（2026-08-23 事故）。
            // 【2026-09-11 修复·用户实测「刷新后视角菜单点了不切窗」】旧行为在
            // 主会话不在 store 时直接 503（宿主重启后必然如此：0.1.3 的侧边栏
            // 打开只走持久化句柄，不进内存 store），前端 catch 静默降级 ⇒ 菜单
            // 项还在（数据源 /actors 有 turn_scopes 文件回退）但点下去解析不到
            // 投影窗 id，只剩 CSS 过滤分支——用户看到「菜单列着窗口、内容完全
            // 不变」。现在先按官方路径把主会话拉活（ensureSessionLive：
            // agents.resume + 挂 FEMO_PRESET，run/pause 同款兜底），拉活后 cwd
            // 与子代理目录齐备，ensure 才有落点。
            let main = sessionsStore?.get(SessionId(sessionId))
            if (main === undefined) {
              main = await ensureSessionLive(ctx, SessionId(sessionId), 'projection-windows', sessionsStore)
            }
            const cwd = (main?.header as { cwd?: string } | undefined)?.cwd
            if (main === undefined || cwd === undefined) {
              // 拉活也失败（会话不存在/持久化不可达）：503 如实报错并带 kind，
              // 前端据此给出可操作提示（不再无声无息地「点了没反应」）。
              writeJson(res, 503, {
                ok: false,
                kind: 'main-not-loaded',
                error: '主会话未装载（自动拉活失败）：先打开一次主会话（戏外 · 主模型）再点视角；一直失败请看宿主日志 [femo-run-diag]',
              })
              return
            }
            const scopeMap = await readTurnScopeFile(resolved.femoRoot, sessionId)
            const scopeActors = [...new Set(Object.values(scopeMap).flat())]
            windows = await projections.ensure(sessionId, scopeActors, cwd)
          }
          // 按水位补齐上帝窗缺失的主会话对话（重启缝隙），打开即全。
          await godMirror.ensureGodMirrorUpToDate(sessionId)
          const actors: Record<string, string> = {}
          for (const [actor, win] of windows.actors) actors[actor] = String(win.id)
          writeJson(res, 200, {
            ok: true,
            god: windows.god === undefined ? undefined : String(windows.god.id),
            stage: windows.stage === undefined ? undefined : String(windows.stage.id),
            actors,
          })
        })().catch((error: unknown) => {
          writeJson(res, 500, { ok: false, error: String(error) })
        })
      },
    })
    webServer.register({
      kind: 'exact',
      path: '/dsh-femo/projection-input',
      handler: (req: IncomingMessage, res: ServerResponse): void => {
        // 三路路由业务体（steer 主模型/喂引擎/本地留痕 + 诊断文件日志）已迁至
        // projection-input.ts（2026-08-26 整理）；本文件只留注册与分发。
        void handleProjectionInput(ctx, {
          resolved,
          bridge,
          runState,
          projections,
          sessionsStore,
          // 主会话不在 store（宿主重启后）：按官方路径拉活，ensure 兜底才有 cwd。
          ensureMainLive: (mainSid: string): Promise<Session | undefined> =>
            ensureSessionLive(ctx, SessionId(mainSid), 'projection-input', sessionsStore),
        }, req, res)
          .catch((error: unknown) => {
            writeJson(res, 500, { ok: false, error: String(error) })
          })
      },
    })
    console.log('[dsh-femo] create-session + scripts + save-script + script + errors routes registered')
  } else {
    console.log('[dsh-femo] webServer unavailable; routes not registered')
  }
}
