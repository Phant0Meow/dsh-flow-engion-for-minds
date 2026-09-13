/**
 * femo-files.ts — FEMO 剧本文件账本（导入过 / 导出过的 .femo 历史清单）。
 *
 * 存在的理由（2026-09-11）：导入原先只有「host 弹系统打开文件对话框」一条路，
 * 隐含前提是操作者坐在宿主屏幕前。手机通过 tailscale 连 dsh 时，对话框开在
 * 电脑上，手机端等于根本没有导入入口（点了只会让电脑屏幕弹窗，人不在跟前）。
 * 于是把「导入」拆成两级：
 *   点导入 → 先出这份历史清单 → 从清单里挑；
 *   电脑端清单右上角另有「浏览…」，按它才走原来的系统对话框。
 * 手机端只有清单（对话框开在电脑上，给了「浏览」也是死路，故不渲染）。
 *
 * 账本记两件事，都只记路径不记内容：
 *  - 导入过的（pick-script / open-femo-file 选中即记；AI 的 femo-mount
 *    挂载成功也算一次使用，2026-09-12——不然 AI 挂的剧本清单里看不到）；
 *  - 导出过的（save-script 写盘成功即记）。
 * 不存内容是为了守住「导入=引用」的既有语义（2026-08-30 猫猫拍板「从哪导入
 * 就指向哪」）：盘上文件改了，下次从清单打开拿到的就是新版，不会拿到一份
 * 陈旧的快照。代价是文件被移走/删掉后条目打不开——故 list 时逐条 stat，
 * 标 exists=false 交前端变灰提示，而不是静默剔除：外接盘/网络盘临时掉线
 * 很常见，静默剔除会让用户以为记录丢了（跟会话记录损坏隔离留证同一个取向：
 * 可疑状态要可见，不要消失）。
 *
 * 落盘位置与其余 user_data 状态文件同级：<femoRoot>/user_data/femo_files.json
 * 纯磁盘读写，无任何 dsh 服务依赖。
 */

import { basename, join } from 'node:path'

/** 条目来源：导入（系统对话框选的 / 从清单打开的 / AI femo-mount 的）或导出（保存出来的）。 */
export type FemoFileSource = 'import' | 'export'

/** 落盘的单条记录（不含 stat 现算的瞬时字段）。 */
interface FemoFileRecord {
  /** 绝对路径（保留原样大小写，读盘时按它读）。 */
  path: string
  /** basename，前端列表主标题。 */
  name: string
  /** 最近一次来源：后一次动作覆盖前一次（同一文件先导入后导出 → 'export'）。 */
  source: FemoFileSource
  /** 首次入账时间（epoch ms）。 */
  firstSeenAt: number
  /** 最近一次导入/导出时间（epoch ms）；清单按它倒序。 */
  lastUsedAt: number
}

interface FemoFileLedger {
  version: 1
  /** 键 = 归一化路径（见 normKey），值 = 记录。 */
  files: Record<string, FemoFileRecord>
}

/** 清单条目 = 落盘记录 + 现算的磁盘状态。 */
export interface FemoFileEntry extends FemoFileRecord {
  /** 现算（不落盘）：文件此刻是否还在盘上且是普通文件。 */
  exists: boolean
  size?: number
  mtimeMs?: number
}

/** 清单上限：超出按 lastUsedAt 砍最旧的，防无界增长。 */
const MAX_ENTRIES = 200

/** 去重键：Windows 路径不区分大小写，反斜杠统一 + 折叠连续分隔符。
 *  折叠是有实测依据的——2026-09-11 补账本时发现历史记录里存着
 *  `D:\\myFiles\\dsh\\...` 这种双反斜杠写法（Windows 照样认，指同一个文件），
 *  不折叠的话同一份剧本会在清单里出现两条。
 *  UNC 路径（`\\server\share\...`）的前导双斜杠要保留，故单独判一下。 */
function normKey(path: string): string {
  const unified = path.trim().replace(/\//g, '\\')
  const isUnc = unified.startsWith('\\\\')
  const body = unified.replace(/\\{2,}/g, '\\').replace(/^\\/, '')
  return (isUnc ? `\\\\${body}` : body).toLowerCase()
}

function ledgerPath(femoRoot: string): string {
  return join(femoRoot, 'user_data', 'femo_files.json')
}

/** 读账本。文件不存在/损坏/形状不对，一律按空账本处理——清单是锦上添花的东西，
 *  不值得为它把导入流程整个炸掉（与「不许静默吞错」不冲突：这里吞掉的是清单
 *  自身的读取失败，且后果可见＝清单为空，不是把用户的真实操作结果吞掉）。 */
async function readLedger(femoRoot: string): Promise<FemoFileLedger> {
  const { readFile } = await import('node:fs/promises')
  try {
    const raw = await readFile(ledgerPath(femoRoot), 'utf8')
    const parsed = JSON.parse(raw) as Partial<FemoFileLedger> | null
    if (parsed === null || typeof parsed !== 'object') return { version: 1, files: {} }
    const files = parsed.files
    if (files === null || typeof files !== 'object' || Array.isArray(files)) return { version: 1, files: {} }
    return { version: 1, files: files as Record<string, FemoFileRecord> }
  } catch {
    return { version: 1, files: {} }
  }
}

/** 写账本：先写 .tmp 再 rename（同目录 rename 在 NTFS 上原子），避免读到半截 JSON。 */
async function writeLedger(femoRoot: string, ledger: FemoFileLedger): Promise<void> {
  const { mkdir, rename, writeFile } = await import('node:fs/promises')
  await mkdir(join(femoRoot, 'user_data'), { recursive: true })
  const target = ledgerPath(femoRoot)
  const tmp = `${target}.tmp`
  await writeFile(tmp, JSON.stringify(ledger, null, 2), 'utf8')
  await rename(tmp, target)
}

/** 写串行化：同一 femoRoot 上的「记一笔」串成链，避免并发读-改-写互相覆盖
 *  （导入与导出可能几乎同时发生）。前序失败不阻断后续（链上挂 catch 兜底）。 */
const writeChains = new Map<string, Promise<unknown>>()

function withLedgerLock<T>(femoRoot: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(femoRoot) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  writeChains.set(femoRoot, next.then(
    () => undefined,
    () => undefined,
  ))
  return next
}

/**
 * 记一笔（导入/导出成功后调用）。同路径 upsert：刷新 lastUsedAt/source，
 * 保留 firstSeenAt。写失败只打日志不上抛——账本记不上不该让已经成功的
 * 导入/导出在用户那儿变成「失败」。
 */
export async function rememberFemoFile(femoRoot: string, path: string, source: FemoFileSource): Promise<void> {
  const trimmed = path.trim()
  if (trimmed.length === 0) return
  try {
    await withLedgerLock(femoRoot, async () => {
      const ledger = await readLedger(femoRoot)
      const key = normKey(trimmed)
      const now = Date.now()
      const prev = ledger.files[key]
      ledger.files[key] = {
        path: trimmed,
        name: basename(trimmed),
        source,
        firstSeenAt: prev?.firstSeenAt ?? now,
        lastUsedAt: now,
      }
      const keys = Object.keys(ledger.files)
      if (keys.length > MAX_ENTRIES) {
        keys.sort((a, b) => ledger.files[a].lastUsedAt - ledger.files[b].lastUsedAt)
        for (const stale of keys.slice(0, keys.length - MAX_ENTRIES)) delete ledger.files[stale]
      }
      await writeLedger(femoRoot, ledger)
    })
  } catch (error) {
    console.log(`[dsh-femo] ⚠️ FEMO 文件账本写入失败（不影响本次导入/导出）: ${String(error)}`)
  }
}

/** 读清单：逐条 stat 现算 exists/size/mtimeMs；在盘的排前面，组内按 lastUsedAt 倒序。 */
export async function listFemoFiles(femoRoot: string): Promise<FemoFileEntry[]> {
  const { stat } = await import('node:fs/promises')
  const ledger = await readLedger(femoRoot)
  const entries = await Promise.all(
    Object.values(ledger.files).map(async (record): Promise<FemoFileEntry> => {
      try {
        const info = await stat(record.path)
        return { ...record, exists: info.isFile(), size: info.size, mtimeMs: info.mtimeMs }
      } catch {
        return { ...record, exists: false }
      }
    }),
  )
  entries.sort((a, b) => {
    if (a.exists !== b.exists) return a.exists ? -1 : 1 // 打得开的先
    return b.lastUsedAt - a.lastUsedAt
  })
  return entries
}

/**
 * 按路径读正文（清单里选中的那条）。
 * 只允许打开账本里记过的文件：这个端点因此不会退化成「任意文件读取器」。
 * 账本外的路径一律拒绝——反正前端能选到的只有清单里的条目。
 */
export async function readLedgerFemoFile(femoRoot: string, path: string): Promise<string> {
  const trimmed = path.trim()
  if (trimmed.length === 0) throw new Error('path is required')
  const ledger = await readLedger(femoRoot)
  const record = ledger.files[normKey(trimmed)]
  if (record === undefined) {
    throw new Error(`不在导入/导出记录中：${trimmed}`)
  }
  const { readFile } = await import('node:fs/promises')
  // 用账本里的原始大小写路径读，而不是前端传来的那份
  return await readFile(record.path, 'utf8')
}
