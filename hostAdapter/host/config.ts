/**
 * config.ts — 插件配置（设置表）。
 *
 * Config schema（dsh 配置面的 zod 声明）+ ResolvedConfig（apply 时的运行时
 * 解析结果，全插件统一消费这一份）。从 index.ts 原样迁出（2026-08-23 重构）。
 */

import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

/** 插件包根目录：femoRoot 缺省时指向插件自身（自包含布局，整个文件夹搬走即用）。 */
export const packageRoot = fileURLToPath(new URL('..', import.meta.url))

export const Config = z.object({
  /** Master switch. */
  enabled: z.boolean().default(true),
  /** Femo 引擎根目录（femoCompiler/femoBridges 所在；AI 工具在 femoToolcall/，示例剧本与 @func 伴生模块在 femoExamples/）。缺省 = 插件包根（自包含）。 */
  femoRoot: z.string().default(''),
  /** Python executable used to launch the bridge. */
  python: z.string().default('python'),
  /** Provider/model/URL for the engine's AI nodes (llmBridge args). */
  provider: z.string().default('deepseek'),
  model: z.string().default('deepseek-v4-flash'),
  apiUrl: z.string().default('https://api.deepseek.com/v1/chat/completions'),
  /** Credential reference (env name) for the engine's LLM key. */
  apiKeyRef: z.string().default('DEEPSEEK_API_KEY'),
  /** M5: dsh LLM provider route for subagents (dsh adapter name). */
  dshProvider: z.string().default('deepseek-official'),
  /** M5: route every AI node through a host subagent (native tool calls + cot).
   *  注意：不给 schema default——缺省语义由 resolveConfig 的回落链表达
   *  （hostAiBackend ?? dshAiBackend ?? true），否则管线注入的 true 会
   *  遮蔽旧键的显式 false。 */
  hostAiBackend: z.boolean(),
  /** @deprecated 旧配置键（引擎协议字段已更名 host_ai_backend）。仅在
   *  hostAiBackend 未显式设置时作为回落读取，后续版本移除。 */
  dshAiBackend: z.boolean().default(true),
  /**
   * Per-Actor tool access default. The 剧本 author decides per actor with
   * `tools: true/false` (or `tools: [name, ...]` as a whitelist); an actor
   * that declares nothing falls back to this global default. Default TRUE —
   * the plugin also runs coding workflows, so工具能力 must not vanish
   * unless a script opts out.
   */
  defaultActorTools: z.boolean().default(true),
  /**
   * Global附加 tool whitelist applied on top of the actor's own access
   * (empty = no extra restriction). Actor whitelists (tools: [..]) win over
   * this for the actor that declares them.
   */
  toolWhitelist: z.array(z.string()).default([]),
  /** Subagent provider name (spawn = fresh child, zero parent context). */
  subagentProvider: z.string().default('spawn'),
  /**
   * Subagent IDLE timeout: a child that keeps producing events (reasoning
   * chunks, tool calls, streamed text) is alive no matter how long it runs —
   * multi-turn tool workflows can legitimately take tens of minutes, so there
   * is NO total-duration cap. Only a child that goes silent for this long is
   * presumed hung and aborted.
   */
  subagentIdleTimeoutMs: z.number().default(120_000),
  /**
   * 子 agent 推理等级（'off'|'low'|'high'|'max'）。缺省跟随主会话请求头的
   * 生效档位（跟随主模型 = 连推理档位一起跟随）。显式设置可覆盖——针对
   * 强制思考的模型（如 glm-5.3-flash：不带 low/high/max 直接 400 1210），
   * 子代理请求必须点名一个合法档位。schema 此前漏声明此字段（ResolvedConfig
   * 有消费无入口，2026-08-29 补上）。
   *
   * 注意：这里不是 zod——`z` 实为 @deepseek-ai/schemastery 的 Schema，
   * 没有 .optional() 方法（不加 .required() 就默认可选）。写成
   * z.string().optional() 会在模块加载时 TypeError，炸掉整个插件树
   * （2026-08-29 踩过：3081 启动即崩）。
   */
  subagentReasoning: z.string(),
})

export interface ResolvedConfig {
  enabled: boolean
  femoRoot: string
  python: string
  provider: string
  model: string
  apiUrl: string
  apiKeyRef: string
  dshProvider: string
  hostAiBackend: boolean
  defaultActorTools: boolean
  toolWhitelist: string[]
  subagentProvider: string
  subagentIdleTimeoutMs: number
  /** 子 agent 推理等级（'off'|'low'|'high'|'max'）；缺省跟随全局默认模型选择。 */
  subagentReasoning?: string
}

export function resolveConfig(config: unknown): ResolvedConfig {
  const c = (config ?? {}) as Partial<ResolvedConfig>
  return {
    enabled: c.enabled ?? true,
    femoRoot: c.femoRoot && c.femoRoot.length > 0 ? c.femoRoot : packageRoot,
    python: c.python ?? 'python',
    provider: c.provider ?? 'deepseek',
    model: c.model ?? 'deepseek-v4-flash',
    apiUrl: c.apiUrl ?? 'https://api.deepseek.com/v1/chat/completions',
    apiKeyRef: c.apiKeyRef ?? 'DEEPSEEK_API_KEY',
    dshProvider: c.dshProvider ?? 'deepseek-official',
    // 旧键 dshAiBackend 回落：老配置只写了旧名时依旧生效（显式设置新名则新名赢）。
    hostAiBackend: c.hostAiBackend ?? (c as Partial<ResolvedConfig> & { dshAiBackend?: boolean }).dshAiBackend ?? true,
    toolWhitelist: c.toolWhitelist ?? [],
    defaultActorTools: c.defaultActorTools ?? true,
    subagentProvider: c.subagentProvider ?? 'spawn',
    subagentIdleTimeoutMs: c.subagentIdleTimeoutMs ?? 120_000,
    ...c.subagentReasoning === undefined ? {} : { subagentReasoning: c.subagentReasoning },
  }
}
