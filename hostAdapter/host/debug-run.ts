/**
 * debug-run.ts — 零 token 调试干跑（femo_debugger.py FakeHost）的两条消费路径。
 *
 * 同一个干跑器、同一份 DebugLogBus 流水，两种取用方式：
 *  ① 编辑器「🐞 调试」按钮 → POST /dsh-femo/debug-run：NDJSON 流式转发，
 *     前端逐行渲染进调试窗（Print 效果）——人看；
 *  ② 主模型 femo-debug 工具 → collectDebugRun()：整跑收集，流水 + 终报
 *     一次性回给主模型——AI 写完剧本先干跑自检（2026-09-11 新增）。
 *
 * 两条路径共用同一份沙盒装配（spawnDebugger）与同一枚单飞闸（inFlight）：
 * 同一插件实例同时只允许一条干跑（femo_debugger 的类级 patch 是进程内的，
 * 并发两条会互相污染 tracker——单飞是最便宜的诚实做法），第二条明确报错。
 *
 * 设计要点（两条路径一致）：
 *  - 与正式运行链路完全解耦：不起 job、不碰 bridge stdio 协议、不发 SSE
 *    广播——调试是独立一次性流；不调任何 LLM（FakeHost 替 AI/human 发言）。
 *  - 剧本落 cache/debug-sandbox/web-<ts>.femo（与 femo_debugger 的
 *    DB 沙盒同目录，只建不删——想清理手动删目录）；流水落同目录
 *    web-<ts>.jsonl、终报落 web-<ts>.report.json，都留档可查。
 *  - 子进程经宿主 subprocess 服务（与 bridge 同一 python 解析）；退出后
 *    再 drain 残余日志，补发 debug_done 哨兵；客户端断开或 180s 看门狗
 *    超时则 terminate（不留僵尸 python）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { basename, dirname, join } from 'node:path'
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import { readBody, writeJson } from './http'
import { pushDiag } from './diag-feed'
import type { ResolvedConfig } from './config'

/** 单轮干跑通常秒级；par/fork 重试链可能慢（实测 139s），给 180s 上限。 */
const DEBUG_TIMEOUT_MS = 180_000
const TAIL_INTERVAL_MS = 150
/** 回传主模型的流水行数上限：超了中段省略（首 600 + 尾 900），完整流水在
 *  jsonl 落盘路径里——剪掉的是重复噪音，不是信息源。 */
const TRANSCRIPT_MAX_LINES = 1500
const TRANSCRIPT_HEAD_LINES = 600
/** stderr 回传上限（编译失败的 SyntaxError 原话在 traceback 末尾）。 */
const STDERR_MAX_CHARS = 2000
/** 终报渲染上限（变量快照/提示逐条列，超了截断并注明总数）。 */
const REPORT_SNAPSHOT_MAX = 40
const REPORT_WARNING_MAX = 20

interface DebugRunBody {
  femo?: unknown
  runs?: unknown
  seed?: unknown
  /** 只干跑某 module（femoGen 模块子画布里按「调试」时由前端按当前画布
   *  推导；嵌套模块点路径 'Outer.Inner'）。缺省=主画布=整剧本。
   *  未知模块由调试器响亮报错（列出可用名，经 stderr 抵达）。 */
  module?: unknown
  /** 会话剧本原路径（前端传 savedPath）：code: file:"xxx.py" 相对引用按它
   *  所在目录解析——与正式运行同语义。缺省/目录不存在则回退沙盒目录
   *  （引用会 404，但报错响亮可见）。 */
  scriptPath?: unknown
}

/** 一次干跑请求（两条路径共用）。 */
export interface DebugRunRequest {
  /** 剧本文本（挂载版/编辑器版——由调用方决定取哪一份）。 */
  femo: string
  /** 剧本原路径：file: 相对引用按它所在目录解析；缺省回退沙盒目录。 */
  scriptPath?: string
  /** 只干跑某 module（点路径）；缺省整剧本。 */
  module?: string
  /** 跑几轮（每轮换种子）；缺省 1，钳到 1~20。 */
  runs?: number
  /** 起始种子（可复现）；缺省由调试器随机。 */
  seed?: number
  /** 看门狗上限（毫秒）；缺省 180s。仅 collect 路径用（测试注短值）。 */
  timeoutMs?: number
}

/** 终报里的一轮结局（femo_debugger --report 的 runs 元素）。 */
export interface DebugReportRun {
  seed: number
  outcome: string
  error: string | null
  elapsed: number
}

/** 变量赋值快照（old/new 已是调试器侧 repr 字符串）。 */
export interface DebugVarSnapshot {
  node: string
  var: string
  old: unknown
  new: unknown
}

/** femo_debugger --report 写出的 JSON 终报形状（字段名即协议，snake_case）。 */
export interface DebugRunReport {
  script: string
  module_mode: string | null
  runs: DebugReportRun[]
  node_visits: Record<string, number>
  node_order: string[]
  edges_taken: string[]
  total_edges: number
  var_snapshots: DebugVarSnapshot[]
  guess_warnings: string[]
  silences: string[]
  flaky_fired: string[]
  /** 一次没走到的作者节点；2026-09-11 起写进终报，老版本无此键。 */
  unreached_nodes?: string[]
  /** module 模式静态检测：被测模块 flow 是否有 [OUT]/[BREAK]（null/缺省=
   *  非 module 模式或老版本）。false=持续循环型——max_steps 结局属预期。 */
  module_has_out?: boolean | null
}

/** 整跑收集结果（femo-debug 工具的数据面）。 */
export interface DebugRunCollect {
  exitCode: number
  /** 看门狗超时被强制终止（疑似死循环/链路太慢）。 */
  timedOut: boolean
  /** 调用方中途撤销（工具被取消）而终止。 */
  aborted: boolean
  /** 实际请求的轮数。 */
  runs: number
  seed?: number
  /** 本场干跑墙钟耗时（毫秒）——多轮是线性叠加：用户实测「AI 调一次等很久」
   *  就是 runs=6 把 6 轮的秒数加了六份，回传里给出总耗时便于模型/人对照。 */
  elapsedMs: number
  /** DebugLogBus 记录原样（解析失败的行已剔除）。 */
  records: Array<Record<string, unknown>>
  /** 终报；未生成（编译失败/超时）时为 undefined——stderr 里有原话。 */
  report?: DebugRunReport
  /** 流水文本（与 femoGen 调试窗同款渲染）。 */
  transcript: string
  /** 流水里省略掉的行数（0=完整）。 */
  transcriptDropped: number
  /** 被中断（撤销/超时）且已产出流水时，同目录留一份可读的部分信息留档
   *  （<log>.partial.md）——框架会把 aborted 的工具结果整条丢掉（用户按停止
   *  即如此），留档保证「数据实时产出了却没人看到」不至于白跑。 */
  partialPath?: string
  /** 引擎 stderr 尾部（编译失败的 SyntaxError 原话在末尾）。 */
  stderr: string
  /** 本次干跑的沙盒剧本 / 流水 / 终报路径（留档可查）。 */
  sandboxScript: string
  logPath: string
  reportPath: string
}

/** 同一插件实例同时只跑一条干跑（见模块注释「单飞闸」）。 */
let inFlight = false

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/** runs 钳制：NaN/0/负数 → 1，上限 20（与前端按钮同口径）。 */
function clampRuns(value: unknown): number {
  return Math.min(Math.max(Math.trunc(Number(value)) || 1, 1), 20)
}

/** seed 归一：非有限数一律当"没给"（调试器自选随机种子）。 */
function normalizeSeed(value: unknown): number | undefined {
  return value !== undefined && value !== null && Number.isFinite(Number(value))
    ? Math.trunc(Number(value))
    : undefined
}

/** module 归一：剥空白与 '&' 前缀（用户习惯 &Mod 引用）；空串当"没给"
 *  （=整剧本）。合法性（段存在/嵌套路径）交给调试器编译时响亮校验。 */
function normalizeModule(value: unknown): string | undefined {
  const s = typeof value === 'string' ? value.trim().replace(/^&+/, '') : ''
  return s.length > 0 ? s : undefined
}

/** 子进程装配结果（stdout/stderr 累积数组：流式模式下为空）。 */
interface DebugSpawn {
  procHandle: SubprocessHandle
  sandboxScript: string
  logPath: string
  reportPath: string
  out: string[]
  err: string[]
}

/**
 * 沙盒装配 + 起子进程（两条路径共用）。失败抛 Error（原话上浮，调用方决定
 * 是 500 还是工具 ❌）。mode='capture' 时 stdout/stderr 进数组（工具路径要
 * 拿编译失败的 traceback）；'stream' 时 stdout 丢弃、stderr 转发控制台——
 * 与调试窗按钮的历史行为逐字一致（引擎 tracebacks 不能静默消失）。
 */
async function spawnDebugger(
  ctx: Context,
  resolved: ResolvedConfig,
  req: DebugRunRequest,
  mode: 'stream' | 'capture',
): Promise<DebugSpawn> {
  const subprocess = ctx.get('subprocess') as {
    resolveExecutable(command: string): Promise<string>
    spawn(spec: unknown): SubprocessHandle
  } | undefined
/** 干跑沙盒滚动清理：删除 mtime 超过 3 天的旧文件（web-* 三件套与 run-*.wor）。
 *  2026-09-12 由「只建不删」改制——只增不减的沙盒会无限长胖。单文件失败
 *  不阻断；整体失败不影响干跑主路。 */
async function sweepDebugSandbox(sandboxDir: string, keepDays = 3): Promise<void> {
  try {
    const { readdir, stat, unlink } = await import('node:fs/promises')
    const cutoff = Date.now() - keepDays * 86400_000
    for (const name of await readdir(sandboxDir)) {
      const fp = join(sandboxDir, name)
      try {
        const st = await stat(fp)
        if (st.isFile() && st.mtimeMs < cutoff) await unlink(fp)
      } catch { /* 单文件失败不阻断 */ }
    }
  } catch { /* 清理失败不影响干跑主路 */ }
}

  if (subprocess === undefined) {
    throw new Error('subprocess 服务不可用（无法拉起调试器子进程）')
  }

  // 剧本与日志都落调试沙盒（滚动保留最近 3 天，与 femo_debugger 的 .wor 同策略）
  const sandboxDir = join(resolved.femoRoot, 'cache', 'debug-sandbox')
  await mkdir(sandboxDir, { recursive: true })
  void sweepDebugSandbox(sandboxDir)
  const stamp = Date.now()
  const sandboxScript = join(sandboxDir, `web-${stamp}.femo`)
  const logPath = join(sandboxDir, `web-${stamp}.jsonl`)
  const reportPath = join(sandboxDir, `web-${stamp}.report.json`)
  await writeFile(sandboxScript, req.femo, 'utf8')

  const pythonPath = await subprocess.resolveExecutable(resolved.python)
  // code: file:"xxx.py" 相对引用的解析目录：带了剧本原路径（savedPath）就按
  // 其所在目录解析（与正式运行同语义）；没带则回退沙盒目录——引用会
  // FileNotFoundError，但错误经 run_end 记录响亮抵达，不静默。
  let baseDirArg: string[] = []
  const savedScriptPath = req.scriptPath?.trim() ?? ''
  if (savedScriptPath.length > 0) {
    const dir = dirname(savedScriptPath)
    try {
      await stat(dir)
      baseDirArg = ['--base-dir', dir]
    } catch {
      console.log(`[dsh-femo] debug-run: scriptPath 目录不存在，回退沙盒解析: ${dir}`)
    }
  }
  const argv = [
    pythonPath,
    join(resolved.femoRoot, 'femoToolcall', 'femo_debugger.py'),
    'run', sandboxScript,
    '--quiet', '--log-jsonl', logPath,
    // 终报 JSON：工具路径的唯一权威汇总（人读版 print_report 只进 stdout）。
    '--report', reportPath,
    '--runs', String(clampRuns(req.runs)),
    ...baseDirArg,
  ]
  const seed = normalizeSeed(req.seed)
  if (seed !== undefined) argv.push('--seed', String(seed))
  // 模块单测（femoGen 模块子画布按「调试」/ femo-debug 工具带 module 时）：
  // 调试器合成 wrapper 直进被测模块，嵌套用点路径；未知模块调试器响亮报错。
  const debugModule = normalizeModule(req.module)
  if (debugModule !== undefined) argv.push('--module', debugModule)

  const out: string[] = []
  const err: string[] = []
  let procHandle: SubprocessHandle
  try {
    procHandle = subprocess.spawn({
      argv,
      cwd: resolved.femoRoot,
      stdio: { stdin: 'ignore', stdout: mode === 'capture' ? 'pipe' : 'ignore', stderr: 'pipe' },
      graceMs: 3000,
      env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
  } catch (error: unknown) {
    throw new Error(`调试器子进程启动失败: ${String(error)}`)
  }
  procHandle.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim().length === 0) continue
      if (mode === 'capture') err.push(line)
      // 【2026-09-11 Host 页口径】调试器(引擎)的 stderr 是"引擎的话"，绕过
      // console 直写 stdout——harness 日志照旧有，但不进调试窗『Host』页。
      else process.stdout.write(`[femo-debug:stderr] ${line}\n`)
      // 【2026-09-11 编译器页补 stderr】两条路径都补一路进调试窗『编译器』页
      // （capture 走 err 回调用方，stream 是面板「编译」按钮那条）。
      pushDiag('engine', `[stderr] ${line}`.slice(0, 400))
    }
  })
  if (mode === 'capture') {
    procHandle.stdout?.on('data', (chunk: Buffer) => { out.push(chunk.toString('utf8')) })
  }
  return { procHandle, sandboxScript, logPath, reportPath, out, err }
}

/** POST /dsh-femo/debug-run：NDJSON 流式响应（每行一条 DebugLogBus 记录）。 */
export async function handleDebugRun(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Context,
  resolved: ResolvedConfig,
): Promise<void> {
  if (inFlight) {
    writeJson(res, 409, { ok: false, error: '已有调试干跑在进行中，请等它结束再点' })
    return
  }
  const body = await readBody(req) as DebugRunBody
  const femo = typeof body.femo === 'string' ? body.femo : ''
  if (femo.trim().length === 0) {
    writeJson(res, 400, { ok: false, error: 'femo 剧本文本为空' })
    return
  }
  const runs = clampRuns(body.runs)
  const seed = normalizeSeed(body.seed)
  const module = normalizeModule(body.module)

  inFlight = true

  // ── 流式会话状态（try 前声明：close 回调 / finally 都要摸到）──
  let streaming = false        // writeHead 之后 true——只有它为 true 才允许 res.end()
  let clientGone = false
  let procHandle: SubprocessHandle | undefined
  let exited = false
  const onClientClose = (): void => {
    clientGone = true
    // 客户端走人＝干跑失去意义：不留僵尸 python
    if (!exited && procHandle !== undefined) {
      try { procHandle.terminate() } catch { /* 已退出则忽略 */ }
    }
  }

  try {
    let spawned: DebugSpawn
    try {
      spawned = await spawnDebugger(ctx, resolved, {
        femo, runs, ...(seed !== undefined ? { seed } : {}),
        ...(module !== undefined ? { module } : {}),
        ...(typeof body.scriptPath === 'string' ? { scriptPath: body.scriptPath } : {}),
      }, 'stream')
    } catch (error: unknown) {
      writeJson(res, 500, { ok: false, error: String(error instanceof Error ? error.message : error) })
      return
    }
    procHandle = spawned.procHandle
    const logPath = spawned.logPath
    req.on('close', onClientClose)
    res.on('close', onClientClose)

    // ── 流式阶段开始：之后任何失败都以一条 debug_error 记录收尾（响应头
    //    已发出，半路换状态码是谎报）。
    streaming = true
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache',
    })
    const send = (rec: unknown): void => {
      if (!clientGone && !res.destroyed) res.write(`${JSON.stringify(rec)}\n`)
    }

    // tail JSONL：offset 增量读，按行转发（femo_debugger 每条 flush，延迟≈TAIL 间隔）
    let offset = 0
    let tailRemainder = ''
    const tailOnce = async (): Promise<void> => {
      let fh
      try { fh = await open(logPath, 'r') } catch { return }   // 文件未创建＝还没跑到
      try {
        const st = await fh.stat()
        if (st.size > offset) {
          const buf = Buffer.alloc(st.size - offset)
          const { bytesRead } = await fh.read(buf, 0, buf.length, offset)
          offset += bytesRead
          tailRemainder += buf.toString('utf8')
          let idx: number
          while ((idx = tailRemainder.indexOf('\n')) !== -1) {
            const line = tailRemainder.slice(0, idx).trim()
            tailRemainder = tailRemainder.slice(idx + 1)
            if (line.length === 0) continue
            try { send(JSON.parse(line)) } catch {
              send({ kind: 'debug_error', error: `日志行解析失败: ${line.slice(0, 200)}` })
            }
          }
        }
      } finally {
        await fh.close()
      }
    }

    void procHandle.done.then((outcome: unknown) => {
      exited = true
    }, () => { exited = true })

    const started = Date.now()
    let timedOut = false
    let exitCode = -1
    while (!exited && !clientGone) {
      await tailOnce()
      if (exited || clientGone) break
      if (Date.now() - started > DEBUG_TIMEOUT_MS) {
        timedOut = true
        try { procHandle.terminate() } catch { /* 已退出则忽略 */ }
        break
      }
      await sleep(TAIL_INTERVAL_MS)
    }
    const outcome = await procHandle.done.catch(() => undefined as unknown)
    exitCode = (outcome as { exitCode?: number } | undefined)?.exitCode ?? -1
    await tailOnce()   // 进程退出后再 drain 一次残余日志

    if (timedOut) send({ kind: 'debug_error', error: `调试干跑超时（${DEBUG_TIMEOUT_MS / 1000}s），已强制终止` })
    send({ kind: 'debug_done', exitCode })
  } finally {
    inFlight = false
    req.off?.('close', onClientClose)
    res.off?.('close', onClientClose)
    if (streaming && !clientGone && !res.destroyed) res.end()
  }
}

/**
 * 主模型工具路径：整跑收集（不流式）。跑完一次性读回流水 + 终报 + stderr，
 * 交给调用方渲染（见 formatDebugRunText / debugRunToolOutcome）。
 *
 * 与流式路径共用单飞闸：调试窗正在跑时调用会明确报错，反之亦然。
 */
export async function collectDebugRun(
  ctx: Context,
  resolved: ResolvedConfig,
  req: DebugRunRequest,
  signal?: AbortSignal,
): Promise<DebugRunCollect> {
  if (inFlight) {
    throw new Error('已有调试干跑在进行中（femoGen 调试窗或另一次 femo-debug 调用），请等它结束再试')
  }
  const runs = clampRuns(req.runs)
  const seed = normalizeSeed(req.seed)
  const timeoutMs = req.timeoutMs ?? DEBUG_TIMEOUT_MS
  // 【2026-09-11】调用方已经撤销（工具 round 被中断/用户按了停止）：别再起子进程——
  // 起了也留不住结果，只会白跑一场、把单飞闸占住直到跑完。
  if (signal?.aborted === true) {
    return emptyCollect(runs, seed)
  }
  inFlight = true
  const startedAt = Date.now()
  let spawned: DebugSpawn | undefined
  let timedOut = false
  let aborted = false
  const onAbort = (): void => {
    aborted = true
    if (spawned !== undefined) {
      try { spawned.procHandle.terminate() } catch { /* 已退出则忽略 */ }
    }
  }
  try {
    spawned = await spawnDebugger(ctx, resolved, {
      ...req, runs, ...(seed !== undefined ? { seed } : {}),
    }, 'capture')
    const local = spawned
    if (signal !== undefined) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    // 进度可见化（用户实测「AI 调一次等很久，以为卡死了」）：起跑/收尾各一条
    // 诊断流——多轮干跑是线性叠加（runs=6 × 每轮几秒到十几秒），看诊窗/log 窗
    // 的人能分辨「在跑」与「死了」。模型看不到这两条（不占它的上下文）。
    pushDiag('femo-debug', `干跑启动：${runs} 轮${seed !== undefined ? `，seed=${seed}` : ''}（沙盒脚本 ${basename(local.sandboxScript)}）`)
    const done = local.procHandle.done.then((outcome: unknown) => outcome, () => undefined)
    const timer = setTimeout(() => {
      timedOut = true
      try { local.procHandle.terminate() } catch { /* 已退出则忽略 */ }
    }, timeoutMs)
    try {
      await done
    } finally {
      clearTimeout(timer)
    }
    const outcome = await done
    const exitCode = (outcome as { exitCode?: number } | undefined)?.exitCode ?? -1

    // ── 收账：流水 JSONL（半行=终止时最后一行不完整，丢弃不谎报）+ 终报 ──
    const rawLog = await readFile(local.logPath, 'utf8').catch(() => '')
    const records: Array<Record<string, unknown>> = []
    for (const line of rawLog.split(/\r?\n/)) {
      if (line.trim().length === 0) continue
      try {
        const rec = JSON.parse(line) as Record<string, unknown>
        records.push(rec)
      } catch { /* 截断的半行：跳过（不计入流水行数） */ }
    }
    let report: DebugRunReport | undefined
    try {
      report = JSON.parse(await readFile(local.reportPath, 'utf8')) as DebugRunReport
    } catch { report = undefined }

    const { lines, dropped } = debugTranscriptLines(records)
    const stderr = local.err.join('\n')
    const elapsedMs = Date.now() - startedAt
    // 被中断（撤销/超时）但已产出流水：同目录留一份可读留档（.partial.md）。
    // 用户实测语境：框架会把 aborted 的工具结果整条替换成 "tool call aborted"
    // ——数据实时产出了却没人看到；留档后用户/AI 都能按路径把它捞出来。
    let partialPath: string | undefined
    if ((aborted || timedOut) && lines.length > 0) {
      partialPath = local.logPath.replace(/\.jsonl$/, '.partial.md')
      const header = `# 干跑被中断时的部分信息（${aborted ? '调用方撤销（回合被中断/用户停止）' : '看门狗超时强制终止'}）\n\n`
        + `- 沙盒剧本：${local.sandboxScript}\n- 原始流水(JSONL)：${local.logPath}\n`
        + `- 用时：${(elapsedMs / 1000).toFixed(1)}s　流水：${records.length} 条\n`
        + `- 终报：未生成（引擎未跑完，没有 --report 产出）\n\n## 流水（与 femoGen 调试窗同款渲染）\n\n`
      try {
        await writeFile(partialPath, header + lines.join('\n') + '\n', 'utf8')
      } catch {
        partialPath = undefined   // 留档失败不拦主流程（原流水仍在）
      }
    }
    pushDiag('femo-debug', `干跑结束：exit=${exitCode} 流水 ${records.length} 条 终报${report === undefined ? '无' : '有'}`
      + `${timedOut ? '（看门狗超时）' : ''}${aborted ? '（被撤销）' : ''} 用时 ${(elapsedMs / 1000).toFixed(1)}s`
      + `${partialPath !== undefined ? `　部分信息留档：${partialPath}` : ''}`)
    return {
      exitCode,
      timedOut,
      aborted,
      runs,
      ...(seed !== undefined ? { seed } : {}),
      elapsedMs,
      records,
      ...(report !== undefined ? { report } : {}),
      transcript: lines.join('\n'),
      transcriptDropped: dropped,
      ...(partialPath !== undefined ? { partialPath } : {}),
      stderr: stderr.length > STDERR_MAX_CHARS ? stderr.slice(-STDERR_MAX_CHARS) : stderr,
      sandboxScript: local.sandboxScript,
      logPath: local.logPath,
      reportPath: local.reportPath,
    }
  } finally {
    inFlight = false
    if (signal !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/** 空结果（调用方在起子进程前就撤销了）：形状与真结果一致，让裁决函数
 *  统一按「没跑起来 + 被撤销」处理，不必在调用方分叉。 */
function emptyCollect(runs: number, seed: number | undefined): DebugRunCollect {
  return {
    exitCode: -1,
    timedOut: false,
    aborted: true,
    runs,
    ...(seed !== undefined ? { seed } : {}),
    elapsedMs: 0,
    records: [],
    transcript: '',
    transcriptDropped: 0,
    stderr: '',
    sandboxScript: '',
    logPath: '',
    reportPath: '',
  }
}

/**
 * DebugLogBus 记录 → 一行可读流水。与 femoGen 调试窗 debugRecToLine 同款
 * 语义（同一套 kind、同一套丢弃规则）：edge 高频噪音不上流水（边覆盖在终报
 * 里给全）、flow_outcome 与 run_end 重复、debug_done 是收尾哨兵。返回 null
 * = 这条不上流水。
 */
export function formatDebugRecordLine(rec: Record<string, unknown>): string | null {
  const s = (value: unknown): string => (value === undefined || value === null ? '' : String(value))
  switch (rec.kind) {
    case 'run_start':
      return `▶ 第 ${s(rec.run) || '-'} 轮干跑开始：${s(rec.script) || '（未命名）'}`
        + `${rec.module ? `（module ${s(rec.module)}）` : ''}（seed=${s(rec.seed) || '-'}）`
    case 'node_start':
      return `→ ${s(rec.node)}${rec.node_type ? `（${s(rec.node_type)}）` : ''}`
    case 'action_outs': {
      const exprs = Array.isArray(rec.exprs) ? rec.exprs.map(String).join('，') : ''
      if (exprs.length === 0) return null
      return rec.node_type === 'func'
        ? `🔧 ${s(rec.node)} 写回：${exprs}`
        : `📝 ${s(rec.node)} 赋值：${exprs}`
    }
    case 'func_result': {
      const out = rec.output === null || rec.output === undefined
        ? ''
        : typeof rec.output === 'object' ? JSON.stringify(rec.output) : String(rec.output)
      if (out.length === 0) return null
      let ins = ''
      const input = rec.func_input
      if (input !== null && typeof input === 'object') {
        const map = input as Record<string, unknown>
        const keys = Object.keys(map)
        if (keys.length > 0) ins = `（入参 ${keys.map(k => `${k}=${JSON.stringify(map[k])}`).join('，')}）`
      }
      return `🔧 ${s(rec.node)} 函数返回：${out.slice(0, 300)}${ins}`
    }
    case 'assign':
      return `${s(rec.node)}  ${s(rec.var)}: ${s(rec.old)} → ${s(rec.new)}`
    case 'ai_reply': {
      const values = (rec.values ?? {}) as Record<string, { value?: unknown; source?: unknown }>
      const entries = Object.entries(values)
      if (entries.length === 0) return null
      return `🤖 ${s(rec.node)} 合成赋值：${entries.map(([k, v]) => `${k}=${s(v?.value)}（${s(v?.source)}）`).join('，')}`
    }
    case 'human_input': {
      const parts = Object.entries((rec.variables ?? {}) as Record<string, unknown>)
        .map(([k, v]) => `${k}=${s(v)}`)
      if (parts.length === 0) return null
      return `👤 ${s(rec.node)} 合成输入：${parts.join('，')}`
    }
    case 'retry':
      return `🔁 ${s(rec.node)} 重试换值：${s(rec.feedback).slice(0, 160)}`
    case 'silence':
      return `🎲 ${s(rec.node)} 概率沉默（不赋值 ${s(rec.var)}）`
    case 'flaky':
      return `💥 ${s(rec.node)} 注入无效赋值（测重试链路）`
    case 'warning':
      return `⚠ ${s(rec.msg)}`
    case 'flow_outcome':
      return null   // run_end 已带结局，不重复
    case 'run_end':
      return `${rec.outcome === 'completed' ? '■' : '❌'} 第 ${s(rec.run) || '-'} 轮结束：${s(rec.outcome)}`
        + `${rec.error ? ` — ${String(rec.error).slice(0, 200)}` : ''}（${s(rec.elapsed) || '?'}s）`
    case 'debug_done':
      return null   // 退出码语义见终报尾部说明；真崩溃经 stderr/退出码表达
    case 'debug_error':
      return `❌ ${s(rec.error)}`
    default:
      return null
  }
}

/** 流水行（含超限时的中段省略：首段 + 尾段，尾部是结局/报错最密的区段）。 */
export function debugTranscriptLines(records: Array<Record<string, unknown>>): { lines: string[]; dropped: number } {
  const all: string[] = []
  for (const rec of records) {
    const line = formatDebugRecordLine(rec)
    if (line !== null) all.push(line)
  }
  if (all.length <= TRANSCRIPT_MAX_LINES) return { lines: all, dropped: 0 }
  const tailCount = TRANSCRIPT_MAX_LINES - TRANSCRIPT_HEAD_LINES
  const dropped = all.length - TRANSCRIPT_MAX_LINES
  return {
    lines: [
      ...all.slice(0, TRANSCRIPT_HEAD_LINES),
      `…（中段 ${dropped} 行已省略——完整流水见 jsonl 落盘路径）…`,
      ...all.slice(all.length - tailCount),
    ],
    dropped,
  }
}

/** 退出码语义（femo_debugger CLI 契约，2026-09-12 起 max_steps 算可接受结局
 *  ——跑满步数预算未停=「可能是无限循环」，退出码 0 非错误）。 */
function exitCodeNote(exitCode: number): string {
  return exitCode === 0 ? '0（全部轮次 completed，或 max_steps=可能是无限循环）'
    : exitCode === 2 ? '2（部分轮次 completed/max_steps）'
      : exitCode === 1 ? '1（无一轮可接受结局 / 编译或装配失败）'
        : `${exitCode}（非正常退出）`
}

/** 终报 → 文本（节点顺序 / 边覆盖 / 变量快照 / 提示 / 未达节点）。 */
function formatReport(report: DebugRunReport, timeoutNote: string | undefined): string[] {
  const lines: string[] = []
  const okRuns = report.runs.filter(r => r.outcome === 'completed').length
  const loopRuns = report.runs.filter(r => r.outcome === 'max_steps').length
  // 各轮合计耗时（多轮=线性叠加；用户实测「AI 调一次等很久」就是 runs 开大的
  // 正常代价——把成本摆在结局行，模型下次自己就会掂量轮数）。
  const sumElapsed = report.runs.reduce((sum, r) => sum + (Number.isFinite(r.elapsed) ? r.elapsed : 0), 0)
  lines.push(`结局：${okRuns}/${report.runs.length} 轮 completed（各轮合计 ${sumElapsed.toFixed(1)}s）`
    + (loopRuns > 0 ? `，${loopRuns} 轮 max_steps（跑满步数预算未停——可能是无限循环，非错误）` : '')
    + `${timeoutNote !== undefined ? `　${timeoutNote}` : ''}`)
  if (report.module_mode) {
    lines.push(`范围：module ${report.module_mode}`
      + (report.module_has_out === false
        ? '（无 [OUT]/[BREAK] 出口——持续循环型设计，max_steps 属预期）'
        : ''))
  }
  for (const r of report.runs) {
    lines.push(`  seed=${r.seed}: ${r.outcome === 'max_steps' ? 'max_steps（可能是无限循环，非错误）' : r.outcome}`
      + (r.error ? ` — ${String(r.error).slice(0, 300)}` : '')
      + `（${r.elapsed}s）`)
  }
  if (report.node_order.length > 0) {
    lines.push(`节点执行（${report.node_order.length} 步）：${report.node_order.slice(0, 60).join(' → ')}`
      + (report.node_order.length > 60 ? ' …' : ''))
  } else {
    lines.push('节点执行：（无——一个节点都没跑到）')
  }
  const coverage = report.total_edges > 0
    ? `${report.edges_taken.length}/${report.total_edges} (${Math.round(report.edges_taken.length / report.total_edges * 100)}%)`
    : '0/0'
  lines.push(`边覆盖：${coverage}`)
  if (report.edges_taken.length > 0) {
    lines.push(`  走过的边：${report.edges_taken.slice(0, 40).join('，')}`
      + (report.edges_taken.length > 40 ? ` …共 ${report.edges_taken.length} 条` : ''))
  }
  if (report.var_snapshots.length > 0) {
    lines.push(`变量快照（${report.var_snapshots.length} 条）：`)
    for (const s of report.var_snapshots.slice(0, REPORT_SNAPSHOT_MAX)) {
      lines.push(`  ${String(s.node)}  ${String(s.var)}: ${String(s.old)} → ${String(s.new)}`)
    }
    if (report.var_snapshots.length > REPORT_SNAPSHOT_MAX) {
      lines.push(`  …（还有 ${report.var_snapshots.length - REPORT_SNAPSHOT_MAX} 条）`)
    }
  }
  const warnings = [
    ...report.guess_warnings,
    ...report.silences.map(s => `概率沉默: ${s}`),
    ...report.flaky_fired.map(s => `flaky 无效赋值: ${s}`),
  ]
  if (warnings.length > 0) {
    lines.push(`⚠ 提示 ${warnings.length} 条（调试器猜值降级/兜底/概率沉默等）：`)
    for (const w of warnings.slice(0, REPORT_WARNING_MAX)) lines.push(`  • ${w}`)
    if (warnings.length > REPORT_WARNING_MAX) lines.push(`  …（还有 ${warnings.length - REPORT_WARNING_MAX} 条）`)
  }
  const unreached = report.unreached_nodes ?? []
  if (unreached.length > 0) {
    lines.push(`未达节点（本场一次没走到——死分支/漏接线/条件永远为假）：${unreached.join('，')}`)
  }
  return lines
}

/**
 * 工具结果裁决 + 完整文本：
 *  - 干跑完全没跑起来（无流水、无终报、非零退出）= 编译/装配失败 → ok:false，
 *    把 stderr 末尾的异常原话（如 SyntaxError: 条件 "y == 1" 引用了未声明的
 *    变量…）放在最前，traceback 尾巴附后；
 *  - 其余（含超时、跑挂的轮次）都有信息可回 → ok:true，流水 + 终报全文。
 */
export function debugRunToolOutcome(
  result: DebugRunCollect,
): { ok: true; text: string } | { ok: false; error: string } {
  const stderrTail = result.stderr.trim()
  if (result.records.length === 0 && result.report === undefined && result.exitCode !== 0) {
    if (result.aborted) {
      // 收窄口径（用户指正 2026-09-11）：干跑数据是实时产的，中途被撤销时上面
      // 那条 records>0 分支会把已产出的流水照常回传——走到这里只可能是「还没
      // 写出任何一条流水就被撤销」（起步阶段/主会话未装载等），别一律说"没有
      // 产生调试数据"（那会冤枉整条链路）。
      return {
        ok: false,
        error: '本次干跑在产出任何流水之前就被撤销（回合被中断/用户停止；也可能卡在起跑阶段——看诊断流的「干跑启动」那行有没有出现）。'
          + '需要结果的话重新调用一次（轮数别开太大：runs 是线性耗时，每轮≈一次 femoGen 调试）。',
      }
    }
    const errorLine = stderrTail.split('\n').reverse()
      .find(line => /^[A-Za-z_][\w.]*(Error|Exception|Warning)?:\s/.test(line.trim()))?.trim()
    return {
      ok: false,
      error: `干跑未能跑起来（退出码 ${result.exitCode}）——`
        + `${result.timedOut ? '看门狗超时强制终止' : '编译/装配错误原话'}：\n`
        + (errorLine !== undefined ? `${errorLine}\n\n` : '')
        + (stderrTail.length > 0 ? stderrTail : '（stderr 为空——可直接跑 femoGen「编译」按钮看报错）'),
    }
  }

  const parts: string[] = []
  parts.push('📋 剧本干跑（零 token 空跑：AI/人类节点全部由调试器合成替答，未调用任何模型）')
  parts.push('')
  if (result.aborted) {
    parts.push('⏹ 本次干跑被调用方撤销（回合被中断/用户停止）；**已实时产出的流水照常回传在下方**'
      + '——注意：框架会把 aborted 的工具结果整条替换成 "tool call aborted"，这种时候这份数据到你手里可能已经丢了，'
      + (result.partialPath !== undefined
        ? `可让用户按留档路径直接读：${result.partialPath}`
        : '沙盒里的原始 JSONL 仍在。'))
    parts.push('')
  }
  if (result.timedOut) {
    parts.push(`⏱ 干跑超时（${DEBUG_TIMEOUT_MS / 1000}s 看门狗）已强制终止——疑似死循环，或 par/fork 重试链太慢；以下是终止前跑出的部分信息。`)
    parts.push('')
  }
  if (result.report !== undefined) {
    parts.push(...formatReport(result.report, undefined))
  } else {
    // 终报缺席但流水在（超时/被撤销）：从 run_end 记录拼结局，诚实标注。
    const ends = result.records.filter(r => r.kind === 'run_end')
    parts.push(`结局：终报未生成（干跑未正常跑完）${ends.length > 0 ? '；已跑完的轮次：' : ''}`)
    for (const e of ends) {
      parts.push(`  第 ${String(e.run ?? '-')} 轮：${String(e.outcome ?? '?')}`
        + (e.error ? ` — ${String(e.error).slice(0, 300)}` : '')
        + `（${String(e.elapsed ?? '?')}s）`)
    }
  }
  parts.push('')
  const transcriptLines = result.transcript.length > 0 ? result.transcript.split('\n').length : 0
  parts.push(`──── 调试流水（${transcriptLines} 行${result.transcriptDropped > 0 ? `，中段省略 ${result.transcriptDropped} 行` : ''}）────`)
  parts.push(result.transcript.length > 0 ? result.transcript : '（无流水记录——先看上面的结局/报错）')
  parts.push('')
  parts.push(`退出码 ${exitCodeNote(result.exitCode)}`
    + `　·　用时 ${(result.elapsedMs / 1000).toFixed(1)}s`
    + `　·　沙盒剧本：${result.sandboxScript}`
    + `　·　完整流水(JSONL)：${result.logPath}`
    + (result.partialPath !== undefined ? `　·　部分信息留档：${result.partialPath}` : '')
    + (result.report !== undefined ? `　·　终报(JSON)：${result.reportPath}` : ''))
  if (result.stderr.trim().length > 0 && result.report === undefined) {
    parts.push('')
    parts.push(`引擎 stderr 尾部（诊断用）：\n${result.stderr.trim().slice(-800)}`)
  }
  return { ok: true, text: parts.join('\n') }
}
