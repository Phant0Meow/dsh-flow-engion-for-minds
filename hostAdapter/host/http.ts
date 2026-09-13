/**
 * http.ts — HTTP 小工具箱。
 *
 * 请求体读取 / JSON 响应写出 / SSE 长连接客户端表与广播。纯工具，无业务逻辑，
 * 全插件共用。从 index.ts 原样迁出（2026-08-23 重构）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** POST /dsh-femo/create-session body. */
export interface CreateSessionBody {
  cwd?: unknown
  femo?: unknown
  scriptPath?: unknown
  /** POST /dsh-femo/run only: the Femo session to play the script on. */
  sessionId?: unknown
  /** POST /dsh-femo/run only: true = 作废 checkpoint 从头跑（缺省带断点续跑）。 */
  reset?: unknown
}

/** POST /dsh-femo/save-script body. */
export interface SaveScriptBody {
  name?: unknown
  content?: unknown
  /** 绝对路径直写（导出流程：用户经系统目录选择器选定目录 + 文件名）。 */
  path?: unknown
  /** 带上则文件写成功后顺写会话剧本记录 {path, text}（导出/覆盖保存统一
   *  为 mount 同款并存格式，2026-08-30 猫猫拍板）+ 广播 script_changed。 */
  sessionId?: unknown
}

/** Read a JSON request body (empty body tolerated). */
export async function readBody(req: IncomingMessage): Promise<CreateSessionBody> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return {}
  try {
    return JSON.parse(text) as CreateSessionBody
  } catch {
    return {}
  }
}

/** Write a JSON response. */
export function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

// ── SSE broadcast（femoGen 可视化运行的实时事件通道）───────────────────────

/** /dsh-femo/events 长连接集合（浏览器 EventSource）；routes.ts 的 SSE 路由直接增删成员。 */
export const sseClients = new Set<ServerResponse>()

/** 向所有 SSE 客户端广播一个事件（画布可视化运行按 node_name 匹配节点）。 */
export function broadcastSse(eventType: string, data: unknown): void {
  const payload = `data: ${JSON.stringify({ type: eventType, data: data ?? {} })}\n\n`
  for (const res of sseClients) {
    try {
      res.write(payload)
    } catch {
      sseClients.delete(res)
    }
  }
}
