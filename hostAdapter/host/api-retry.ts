/**
 * api-retry.ts — femo AI 演员的 API 请求错误慢层兜底（第二类错误，施工清单 v4 §2）。
 *
 * 官方 base bundle 已装配 dsh-llm-retry（请求层快层：≤5 次 500ms→10s 快速退避，
 * base/cordis.patch.yml L84-85）。本模块注册在同一条 `agent/request-error`
 * 瀑布的下游（base bundle 先装配 → 快层先消费；profile patch 插件晚装配 →
 * 快层耗尽才落到这里）：快层仍失败的 femo 演员请求（子代理 + main 在飞
 * 回合）进入本慢层——五段退避重试（立即 / 20s / 1min / 3min / 10min），
 * 第五段重试之后仍失败则放行（turn error → 既有 recordError/交卷路径 →
 * 引擎"AI 沉默"move on = 节点按结束）。compiler 全程无感。
 *
 * 计数口径（P1 已裁决：连续计数·成功清零）：按 childSessionId 记录
 * (turn, step) 连续失败序列——新失败与上次记录的 (turn,step) 不同（=中间有
 * step 成功推进）→ 计数重置 1；相同 → +1。零跨模块钩子（handler 自足，
 * subagent/main 统一处理）——多轮 react 各 step 的偶发失败各自享"立即重试"，
 * 长退避只在持续故障时发生。
 *
 * 永久性错误码不重试（P3）：NO_ADAPTER / INVALID_CREDENTIAL / MISSING_CREDENTIAL /
 * QUOTA / CONTEXT_WINDOW_EXCEEDED 等重试恒同败，立即放行（白等 14 分钟无意义）。
 */

import type { Context } from '@deepseek-ai/cordis'

/** 一次慢层重试的作用对象（v4 §2）。 */
export interface ActorTarget {
  kind: 'subagent' | 'main'
  /** 主会话 id（通知/错误表定位）。 */
  mainSessionId: string
  /** 触发失败的 agent 会话 id（子代理 = run.id；main = 主会话 id）。 */
  childSessionId: string
  /** 引擎节点 id。 */
  node: string
}

/** 归一化后的失败事实（从 LlmFailure 取路由需要的两个字段）。 */
export interface ApiRetryFailure {
  code: string
  message: string
}

export interface ApiRetryDeps {
  /** filter：childId → 演员 target；未命中（导演轮次/用户聊天/陌生 agent/已收尾）→ undefined 透传。 */
  resolveTarget(childSessionId: string): ActorTarget | undefined
  /** 每次慢层重试排程后的通知（投影窗 ⏳ / main 走 console.log，装配处实现）。 */
  onRetry(target: ActorTarget, attempt: number, delayMs: number, failure: ApiRetryFailure): void
  /** 连续第 5 次失败：放行前通知（recordError + 投影窗 ❌，装配处实现）。 */
  onExhausted(target: ActorTarget, failure: ApiRetryFailure): void
}

/** 可重试错误码：与官方 llm-retry 快层五码一致。永久码（NO_ADAPTER 等）在
 *  快层就被放行根本到不了这里；此处再过滤一遍是防御装配顺序变化。 */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE',
])

/** 五段慢层退避（协议常量，猫猫纲领）：立即 / 20s / 1min / 3min / 10min。 */
const SLOW_DELAYS_MS: readonly number[] = [0, 20_000, 60_000, 180_000, 600_000]

/** 连续失败上限：第五次慢层重试（10min 段）之后仍失败 → 放行。没有第六次。 */
const MAX_CONSECUTIVE_FAILURES = 5

/** 同一 childId 的连续失败记录：(turn,step) 相同 = 同一步骤连续败。 */
interface AttemptRecord {
  turn: number
  step: number
  count: number
}

export class ApiRetryChain {
  private readonly attempts = new Map<string, AttemptRecord>()
  private readonly lifetime = new AbortController()

  /**
   * 注册 `agent/request-error` 瀑布下游 listener。返回 disposer（HMR 安全：
   * 移除 listener + 中止在飞延迟 + 清计数）。
   */
  install(ctx: Context, deps: ApiRetryDeps): () => void {
    const disposeListener = ctx.on('agent/request-error', async (payload, next) => {
      const childId = String(payload.agent.session.id)
      // 1. filter 未命中 → 透传（dsh 默认零变——零影响关键）。顺带清掉已收尾
      //    agent 的计数残留（孤儿防泄漏：登记表已删 = 该 agent 不再归我们管）。
      const target = deps.resolveTarget(childId)
      if (target === undefined) {
        this.attempts.delete(childId)
        return next()
      }
      // 2. turn 已中止（用户停止剧本）→ 不再排程重试，交还上游收尾。
      if (payload.signal.aborted) return next()
      const failure: ApiRetryFailure = { code: payload.failure.code, message: payload.failure.message }
      // 3. 永久性错误码（P3）：重试恒同败，立即放行。
      if (!RETRYABLE_CODES.has(failure.code)) return next()
      // 4. (turn,step) 连续计数（P1）：新 (turn,step) = 中间有成功推进 → 重置 1。
      const previous = this.attempts.get(childId)
      const count = previous !== undefined
        && previous.turn === payload.turn && previous.step === payload.step
        ? previous.count + 1
        : 1
      if (count > MAX_CONSECUTIVE_FAILURES) {
        // 第五段（10min）重试之后仍失败：放行 = turn error = 既有 recordError/
        // 交卷路径 = 节点按结束（compiler 无感）。
        this.attempts.delete(childId)
        deps.onExhausted(target, failure)
        return next()
      }
      this.attempts.set(childId, { turn: payload.turn, step: payload.step, count })
      const delayMs = SLOW_DELAYS_MS[count - 1] ?? 0
      deps.onRetry(target, count, delayMs, failure)
      // 5. 可取消延迟：turn abort / 插件 dispose 都能秒级打断，不占着瀑布。
      const fused = AbortSignal.any([payload.signal, this.lifetime.signal])
      if (fused.aborted) return undefined
      const completed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          fused.removeEventListener('abort', onAbort)
          resolve(true)
        }, delayMs)
        function onAbort(): void {
          clearTimeout(timer)
          resolve(false)
        }
        fused.addEventListener('abort', onAbort, { once: true })
      })
      if (!completed) return undefined
      // 6. 同 turn 同 step、同一 durable history 原地重跑（官方 request-error 语义）。
      return { kind: 'retry' }
    })
    return () => {
      disposeListener()
      this.lifetime.abort(new Error('dsh-femo api-retry chain disposed'))
      this.attempts.clear()
    }
  }

  /** 显式清某个 child 的失败计数（子代理/main 收尾路径可调用；幂等）。 */
  clearChild(childSessionId: string): void {
    this.attempts.delete(childSessionId)
  }
}

/** 插件级单例：index.ts 装配 install 与 subagent.ts finally 的 clearChild
 *  共用同一实例（模块级常量风格，与 node-retry broker 一致）。 */
export const apiRetry = new ApiRetryChain()
