/**
 * dsh-femo — Femo integration for DeepSeek Harness.
 *
 * 本文件是「总装车间」：插件门面（name/inject/Config）、事件词汇声明合并、
 * 以及 apply() 编排——把各职责模块按序装配起来。业务逻辑都在对应模块：
 *
 *   config.ts        设置表（Config schema + ResolvedConfig）
 *   bridge.ts        与 Python 引擎通话的电话线（FemoBridge 子进程封装）
 *   persona.ts       Femo 会话身份证 + 导演手册/运行通知注入
 *   http.ts          HTTP 小工具箱（readBody/writeJson/SSE 广播）
 *   state-files.ts   存档管理员（checkpoint/turn_scopes/session_script 文件族)
 *   projection.ts    投影窗管家（建窗/唤醒/投影 + chat 行写入）
 *   god-mirror.ts    主会话→上帝窗镜像（实时监听 + 水位补齐，2026-08-26 自 projection 迁出）
 *   subagent.ts      AI 演员经纪人（引擎 AI 节点 → dsh 子代理执行与事件镜像）
 *   engine-events.ts 演出中的总调度（pre-step 门卫接线 + 输入桥 + 引擎事件 switch）
 *   pre-step-gate.ts 门卫裁决面（纯函数：按轮裁决，见该文件头）
 *   run-control.ts   开演流程（startRunOnSession + 剧本读写 handler）
 *   routes.ts        前台接线员（全部 /dsh-femo/* HTTP 路由）
 *   tools.ts         主模型专用工具（femo-mount/run/script/soul；本就独立）
 *
 * 历史行为注记（M2 scope）：
 *   1. Femo sessions via sidebar button (POST /dsh-femo/create-session),
 *      optionally with a `femo` script body that auto-starts the engine.
 *   2. No main model while running: pre-step rejects for running Femo sessions
 *      — turn-scoped since 2026-09-11 (only the step-1 gate decides; a turn
 *      already entered keeps its tool-continuation steps, so real user input
 *      typed in the main window runs a full native turn even mid-script).
 *      idle Femo sessions run the main model normally.
 *   3. Engine bridge: managed Python subprocess (femo_bridge.py), NDJSON
 *      over stdio. run/pause/resume/human_input/list_scripts/ping/
 *      shutdown. LLM key resolved from ctx.credentials per run.
 *   4. Event bridge: engine events are re-emitted as cordis
 *      'dsh-femo/event'; the event switch turns them into projected chat
 *      lines and main-model notices.
 *   5. Input bridge: user messages on the running Femo session are forwarded
 *      as human input while a human node waits, or hard-pause the run (job_pause)
 *      (interrupt semantics) while the engine is working.
 *
 * NOTE: ctx.logger output is not reliably visible in this deployment, so
 * diagnostics also go to console.log.
 *
 * 2026-08-23 重构：单文件（2733 行）拆分为上述模块；纯搬家+闭包工厂化，
 * 行为零变化。重构前快照见 src/index.ts.bak-20260823-pre-refactor。
 */

import type { Context } from '@deepseek-ai/cordis'
// Value import: SessionId 构造器在 resolveMounted 用。
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
// Namespace import: `registerSessionEventType` (the runtime event-type
// registration surface) only exists on builds that ship it; on stock builds
// the plugin still loads and live sessions work — only loading history of
// dsh-femo/chat sessions is unavailable there (see README "dsh 版本要求").
// 红线：注册必须只发生在此处一处（external 单例语义，见 build.mjs 注释）。
import * as sessionNS from '@deepseek-ai/dsh-session'

import { Config, resolveConfig } from './config'
import { FemoBridge } from './bridge'
import { FEMO_PRESET, presetOf, isFemoAgent, registerPersonaHooks } from './persona'
import { broadcastSse } from './http'
import { readSessionScript, readSessionScriptText, writeSessionScript, readSessionCurrentJob } from './state-files'
import { appendChatProjected, createProjectionRegistry, awakenedDisposers, disposeProjectionWriters } from './projection'
import { installNativeWindowing, isNativeDshBuild } from './windowing-native'
import { installPersistenceListCache } from './list-cache'
import { createGodMirror } from './god-mirror'
import { type RunState, registerEngineEventHandlers, jobMirrorPrearm, activeJobOfSession, broadcastProjectionState } from './engine-events'
import { initDiagFeed, pushDiag } from './diag-feed'
import { installHostLogCapture } from './host-log'
import { rememberFemoFile } from './femo-files'
import { startJobOnSession, assertRunAllowed, collectLlmModels } from './run-control'
import { registerRoutes } from './routes'
import { registerFemoTools, type FemoToolDeps } from './tools'
// femo-debug 工具的执行体：与 femoGen 调试窗「编译」按钮共用同一台
// femo_debugger（流式路径在 routes.ts；这里是整跑收集路径）。
import { collectDebugRun } from './debug-run'
import { apiRetry } from './api-retry'
import { activeChildRuns, abortAllSubagents } from './subagent'
import { disposeMainDeliveries, isMainAnswerPending, mainActorSceneActor, pendingNodeName } from './main-actor'
import { broker } from './node-retry'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One Femo engine chat line rendered by the dsh-femo client node.
     * @mode emit
     * @param data - speaker, line text, and line kind.
     */
    'dsh-femo/chat': {
      /** Speaker name (engine node), when the line is a role line. */
      actor?: string
      /** The line's text. */
      text: string
      /** role = AI character line; notice = engine/flow status; human_wait = waiting for the user; prompt = node hint/announcement; error = engine error (red, system-like); thinking = subagent cot (folded); tool_call = subagent tool invocation line (JSON body); speaker = subagent turn header name line; sys = femo-run success receipt (main session surface only, user-facing). */
      kind: 'role' | 'notice' | 'human_wait' | 'prompt' | 'error' | 'thinking' | 'tool_call' | 'speaker' | 'sys'
    }
  }
}

export const name = 'dsh-femo'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** One Femo engine event, re-emitted verbatim (eventType, data). */
    'dsh-femo/event'(eventType: string, data: unknown): void
  }
}

/** Required services: agent registry + session store + tools (femo-mount/run). */
export const inject = ['agents', 'sessions', 'agentDefaultModel', 'tools', 'webServer']

export { Config }

export async function apply(ctx: Context, config: unknown): Promise<void> {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) {
    console.log('[dsh-femo] disabled by config')
    return
  }
  // 全局默认模型选择（用户在模型选择 UI 保存的推理等级在这里）；
  // 子 agent 不走 apiproxy 的 selection 安装，需要手动注入。
  const defaultModel = ctx.get('agentDefaultModel') as
    | { currentSelection(): unknown }
    | undefined

  // Admit the plugin's custom event type ('dsh-femo/chat') into the session
  // event vocabulary at runtime (the persistence read path otherwise refuses
  // logs containing it). Every type the plugin appends to a session log must
  // be registered here — missing one means that session's history fails to
  // load. (turn→scope used to be a log event too; it now persists to the
  // plugin's user_data/host-history/projections/turn-scopes/<sessionId>.json instead.) Registration
  // must precede any session load, so it happens at apply time. Only builds
  // that ship the registration surface (upstreamed feature / meow fork) have
  // it; on stock builds the plugin keeps working for live sessions.
  const registerSessionEventType = (sessionNS as { registerSessionEventType?: (type: string) => () => void }).registerSessionEventType
  if (registerSessionEventType !== undefined) {
    ctx.effect(() => registerSessionEventType('dsh-femo/chat'), 'dsh-femo: session event type')
    // 旧会话日志（turn-scope 文件化改造前）带 dsh-femo/turn-scope 事件；
    // 2026-09-12 femo 改名时存量事件类型已一并迁移，这里照常放行。
    ctx.effect(() => registerSessionEventType('dsh-femo/turn-scope'), 'dsh-femo: session event type (legacy turn-scope)')

  } else {
    console.log('[dsh-femo] this dsh build lacks registerSessionEventType; loading history of dsh-femo sessions is unsupported here (see README)')
  }

  // Crash diagnostics: log uncaught exceptions/rejections instead of taking
  // the process down silently (the 3081 instance is managed by AutoClaw and
  // gets relaunched, so a visible log beats a silent relaunch).
  process.on('uncaughtException', (error: Error) => {
    console.log(`[dsh-femo] uncaughtException: ${String(error?.stack ?? error)}`)
  })
  process.on('unhandledRejection', (reason: unknown) => {
    console.log(`[dsh-femo] unhandledRejection: ${String(reason instanceof Error ? reason.stack : reason)}`)
  })
  // Event-loop heartbeat (2026-08-23 卡死调查): a 1s timer whose drift exposes
  // event-loop stalls. 静态文件活着但 RPC 全挂 = 异步死锁（心跳正常）；
  // 心跳也停 = 事件循环被同步代码堵死。两种病，两副药。
  let heartbeatLast = Date.now()
  const HEARTBEAT_INTERVAL = 1000
  setInterval(() => {
    const now = Date.now()
    const lag = now - heartbeatLast - HEARTBEAT_INTERVAL
    heartbeatLast = now
    if (lag > 2000) {
      console.log(`[dsh-femo] event-loop stall: ${lag}ms behind`)
    }
  }, HEARTBEAT_INTERVAL)

  const bridge = new FemoBridge()
  ;(bridge as unknown as { emit(name: string, ...args: unknown[]): void }).emit = (name, ...args) => {
    ;(ctx.emit as (name: string, ...args: unknown[]) => void)(name, ...args)
  }

  // Run-state bookkeeping（Job 模型新形态 §6.2/§10.2）：jobs=Job 镜像表、
  // sidIndex=sid→最近 Job、activeJobId=引擎活跃 Job（全插件共享同一引用，
  // engine-events/routes/tools deps 显式传参）。
  const runState: RunState = {
    jobs: new Map(),
    sidIndex: new Map(),
    sessionActors: new Map(),
    errors: new Map(),
    lastEvents: [],
  }
  // 【诊断 2026-09-06】诊断流落盘初始化（user_data/debug-diag-feed.log）。
  initDiagFeed(resolved.femoRoot)
  // 【调试窗『Host』页 2026-09-11】宿主侧 console 采集：只认本插件代码打的行
  // （栈过滤，见 host-log.ts），进 diag feed 的 tag 'host' 供前端第四页显示。
  installHostLogCapture()

  // 【原生 0.1.3+ 分流】stock 构建安装 windowing-native 层：投影窗保持裸建
  // （原 0.1.3 实测不落盘 ⇒ 自定义事件永不进持久层，无拒载/无砖），窗历史由
  // femo 自有镜像跨重启重放；主会话 sys 回执自动降级为仅窗侧。meow fork
  // （有 registerSessionEventType）不安装，原投影窗路径行为逐字节不变。
  installNativeWindowing(ctx, {
    native: isNativeDshBuild(sessionNS),
    mirrorDir: `${resolved.femoRoot}\\user_data\\host-history\\projections\\proj-mirror`,
  })

  const sessionsStore = ctx.get('sessions') as { get(id: SessionId): Session | undefined } | undefined

  // ── 断电闭环 + 索引重建（§10.2，提案 §二.5 闭环的宿主半场）──────────────
  // 扫会话记录的 currentJobId 填 runState.sidIndex——不置 running（引擎
  // reconcile 已把全量 running 判 suspended(crash)，镜像天然干净）。此后：
  // 前端 /session-state 走 get_job_state 代理看到 suspended + checkpoint →
  // 显示「继续」→ job_resume 六关裁决 → 恢复。
  const rebuildJobIndexFromRecords = async (): Promise<void> => {
    const { readdir } = await import('node:fs/promises')
    const sessionsDir = `${resolved.femoRoot}\\user_data\\host-history\\drafts`
    let names: string[] = []
    try {
      names = await readdir(sessionsDir)
    } catch {
      return
    }
    let rebuilt = 0
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const sid = name.slice(0, -'.json'.length)
      const jobId = await readSessionCurrentJob(resolved.femoRoot, sid)
      if (jobId !== undefined) {
        runState.sidIndex.set(sid, jobId)
        rebuilt += 1
      }
    }
    if (rebuilt > 0) console.log(`[dsh-femo] job index rebuilt from session records: ${rebuilt} entr(y|ies)`)
  }

  // ── C1 进程监督自愈（§十四.1，第二步收尾）──────────────────────────────
  // bridge 半路死亡 → 清账（下方 onExited）→ 延迟 3s 自动 respawn + ping 轮询
  // → 就绪后重建 Job 索引（Job 档案在引擎侧未丢——新进程 reconcile 已把
  // running 判 suspended(crash)，runs 目录是权威）。两道防线：
  // ① dispose 标志：插件卸载/HMR 时 bridge.stop() 也会触发 onExited——
  //   卸载后绝不允许僵尸 respawn；
  // ② 崩溃连击退避：30s 窗口内连续死亡 ≥3 次（spawn 即死/启动即崩）→
  //   停止自动重启并大声 log——监督自愈不能变成重启风暴（防反复烧桥）。
  let bridgeDisposed = false
  let bridgeCrashStreak = 0
  let lastCrashAt = 0

  /** 轮询 ping 等重生后的 bridge 就绪（最多 15s），就绪即重建 Job 索引。 */
  const pingBridgeUntilAlive = async (): Promise<void> => {
    for (let i = 0; i < 15; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      if (bridgeDisposed) return
      try {
        await bridge.send('ping', {}, 3000)
        console.log(`[dsh-femo] C1 self-heal: bridge respawned and ready (after ~${i + 1}s); rebuilding job index`)
        await rebuildJobIndexFromRecords()
        return
      } catch { /* spawn 中/未就绪：继续等 */ }
    }
    console.log('[dsh-femo] C1 self-heal: bridge ping not ready after 15s; subsequent commands will surface errors if still down')
  }

  // 引擎进程半路死亡时不会有任何终止事件，镜像会卡孤儿 running——这里清账
  // 并自愈重启（第一步只清账+log，C1 自愈为第二步收尾，§十四.1）。
  bridge.onExited = (): void => {
    if (runState.activeJobId !== undefined || runState.jobs.size > 0) {
      console.log('[dsh-femo] bridge exited mid-run; clearing stale job mirrors')
      pushDiag('bridge', 'exited mid-run → 清全部 Job 镜像 waitingHuman + activeJobId（C1 自愈将重建索引）')
    }
    // 清场：全场掐断在飞演员 + 放行全部停靠者 + jobs 全部 state 校正。
    abortAllSubagents('bridge exited')
    broker.abortAll('bridge exited')
    for (const [jobId, mirror] of runState.jobs) {
      if (mirror.state === 'running') mirror.state = 'failed'
      mirror.waitingHuman = undefined
    }
    runState.activeJobId = undefined
    // sidIndex 保留（respawn 后 pingBridgeUntilAlive / 重启 rebuild 重建）。
    // 清账后向各 Job 归属会话广播投影窗状态（全部转非 running）。
    for (const mirror of runState.jobs.values()) {
      broadcastProjectionState(runState, mirror.ownerSid)
    }
    void rebuildJobIndexFromRecords()

    if (bridgeDisposed) return
    const now = Date.now()
    bridgeCrashStreak = (now - lastCrashAt < 30_000) ? bridgeCrashStreak + 1 : 1
    lastCrashAt = now
    if (bridgeCrashStreak >= 3) {
      console.log('[dsh-femo] C1 self-heal: bridge crashed 3x within 30s; auto-respawn disabled (needs manual restart)')
      return
    }
    setTimeout(() => {
      if (bridgeDisposed) return
      console.log(`[dsh-femo] C1 self-heal: respawning bridge (crash streak=${bridgeCrashStreak})`)
      bridge.start(ctx, resolved)
      void pingBridgeUntilAlive()
    }, 3000)
  }

  /** 投影窗注册表：sid → { god, stage, actors }（上帝/戏内/角色视角的子代理窗）。 */
  const projections = createProjectionRegistry(ctx)

  /** 主会话 → 上帝窗镜像（实时监听 + 水位补齐）。 */
  const godMirror = createGodMirror({ femoRoot: resolved.femoRoot, sessionsStore, projections, mainActorSceneActor })

  const recordError = (sessionId: SessionId, text: string): void => {
    const key = String(sessionId)
    const list = runState.errors.get(key) ?? []
    list.push({ ts: Date.now(), text })
    if (list.length > 50) list.shift()
    runState.errors.set(key, list)
    console.log(`[dsh-femo] error on ${key}: ${text}`)
  }

  // 身份钩子（preset override 重建 + docs section 补注入/清除）。
  registerPersonaHooks(ctx)

  // 运行期总调度：pre-step 门卫 + 输入桥 + 上帝窗实时镜像 + 引擎事件 switch
  // （内部按此顺序注册监听器，与重构前 apply() 的注册顺序一致）。
  registerEngineEventHandlers(ctx, {
    resolved, bridge, runState, sessionsStore, projections, godMirror, defaultModel, recordError,
    broker,
  })

  // ── API 请求错误慢层兜底（第二类错误，施工清单 v4 §2 / §12 Step A）──────
  // agent/request-error 瀑布的下游（base bundle llm-retry 快层之后注册）：
  // femo 演员请求（子代理 + main 在飞回合）五段退避重试（立即/20s/1min/
  // 3min/10min），第五段之后仍败放行 = turn error = 节点按结束。compiler 无感。
  // apiRetry/broker 均为模块级单例（subagent.ts finally 的 clearChild/
  // unregister 与此共用实例）。
  ctx.effect(() => apiRetry.install(ctx, {
    resolveTarget: (childId) => {
      const hit = activeChildRuns.get(childId)
      if (hit !== undefined) {
        return { kind: 'subagent', mainSessionId: hit.mainSid, childSessionId: childId, node: hit.node }
      }
      if (isMainAnswerPending(childId)) {
        return { kind: 'main', mainSessionId: childId, childSessionId: childId, node: pendingNodeName(childId) }
      }
      return undefined
    },
    onRetry: (target, attempt, delayMs, failure) => {
      const delayText = delayMs <= 0 ? '立即' : `${Math.round(delayMs / 1000)} 秒后`
      if (target.kind === 'main') {
        console.log(`[femo-api-retry] main 调用失败（${failure.code}），${delayText}重试（第 ${attempt}/5 次）：node=${target.node} ${failure.message.slice(0, 200)}`)
        return
      }
      const session = sessionsStore?.get(SessionId(target.mainSessionId))
      if (session === undefined) return
      // 取值面 mirror 化（§6.2）：nodeActors/nodeScopes 随 Job 走。
      const mirror = activeJobOfSession(runState, target.mainSessionId)
      const actor = mirror?.nodeActors.get(target.node) ?? target.node
      appendChatProjected(ctx, session, projections,
        `⏳ 演员 ${actor} 调用失败（${failure.code}），${delayText}重试（第 ${attempt}/5 次）`,
        'notice', actor, mirror?.nodeScopes.get(target.node))
    },
    onExhausted: (target, failure) => {
      if (target.kind === 'main') {
        console.log(`[femo-api-retry] main 连续 5 次 API 失败，节点「${target.node}」执行失败上报引擎（本场挂起可续跑）：${failure.code} ${failure.message.slice(0, 200)}`)
        return
      }
      const session = sessionsStore?.get(SessionId(target.mainSessionId))
      if (session === undefined) return
      const mirror = activeJobOfSession(runState, target.mainSessionId)
      const actor = mirror?.nodeActors.get(target.node) ?? target.node
      const text = `演员 ${actor} 连续 5 次 API 失败，节点「${target.node}」执行失败：${failure.code} ${failure.message}（本场将挂起，可点「继续」重演）`
      recordError(SessionId(target.mainSessionId), text)
      appendChatProjected(ctx, session, projections, `❌ ${text}`, 'notice', actor, mirror?.nodeScopes.get(target.node))
    },
  }), 'dsh-femo: api retry chain')

  // 停靠经纪人生命周期（第三类剧本错误，施工清单 v4 §5 / §12 Step C）：
  // HMR/插件卸载时清全部 parker 与在飞 timer（abortAll 幂等）。
  ctx.effect(() => () => {
    broker.dispose()
    // 【2026-09-11】戏内注入排队件（等主会话轮收口的）一并清，防 HMR 残留。
    disposeMainDeliveries()
  }, 'dsh-femo: node retry broker')

  // HTTP 路由（19 个 /dsh-femo/* 接口登记——run-result 退役、jobs 新增）。
  registerRoutes(ctx, {
    resolved, bridge, runState, projections, sessionsStore, godMirror, recordError,
  })

  // Bridge lifecycle: start the Python engine subprocess, stop on dispose.
  setTimeout(() => { bridge.start(ctx, resolved) }, 1000)
  ctx.effect(() => () => {
    // 先置 disposed 再 stop：bridge.stop() 触发的 onExited 据此跳过 C1
    // respawn（插件卸载/HMR 后不留僵尸引擎进程）。
    bridgeDisposed = true
    void bridge.stop()
  }, 'dsh-femo: bridge lifecycle')
  // 唤醒的冷投影窗 detach：插件卸载/HMR 重载时移出 sessions store，防泄漏。
  ctx.effect(() => () => {
    for (const dispose of awakenedDisposers.splice(0)) {
      try { dispose() } catch { /* 已分离则忽略 */ }
    }
    // 【2026-09-11】同时收尾接管的写盘句柄（attachProjectionWriter）——不 close
    // 会把单写者所有权留在进程里，下次 boot 的 open('write') 会被拒。
    disposeProjectionWriters()
  }, 'dsh-femo: awakened projection windows')

  // persistence.list 指纹缓存（2026-08-30 会话列表卡死修复）：session.list /
  // session.history 的全量 header 扫描降到 ~50ms；卸载即恢复裸方法。
  // 停用史：2026-09-08 因 0.1.3-alpha.2 实验实例上冷会话从列表消失而停用。
  // 2026-09-12 复盘并恢复：根因是 0.1.3+ 官方消费方改用 persistence.list({ signal })
  // 选项对象传参，包装层按裸 signal 解析直接 TypeError（list RPC 全体失败）。
  // list-cache.ts 已兼容两种传法；当前实例 0.1.5-rc.1 的列表链路为
  // ApiSessionList.list → sessionQuery.listSessions → SessionCorpus.listSessions
  // → persistence.list()（SQLite 索引只加速搜索，不接管列表），缓存包装点仍是热路径。
  ctx.effect(() => installPersistenceListCache(ctx), 'dsh-femo: persistence list cache')

  // ── 主模型专用工具：femo-mount（挂载剧本到会话）/ femo-run（控制运行）。
  //    执行体复用现有链路（writeSessionScript / startRunOnSession），只注入依赖。
  // 公共解析：会话校验 + 读挂载剧本（text 优先）+ 编译校验（check 命令）。
  // fresh_start 与 resume 共用——AI 看到的=AI 跑的=编译过的。
  const resolveMounted = async (sessionId: string): Promise<{ sid: SessionId; scriptText: string; effectivePath?: string }> => {
    const sid = SessionId(sessionId)
    const session = sessionsStore?.get(sid)
    if (session === undefined) {
      throw new Error(`会话 ${sessionId} 不存在`)
    }
    if (presetOf(session) !== FEMO_PRESET) {
      throw new Error('当前会话不是 FEMO模式')
    }
    // 守卫（§10.2）：本会话活跃才拒；他 session 活跃由引擎 another_job_active
    // 拒并原话上浮——文案信息化保留。
    assertRunAllowed(runState, sessionId)
    const scriptText = await readSessionScriptText(resolved.femoRoot, sessionId)
    if (scriptText === undefined) {
      throw new Error('会话未挂载剧本：请先 femo-mount 或用 femoGen 编辑器写入剧本')
    }
    const prev = await readSessionScript(resolved.femoRoot, sessionId)
    const effectivePath = prev?.path
    // 编译校验（femo-run 路径）：编译错误作为工具返回结果给主模型，
    // 带细节（parse_script 的行号/变量名）指导改剧本；不启动运行、无状态残留。
    const baseDir = effectivePath !== undefined
      ? effectivePath.replace(/[\\/][^\\/]*$/, '')
      : ''
    try {
      await bridge.send('check', { femo: scriptText, base_dir: baseDir, models: await collectLlmModels(ctx, resolved) }, 30_000)
    } catch (error: unknown) {
      throw new Error(`剧本编译失败：${String(error instanceof Error ? error.message : error)}`)
    }
    return { sid, scriptText, effectivePath }
  }
  // editor_errors 回传：只取编辑器来源（带 [编辑器·] 前缀）的错误，取走即从
  // 列表删除。engine 来源的错误（flow_error / 子 agent 失败等）不带走——它们
  // 已有 steer ❌ 必达通道，不应再经工具返回体重复通知主模型。
  // errors 大列表保留供画布面板 /dsh-femo/errors GET 显示用。
  const toolDeps: FemoToolDeps = {
    takeEditorErrors: (sessionId: string): string[] => {
      const list = runState.errors.get(sessionId) ?? []
      if (list.length === 0) return []
      const taken: string[] = []
      const remaining: typeof list = []
      for (const e of list) {
        if (e.text.startsWith('[编辑器·')) {
          taken.push(e.text)
        } else {
          remaining.push(e)
        }
      }
      if (taken.length > 0) {
        runState.errors.set(sessionId, remaining)
      }
      return taken
    },
    mountScript: async (sessionId, scriptPath) => {
      // 挂载=全新开始（用户语义「我就要这一版」）：旧版遗留的报错与本次
      // 挂载无关，先清空本会话错误列表——mount 之后之前的报错一律作废。
      runState.errors.delete(sessionId)
      // 双链路①：path + text 一起写。恢复面读取是 text 优先（实际运行版本），
      // mount 只写 path 的话，任何后续快照写回的 stale text 都会遮蔽新挂载的
      // 剧本（2026-08-21「挂载后画布空白」bug 根因）。text 始终与文件内容一致。
      const { readFile } = await import('node:fs/promises')
      let text: string
      try {
        text = await readFile(scriptPath, 'utf8')
      } catch (error) {
        throw new Error(`无法读取剧本文件 ${scriptPath}：${String(error instanceof Error ? error.message : error)}`)
      }
      // 同步校验本次挂载文本（与 run 的 resolveMounted 同一套 check；base_dir=
      // 剧本文件所在目录，file: 相对引用按剧本位置解析）：mount 返回应报
      //「当前 mount 文本」的错误——历史残留已清、编辑器异步上报慢一拍，
      // 这里才是 mount 时刻的权威校验。有错只记不拦（挂载不受阻，编辑器可见）。
      const baseDir = scriptPath.replace(/[\\/][^\\/]*$/, '')
      try {
        await bridge.send('check', { femo: text, base_dir: baseDir, models: await collectLlmModels(ctx, resolved) }, 30_000)
      } catch (error: unknown) {
        recordError(SessionId(sessionId), `[编辑器·mount] ${String(error instanceof Error ? error.message : error)}`)
      }
      await writeSessionScript(resolved.femoRoot, sessionId, { path: scriptPath, text })
      // 入账（2026-09-12）：AI femo-mount 的剧本与人工导入同待遇——进导入
      // 清单（femogen 导入浮层），手机端才能直接挑到 AI 刚挂载的那份。
      // rememberFemoFile 自吞写失败（只打日志），不会让挂载本身变失败。
      await rememberFemoFile(resolved.femoRoot, scriptPath, 'import')
      console.log(`[dsh-femo] femo-mount ${sessionId} <- ${scriptPath}`)
      // 双链路②：记录已更新 → 推信号让已打开的编辑器重读。否则旧画布的
      // 3s 防抖回写会用内存旧本盖掉新写入的地址，重新挂载等于白挂。
      broadcastSse('script_changed', { sessionId })
    },
    startJob: async (sessionId, mode, jobId) => {
      // §10.2：fresh——resolveMounted（守卫+读剧本+check 保留）→ 查旧
      // currentJobId 供幽灵书签 note → startJobOnSession(reset=true)；
      // resume——同 resolveMounted → startJobOnSession(reset=false, jobId)。
      // 六关/排他错误原话上浮（B2：不再静默）。
      const { sid, scriptText, effectivePath } = await resolveMounted(sessionId)
      if (mode === 'fresh') {
        // 幽灵书签 note：旧 Job 确为 suspended 才附注（get_job_state 失败不阻塞）。
        let note: string | undefined
        try {
          const oldJobId = await readSessionCurrentJob(resolved.femoRoot, sessionId)
          if (oldJobId !== undefined) {
            const st = await bridge.send('get_job_state', { job_id: oldJobId }, 15000) as { state?: string } | undefined
            if (st?.state === 'suspended') {
              note = `上一场 Job ${oldJobId} 已挂起存档，可 femo-run resume + job_id 或 list_jobs 找回`
            }
          }
        } catch { /* note 是增强信息，失败不阻塞主流程 */ }
        await startJobOnSession(ctx, resolved, bridge, runState, sid, scriptText, effectivePath, true, undefined, projections)
        // jobId 从镜像取（prearm 已写入）
        const activeId = runState.activeJobId
        return { ok: true, jobId: activeId ?? -1, ...(note !== undefined ? { note } : {}) }
      }
      await startJobOnSession(ctx, resolved, bridge, runState, sid, scriptText, effectivePath, false, jobId, projections)
      const activeId = runState.activeJobId
      return { ok: true, jobId: activeId ?? jobId ?? -1 }
    },
    pauseScript: async (sessionId) => {
      // pause 不带 job_id（2026-09-06 猫猫拍板）：自动停本会话正在运行的
      // Job——与前端 pause 路由同款镜像解析（running + 活跃指针双判定）。
      // 镜像不满足（没跑过/已挂起/重启后镜像空）一律按"无活跃剧本"回，
      // 不裸发 job_pause——引擎对 finished Job 也回 paused:true，会误报成功。
      const job = activeJobOfSession(runState, sessionId)
      const targetId = job?.state === 'running' && runState.activeJobId === job.jobId
        ? job.jobId
        : undefined
      if (targetId === undefined) {
        console.log(`[dsh-femo] femo-run pause ${sessionId} -> no running job (mirror=${String(job?.jobId ?? '-')}, active=${String(runState.activeJobId ?? '-')})`)
        return { paused: false }
      }
      // job_pause 幂等回执；no_such_job 等失败原话上浮为工具 ❌。
      const result = await bridge.send('job_pause', { job_id: targetId }, 15000) as { paused?: boolean; state?: string } | undefined
      console.log(`[dsh-femo] femo-run pause ${sessionId} job=${String(targetId)} -> paused=${result?.paused === true} state=${String(result?.state ?? '-')}`)
      return { paused: result?.paused === true, state: result?.state, jobId: targetId }
    },
    listJobs: async () => {
      const result = await bridge.send('list_jobs', {}, 15000) as { jobs?: Array<{ job_id: number; state: string; reason: string; waiting_human: boolean; femo_session_id: number | null; host_ref: string; script_name: string; created_at: string; updated_at: string; has_breakpoint: boolean }> } | undefined
      return result?.jobs ?? []
    },
    isFemoMainSession: (agent) => isFemoAgent(agent),
    soulList: async () => {
      // femo-soul list：主模型写剧本选角前查角色库（bridge 直读 DB）。
      const result = await bridge.send('list_souls', {}, 15000) as { souls?: Array<{ soul_id: string; soul_name: string }> } | undefined
      return { souls: result?.souls ?? [] }
    },
    soulCreate: async (soulId, soulName, description) => {
      // femo-soul create：新建全局角色（归属/创建者固定 u001，与前端 soul 弹窗同链路）。
      return bridge.send('create_soul', { soul_id: soulId, soul_name: soulName, description, user_id: 'u001' }, 15000)
    },
    readScript: async (sessionId) => {
      const record = await readSessionScript(resolved.femoRoot, sessionId)
      if (record === undefined) return undefined
      const finalText = await readSessionScriptText(resolved.femoRoot, sessionId)
      if (finalText === undefined) return undefined
      return { path: record.path, text: record.text, finalText }
    },
    debugRun: async (sessionId, opts) => {
      // femo-debug：零 token 干跑当前挂载的剧本（与 femoGen 调试窗同一台
      // femo_debugger）。与 femo-run 的差别：不查 Job 守卫、不开 Job、不广播、
      // 不 check——调试器自己会编译并原话报错；跑的是独立沙盒，不碰生产台账。
      // 读文本与 femo-script 同源（text 优先，实际运行版本），scriptPath 供
      // code: file:"xxx.py" 相对引用解析（与正式运行同语义）。
      const scriptText = await readSessionScriptText(resolved.femoRoot, sessionId)
      if (scriptText === undefined) {
        throw new Error('会话未挂载剧本：请先 femo-mount 挂载，或用 femoGen 编辑器写入剧本')
      }
      const prev = await readSessionScript(resolved.femoRoot, sessionId)
      const started = Date.now()
      const result = await collectDebugRun(ctx, resolved, {
        femo: scriptText,
        ...(prev?.path !== undefined ? { scriptPath: prev.path } : {}),
        ...(opts.module !== undefined && opts.module.length > 0 ? { module: opts.module } : {}),
        ...(opts.runs !== undefined ? { runs: opts.runs } : {}),
        ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      }, opts.signal)
      console.log(`[dsh-femo] femo-debug ${sessionId} → exit=${result.exitCode}`
        + ` records=${result.records.length} report=${result.report !== undefined}`
        + ` timedOut=${result.timedOut}`
        + `${opts.module !== undefined && opts.module.length > 0 ? ` module=${opts.module}` : ''}`
        + `（${Date.now() - started}ms）`)
      return result
    },
    chronicaQuery: async (opts) => {
      // femo-chronica：直接复用插件根目录的 chronica.py CLI（能力只有一份）。
      // 只读查询，一次性子进程——不走 bridge（那条链路是运行控制/写库用的）。
      const args: string[] = []
      if (opts.list !== undefined) args.push('--list', String(opts.list))
      else if (opts.show !== undefined) args.push(String(opts.show))
      if (opts.scope === true) args.push('--scope')
      if (opts.full === true) args.push('--full')
      const subprocess = ctx.get('subprocess') as {
        resolveExecutable(command: string): Promise<string>
      } | undefined
      if (subprocess === undefined) {
        throw new Error('subprocess 服务不可用（无法解析 python 可执行文件）')
      }
      const pythonPath = await subprocess.resolveExecutable(resolved.python)
      const [{ execFile }, { promisify }, { join }] = await Promise.all([
        import('node:child_process'),
        import('node:util'),
        import('node:path'),
      ])
      try {
        const { stdout } = await promisify(execFile)(
          pythonPath,
          [join(resolved.femoRoot, 'femoToolcall', 'chronica.py'), ...args],
          {
            timeout: 15_000,
            maxBuffer: 32 * 1024 * 1024,
            encoding: 'utf8',
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
          },
        )
        return stdout
      } catch (error: unknown) {
        // 红线：不许静默吞错——退出码/stderr 原样带回给主模型。
        const err = error as { code?: unknown; stderr?: unknown; killed?: boolean; message?: unknown }
        if (err.killed === true) throw new Error('chronica.py 查询超时（15s）')
        const stderr = typeof err.stderr === 'string' && err.stderr.length > 0 ? err.stderr : String(err.message ?? '')
        throw new Error(`chronica.py 查询失败（退出码 ${String(err.code ?? '?')}）：${stderr.slice(-800)}`)
      }
    },
  }
  // 断电闭环（§10.2）：宿主启动/重启后扫会话记录 currentJobId 重建索引——
  // 引擎 reconcile 已把断电现场判 suspended(crash)，前端经 /session-state
  // 看到挂起+断点即可「继续」。
  void rebuildJobIndexFromRecords()

  ctx.effect(() => registerFemoTools(ctx, toolDeps, projections), 'dsh-femo: main-model tools')
}
