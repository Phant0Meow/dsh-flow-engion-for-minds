/**
 * node-retry.ts — 停靠经纪人 + 信号翻译（第三类剧本错误，施工清单 v4 §5）。
 *
 * 引擎（femoCompiler/FEMO_errors.py ErrorDispatcher）对剧本错误发两个信号：
 *  - node_retry：执行者的输出未通过剧本校验 → "节点重试"。
 *  - notify_author：通知作者——severity='agent_error'（报错即通知，2026-09-05
 *    猫猫实测修订：与重试并行，不再等用尽——执行者可能"聪明规避"报错，作者
 *    必须第一时间知道）/ 'agent_giveup'（反馈超限收场）/ 'fatal'（致命）。
 * 本模块是 node_retry 的接收端（dsh 侧翻译层）：把"让执行者再试一次"翻译成
 * dsh 的行为——子代理与 main 都是 Agent.steer 原语，human 是投影窗提醒；
 * 三种执行者一个信号一个租约（v4 §5.3 kind 翻译表）。
 *
 * 停靠模型：runAiSubagent 首次交卷后 park（挂起等待裁决）；node_retry 到达
 * 时 deliverRetry 按 parker.kind 分发（subagent/main → resolve(retry) 由停靠
 * 循环消费；human → 直接 steer 显示，人类在引擎自己的人类重等循环里重输）；
 * node_settled 到达时 markSettled 放行收尾。裁决先于 park 到达时暂存
 * pending（持久登记：登记永远早于引擎可能发出的第一个信号，不存在
 * "信号到了没人接"的窗口）。
 *
 * 安全网（v4 §5）：park 带 15min 超时（P4：> API 五段退避 860s、< 引擎
 * wait_for_input 3600s）；flow_paused/flow_error/bridge_run_ended/onExited
 * 时 abortAll 全场放行；deliverRetry 无 parker 时仅 log——不做空回传注入
 * （盲目注入可能误喂 human wait_key 静默跳过一个人类节点，危害大于让引擎
 * 3600s 超时兜底）。
 */

import { safeSteer } from './safe-steer'

/** 一次停靠裁决。retry=让执行者带着反馈再试一次；done=节点审结（ok/gave_up）
 *  或停靠超时兜底收场；aborted=全场暂停/出错/bridge 死亡。 */
export type ParkVerdict =
  | { kind: 'retry'; feedback: string; attempt: number; aiName: string }
  | { kind: 'done' }
  | { kind: 'aborted' }

/** 宿主翻译路由：登记时按事实标注（v4 §5.3）。
 *  - subagent：ai_request 分流 spawn 的子代理，租约=localAgent.steer；
 *  - main：主模型下场在飞注入（Step D 接线），租约=rearmPending+steerMainAgent；
 *  - human：human_wait 等待输入，租约=投影窗提醒（不 park）。
 *  payload.target（'ai'|'human'，compiler 认识的执行者类型）是信号语义字段，
 *  与本路由正交共存——信号对任何 agent 框架同构，dsh 侧路由靠 kind。 */
export type ParkerKind = 'subagent' | 'main' | 'human'

/** 登记规格（register 的入参）。steer 是执行者的"继续跑"租约：调用方闭包
 *  捕获自己的执行通道，broker 只经租约触发，绝不直接触碰执行者。
 *  jobId（Job 模型 §9.3）：清场域化维度——flow_paused/flow_error 只 abort
 *  本 Job 的停靠者，不误杀其他会话在飞演员。parker 键仍为 waitKey：
 *  run_tag 前缀后 wait_key 全局唯一（§5.6），不同 Job 不可能撞键——键控
 *  方案不变，只加过滤维度。 */
export interface ParkerSpec {
  waitKey: string
  nodeName: string
  kind: ParkerKind
  jobId: number
  /** 主会话 id（通知/错误表定位）。 */
  mainSessionId: string
  /** subagent 与 activeSubagents 共用的取消控制器；main/human 可省略。 */
  controller?: AbortController
  steer(text: string): void
}

interface Parker extends ParkerSpec {
  state: 'idle' | 'parked'
  /** 裁决先于 park 到达时暂存，park 立即消费。 */
  pending?: ParkVerdict
  resolve?: (verdict: ParkVerdict) => void
  timer?: NodeJS.Timeout
}

/** 停靠超时（P4）：大于 API 五段退避总时长（~14.4min 首段起算），小于引擎
 *  wait_for_input 的 3600s——超时按 aborted 收场进既有 finally 清理。 */
const PARK_TIMEOUT_MS = 15 * 60_000

/** 重试回合等待上限（v4 §6.2(b) whenIdle race 的 5min 段）：steer 后子代理
 *  新回合的保守收口兜底——正常回合远快于此，超时后按当下事件流片段收场
 *  （空片段防御可观测）。 */
export const RETRY_TURN_TIMEOUT_MS = 5 * 60_000

/** SET VARIABLE 语法教学（B6① 单点化）：femo 剧本语言知识，措辞唯一权威
 * 在此——改教学措辞只改这一处。消费方：RETRY_STEER_TEXT（子代理停靠重试）、
 * main-actor 的重试信与 stageNotice 〖要求〗行。 */
export const SET_VARIABLE_TEACHING = '需要 SET VARIABLE 的节点把赋值按格式写在台词末尾'

/** 三种执行者共用的重试反馈文案（v4 §6 统一文案）。 */
export function RETRY_STEER_TEXT(attempt: number, message: string): string {
  return `[dsh-femo·节点重试] 你上一轮的输出未通过剧本校验（第 ${attempt} 次反馈）：\n${message}\n请基于以上全部过程修正并重新输出本节点台词（${SET_VARIABLE_TEACHING}）。`
}

/**
 * 停靠经纪人（插件级单例，见文件尾导出）。wait_key 键控——wait_key 含引擎
 * 自增 counter（ai_<node>_<n> / human_<node>_<n>），par 并发各分支独立 key
 * 天然隔离（v3 的 node_id 键控互抢额度教训）。
 */
export class NodeRetryBroker {
  private readonly parkers = new Map<string, Parker>()

  /** 持久登记（幂等：同 waitKey 已存在则跳过——首次登记权威，登记时点
   *  永远早于引擎可能发出的第一个 node_retry）。 */
  register(spec: ParkerSpec): void {
    if (this.parkers.has(spec.waitKey)) return
    this.parkers.set(spec.waitKey, { ...spec, state: 'idle' })
  }

  /** 停靠点（仅 subagent/main 调用；human 不 park——引擎在自己的人类重等
   *  循环里等输入）。已暂存裁决 → 立即返回；否则置 parked 并武装 15min 超时。 */
  park(waitKey: string): Promise<ParkVerdict> {
    const p = this.parkers.get(waitKey)
    if (p === undefined) {
      // 理论不可达（register 先于 park）：无登记无处暂存，按 aborted 收场防挂死。
      console.log(`[dsh-femo] park without registration: wait_key=${waitKey}`)
      return Promise.resolve({ kind: 'aborted' })
    }
    if (p.pending !== undefined) {
      const verdict = p.pending
      p.pending = undefined
      return Promise.resolve(verdict)
    }
    return new Promise<ParkVerdict>((resolve) => {
      p.resolve = resolve
      p.state = 'parked'
      p.timer = setTimeout(() => {
        console.log(`[dsh-femo] node-retry park timeout (${Math.round(PARK_TIMEOUT_MS / 60_000)}min): wait_key=${waitKey} node=${p.nodeName}`)
        p.resolve = undefined
        p.state = 'idle'
        p.timer = undefined
        resolve({ kind: 'aborted' })
      }, PARK_TIMEOUT_MS)
    })
  }

  /** node_retry 信号的入口。按 parker.kind 分发：
   *  - human → 租约（投影窗提醒）即翻译：显示到人类输入的地方，引擎在
   *    自己的人类重等循环里等重输，宿主零额外机制；
   *  - subagent/main → parked 则 resolve(retry)，否则暂存 pending。
   *  ⚠️ 对 subagent/main 只 resolve/pending，不代调租约——steer 的调用时机
   *  =停靠循环收到 verdict 之后（漏调=重试永远空转）。 */
  deliverRetry(waitKey: string, feedback: string, attempt: number, aiName: string): void {
    const p = this.parkers.get(waitKey)
    if (p === undefined) {
      console.log(`[dsh-femo] node_retry without parker (dropped; engine 3600s timeout covers): wait_key=${waitKey} attempt=${attempt}`)
      return
    }
    if (p.kind === 'human') {
      // 租约 steer 统一兜底：0.1.5 起 agent.steer 可能抛（inbox 投影未激活），
      // 未捕获会顺着引擎事件回调往上炸——投递失败只记日志，引擎自带 3600s 超时兜底。
      safeSteer(p, feedback, `node_retry human ${waitKey}`)
      return
    }
    const verdict: ParkVerdict = { kind: 'retry', feedback, attempt, aiName }
    if (p.state === 'parked' && p.resolve !== undefined) {
      this.clearTimer(p)
      const resolve = p.resolve
      p.resolve = undefined
      p.state = 'idle'
      resolve(verdict)
    } else {
      p.pending = verdict
    }
  }

  /** 停靠循环统一经租约 steer 的出口（循环体不直接触碰执行者）。 */
  steerLease(waitKey: string, text: string): void {
    const p = this.parkers.get(waitKey)
    if (p === undefined) return
    // 同上：租约可能指向 agent.steer（0.1.5 会抛），兜底后失败只记日志。
    safeSteer(p, text, `lease ${waitKey}`)
  }

  /** node_settled 信号（ai/human 同发）→ resolve(done) + 清 timer（幂等）。
   *  human 不暂存 pending（human 不 park，无消费者）。 */
  markSettled(waitKey: string): void {
    const p = this.parkers.get(waitKey)
    if (p === undefined) return
    this.clearTimer(p)
    if (p.kind === 'human') return
    if (p.state === 'parked' && p.resolve !== undefined) {
      const resolve = p.resolve
      p.resolve = undefined
      p.state = 'idle'
      resolve({ kind: 'done' })
    } else {
      p.pending = { kind: 'done' }
    }
  }

  /** 全场放行（flow_paused/flow_error/bridge_run_ended/onExited）：所有
   *  parker resolve(aborted) 并清空登记（引擎已停，剩余停靠无意义；幂等）。 */
  abortAll(reason: string): void {
    for (const [waitKey, p] of [...this.parkers]) {
      this.clearTimer(p)
      if (p.state === 'parked' && p.resolve !== undefined) {
        const resolve = p.resolve
        p.resolve = undefined
        resolve({ kind: 'aborted' })
      }
      this.parkers.delete(waitKey)
    }
    if (reason.length > 0) console.log(`[dsh-femo] node-retry abortAll: ${reason}`)
  }

  /** Job 域放行（Job 模型 §9.3）：只 abort 本 Job 的 parker——flow_paused/
   *  flow_error 清场用，不误杀其他会话在飞演员（abortAll 保留给 bridge 死亡/
   *  HMR 全场场景）。 */
  abortJob(jobId: number, reason: string): void {
    for (const [waitKey, p] of [...this.parkers]) {
      if (p.jobId !== jobId) continue
      this.clearTimer(p)
      if (p.state === 'parked' && p.resolve !== undefined) {
        const resolve = p.resolve
        p.resolve = undefined
        resolve({ kind: 'aborted' })
      }
      this.parkers.delete(waitKey)
    }
    if (reason.length > 0) console.log(`[dsh-femo] node-retry abortJob(${jobId}): ${reason}`)
  }

  has(waitKey: string): boolean {
    return this.parkers.has(waitKey)
  }

  /** 各方 finally 兜底清登记（幂等防泄漏）。 */
  unregister(waitKey: string): void {
    const p = this.parkers.get(waitKey)
    if (p === undefined) return
    this.clearTimer(p)
    this.parkers.delete(waitKey)
  }

  /** HMR/插件卸载：清全部状态（在飞 timer 一并清）。 */
  dispose(): void {
    this.abortAll('broker disposed')
  }

  private clearTimer(p: Parker): void {
    if (p.timer !== undefined) {
      clearTimeout(p.timer)
      p.timer = undefined
    }
  }
}

/** 插件级单例：subagent.ts（登记/停靠）、engine-events.ts（信号接线）、
 *  index.ts（onExited/dispose）与未来的 main-actor.ts（Step D）共用同一
 *  实例——模块级常量风格，与 activeChildRuns 等现有登记表一致。 */
export const broker = new NodeRetryBroker()
