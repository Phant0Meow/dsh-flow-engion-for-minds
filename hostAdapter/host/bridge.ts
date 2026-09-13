/**
 * bridge.ts — Femo bridge client（与 Python 引擎通话的电话线）。
 *
 * 管理 femo_bridge.py 子进程：NDJSON over stdio 的请求/响应配对，引擎事件
 * 以 (name='dsh-femo/event', eventType, data) 形式 re-emit——emit 由 index.ts
 * 总装时注入为 ctx.emit（FemoBridge 自身不依赖事件总线）。
 * 从 index.ts 原样迁出（2026-08-23 重构）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { join } from 'node:path'
import { pushDiag } from './diag-feed'

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
}

export class FemoBridge {
  private handle: SubprocessHandle | undefined
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private lineBuf = ''

  /** 进程退出回调（index.ts 接线）：引擎半路死亡时不会有任何终止事件
   * （flow_done/flow_stopped），宿主 runState.running 会卡 true——在这里
   * 让总装层清理孤儿运行态（2026-08-24）。 */
  onExited?: (outcome: unknown) => void

  get alive(): boolean {
    return this.handle !== undefined
  }

  /** Spawn the bridge and wire stdout line parsing. */
  start(ctx: Context, config: { python: string; femoRoot: string }, attempt = 0): void {
    if (this.handle !== undefined) return
    const subprocess = ctx.get('subprocess') as {
      resolveExecutable(command: string, env?: Record<string, string>, signal?: AbortSignal): Promise<string>
      spawn(spec: unknown): SubprocessHandle
    } | undefined
    if (subprocess === undefined) {
      // 插件树并发装配：本插件 apply 可能先于 base bundle 的 subprocess
      // provider 完成（rc.2 快照插件更多、apply 更慢，固定 1s 延迟不再够）。
      // 轮询等待而不是一次性放弃——最多 30s。
      if (attempt < 30) {
        setTimeout(() => this.start(ctx, config, attempt + 1), 1000)
        return
      }
      console.log('[dsh-femo] subprocess service unavailable after 30s; bridge not started')
      return
    }
    if (attempt > 0) console.log(`[dsh-femo] subprocess service ready after ${attempt}s wait; starting bridge`)
    // Bridge lives inside the Femo project itself (self-contained plugin):
    // <femoRoot>/python/femo_bridge.py
    const bridgePath = join(config.femoRoot, 'hostAdapter', 'python', 'femo_bridge.py')
    // 宿主能力清单（A2.1 解耦）：harness 的词汇与环境（thinking 档位/默认用户）
    // 由接口侧这份文件提供，引擎启动时读取——换 harness 换文件，引擎零改动。
    // 文件缺失时引擎用内置缺省（standalone 自圆满）。
    const hostManifestPath = join(config.femoRoot, 'host.manifest.json')
    void subprocess.resolveExecutable(config.python).then((pythonPath) => {
      const handle = subprocess.spawn({
        argv: [pythonPath, bridgePath, '--fe4m', config.femoRoot, '--host-manifest', hostManifestPath],
        cwd: config.femoRoot,
        stdio: {
          stdin: 'pipe',
          stdout: 'pipe',
          // 'pipe' (not collect): the caller owns the stream and forwards
          // tracebacks live; a collect buffer would swallow them silently.
          stderr: 'pipe',
        },
        graceMs: 3000,
        env: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
      this.handle = handle
      handle.stdout?.on('data', (chunk: Buffer) => this.onData(chunk))
      // Bridge stderr (Python tracebacks) must not vanish: forward every line.
      handle.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        for (const line of text.split(/\r?\n/)) {
          if (line.trim().length === 0) continue
          // 【2026-09-11 编译器页补 stderr】引擎 stderr（Python traceback 之类）
          // 进调试窗『编译器』页，`[stderr] ` 前缀与 stdout 原文区分。
          pushDiag('engine', `[stderr] ${line}`.slice(0, 400))
          // 【2026-09-11 Host 页口径】引擎侧透传绕过 console 直写 stdout：
          // 这是"引擎的话"不是"DSH 接口侧的话"，不进『Host』页；
          // harness 日志照旧收得到，一个字没少。
          process.stdout.write(`[femo-engine:stderr] ${line}\n`)
        }
      })
      handle.done.then((outcome) => {
        console.log(`[dsh-femo] bridge exited: code=${outcome.exitCode} signal=${outcome.signal}`)
        for (const [, pending] of this.pending) {
          pending.reject(new Error(`bridge exited (code=${outcome.exitCode})`))
        }
        this.pending.clear()
        this.handle = undefined
        try { this.onExited?.(outcome) } catch (error: unknown) {
          console.log(`[dsh-femo] onExited callback failed: ${String(error)}`)
        }
      }, (error: unknown) => {
        console.log(`[dsh-femo] bridge spawn failed: ${String(error)}`)
        this.handle = undefined
      })
      console.log(`[dsh-femo] bridge started (pid=${handle.pid})`)
    }, (error: unknown) => {
      console.log(`[dsh-femo] python resolve failed: ${String(error)}`)
    })
  }

  /** Send one command; resolves with the bridge's response result. */
  send(cmd: string, args: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<unknown> {
    const handle = this.handle
    if (handle === undefined) return Promise.reject(new Error('bridge not running'))
    const id = this.nextId++
    const payload = `${JSON.stringify({ id, cmd, args })}\n`
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`bridge command "${cmd}" timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      handle.stdin?.write(payload, (error?: Error | null) => {
        if (error !== undefined && error !== null) {
          this.pending.delete(id)
          clearTimeout(timer)
          reject(error)
        }
      })
    })
  }

  /** Terminate the bridge process tree (graceful shutdown command first). */
  async stop(): Promise<void> {
    const handle = this.handle
    if (handle === undefined) return
    try {
      await this.send('shutdown', {}, 2000)
    } catch {
      // fall through to terminate
    }
    handle.terminate()
    await handle.waitForExit()
    this.handle = undefined
  }

  private onData(chunk: Buffer): void {
    this.lineBuf += chunk.toString('utf8')
    let idx: number
    while ((idx = this.lineBuf.indexOf('\n')) !== -1) {
      const line = this.lineBuf.slice(0, idx).trim()
      this.lineBuf = this.lineBuf.slice(idx + 1)
      if (line.length === 0) continue
      // Femo's own prints share stdout; only JSON protocol lines parse.
      // Engine prints (the engine's debugging voice) are forwarded so the
      // harness log can see what the engine saw — they used to be dropped.
      if (!line.startsWith('{')) {
        // 【诊断 2026-09-06】撕裂嫌疑：NDJSON 事件行若被引擎 print 的并发
        // write 粘包/撕裂，首字符不再是 '{' 且行内必含 JSON 事件字段——
        // 此类行是"human_wait 事件在管道中丢失"假设的直接证据。
        if (line.includes('"type"') || line.includes('job_id')) {
          pushDiag('bridge', `TORN_LINE_SUSPECT: ${line.slice(0, 300)}`)
        }
        // 【2026-09-11 调试窗「编译器」页】引擎 print 全量进诊断面（tag 'engine'）：
        // 此前只放行 [resume-diag]/[resume]/[FORK] 三类探针行，其余 print 仅落
        // harness console——femoGen 看不到编译器在说什么。现在全部转发。
        // 截断 400 字符：引擎偶有把整个 payload 打出来的行，不能让一条撑爆面板。
        pushDiag('engine', line.slice(0, 400))
        // 【2026-09-11 Host 页口径】引擎 stdout 原文绕过 console 直写
        // stdout——它的家在『编译器』页（上一条 pushDiag），不进『Host』页。
        process.stdout.write(`[femo-engine] ${line}\n`)
        continue
      }
      let msg: {
        type?: string; id?: number; ok?: boolean; result?: unknown; error?: unknown
        detail?: unknown
        event?: string; data?: unknown
      }
      try {
        msg = JSON.parse(line) as typeof msg
      } catch {
        // 【诊断 2026-09-06】解析失败=行被撕裂的另一半实锤（首字符是 '{'
        // 但尾部粘了别的 write 或被截断）——原样静默 continue 会丢事件无痕。
        pushDiag('bridge', `JSON_PARSE_FAIL: ${line.slice(0, 300)}`)
        continue
      }
      if (msg.type === 'response') {
        const rid = msg.id
        if (rid === undefined) continue
        const pending = this.pending.get(rid)
        if (pending === undefined) continue
        this.pending.delete(rid)
        if (msg.ok === true) pending.resolve(msg.result)
        // 错误形态（Job 模型 §7.2）：{ok:false, error:<code>, detail:<人话>}——
        // detail 优先（六关裁决原话上浮给 AI/前端，B2），旧形态无 detail 回退
        // error code。
        else pending.reject(new Error(String(msg.detail ?? msg.error ?? 'bridge error')))
      } else if (msg.type === 'event') {
        // 【诊断 2026-09-06】管道层收到事件=链路第一实证点（对照 engine-events
        // 入口的 ev-in 记录，两者之间即丢失区间）。
        pushDiag('bridge', `event ${String(msg.event)} job=${String((msg.data as Record<string, unknown> | undefined)?.job_id ?? '-')}`)
        ;(this as unknown as { emit(name: string, ...args: unknown[]): void }).emit('dsh-femo/event', msg.event, msg.data)
      }
    }
  }
}

/** 宿主执行体最终失败信号（B5）：执行者死亡/超时/API 预算耗尽——显式上报，
 * 引擎按「沉默收场」裁决（通知作者 + 节点按失败跳过 + 剧本继续）。宿主不再
 * 伪装空台词（output:'' 会让引擎错误体系全程失明：不通知、不留失败痕迹）。 */
export async function sendActorFailure(
  bridge: FemoBridge, jobId: number, waitKey: string, kind: string, detail: string,
): Promise<void> {
  await bridge.send('actor_failed', {
    job_id: jobId,
    wait_key: waitKey,
    kind,
    detail: detail.slice(0, 500),
  }, 10_000)
}
