/**
 * engine-transcript.ts — 引擎档案转写的唯一翻译官（握手契约的宿主侧实现）。
 *
 * 引擎在 femoCompiler/protocol.py 白纸黑字定义 TranscriptStep 契约（生料形态：
 * tool_calls/tool_results 结构化原文，不带排版；[TOOL CALL #N] 模板由引擎
 * 落档前套用，全世界只有引擎那一份）。本文件唯一职责：把 harness 子会话的
 * 事件流水账翻译成该契约。subagent.ts（子代理路径）与 main-actor.ts（主模型
 * 下场路径）都从这里取——换 harness 需要重写的翻译逻辑就这一个文件。
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** 一条工具命令（生料：名称+参数文本；配对靠数组序，引擎落档时套模板）。 */
export interface TranscriptToolCall {
  name: string
  arguments: string
}

/**
 * 一个子会话 step（一轮）的结构化转写（femoCompiler/protocol.py 契约）：
 * cot=该轮 reasoning（全量存，可见性由读取侧开关管）；reply=该轮 assistant
 * 文本；tool_calls/tool_results=该轮工具命令与结果（生料，按序配对）。
 */
export interface TranscriptStep {
  step: number
  cot: string
  reply: string
  tool_calls: TranscriptToolCall[]
  tool_results: string[]
}

export interface Transcript {
  /** 该场最终台词=最后一个非空 reply（流程用）。 */
  output: string
  steps: TranscriptStep[]
}

/** Extract plain text from content blocks (text + tool-result content). */
function blocksToText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    const b = block as { type?: string; text?: unknown; content?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') return b.text
    if (b.type === 'tool-result' && Array.isArray(b.content)) return blocksToText(b.content)
    return ''
  }).join('')
}

/**
 * 把子会话事件流按 step 分桶成结构化转写（2026-08-29 转写分离；2026-09-07
 * 收编为契约翻译官）：assistant/message 开启新一轮（reasoning→cot、
 * text→reply），tool/call 逮住命令（name/arguments），tool/result 归属本轮
 * 结果——不再拍平成带标记的长文本，下游上下文由读取侧按可见性开关重组。
 * output=最后一个非空 reply（流程用）。
 */
export function buildTranscript(events: readonly SessionEvent[]): Transcript {
  type Bucket = {
    cot: string[]
    reply: string[]
    calls: TranscriptToolCall[]
    results: string[]
  }
  const buckets = new Map<number, Bucket>()
  const bucketOf = (step: number): Bucket => {
    let b = buckets.get(step)
    if (b === undefined) {
      b = { cot: [], reply: [], calls: [], results: [] }
      buckets.set(step, b)
    }
    return b
  }
  let output = ''
  for (const event of events) {
    if (event.type === 'assistant/message') {
      const data = event.data as { step?: unknown; message?: { content?: unknown } }
      const content = data.message?.content
      if (!Array.isArray(content)) continue
      const step = typeof data.step === 'number' ? data.step : 0
      const b = bucketOf(step)
      const text = content.filter(b2 => (b2 as { type?: string }).type === 'text')
        .map(b2 => String((b2 as { text?: unknown }).text ?? '')).join('')
      const reasoning = content.filter(b2 => (b2 as { type?: string }).type === 'reasoning')
        .map(b2 => String((b2 as { text?: unknown }).text ?? '')).join('')
      if (reasoning.length > 0) b.cot.push(reasoning)
      if (text.length > 0) {
        b.reply.push(text)
        output = text
      }
    } else if (event.type === 'tool/call') {
      const data = event.data as { step?: unknown; callId?: unknown; name?: unknown; arguments?: unknown }
      const step = typeof data.step === 'number' ? data.step : 0
      bucketOf(step).calls.push({
        name: typeof data.name === 'string' ? data.name : '',
        arguments: typeof data.arguments === 'string' ? data.arguments : '',
      })
    } else if (event.type === 'tool/result') {
      const data = event.data as { step?: unknown; message?: { content?: unknown } }
      const step = typeof data.step === 'number' ? data.step : 0
      const message = data.message
      if (message === undefined) continue
      const content = message.content
      const items = Array.isArray(content) ? content : []
      for (const block of items) {
        const bl = block as { type?: string; text?: unknown; content?: unknown }
        if (bl.type !== 'tool-result') continue
        const text = typeof bl.text === 'string' ? bl.text : blocksToText(bl.content)
        if (text.length > 0) bucketOf(step).results.push(text)
      }
    }
  }
  const steps: TranscriptStep[] = [...buckets.keys()].sort((a, b) => a - b).map((step) => {
    const b = buckets.get(step)!
    return {
      step,
      cot: b.cot.join('\n\n'),
      reply: b.reply.join('\n\n'),
      tool_calls: b.calls,
      tool_results: b.calls.length > 0 || b.results.length > 0 ? b.results : [],
    }
  })
  return { output, steps }
}
