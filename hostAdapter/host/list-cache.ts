/**
 * list-cache.ts — sessionPersistence.list 运行时缓存（2026-08-30 会话列表卡死修复）。
 *
 * 病灶：session-persistence-jsonl 的 listArtifacts() 每次被调用都对磁盘上
 * 【每一个】会话日志做 open → 读 header zstd 帧 → 解压 → JSON 解析，且同一
 * 文件读两遍（readFirstZstdLine + assertStoredIdentity 各一次）。会话数增长后
 * （femo 剧本每次运行产生 god/stage/角色窗 + 主会话，671 个日志实测），
 * 一次 list() 要 3.5~10 秒——网页会话列表（session.list）、点开任意冷会话
 * （session.history 的身份检查）、跨会话搜索全部走它，整站被拖死。
 *
 * 药方（依据 append-only 契约：header 帧在会话创建时写一次，此后 append 只追加
 * 后续帧、永不改写 header）：包装 persistence.list，按「会话目录集合指纹」决定
 * 走缓存还是调原生：
 *  - 指纹不变（绝大多数调用）→ 直接返回缓存 header（约 50ms，纯 readdir + stat）；
 *  - 指纹变化（新建/删除了会话目录，低频）→ 调原生 list() 全量重建；
 *  - 扫描发现陌生布局（项目根下的 flat 日志文件 / 相反压缩编码的文件）→
 *    原样交给原生 list()，让原生校验逻辑自己报错（misconfiguration fails loud）。
 *
 * 边界：
 *  - 只对带 root 目录的 jsonl 后端生效（SQLite 等后端 list 实现不同，不碰）；
 *  - 崩溃修复（repair 截断重写）理论上可能改写 header——概率极低，且 header.id
 *    与文件路径绑定不会错，最坏是某行元数据略旧，下次集合变化或重启即愈；
 *  - 并发调用 single-flight（共享一次扫描/重建）；每次返回浅拷贝，防调用方改写；
 *  - 插件卸载/HMR 重载：disposer 恢复裸方法（模块级 WeakMap 登记裸版防双包）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

type Header = Record<string, unknown>
type ListFn = (signal?: AbortSignal) => Promise<Header[]>

/** 模块级裸方法登记：HMR 重载时新 fiber install 前先恢复裸版，绝不叠加包装。 */
const bareList = new WeakMap<object, ListFn>()

/** 在事件循环间让步：窗与窗的唤醒之间把控制权还给 event loop。 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/**
 * 安装 persistence.list 缓存。sessionPersistence 由 web 组合的 jsonl 后端提供，
 * femo apply 时大概率已就绪；为兼容无此服务的部署（不声明 inject，避免 PENDING），
 * 短轮询等待最多 30 秒，就绪即装。返回 disposer（卸载时停止轮询并恢复裸方法）。
 */
export function installPersistenceListCache(ctx: Context): () => void {
  let disposed = false
  let timer: ReturnType<typeof setInterval> | undefined
  let restore: (() => void) | undefined

  const finish = (): void => {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }

  const tryInstall = (): void => {
    if (disposed) return
    const persistence = ctx.get('sessionPersistence') as
      | { list?: ListFn; root?: unknown; config?: { compression?: string } }
      | undefined
    if (persistence === undefined || typeof persistence.list !== 'function') return

    // 只对 jsonl 后端（持有 root 目录）生效。
    if (typeof persistence.root !== 'string' || persistence.root === '') {
      console.log('[dsh-femo] list-cache: persistence has no root dir (non-jsonl backend?), skip')
      finish()
      return
    }
    const root = persistence.root
    const compression = persistence.config?.compression === 'none' ? 'none' : 'zstd'

    const bare = bareList.get(persistence)
    if (bare !== undefined) persistence.list = bare // HMR：先恢复裸版再重装
    const orig: ListFn = persistence.list.bind(persistence)
    bareList.set(persistence, orig)

    const state = { headers: undefined as Header[] | undefined, fingerprint: '' }
    let inflight: Promise<Header[]> | undefined

    /**
     * 会话目录集合指纹：root/<project>/<sessionDir> 全树相对路径串。
     * 只做 project 层 readdir（~9 次），绝不进会话目录内部——Windows 上
     * stat 不存在的路径代价 ~1ms/次，671 个目录逐个 stat 会把指纹扫描
     * 自己变成 1.4s 的新瓶颈（首版实测踩坑）。会话目录内部的文件布局
     * （opposite 编码/半写文件）交由原生 list() 在重建时校验；指纹层只
     * 检测「会话目录集合」变化（新建/删除会话 = 目录出现/消失），这正是
     * header 缓存唯一需要失效的信号。
     */
    const scanFingerprint = async (): Promise<string | 'fallback'> => {
      const parts: string[] = []
      const projects = await readdir(root, { withFileTypes: true })
      for (const project of projects) {
        if (!project.isDirectory()) continue
        const projectPath = join(root, project.name)
        const entries = await readdir(projectPath, { withFileTypes: true })
        for (const entry of entries) {
          // 陌生布局：项目根下直接放日志文件（原生 legacyLayout 会拒绝，交还原生）。
          if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd'))) {
            return 'fallback'
          }
          if (!entry.isDirectory()) continue
          parts.push(`${project.name}/${entry.name}`)
        }
      }
      parts.sort()
      return parts.join('\n')
    }

    const wrapped = async (signal?: AbortSignal): Promise<Header[]> => {
      signal?.throwIfAborted()
      if (inflight !== undefined) {
        const shared = await inflight
        signal?.throwIfAborted()
        return shared.slice()
      }
      inflight = (async () => {
        const fingerprint = await scanFingerprint()
        if (fingerprint === 'fallback') {
          const fresh = await orig(signal)
          state.headers = fresh.slice()
          state.fingerprint = '' // 陌生布局不建指纹：布局恢复正常前每次都走原生
          return state.headers
        }
        if (state.headers === undefined || fingerprint !== state.fingerprint) {
          const fresh = await orig(signal)
          state.headers = fresh.slice()
          state.fingerprint = fingerprint
          console.log(`[dsh-femo] list-cache: rebuilt via native scan (sessions=${fresh.length})`)
        }
        return state.headers
      })()
      try {
        const result = await inflight
        signal?.throwIfAborted()
        return result.slice()
      } finally {
        inflight = undefined
      }
    }

    persistence.list = wrapped
    restore = (): void => {
      if (bareList.get(persistence) === orig) persistence.list = orig
      bareList.delete(persistence)
      state.headers = undefined
      state.fingerprint = ''
    }
    finish()
    console.log(`[dsh-femo] list-cache installed (root=${root}, compression=${compression})`)
  }

  tryInstall()
  timer = setInterval(tryInstall, 200)
  // 30 秒还没等到服务（无 sessionPersistence 的部署）就放弃轮询，安静退出。
  const giveUp = setTimeout(() => {
    if (!disposed && timer !== undefined) finish()
  }, 30_000)
  // giveUp 只是兜底，不需要单独清理语义；但避免它持有进程：unref。
  ;(giveUp as { unref?: () => void }).unref?.()

  return () => {
    disposed = true
    finish()
    restore?.()
    restore = undefined
  }
}
