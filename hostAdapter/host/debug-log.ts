/**
 * debug-log.ts — 排障日志统一落点：<femoRoot>/cache/logs/。
 *
 * 排障日志是可再生的诊断输出，不是用户数据——不入 user_data（那里只放
 * 「搬文件夹要带走」的东西）。写入时自动建目录；单文件 mtime 超过 3 天
 * 即删（下次写入重新创建），日志自动保鲜、永不无限长胖。
 */
import { appendFileSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const KEEP_DAYS = 3
const NL = String.fromCharCode(10)

export function debugLogPath(femoRoot: string, name: string): string {
  return join(femoRoot, 'cache', 'logs', name)
}

/** 追加一行（自动补行尾换行）；目录自动创建，过期文件自动删，任何失败静默（观测绝不反噬主路）。 */
export function appendDebugLog(femoRoot: string, name: string, line: string): void {
  try {
    const dir = join(femoRoot, 'cache', 'logs')
    const file = join(dir, name)
    mkdirSync(dir, { recursive: true })
    try {
      if (statSync(file).mtimeMs < Date.now() - KEEP_DAYS * 86400_000) unlinkSync(file)
    } catch { /* 不存在 = 正常 */ }
    appendFileSync(file, line.endsWith(NL) ? line : line + NL, 'utf8')
  } catch { /* 日志失败不影响主路 */ }
}
