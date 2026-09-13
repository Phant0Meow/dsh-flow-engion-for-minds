/**
 * host-log.ts — 宿主侧 console 采集（调试窗『Host』页的数据面）。
 *
 * 2026-09-11 用户点名："第 4 个标签页是 Host，就是投影窗这边的代码里的 print"。
 * 宿主跑在 dsh 的 Node 进程里，console 只落 harness 日志文件（user_data/*.log），
 * 浏览器侧一点看不到——本模块把**本插件自己打的**那些行顺到跟前端共用的
 * diag feed（SSE femo_diag / tag 'host'），调试面板第四页据此显示。
 *
 * 做法与前端 femoLog.js 同源：**不改 198 处调用点**，钩 console。区别在"认领范围"——
 * 宿主进程的 console 是全局的，harness 自己/其它插件也在打，若全量转发会把
 * femoGen 的面板淹掉（harness 日志动辄 MB 级），故用**调用栈过滤**：
 * 栈里出现本模块所在目录的帧 ⇒ 这行是本插件代码打的（打包态 lib/index.js、
 * tsx 直跑态 src/*.ts，两种都命中），否则丢弃。
 *
 * 已知边界：
 *  - 过滤第一帧是钩子自身（跳过），其后任一帧命中 SELF_DIR 即认领。若某天宿主
 *    构建改成多文件输出，只要仍在本目录下，判定依旧成立。
 *  - **口径（2026-09-11 用户拍板）：Host 页只放"DSH 接口侧"（投影窗/会话/agent
 *    工具层）的 print**。引擎 stdout/stderr 的透传是"引擎的话"，已在调用点
 *    （bridge.ts / debug-run.ts）改成 `process.stdout.write` **绕过 console**
 *    ——harness 日志照旧，但不会被本钩子认领；它们的家在调试窗『编译器』页。
 *    打包后所有模块同处 lib/index.js，栈里分不出"哪个模块"，故这种模块级取舍
 *    只能在调用点做，不能靠栈过滤。
 *  - 开销：每次全进程 console 调用都会做一次 `new Error().stack`。Node 侧日志
 *    频率很低（实测 harness 峰值也就百行/分钟级），微秒量级无感；原 console
 *    行为完整保留（照常写 harness 日志）。
 */
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pushDiag } from './diag-feed'

/** 本模块目录：打包态 dist/lib、tsx 直跑态 src——用于认领"是不是自己打的"。
 *  归一成正斜杠：Node 的栈帧是 `file:///D:/...` 形式（正斜杠 URL），而
 *  fileURLToPath 在 Windows 给反斜杠路径，不归一则 includes 永不命中
 *  （2026-09-11 离线测试实测：不归一时一条都收不到）。 */
const SELF_DIR = dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/')

const LEVELS = ['log', 'info', 'warn', 'error'] as const
type HostLogLevel = (typeof LEVELS)[number]

/** 落点：默认进 diag feed（tag 'host'）；测试可注入替身。 */
export type HostLogSink = (level: HostLogLevel, text: string) => void

const TEXT_MAX = 400

function fmtArg(a: unknown): string {
  if (typeof a === 'string') return a
  if (a instanceof Error) return a.message
  if (a === null) return 'null'
  if (a === undefined) return 'undefined'
  try {
    const s = JSON.stringify(a)
    return s === undefined ? String(a) : s
  } catch {
    return String(a)
  }
}

/** 栈里是否出现本模块 ⇒ 调用方是本插件代码。
 *  必须在**包装函数内部**取栈（不要抽成独立函数）：抽出去会多一层本模块的帧，
 *  把"跳过钩子自身"的偏移算错，导致任何调用方都被认领（2026-09-11 离线测试
 *  实测：抽成 calledFromSelf() 后 `other/` 的日志也被收了）。
 *  约定：frames[0]='Error'、frames[1]=包装函数自身，从 frames[2] 起找。 */
function isCalledFromSelf(stack: string | undefined): boolean {
  if (stack === undefined) return false
  const frames = stack.split('\n')
  for (let i = 2; i < frames.length; i += 1) {
    if (frames[i].replace(/\\/g, '/').includes(SELF_DIR)) return true
  }
  return false
}

let installed = false

/**
 * 装钩子（幂等）。在插件 apply 里调一次即可——之后本插件所有 console 调用
 * 都会额外落一路到 diag feed。warn/error 的行首带 `[warn]`/`[error]` 标记，
 * 前端据此给行上色（与『剧本』『FEMOGen』页同一套级别配色）。
 */
export function installHostLogCapture(sink?: HostLogSink): void {
  if (installed) return
  installed = true
  const emit: HostLogSink = sink ?? ((level, text) => pushDiag('host', text))
  for (const name of LEVELS) {
    const orig = console[name]
    if (typeof orig !== 'function') continue
    console[name] = (...args: unknown[]): void => {
      try {
        // 注意：这里直接取栈（不外包函数）——外包会多一层本模块的帧，见 isCalledFromSelf 注释。
        if (isCalledFromSelf(new Error().stack)) {
          const body = args.map(fmtArg).join(' ').slice(0, TEXT_MAX)
          emit(name, name === 'log' ? body : `[${name}] ${body}`)
        }
      } catch { /* 采集失败绝不反噬业务 */ }
      orig.apply(console, args)
    }
  }
  // 开机确认行（2026-09-12）：装好后立刻留一条在诊断环里——用户打开 Host 页
  // 第一眼就能看到采集在工作，而不是对着空页猜"到底装没装"。
  emit('log', 'Host 日志采集已启动：投影窗、会话等宿主侧日志将实时显示在这里')
}
