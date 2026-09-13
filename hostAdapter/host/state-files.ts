/**
 * state-files.ts — user_data 状态文件读写族（存档管理员）。
 *
 * 两套互不相干的 JSON 小文件，全部落在 <femoRoot>/user_data/ 下：
 *  - sessions/<sid>.json     会话剧本记录：文本域（path/text/rev 乐观锁，画布恢复）
 *                            + 演出域（femoSessions 场次账本 / currentJobId 索引）；
 *  - turn_scopes/<sid>.json  镜像 turn → scope 映射，重启后视角过滤重建用。
 *
 * 纯磁盘读写，无任何 dsh 服务依赖。从 index.ts 原样迁出（2026-08-23 重构）；
 * 2026-08-25 断点改造：checkpoints/ 文件族退役，断点并入会话记录 resume 块。
 * 【2026-09-06 Job 模型（运行状态链路重构 §6.1）】PlayResume 族整套退役——
 * 断点归引擎 runs/<job_id>.json（JobManager 唯一权威，原子写/对账/六关裁决），
 * 宿主降级为索引：会话记录只存 currentJobId（权威在引擎文件，宿主侧只是
 * 索引，提案 §四）。存量 resume 块按"不用管旧记录，只管新代码优雅"
 * （猫猫 2026-08-27 拍板）自然失效，不迁移。
 */

import { join } from 'node:path'

/** 会话剧本记录文件的完整形态：文本域 + 演出域。 */
interface SessionRecordFile {
  sessionId?: string
  path?: string
  text?: string
  rev?: number
  femoSessions?: number[]
  /** 当前 Job 索引（femo-run fresh/resume 成功后写；null=清除）。
   * 权威在引擎 runs/<job_id>.json，此处只是"本会话最近一次运行"的索引。 */
  currentJobId?: number
  /** 本会话激活过的全部 Job（按首次激活顺序，含历史挂起场；femoGen 场次
   * 回放/续跑旧 Job 的候选清单）。去重：同一 Job 只记一次。 */
  jobIds?: number[]
}

/** 读会话记录文件全文（文本域+演出域）。
 * quarantineOnParseError：仅限持锁的写入方开启——锁保证本进程写入互斥，
 * 锁内解析失败=真损坏而非并发撕裂读，此时把坏档改名留证并大声报错
 * （不许静默吞错红线）后按缺失处理。普通读取方严禁开启：并发读到半截
 * 文件属正常瞬态，隔离反而会把好档案误伤走。 */
async function readSessionRecord(femoRoot: string, sessionId: string, quarantineOnParseError = false): Promise<SessionRecordFile | undefined> {
  const { readFile } = await import('node:fs/promises')
  let raw: string
  try {
    raw = await readFile(sessionScriptPath(femoRoot, sessionId), 'utf8')
  } catch {
    return undefined // 文件不存在=正常缺省
  }
  try {
    return JSON.parse(raw) as SessionRecordFile
  } catch (error) {
    if (!quarantineOnParseError) return undefined
    const { rename } = await import('node:fs/promises')
    const quarantined = `${sessionScriptPath(femoRoot, sessionId)}.corrupt-${Date.now()}`
    try {
      await rename(sessionScriptPath(femoRoot, sessionId), quarantined)
      console.log(`[dsh-femo] ⚠️ 会话记录损坏，原档已隔离留证: ${quarantined}（${String(error)}）`)
    } catch (renameError) {
      console.log(`[dsh-femo] ⚠️ 会话记录解析失败且隔离失败: ${String(error)} / ${String(renameError)}`)
    }
    return undefined
  }
}

// ── 会话记录并发控制（2026-08-26 记录剥空 bug 修复）─────────────────────
//
// 病根：全部写入方都是「async 读 → 改 → async 写」三段式且彼此无互斥。
// fs.writeFile 有 truncate→write 的中间窗口，并发的读撞进窗口会读到半个
// JSON，解析失败被静默当作「档案不存在」，写入方遂从空底重写整份文件——
// path/text/rev/femoSessions 全部蒸发（实测 2026-08-25 场次 869 运行收尾时
// 剥空成 {sessionId}）。药方：同一 sessionId 的所有记录变更经
// withRecordLock 串行化；锁内解析失败按真损坏隔离留证。
const recordLocks = new Map<string, Promise<unknown>>()

/** 同一 sessionId 的记录变更串行队列：fn 排在前一变更之后执行，
 * 读到写的全程不与其他变更交错。 */
function withRecordLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = recordLocks.get(sessionId) ?? Promise.resolve()
  const next = prev.then(() => fn(), () => fn())
  recordLocks.set(sessionId, next)
  return (async (): Promise<T> => {
    try {
      return await next
    } finally {
      if (recordLocks.get(sessionId) === next) recordLocks.delete(sessionId)
    }
  })()
}

/** 写回会话记录文件整对象。不碰 rev——rev 只归文本快照协议管，
 * 运行态（演出域）写入不该惊动前端的乐观锁。 */
async function writeSessionRecord(femoRoot: string, sessionId: string, record: SessionRecordFile): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const path = sessionScriptPath(femoRoot, sessionId)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify({ ...record, sessionId }, null, 2), 'utf8')
}

/** 锁内读-改-写会话记录的 currentJobId（null=删除键）。经会话记录串行队列
 * 执行；只动 currentJobId 键，不碰文本域与 femoSessions。 */
export async function setSessionCurrentJob(femoRoot: string, sessionId: string, jobId: number | null): Promise<void> {
  await withRecordLock(sessionId, async (): Promise<void> => {
    const record: SessionRecordFile = { ...(await readSessionRecord(femoRoot, sessionId, true) ?? {}) }
    if (jobId === null) delete record.currentJobId
    else record.currentJobId = jobId
    await writeSessionRecord(femoRoot, sessionId, record)
  })
}

/** 读会话记录的 currentJobId 索引；无记录/无键返回 undefined。 */
export async function readSessionCurrentJob(femoRoot: string, sessionId: string): Promise<number | undefined> {
  const record = await readSessionRecord(femoRoot, sessionId)
  return record?.currentJobId
}

/** 读会话激活过的全部 Job（无记录/无键返回 undefined——旧记录自然缺省）。 */
export async function readSessionJobIds(femoRoot: string, sessionId: string): Promise<number[] | undefined> {
  const record = await readSessionRecord(femoRoot, sessionId)
  return record?.jobIds
}

/** 登记一个激活过的 Job（幂等：已在列则不动）。开跑/续跑成功回执后调用。
 * 经会话记录串行队列执行；只动 jobIds 键，不碰文本域。 */
export async function appendSessionJob(femoRoot: string, sessionId: string, jobId: number): Promise<void> {
  await withRecordLock(sessionId, async (): Promise<void> => {
    const record: SessionRecordFile = { ...(await readSessionRecord(femoRoot, sessionId, true) ?? {}) }
    if (record.jobIds?.includes(jobId)) return
    record.jobIds = [...(record.jobIds ?? []), jobId]
    await writeSessionRecord(femoRoot, sessionId, record)
  })
}

/** 记一场演出：dsh 会话 ↔ femo 场次的一对多账本（末位=当前场次）。连续去重。
 * 经会话记录串行队列执行。 */
export function appendFemoSession(femoRoot: string, sessionId: string, femoSessionId: number): Promise<void> {
  return withRecordLock(sessionId, async () => {
    const record: SessionRecordFile = { ...(await readSessionRecord(femoRoot, sessionId, true) ?? {}) }
    const list = record.femoSessions ?? []
    if (list[list.length - 1] === femoSessionId) return
    record.femoSessions = [...list, femoSessionId]
    await writeSessionRecord(femoRoot, sessionId, record)
  })
}

/** turn→scope 映射文件路径：一 Femo 会话一个 JSON（重启后 /dsh-femo/turn-scopes 重建用）。 */
function turnScopePath(femoRoot: string, sessionId: string): string {
  return join(femoRoot, 'user_data', 'host-history', 'projections', 'turn-scopes', `${sessionId}.json`)
}

/** Persist the session's whole turn→scope map（跨 run 累积；turnBase 递增保证键不冲突）。 */
export async function writeTurnScopeFile(femoRoot: string, sessionId: string, scopes: Map<number, string[]>): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const path = turnScopePath(femoRoot, sessionId)
  const out: Record<string, string[]> = {}
  for (const [turn, scope] of scopes) out[String(turn)] = scope
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify({ sessionId, updatedAt: Date.now(), scopes: out }, null, 2), 'utf8')
}

/** Read the persisted turn→scope map as a plain object (absent file → {}). */
export async function readTurnScopeFile(femoRoot: string, sessionId: string): Promise<Record<string, string[]>> {
  const { readFile } = await import('node:fs/promises')
  try {
    const raw = await readFile(turnScopePath(femoRoot, sessionId), 'utf8')
    const parsed = JSON.parse(raw) as { scopes?: Record<string, string[]> }
    return parsed.scopes ?? {}
  } catch {
    return {}
  }
}

/** 会话级剧本记录路径（femoGen 刷新/重启后恢复画布用；JSON 单文件）。 */
function sessionScriptPath(femoRoot: string, sessionId: string): string {
  return join(femoRoot, 'user_data', 'host-history', 'drafts', `${sessionId}.json`)
}

/** 会话剧本记录：path=剧本文件地址（导出/导入产生），text=浏览器端剧本原文
 * （未保存态；或已保存但前端修改过、运行检测不一致时保存的实际运行版本）。
 * rev=乐观锁版本号：每次写入自增；前端快照写带 baseRev 做多端并发裁决。
 * 读取优先级：text（实际运行的版本）→ path 指向文件内容。 */
export interface SessionScriptRecord {
  path?: string
  text?: string
  rev?: number
}

export type WriteSessionScriptResult =
  | { ok: true; rev: number }
  | { ok: false; reason: 'conflict'; record: SessionScriptRecord }

/** 写会话剧本记录（覆盖式，自动 rev+1）。expectRev 非空时做乐观锁校验：
 * 与服务端当前 rev 不符 → 拒绝写入并返回当前记录（多端并发编辑，后写者输）。
 * 经会话记录串行队列执行。 */
export function writeSessionScript(
  femoRoot: string,
  sessionId: string,
  record: SessionScriptRecord,
  expectRev?: number,
): Promise<WriteSessionScriptResult> {
  return withRecordLock(sessionId, async (): Promise<WriteSessionScriptResult> => {
    const prevFile = await readSessionRecord(femoRoot, sessionId, true)
    if (expectRev !== undefined && (prevFile?.rev ?? 0) !== expectRev) {
      const conflictRecord: SessionScriptRecord = {}
      if (prevFile?.path !== undefined) conflictRecord.path = prevFile.path
      if (prevFile?.text !== undefined) conflictRecord.text = prevFile.text
      if (prevFile?.rev !== undefined) conflictRecord.rev = prevFile.rev
      return { ok: false, reason: 'conflict', record: conflictRecord }
    }
    const rev = (prevFile?.rev ?? 0) + 1
    // 文本域（path/text）整体以本次传入为准——「一致→只存地址」依赖字段替换语义；
    // 演出域（femoSessions/currentJobId/jobIds）是 host 独占的运行态，跨文本写入保留。
    const next: SessionRecordFile = {
      ...(prevFile?.femoSessions !== undefined ? { femoSessions: prevFile.femoSessions } : {}),
      ...(prevFile?.currentJobId !== undefined ? { currentJobId: prevFile.currentJobId } : {}),
      ...(prevFile?.jobIds !== undefined ? { jobIds: prevFile.jobIds } : {}),
      ...record,
      rev,
    }
    await writeSessionRecord(femoRoot, sessionId, next)
    return { ok: true, rev }
  })
}

/** 读会话剧本记录；不存在返回 undefined。 */
export async function readSessionScript(femoRoot: string, sessionId: string): Promise<SessionScriptRecord | undefined> {
  const { readFile } = await import('node:fs/promises')
  try {
    const raw = await readFile(sessionScriptPath(femoRoot, sessionId), 'utf8')
    const parsed = JSON.parse(raw) as Partial<SessionScriptRecord>
    return {
      ...parsed.path === undefined ? {} : { path: parsed.path },
      ...parsed.text === undefined ? {} : { text: parsed.text },
      ...parsed.rev === undefined ? {} : { rev: parsed.rev },
    }
  } catch {
    return undefined
  }
}

/** 读会话剧本的最终文本：text 优先（实际运行版本）→ path 指向的文件内容 → undefined。 */
export async function readSessionScriptText(femoRoot: string, sessionId: string): Promise<string | undefined> {
  const record = await readSessionScript(femoRoot, sessionId)
  if (record === undefined) return undefined
  if (record.text !== undefined && record.text.trim().length > 0) return record.text
  if (record.path !== undefined) {
    try {
      const { readFile } = await import('node:fs/promises')
      return await readFile(record.path, 'utf8')
    } catch {
      return undefined
    }
  }
  return undefined
}

// ── 角色上下文占用档案（actor-usage，2026-08-31 角色窗圆环）────────────────

/** 一个角色最近一次演出的上下文占用快照。usedTokens=该角色上一次发言时发给
 * API 的完整 prompt 的 provider 实报 token 量（input+缓存读写，不含输出——
 * 官方 pressureTokens 同语义，2026-08-31 猫猫拍板语义）；contextWindow=该
 * 模型 request/context 记录的容量（adapter 未广告时 host 兜底 1_000_000）。 */
export interface ActorUsageRecord {
  provider: string
  model: string
  contextWindow: number
  usedTokens: number
  /** 最近更新时刻（epoch ms）。 */
  updatedAt: number
}

/** 主会话角色占用档案：{ 消毒后 actorKey: 快照 }。key 用 projectionActorKey
 * （与投影窗 id 尾段同款消毒）——前端从 sessionId 解析出的正是该形态。 */
export type ActorUsageFileBody = Record<string, ActorUsageRecord>

function actorUsagePath(femoRoot: string, sessionId: string): string {
  return join(femoRoot, 'user_data', 'host-history', 'projections', 'actor-usage', `${sessionId}.json`)
}

/** 读主会话的角色占用档案；不存在/损坏返回 undefined（普通读取方：并发读到
 * 半截文件属正常瞬态，与 sessions 记录同哲学，不隔离）。 */
export async function readActorUsageFile(femoRoot: string, sessionId: string): Promise<ActorUsageFileBody | undefined> {
  const { readFile } = await import('node:fs/promises')
  try {
    const raw = await readFile(actorUsagePath(femoRoot, sessionId), 'utf8')
    const parsed = JSON.parse(raw) as { actors?: ActorUsageFileBody }
    return typeof parsed.actors === 'object' && parsed.actors !== null ? parsed.actors : undefined
  } catch {
    return undefined
  }
}

/** 合并写一个角色的占用快照（锁内 read-merge-write：par 兄弟 run 的收尾
 * 并发不会互相覆盖丢 actor）。actorKey=消毒后的投影窗尾段（与前端一致）。 */
export async function mergeActorUsageFile(femoRoot: string, sessionId: string, actorKey: string, record: ActorUsageRecord): Promise<void> {
  await withRecordLock(sessionId, async (): Promise<void> => {
    const fs = await import('node:fs/promises')
    const existing = await readActorUsageFile(femoRoot, sessionId) ?? {}
    const actors: ActorUsageFileBody = { ...existing, [actorKey]: record }
    await fs.mkdir(join(femoRoot, 'user_data', 'host-history', 'projections', 'actor-usage'), { recursive: true })
    await fs.writeFile(actorUsagePath(femoRoot, sessionId), JSON.stringify({ sessionId, actors }, null, 2), 'utf8')
  })
}
