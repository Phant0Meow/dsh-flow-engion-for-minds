/**
 * engine-events.ts — 演出中的总调度。
 *
 * 引擎运行期间的所有钩子集中在这：
 *  1. agent/pre-step —— 门卫接线（裁决面在 pre-step-gate.ts，纯函数可测）：
 *     运行中不让 plugin 注入把主模型叫醒，但**只在轮首步（step=1）裁决**；
 *     一轮既已开跑（含 flag 置位的 main 节点下场轮、真实用户输入起头的轮），
 *     后继步（工具续跑）一律放行——按步裁决会让主模型只调得动一轮工具
 *     （2026-09-11 修，根因与口径见 pre-step-gate.ts 文件头）。
 *     例外：main 节点下场注入、真实用户输入（主窗口原生聊天，2026-09-05
 *     语义拍板：reject 会把已 claim 的消息整批丢弃且永不落 user/message，
 *     旧逻辑由此静默吞掉运行中主窗消息）；
 *  2. session/event —— 只剩主模型下场轮次捕获（mainSessionEventHook）；
 *     旧输入桥（human 转发/硬停）依赖的 user/message 事件在 pre-step
 *     reject 下从未发生过（死代码），且放行后会错误硬停剧本，已随
 *     2026-09-05 主窗口原生聊天语义删除；human 节点喂入=投影窗通道。
 *  3. 上帝窗实时镜像监听器（由 deps.godMirror 注册，保持原注册顺序）；
 *  4. dsh-femo/event 事件 switch —— 引擎每个事件的状态更新/投影窗提示/
 *     通知主模型/子代理派发。
 * 原 apply() 内联逻辑提为注册函数，依赖经 EngineEventsDeps 显式注入
 * （2026-08-23 重构，行为零变化；监听器注册顺序与原版一致）。
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { FemoBridge } from './bridge'
import type { ResolvedConfig } from './config'
import { sendActorFailure } from './bridge'
import { broadcastSse } from './http'
import { FEMO_PRESET, presetOf, isFemoAgent } from './persona'
import { appendChatProjected, type ProjectionRegistry } from './projection'
import { broadcastCompat, projectedCompat } from './windowing-native'
import { type GodMirror } from './god-mirror'
import { runAiSubagent, abortJobSubagents } from './subagent'
import { runAiSubagentNative } from './subagent-native'
import { isNativeMode } from './windowing-native'
import { pushDiag } from './diag-feed'
import {
  runMainModelTurn, clearMainPlayState, noteMainActor, noteFlowLine,
  isMainAnswerPending, abandonMainAnswer, flushMainFinalDelta, mainSessionEventHook,
  debugLogMainActor, installMainActorStreamBridge,
} from './main-actor'
import { LiveStreamFrames, onAssistantStreamFrames } from './stream-frames'
import { appendFemoSession } from './state-files'
import type { NodeRetryBroker } from './node-retry'
import { projTrace } from './proj-trace' // 【诊断 2026-09-11 临时】导演流埋点
// 门卫裁决面（含演员噪音判定）已抽为纯函数：按「轮」裁决，见该文件头注释。
import { gatePreStep } from './pre-step-gate'

// 【cp 诊断】到达时刻打点（Job 模型：断点已由引擎落盘，此处只剩到达观测）。
const diagTs = (): string => new Date().toISOString().slice(11, 23)

/** 演员子代理流出的「噪音消息」判定已迁 pre-step-gate.ts（门卫裁决面同处）。 */

/** 引擎运行结局直达主模型对话流：以 plugin 来源构造 user 消息并 agent.steer()。
 * dsh 官方语义（dsh-agent）：空闲的主模型立即开新回合收到通知；忙碌时在
 * 下一 step 边界消费——必达、不打断当前回合。取代旧 femo:notify
 * systemPrompt section（布告栏式注入易被模型漏读，2026-08-23 废弃）。
 * 2026-08-24 起导出共用：投影窗输入框「剧本未跑→直达主模型」路由同款通道。 */
export function steerMainAgent(ctx: Context, sessionId: string | SessionId, text: string): void {
  try {
    const sid = String(sessionId)
    const bag = ctx as unknown as {
      agents?: { get(id: string): { steer?: unknown } | undefined }
      get?(name: string): { get(id: string): { steer?: unknown } | undefined } | undefined
    }
    const viaProp = bag.agents?.get(sid)
    const viaSvc = typeof bag.get === 'function' ? bag.get('agents')?.get(sid) : undefined
    const agent = (viaProp ?? viaSvc) as { steer?(message: unknown): void } | undefined
    if (agent === undefined || typeof agent.steer !== 'function') {
      console.log(`[dsh-femo] steer skipped (main agent unavailable): sid=${sid}`)
      return
    }
    agent.steer({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-femo' },
    })
    console.log(`[dsh-femo] steered main agent: sid=${sid} len=${text.length}`)
  } catch (error: unknown) {
    console.log(`[dsh-femo] steer failed: ${String(error)}`)
  }
}

/** Job 镜像（Job 模型，运行状态链路重构 §6.2）：一个 Job 的宿主侧显示面
 *  簿记。状态权威在引擎 runs/<job_id>.json，宿主只是翻译层+索引——镜像
 *  三收敛源（§八.11）：①job_start/job_resume 命令成功回执（prearm，最早
 *  证据）②引擎事件到达（correct/setState 校正）③进程死亡（onExited 清账）。
 *  nodeActors/nodeScopes/nodeShowprompts 随 Job 生灭——同一节点名跨 Job
 *  复用是 A4 串台的一半病根，此处根治。 */
export interface JobMirror {
  jobId: number
  ownerSid: string
  state: 'running' | 'suspended' | 'finished' | 'failed'
  /** 引擎等待人类输入快照（human_wait SET / human_done 清）。全量字段
   *  （上下文/提示/出参）供 /session-state 带回前端——刷新页面后按此恢复
   *  画布人类输入气泡（SSE 重放环可能已把该事件挤出去，这里是权威兜底）。 */
  waitingHuman?: {
    waitKey: string
    nodeName?: string
    context?: string
    memory?: string
    showprompt?: string
    prompt?: string
    outVars?: string[]
    /** 等待节点的投影 scope（引擎 human_wait 事件自带，到达时现场冻结）。
     *  【2026-09-08 角色窗按钮不亮根因】旧实现事后查 nodeScopes 表——该表按
     *  节点名收纳 node_start 的 scope，par 并发（投票/上警的 par 分支共享同名
     *  节点）时同键互相覆盖、最后到达者胜：人类分支不经 LLM 通常最先进入等待，
     *  随后 AI 分支的 node_start 把 scope 覆盖成 AI 的（如 [@上帝,@小机]）→
     *  waitScope 永不含人类演员 → 角色窗按钮恒灰、切窗重挂拉到的仍是坏值
     *  （上帝/戏内窗只看 waiting 布尔不受影响——正是「只有人类角色窗坏」的
     *  症状）。冻结快照免疫并发覆盖。 */
    waitScope?: string[]
  }
  nodeActors: Map<string, string>
  nodeScopes: Map<string, string[]>
  nodeShowprompts: Map<string, string>
  /** 剧本错误台账（从 sid 键控随 Job 走；flow_done/flow_error 时 flush→steer）。 */
  giveups: Array<{ node: string; aiName: string; message: string }>
  /** 剧本警告台账（2026-09-07 warning 桶）：notify_author{severity:'warning'}
   *  累计于此——不进 giveups（警告不是错误，主模型汇总措辞分开），随
   *  Job 在 flow_done/flow_error flush→steer。 */
  warnings: Array<{ node: string; message: string }>
}

/** 引擎运行状态簿记（index.ts 总装创建唯一实例，全插件共享引用）：
 *  jobs=Job 镜像表；sidIndex=sid → 最近 Job（currentJobId 内存镜像，单值够用
 *  ——消费方只关心活跃/最近 Job）；sessionActors/errors/lastEvents 保留 sid 键
 *  （视角菜单重启回退 / 错误面板跨 Job 历史 / SSE 重放——信封带 sid 后前端
 *  自行过滤）。 */
export interface RunState {
  jobs: Map<number, JobMirror>
  sidIndex: Map<string, number>
  /** 引擎活跃 Job（全引擎同时至多一个；引擎排他裁决的镜像）。 */
  activeJobId?: number
  /** Per-session script actors (flow_start) for the view-perspective menu. */
  sessionActors: Map<string, string[]>
  /** Per-session engine errors (meta info for the Femo script panel). */
  errors: Map<string, Array<{ ts: number; text: string }>>
  /** 最近引擎事件缓冲（cap 400）：SSE 新连接重放（信封已带 sid/job_id，
   *  前端自行过滤）。 */
  lastEvents: Array<{ type: string; data: unknown }>
}

/** 重放缓冲写入（2026-09-06 刷新恢复修复）：ai_token/step 高频非状态帧
 *  不入环——旧 100 环被一次长 AI 回复的逐 token 帧冲爆，node_start/
 *  context_ready/human_wait 全被挤出，刷新后画布小气泡尽失、人类输入
 *  快照丢失；checkpoint 环内 replace-in-place 只留最新一条（变量世界
 *  快照不回放堆积旧帧）。cap 提到 400。 */
function rememberEvent(runState: RunState, eventType: string, data: unknown): void {
  if (eventType === 'ai_token' || eventType === 'step') return
  if (eventType === 'checkpoint') {
    const idx = runState.lastEvents.findIndex((e) => e.type === 'checkpoint')
    if (idx >= 0) {
      runState.lastEvents[idx] = { type: eventType, data }
      return
    }
  }
  runState.lastEvents.push({ type: eventType, data })
  if (runState.lastEvents.length > 400) runState.lastEvents.shift()
}

// ── Job 镜像 helper（落本文件不造新组件文件，提案 §七）────────────────────

/** 命令成功回执即调（§八.11：引擎已接受的最早证据）——pre-step 守卫在
 *  flow_start 到达前的秒级窗口不再裸奔。 */
export function jobMirrorPrearm(runState: RunState, jobId: number, ownerSid: string): void {
  runState.jobs.set(jobId, {
    jobId,
    ownerSid,
    state: 'running',
    nodeActors: new Map(),
    nodeScopes: new Map(),
    nodeShowprompts: new Map(),
    giveups: [],
    warnings: [],
  })
  runState.sidIndex.set(ownerSid, jobId)
  runState.activeJobId = jobId
}

/** flow_start 到达校正（幂等）：镜像未登记（理论不可达，防御）则补建。 */
export function jobMirrorCorrect(runState: RunState, jobId: number, ownerSid: string): void {
  const mirror = runState.jobs.get(jobId)
  if (mirror !== undefined) return
  jobMirrorPrearm(runState, jobId, ownerSid)
}

/** 终态/校正统一入口：每次 state 变化伴生 run_state 快照广播（v1 吸收——
 *  前端显示者数据源=快照事件，B7 死于结构：不再有本地兜底覆盖）。 */
export function jobMirrorSetState(runState: RunState, jobId: number, state: JobMirror['state']): void {
  const mirror = runState.jobs.get(jobId)
  if (mirror === undefined) return
  if (mirror.state === state) return
  mirror.state = state
  broadcastSse('run_state', { sid: mirror.ownerSid, job_id: jobId, state })
}

/** running→终态：清活跃指针（镜像本身保留供 /session-state 等消费）。 */
export function jobMirrorClear(runState: RunState, jobId: number): void {
  const mirror = runState.jobs.get(jobId)
  if (mirror === undefined) return
  if (mirror.state === 'running') jobMirrorSetState(runState, jobId, 'suspended')
  if (runState.activeJobId === jobId) runState.activeJobId = undefined
}

/** 本会话绑定的 Job 是引擎活跃 Job？（pre-step 守卫判定源——现状
 *  "running && owner 匹配"的 Job 化等价改写。） */
export function isSessionRunning(runState: RunState, sessionId: string): boolean {
  const jobId = runState.sidIndex.get(sessionId)
  if (jobId === undefined) return false
  const mirror = runState.jobs.get(jobId)
  return mirror !== undefined && mirror.state === 'running' && runState.activeJobId === jobId
}

/** 会话的活跃/最近 Job 镜像（routes/projection-input/tools 消费）。 */
export function activeJobOfSession(runState: RunState, sessionId: string): JobMirror | undefined {
  const jobId = runState.sidIndex.get(sessionId)
  return jobId === undefined ? undefined : runState.jobs.get(jobId)
}

/** 投影窗 composer 按钮状态的权威快照（2026-09-06 猫猫拍板：各投影窗发送/
 * 停止钮与主模型发言状态解耦，按「窗型×剧本态」统一控制）。
 * 语义：running=本会话 Job 是引擎活跃 Job 且 running；waiting=running 且
 * human 节点等输入；waitScope=等待节点 scope 的原始演员名列表（判定哪个
 * 角色窗是人类窗——AI 演员不会出现在 human 节点 scope，天然区分）。 */
export interface ProjectionRunState {
  running: boolean
  waiting: boolean
  waitScope: string[]
  /** 轮到人类节点时的提示全文（composer 内嵌等待横幅的数据源；非等待缺省）。 */
  prompt?: string
}

export function projectionStateOf(runState: RunState, mainSid: string): ProjectionRunState {
  const job = activeJobOfSession(runState, mainSid)
  const running = job !== undefined && job.state === 'running' && runState.activeJobId === job.jobId
  const waiting = running && job.waitingHuman !== undefined
  // waitScope 数据源（2026-09-08 修复）：优先 human_wait 到达时冻结的现场
  // 快照（par 并发覆盖免疫，且引擎侧保证必含执行者本人）；快照缺失（理论
  // 防御：事件未带 scope 的旧形态）才回退 nodeScopes 事后查表。
  const waitScope = waiting
    ? job.waitingHuman?.waitScope
      ?? (job.waitingHuman?.nodeName !== undefined ? job.nodeScopes.get(job.waitingHuman.nodeName) ?? [] : [])
    : []
  return { running, waiting, waitScope, ...(waiting ? { prompt: job.waitingHuman?.prompt } : {}) }
}

/** 快照广播（SSE projection_state，信封 sid=主会话）：waitingHuman 变化与
 * Job 终态/清账时调用——前端 composer 打开时拉 projection-state 接口建基线，
 * 此后按本事件增量覆盖（快照语义无竞态）。 */
export function broadcastProjectionState(runState: RunState, mainSid: string): void {
  broadcastSse('projection_state', { sid: mainSid, ...projectionStateOf(runState, mainSid) })
}

export interface EngineEventsDeps {
  resolved: ResolvedConfig
  bridge: FemoBridge
  runState: RunState
  sessionsStore?: { get(id: SessionId): Session | undefined }
  projections: ProjectionRegistry
  godMirror: GodMirror
  defaultModel?: { currentSelection(): unknown }
  recordError(sessionId: SessionId, text: string): void
  /** 停靠经纪人（v4 §8.1）：node_retry/notify_author/node_settled 三信号的
   *  接收端；human_wait 时登记 human 租约。缺省 no-op+log（可测性）。 */
  broker?: NodeRetryBroker
}

export function registerEngineEventHandlers(ctx: Context, deps: EngineEventsDeps): void {
  const { resolved, bridge, runState, sessionsStore, projections, godMirror, defaultModel, recordError, broker } = deps

  // 1) Femo sessions: idle → main model runs normally (dsh default);
  //    running → reject (the engine owns the conversation), except main-node
  //    injections and real user input (main-window native chat semantics).
  //    【2026-09-11 修】裁决面全部落在轮首步（step=1）：dsh 的 pre-step 每步都
  //    跑，reject = 整个 turn 以 blocked 收场——按步裁决会让轮首步已放行的
  //    回合在工具续跑步被砍掉（主模型只调得动一轮工具）。裁决口径与理由见
  //    pre-step-gate.ts 文件头；这里只做接线（agent 判定 + 两个事实源查询）。
  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision === undefined || signal.aborted) return decision
    if (decision.kind !== 'enter') return decision
    if (!isFemoAgent(agent)) return decision
    const sid = String(agent.session.id)
    return gatePreStep({
      messages: decision.messages,
      step,
      mainAnswerPending: isMainAnswerPending(sid),
      running: isSessionRunning(runState, sid),
      tag: sid,
    })
  })

  // 2) Session event hook: main-actor answer capture only.
  //    【2026-09-05 语义拍板】主窗口回归 dsh 原生聊天——运行中用户消息随放行
  //    的回合自然落盘、主模型原生回答。旧输入桥（human 转发 / main 在飞留
  //    inbox / 硬停）依赖的 user/message 事件在 pre-step reject 时代从未发生
  //    （门卫在 claim 时已把消息丢弃；dsh interception.spec 实证 reject 后
  //    user/message === false），三分支全是死代码；用户批次放行后若保留反而
  //    会错误触发硬停。human 节点的喂入通道=投影窗（projection-input ②）。
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (presetOf(session) !== FEMO_PRESET) return
    if (session.header.parentSession !== undefined) return // subagent sessions
    // 主模型下场轮次捕获（main 节点在飞时缓冲回答事件、turn/end 交卷）。
    mainSessionEventHook(ctx, session, event, bridge, resolved, projections)
  })

  // 3) 实时镜像监听器（原 apply 内联位置：输入桥之后、事件 switch 之前——
  //    保持注册顺序不变）。
  godMirror.registerRealtimeListener(ctx)

  // 3.4)【步3 2026-09-11】主 Agent 轮的开轮锚点**不在这里写**了。
  //      踩坑实录（Job 795/796）：装配器硬规矩「start 必须是该 context 收到的
  //      第一个事件」，而 god-mirror 会把主会话 turn/start 先镜像进上帝窗——锚晚
  //      一步就抛 `received an update before its start Match`、整轮装配失败。
  //      ⚠️ 把钩子"注册在 god-mirror 之前"**不管用**：实测 ctx.on 的执行顺序不
  //      保证等于注册顺序（前移后锚仍晚一位）。顺序只能由同一段代码保证，故锚已
  //      移入 god-mirror 的 mirrorMainEventToGod——写 turn/start 之前先补锚。

  // 3.5) 导演直播（2026-08-25 方案B Step2）：主模型在上帝窗的发言此前要等
  //      assistant/message 整块落地（MIRROR 白名单不含 chunk）。这里把主会话
  //      chunk 旁路广播成 femo_stream（actor='导演'），前端在上帝窗最新一条用
  //      户消息节点下自绘打字机。只对存在投影窗的 Femo 会话生效；纯 SSE 零落
  //      盘，不写事件、不动 MIRROR 白名单与水位。
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (session.header.parentSession !== undefined) return
    const sid0 = String(session.id)
    const windows = projections.get(sid0)
    if (windows?.god === undefined) return
    const actor = '导演'
    // ── 清屏权威信号（2026-08-25 实测修正）：主模型流的块结束 chunk 不可靠
    //    （缺失/形态不定），靠它移除缓冲会残留上一轮内容=原生落地后双份。
    //    改用两个必然发生的权威节点清屏：
    //    ①assistant/message 落地=该轮已由原生接管 → 清空整个导演缓冲；
    //    ②tool/call 落地=原生工具卡出现 → ⚙ 行立即移交（移除最后一个
    //      toolcall 块）。
    if (event.type === 'assistant/message') {
      broadcastSse('femo_stream', { kind: 'end', sid: sid0, node_name: '', actor })
      return
    }
    // 【2026-09-10】主会话回合收口 → 熄灭导演状态行（整 turn 常亮：上面那条
    // assistant/message 只清块不熄状态，多步 react 的工具执行期状态行不闪）。
    if (event.type === 'turn/end') {
      directorLive.get(sid0)?.endTurn()
      return
    }
    if (event.type === 'tool/call') {
      broadcastSse('femo_stream', { kind: 'block_end', sid: sid0, node_name: '', actor, blockKind: 'toolcall' })
      return
    }
    if (event.type !== 'assistant/chunk') return
    const chunk = (event.data as {
      chunk?: { type?: string; index?: number; blockType?: string; text?: unknown; name?: unknown; argumentsDelta?: unknown; block?: { type?: string } }
    }).chunk
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
      broadcastSse('femo_stream', { kind: 'delta', sid: sid0, node_name: '', actor, blockKind: 'text', index: chunk.index, text: chunk.text })
    } else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
      broadcastSse('femo_stream', { kind: 'delta', sid: sid0, node_name: '', actor, blockKind: 'reasoning', index: chunk.index, text: chunk.text })
    } else if (chunk?.type === 'tool-call-delta') {
      // 【2026-08-29 修】按源 chunk index 聚合（GLM 并行工具调用 delta 交错，
      // 按「最后一个同类块」聚合会把多工具参数拼进同一块）。
      const name = typeof chunk.name === 'string' && chunk.name.length > 0 ? chunk.name : undefined
      const argsDelta = typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
      if (name !== undefined || argsDelta.length > 0) {
        broadcastSse('femo_stream', {
          kind: 'delta', sid: sid0, node_name: '', actor, blockKind: 'toolcall', index: chunk.index,
          ...name !== undefined ? { name } : {},
          text: argsDelta,
        })
      }
    } else if (chunk?.type === 'block-start' && (chunk.blockType === 'text' || chunk.blockType === 'reasoning')) {
      broadcastSse('femo_stream', { kind: 'start', sid: sid0, node_name: '', actor, blockKind: chunk.blockType, index: chunk.index })
    } else if (chunk?.type === 'block-end' && (chunk.block?.type === 'text' || chunk.block?.type === 'reasoning' || chunk.block?.type === 'tool-call')) {
      // 【2026-08-29 修】块类型字段是 block.type（llm StreamChunk 定义），旧代码
      // 读 chunk.block?.kind 恒 undefined → 导演路径 block_end 广播全丢。
      broadcastSse('femo_stream', {
        kind: 'block_end', sid: sid0, node_name: '', actor, index: chunk.index,
        blockKind: chunk.block?.type === 'tool-call' ? 'toolcall' : chunk.block?.type,
      })
    }
  })

  // 3.6) 0.1.3 原生流帧桥（2026-09-10）：0.1.3 起模型增量不再是会话事件
  //      （assistant/chunk 已不在 KNOWN_SESSION_EVENT_TYPES，改走 agent 级瞬时
  //      帧 agent/assistant-stream）——上面 3.5 与 main-actor 的 chunk 分支在
  //      原生构建下恒不触发=投影窗失去打字机。这里按同一 femo_stream 词汇转出
  //      原生帧：导演流（上帝窗）与主模型下场（stage/角色窗）各一座桥。两条
  //      chunk 路径与帧桥互斥（旧版无本帧、0.1.3 无 chunk 事件），不重复广播。
  const directorLive = new Map<string, { turn: number | undefined; frames: LiveStreamFrames }>()
  onAssistantStreamFrames(ctx, ({ agent, frame }) => {
    if (frame === undefined) return
    if (agent?.session?.header?.parentSession !== undefined) return // subagent sessions
    const sid0 = String(agent?.session?.id ?? agent?.id ?? '')
    if (sid0.length === 0 || projections.get(sid0)?.god === undefined) return
    // 【步3 2026-09-11】导演流补轮次维度：帧自带主会话原生 turn → 前端按
    // (sid, turn) 入桶，主 Agent 打字机归自己那一轮（旧实现无轮次维度，只能挂
    // "最新锚点"，于是插在演员块中间）。turn 变了换新直播位——一轮一个位。
    const turn = typeof frame.turn === 'number' ? frame.turn : undefined
    let live = directorLive.get(sid0)
    if (live === undefined || (turn !== undefined && live.turn !== turn)) {
      live = {
        turn,
        frames: new LiveStreamFrames({
          sid: sid0, node_name: '', actor: '导演',
          ...(turn !== undefined ? { turn } : {}),
        }),
      }
      directorLive.set(sid0, live)
      projTrace('frame', `建立导演直播位 turn=${turn === undefined ? '无' : String(turn).slice(-4)} sid=${sid0.slice(-8)}`)
    }
    projTrace('frame', `导演流收帧 type=${frame.type ?? '-'}（sid=${sid0.slice(-8)}，turn=${turn === undefined ? '无' : String(turn).slice(-4)}）`)
    live.frame(frame)
  })
  installMainActorStreamBridge(ctx)

  // 4) Event bridge: engine events -> chat messages on the run's session.
  //    【Job 模型 §6.2】入口解信封：事件自带 job_id（bridge make_event_callback
  //    注入），按 mirror 反查归属会话——A4 死于结构（事件认 Job，跨会话不串台）。
  ctx.on('dsh-femo/event', (eventType: string, data: unknown) => {
    if (eventType === 'flow_start') console.log(`[dsh-femo][diag] flow_start event received; activeJobId=${String(runState.activeJobId ?? '-')}`)
    const d0 = (data ?? {}) as Record<string, unknown>
    const jobId = typeof d0.job_id === 'number' ? d0.job_id : undefined
    const mirror = jobId !== undefined ? runState.jobs.get(jobId) : undefined
    if (jobId === undefined || mirror === undefined) {
      // 防御（§6.2.1）：jobId 缺失或 mirror 未登记 → log + 仅透传 broadcast +
      // return。重启后 bridge 新进程不会为旧 suspended Job 发事件，此路理论
      // 不可达；真到达也绝不路由到错误会话。
      // 【诊断 2026-09-06】此早退=human_wait 无法 SET waitingHuman 的候选断点
      // 之一（事件到了宿主但找不到归属 mirror）——落诊断流可观测。
      pushDiag('ev-in', `${eventType} DROPPED(no-mirror) job=${String(d0.job_id ?? '-')}`)
      if (eventType === 'flow_start') console.log('[dsh-femo][diag] flow_start without mirror: broadcast only')
      console.log(`[dsh-femo] event ${eventType} without mirror (job_id=${String(d0.job_id ?? '-')}); broadcast only`)
      broadcastSse(eventType, data)
      rememberEvent(runState, eventType, data)
      return
    }
    const sessionId = SessionId(mirror.ownerSid)
    // broadcastSse 载荷统一包信封（A4 前端过滤地基）；checkpoint 广播前裁掉
    // state 字段（D5 半个——前端只需位置+label，整包变量世界不再全量广播）。
    const envelope: Record<string, unknown> = { ...d0, sid: mirror.ownerSid, job_id: jobId }
    const broadcastPayload = eventType === 'checkpoint'
      ? (() => { const { state: _varsState, ...rest } = envelope; return rest })()
      : envelope
    broadcastSse(eventType, broadcastPayload)
    // 事件缓冲：SSE 新连接（运行中打开编辑器标签）先重放已发生的事件。
    rememberEvent(runState, eventType, broadcastPayload)
    const session = sessionsStore?.get(sessionId)
    if (session === undefined) {
      // [femo-diag] 此早退在 broadcastSse 之后：帧已发给前端，但 mem 不更新。
      // 【诊断 2026-09-06】同样=human_wait SET 不上的候选断点（session 不在
      // store）——此前除 flow_start 外完全静默。
      pushDiag('ev-in', `${eventType} DROPPED(no-session) job=${jobId} sid=${String(sessionId)}`)
      if (eventType === 'flow_start') console.log(`[dsh-femo][diag] flow_start broadcast done but DROPPED before sessionActors.set: session ${String(sessionId)} not in store`)
      return
    }
    // 【诊断 2026-09-06】事件通过全部早退=即将进入 switch（对照 bridge 层的
    // event 记录：两处都有=分发链完整；bridge 有此处无=在这两段之间丢失）。
    if (eventType === 'human_wait' || eventType === 'human_done') {
      pushDiag('ev-in', `${eventType} dispatched job=${jobId} wait_key=${String(d0.wait_key ?? '-')}`)
    }
    const d = d0
    switch (eventType) {
      case 'flow_start': {
        // Script actors feed the view-perspective menu + projection windows.
        const actors = Array.isArray(d.actors)
          ? d.actors.filter((x): x is string => typeof x === 'string')
          : []
        runState.sessionActors.set(String(sessionId), actors)
        // 主模型下场状态清场 + 记剧本名 + 登记 main 演员静态名单（编译期声明）。
        clearMainPlayState(
          String(sessionId),
          typeof d.name === 'string' ? d.name : '',
          Array.isArray(d.main_actors) ? d.main_actors.filter((x): x is string => typeof x === 'string') : [],
        )
        console.log(`[dsh-femo][diag] flow_start processed: sessionActors[${String(sessionId)}]=${JSON.stringify(actors)} (femoSession=${String(d.session_id)})`)
        // flow_start 到达校正（§6.2.3，幂等）：prearm 已登记则零操作。
        jobMirrorCorrect(runState, jobId, String(sessionId))
        // 引擎场次身份入账本：dsh 会话 ↔ femo 场次一对多（末位=当前场次）。
        if (typeof d.session_id === 'number') {
          void appendFemoSession(resolved.femoRoot, String(sessionId), d.session_id)
            .catch((error: unknown) => console.log(`[dsh-femo] femoSessions append failed: ${String(error)}`))
        }
        // 上帝窗无条件创建（actors 为空的剧本也要有引擎通知的落点）；
        // 角色窗按剧本角色。幂等创建/复用/冷唤醒；异步，失败仅打日志。
        // 【cwd 守卫】与 routes.ts projection-windows 同款：主会话 cwd 缺失时
        // 不建窗——cwd 绝不能落到 process.cwd()，否则投影窗建进宿主启动目录
        // 分组 → duplicate session id 整树拒绝加载（2026-08-23 事故定案原则：
        // 分组键绝不允许环境兜底）。同会话 header.cwd 要么一直有要么一直无，
        // 守卫跳过不会误伤"registry 已有窗"的复用场景。
        const header = session.header as { cwd?: string } | undefined
        debugLogMainActor(resolved, `[宿主] flow_start 建窗检查: cwd=${header?.cwd ?? '无'} actors=${JSON.stringify(actors)}`)
        if (header?.cwd === undefined || header.cwd.length === 0) {
          console.log(`[dsh-femo] flow_start ${String(sessionId)}: session cwd missing — projection windows NOT ensured (process.cwd() fallback forbidden)`)
          break
        }
        // 【2026-09-09 晚改版】新旧版行为归一：god/stage/角色投影窗全建。
        // 0.1.3 原生版同样恢复 femo-proj 角色窗——角色内容由 subagent-native
        // 把常驻执行体子代理的镜像事件按 scope 投进来（子代理窗只是执行体，
        // 显示面回归 femo 自绘投影窗；femo-actor 子代理在目录里重新 ban）。
        void projections.ensure(String(sessionId), actors, header.cwd).then(() => {
          debugLogMainActor(resolved, `[宿主] flow_start ensure 完成: ${JSON.stringify(actors)}`)
        }).catch((error: unknown) => {
          debugLogMainActor(resolved, `!! flow_start ensure 失败: ${error instanceof Error ? error.message : String(error)}`)
          console.log(`[dsh-femo] flow_start ensure projection windows failed: ${String(error)}`)
        })
        // 补齐上帝窗缺失的主会话对话（重启缝隙：registry 是内存态，
        // 重启后到本次运行前的主模型对话按水位一次性补写）。
        void godMirror.ensureGodMirrorUpToDate(String(sessionId))
        break
      }
      case 'node_start': {
        // Node hint as a chat announcement: human nodes show their prompt
        // (the user needs it); AI node hints ride context_ready's showprompt.
        // Remember the node's visible actor list for later role lines.
        const nodeName = typeof d.node_name === 'string' ? d.node_name : undefined
        const scopeInfo = Array.isArray(d.scope)
          ? d.scope.filter((x): x is string => typeof x === 'string')
          : undefined
        if (nodeName !== undefined && scopeInfo !== undefined) {
          mirror.nodeScopes.set(nodeName, scopeInfo)
        }
        const nodeType = d.node_type
        if (nodeType === 'human') {
          const prompt = typeof d.prompt === 'string' && d.prompt.trim().length > 0 ? d.prompt : undefined
          if (prompt !== undefined) {
            appendChatProjected(ctx, session, projections, `📢 ${prompt}`, 'prompt', undefined, nodeName === undefined ? undefined : mirror.nodeScopes.get(nodeName))
          }
        } else if (nodeType === 'notice') {
          // 【2026-09-12】@notice 公告节点（引擎 _exec_notice：只注入一条
          // prompt 进 dialog，无 LLM 无回答）。此前这里不认 notice ⇒ 三扇投影
          // 窗都不显示。按激活顺序即时落一条 📢 行（prompt 舞台提示条，与
          // human 节点提示同款渲染；事件 scope 引擎已置空=全员可见）。
          // 已知边界：par 下若先激活的 AI 轮尚未由闸门收口，本行会落在它前面
          // （行不进闸门）——顺序严格化的改造待真实剧本需要时再做。
          const prompt = typeof d.prompt === 'string' && d.prompt.trim().length > 0 ? d.prompt : undefined
          if (prompt !== undefined) {
            appendChatProjected(ctx, session, projections, `📢 ${prompt}`, 'prompt', undefined, nodeName === undefined ? undefined : mirror.nodeScopes.get(nodeName))
          }
        }
        break
      }
      case 'context_ready': {
        // Remember the character name for this engine node (ai_done only
        // carries the node id), and announce the AI node's showprompt.
        const nodeName = typeof d.node_name === 'string' ? d.node_name : undefined
        const aiName = typeof d.ai_name === 'string' && d.ai_name.length > 0 ? d.ai_name : undefined
        if (nodeName !== undefined && aiName !== undefined) {
          mirror.nodeActors.set(nodeName, aiName)
        }
        // 【V6.2】showprompt 不再此处立即落盘，改暂存 nodeShowprompts（渲染
        // 位由 femo-turn-head 决定，见 JobMirror 注释）。仅当引擎没带 node_name
        // （理论不可达，映射键缺失）时保留旧立即落盘路径，零信息丢失。
        const showprompt = typeof d.showprompt === 'string' && d.showprompt.trim().length > 0 ? d.showprompt : undefined
        if (showprompt !== undefined) {
          if (nodeName !== undefined) {
            mirror.nodeShowprompts.set(nodeName, showprompt)
          } else {
            appendChatProjected(ctx, session, projections, `📢 ${showprompt}`, 'prompt', undefined, nodeName === undefined ? undefined : mirror.nodeScopes.get(nodeName))
          }
        }
        break
      }
      case 'ai_retry': {
        // 赋值失败重试：把拒绝原因显示出来（此前静默——用户视角是
        // "AI 输出了赋值但系统没识别"，实际是引擎拒绝了非法赋值）。
        const errors = Array.isArray(d.errors) ? d.errors.map(String) : []
        const attempt = typeof d.attempt === 'number' ? d.attempt : 0
        const nodeName = typeof d.node_name === 'string' ? d.node_name : undefined
        if (errors.length > 0) {
          appendChatProjected(ctx, session, projections, `⚠️ ${errors[0]}（第 ${attempt} 次重试）`, 'notice',
            undefined, nodeName === undefined ? undefined : mirror.nodeScopes.get(nodeName))
        }
        break
      }
      case 'human_wait': {
        // 【诊断 2026-09-06】上帝窗人类发言 kept local（waiting=false）排查：
        // 此前本 case 零日志——信号是否到达宿主、登记是否发生完全不可观测。
        // 到达日志（引擎发信号→宿主 case 执行的实证）+登记后快照。
        console.log(`[dsh-femo] human_wait received: job=${jobId} node=${String(d.node_name ?? '-')} wait_key=${String(d.wait_key ?? '-')} -> waitingHuman SET`)
        pushDiag('human_wait', `SET job=${jobId} node=${String(d.node_name ?? '-')} wait_key=${String(d.wait_key ?? '-')}`)
        // 写本 mirror 的 waitingHuman（B6：suspended 转移强制清——
        // jobMirrorSetState 不清 waitingHuman，此处终态 case 统一清）。
        // 2026-09-06 起带全量字段：/session-state 据此给刷新后的画布恢复
        // 人类输入气泡（不依赖 SSE 重放环是否还被覆盖）。
        // 【2026-09-08 修复】scope 现场冻结：human_wait 事件自带本分支现场算
        // 出的 scope（引擎 _exec_human 发事件前刚求值，且保证含执行者本人），
        // 存入等待快照作按钮/等待行的权威源——不再事后查 nodeScopes（par 并发
        // 下同名节点互相覆盖，人类分支的 scope 会被 AI 分支冲掉）。
        const waitScope: string[] | undefined = Array.isArray(d.scope)
          ? d.scope.filter((x): x is string => typeof x === 'string')
          : undefined
        mirror.waitingHuman = {
          waitKey: String(d.wait_key ?? ''),
          nodeName: typeof d.node_name === 'string' ? d.node_name : undefined,
          context: typeof d.context === 'string' ? d.context : '',
          memory: typeof d.memory === 'string' ? d.memory : '',
          showprompt: typeof d.showprompt === 'string' ? d.showprompt : undefined,
          prompt: typeof d.prompt === 'string' ? d.prompt : '',
          outVars: Array.isArray(d.out_vars)
            ? d.out_vars.filter((x): x is string => typeof x === 'string')
            : [],
          waitScope,
        }
        // 快照广播必须在 SET 之后——先广播会把 waiting=false 发给前端
        // （composer 按钮不亮，切窗重挂 fetch 才纠正，2026-09-06 实测）。
        broadcastProjectionState(runState, String(sessionId))
        // prompt 全文显示（2026-09-06 猫猫拍板：提示信息有多长放多长，
        // 不截断；引擎侧 human_wait 事件本就带全文）。
        const prompt = typeof d.prompt === 'string' ? d.prompt : ''
        const nodeName = typeof d.node_name === 'string' ? d.node_name : undefined
        // 等待行可见性与按钮同源（冻结快照优先；缺快照回退查表）。
        const waitLineScope = waitScope ?? (nodeName === undefined ? undefined : mirror.nodeScopes.get(nodeName))
        appendChatProjected(ctx, session, projections, prompt.length > 0 ? `🎭 等待你的回应：${prompt}` : '🎭 等待你的回应', 'human_wait',
          undefined, waitLineScope)
        // human 租约登记（v4 §8.1/§5.3）：node_retry(target='human') 的提醒
        // 经此租约显示到投影窗——人类输入的地方就在那里，显示即翻译（引擎在
        // 自己的人类重等循环里等重输，宿主零额外机制）。scope 取 node_start
        // 已存的 nodeScopes（v4 §8.5）。引擎重等输入不重发 human_wait，本
        // register 恰好一次（幂等再保险）。登记带 job_id（§9.3 ParkerSpec）。
        broker?.register({
          waitKey: String(d.wait_key ?? ''),
          nodeName: nodeName ?? '',
          kind: 'human',
          jobId,
          mainSessionId: String(sessionId),
          steer: (text) => appendChatProjected(ctx, session, projections, `⚠️ ${text}`, 'notice',
            undefined, waitLineScope),
        })
        break
      }
      case 'human_done': {
        // 【诊断 2026-09-06】waitingHuman 清空的三大触发点之一——到达即留痕。
        console.log(`[dsh-femo] human_done received: job=${jobId} -> waitingHuman CLEARED`)
        pushDiag('human_done', `CLEARED job=${jobId} (输入被引擎消费：正常输入/空输入超时放行均走此信号)`)
        mirror.waitingHuman = undefined
        broadcastProjectionState(runState, String(sessionId))
        break
      }
      case 'checkpoint': {
        // 断点已由引擎落盘（Job 模型 §6.2.4）：runs/<job_id>.json 经
        // JobManager.merge_checkpoint 原子写（A3/C5 死于结构）——宿主不再
        // 持久化 resume 块。保留到达观测日志。
        const cp = (d.checkpoints ?? {}) as Record<string, string>
        console.log(`[femo-cp-diag ${diagTs()}] checkpoint ARRIVE sid=${String(sessionId)} job=${jobId} cps=${JSON.stringify(cp)} femoSession=${String(d.session_id ?? '-')} 断点已由引擎落盘`)
        break
      }
      case 'ai_done': {
        // dsh 后端模式：回答已由子代理事件镜像（原生 assistant 节点）显示，
        // 这里不再自绘 role 行；llmBridge 直连模式无镜像，role 行是主会话
        // 唯一显示面（alsoMainSession=true 双写）。
        // main 可见流水记账（主模型下场）：该节点 scope 含 main 演员时入流水。
        {
          const doneNode = typeof d.node_name === 'string' ? d.node_name : undefined
          const doneOutput = typeof d.output === 'string' ? d.output : ''
          if (doneNode !== undefined) {
            const doneActor = mirror.nodeActors.get(doneNode) ?? doneNode
            const doneScopes = mirror.nodeScopes.get(doneNode)
            const size = noteFlowLine(String(sessionId), doneActor, doneOutput, doneScopes)
            debugLogMainActor(resolved, `[宿主] ai_done 记账: node=${doneNode} actor=${doneActor} out=${doneOutput.length}ch scopes=${JSON.stringify(doneScopes ?? null)} → 流水=${size}`)
          }
        }
        if (resolved.hostAiBackend) break
        const output = typeof d.output === 'string' && d.output.length > 0 ? d.output : undefined
        if (output !== undefined) {
          const nodeName = typeof d.node_name === 'string' ? d.node_name : undefined
          const actor = nodeName === undefined ? undefined : mirror.nodeActors.get(nodeName) ?? nodeName
          projectedCompat(ctx, session, projections, output, 'role', actor, nodeName === undefined ? undefined : mirror.nodeScopes.get(nodeName), true)
        }
        break
      }
      case 'ai_request': {
        // M5: engine wants an AI turn executed by a dsh subagent. Spawn a
        // fresh child (zero parent context), wait for it to finish, assemble
        // the full trajectory (cot only on tool-call turns, matching dsh's
        // passback rule), then deliver { output, trajectory } back to the
        // engine, which stores the trajectory as one long text.
        const reqNode = typeof d.node_name === 'string' ? d.node_name : undefined
        const reqScope = Array.isArray(d.scope_info)
          ? d.scope_info.filter((x): x is string => typeof x === 'string')
          : undefined
        if (reqNode !== undefined && reqScope !== undefined) {
          mirror.nodeScopes.set(reqNode, reqScope)
        }
        console.log(`[dsh-femo] ai_request received node=${String(d.node_name ?? '')} wait_key=${String(d.wait_key ?? '')} job=${jobId}`)
        if (String(d.source ?? '') === 'main') {
          // 主模型下场（主窗口回答制）：不拉子代理——增量剧内上下文+节点提醒
          // steer 进主窗口，主模型在主窗口回答，捕获该轮经 human_input 交卷。
          // 【2026-09-11】交付过"等本轮收口"队列：主模型正在跟用户说话（有轮
          // 在飞）时不插进那一轮，等它结束再作为新一轮开场（main-delivery-queue
          // 与 main-actor.deliverMain；戏内戏外不掺一轮）。
          noteMainActor(String(sessionId), typeof d.ai_name === 'string' ? d.ai_name : '')
          void runMainModelTurn(ctx, resolved, bridge, session, d, recordError, projections, mirror.nodeScopes, mirror.nodeShowprompts, jobId).catch((error: unknown) => {
            recordError(session.id, `主模型下场注入失败：${String(error)}`)
            void sendActorFailure(bridge, jobId, String(d.wait_key ?? ''), 'main_executor_error', String(error)).catch(() => undefined)
          })
          break
        }
        // 【版本分流 2026-09-09】0.1.3 原生：同 actor 复用同一常驻子代理
        // （startContinuable/sendMessage），子代理窗口=角色视角投影窗，不隐藏
        // 不归档；one-shot 每节点新子代理的旧路径只在 meow fork（旧版）执行。
        if (isNativeMode()) {
          void runAiSubagentNative(ctx, resolved, bridge, session, d, recordError, defaultModel, mirror.nodeActors, projections, mirror.nodeShowprompts, jobId).catch((error: unknown) => {
            recordError(session.id, `子 agent 执行失败：${String(error)}`)
            void sendActorFailure(bridge, jobId, String(d.wait_key ?? ''), 'dispatch_error', String(error)).catch(() => undefined)
          })
          break
        }
        void runAiSubagent(ctx, resolved, bridge, session, d, recordError, defaultModel, mirror.nodeActors, projections, mirror.nodeShowprompts, jobId).catch((error: unknown) => {
          recordError(session.id, `子 agent 执行失败：${String(error)}`)
          void sendActorFailure(bridge, jobId, String(d.wait_key ?? ''), 'dispatch_error', String(error)).catch(() => undefined)
        })
        break
      }
      case 'flow_done': {
        console.log(`[femo-cp-diag ${diagTs()}] flow_done ARRIVE sid=${String(sessionId)} job=${jobId} → Job finished（断点作废由引擎 finalize 承担）`)
        jobMirrorSetState(runState, jobId, 'finished')
        broadcastProjectionState(runState, String(sessionId))
        if (runState.activeJobId === jobId) runState.activeJobId = undefined
        // 结局通知全窗广播（主会话+god+角色窗统一可见，2026-08-23 通知统一改造）。
        broadcastCompat(ctx, session, projections, '✅ 剧本已跑完')
        // 主模型下场：剧终补遗——把剩余未注入的 main 可见发言补进主窗口
        // （有则发；main 的台词天然在主窗口历史里，无需日记）。
        flushMainFinalDelta(ctx, sessionId, resolved)
        // giveups/warnings 的汇总与清空**不在此处**（2026-09-10 猫猫拍板）：
        // 跑完通知的 steer 已挪到 bridge_run_ended（整场真正终止）再发——
        // 这里把数据原样留给那边组装。理由：flow_done 是"引擎逻辑完成"这个
        // 过早的窗口，此刻演员子代理的 settled 通知还在飞，steer 会以
        // next-step 投递、被 settled 通知开的空 turn 吃掉而滞留（Job 761 实证：
        // 通知拖到用户下一条消息才随新 turn 的 step1 送达，主模型不醒来）。
        break
      }
      case 'flow_error': {
        // 【Job 域清场（§6.2.8，§八.4 域化）】只掐本 Job 的在飞演员——
        // 全场 abortActiveSubagents 会误杀 B 会话在飞演员（B 的 subagent
        // catch 走空回传 → B 引擎拿空 output 继续演 = A 的停止污染 B 的戏）。
        const abortedOnError = abortJobSubagents(jobId, '剧本出错：中断在飞 AI 演员')
        if (abortedOnError > 0) console.log(`[dsh-femo] flow_error: aborted ${abortedOnError} in-flight subagent(s) of job ${jobId}`)
        abandonMainAnswer(String(sessionId), '剧本出错，在飞注入作废', projections)
        // 本 Job 的停靠者立即放行（aborted verdict → 既有 finally 清理）。
        broker?.abortJob(jobId, 'flow error')
        jobMirrorSetState(runState, jobId, 'failed')
        broadcastProjectionState(runState, String(sessionId))
        if (runState.activeJobId === jobId) runState.activeJobId = undefined
        const text = `剧本出错：${String(d.error ?? 'unknown error')}`
        recordError(session.id, text)
        // 报错通知全窗广播（含主会话；❌ 前缀补足原 error 红行的警示性）。
        broadcastCompat(ctx, session, projections, `❌ ${text}`)
        // giveups 残留随错误 steer 一并汇总 → 清空（标题中性，同 flow_done）。
        const errorGiveups = mirror.giveups
        mirror.giveups = []
        const errorSuffix = errorGiveups.length > 0
          ? `\n\n⚠️ 另有出现过剧本错误的节点：\n- ${errorGiveups.map(g => g.message).join('\n- ')}`
          : ''
        // 警告残留同 flow_done 清空（措辞分开，同前）。
        const errorWarnings = mirror.warnings
        mirror.warnings = []
        const errorWarnSuffix = errorWarnings.length > 0
          ? `\n\nℹ️ 另有警告（不阻断，供修剧本参考）：\n- ${errorWarnings.map(w => w.message).join('\n- ')}`
          : ''
        // 通知主模型（对话流直达，必达）：报错详情供据此迭代修剧本。
        steerMainAgent(ctx, sessionId, `[dsh-femo] 剧本运行结果：❌ 运行出错。错误信息：${String(d.error ?? 'unknown error')}——可修复剧本后再 fresh_start。${errorSuffix}${errorWarnSuffix}`)
        break
      }
      case 'flow_stopped': {
        // 【Job 域清场】同 flow_error（§6.2.9）。
        const abortedOnStop = abortJobSubagents(jobId, '剧本停止：中断在飞 AI 演员')
        if (abortedOnStop > 0) console.log(`[dsh-femo] flow_stopped: aborted ${abortedOnStop} in-flight subagent(s) of job ${jobId}`)
        abandonMainAnswer(String(sessionId), '剧本停止，在飞注入作废', projections)
        // 本 Job 停靠者立即放行。
        broker?.abortJob(jobId, 'flow stopped')
        // 挂起（可续跑）：断点保留在引擎 runs 档案；pausedByUser 判定删除——
        // pause 语义退役，停止=挂起（可续跑），文案恒定。
        jobMirrorSetState(runState, jobId, 'suspended')
        mirror.waitingHuman = undefined
        pushDiag('flow_stopped', `suspended + waitingHuman CLEARED job=${jobId}`)
        broadcastProjectionState(runState, String(sessionId))
        if (runState.activeJobId === jobId) runState.activeJobId = undefined
        // 全窗广播：工具与前端按钮触发的停止都由此统一通知所有窗口
        // （femo-run 工具侧已不再重复写）。
        broadcastCompat(ctx, session, projections, '⏹ 剧本已停止（可续跑）')
        // 通知主模型（对话流直达，必达）：前端按钮停止时没有工具回执，
        // steer 是主模型知情的唯一通道（2026-09-06 猫猫实测：手动停止后主模型
        // 零通知）。时序在 suspended 落定+activeJobId 清空之后，isSessionRunning
        // 已为 false，不被 pre-step 门卫吞——与 flow_done/flow_error 同时序。
        steerMainAgent(ctx, sessionId, '[dsh-femo] 剧本运行结果：⏹ 已停止（挂起，断点保留）。可用 resume 续跑或 fresh_start 重跑。')
        break
      }
      case 'bridge_run_ended': {
        // mirror 复位（§6.2.10）：state 校正 + humanWait 清 + 本 Job 停靠者放行。
        broker?.abortJob(jobId, 'bridge run ended')
        mirror.waitingHuman = undefined
        pushDiag('bridge_run_ended', `waitingHuman CLEARED job=${jobId} ok=${String(d.ok ?? '-')}`)
        if (mirror.state === 'running') {
          // worker 收尾了但没等到终态事件（理论不可达，防御）：按引擎侧
          // finalize 兜底语义校正为 failed（get_job_state 可查证）。
          jobMirrorSetState(runState, jobId, 'failed')
        }
        if (runState.activeJobId === jobId) runState.activeJobId = undefined
        // 【跑完通知的 steer 落点（2026-09-10 猫猫拍板）】改由整场运行终止信号
        // 发——bridge_run_ended 由 worker 在 runner.run() 返回后 emit
        // （femo_bridge.py:261），必然晚于 flow_done；此刻引擎与全部演员子代理
        // 均已收工，不会再冒出 settled 通知开的空 turn 把通知吃掉（Job 761 实证）。
        //
        // 判定必须用 mirror.state === 'finished'（flow_done 真的来过），
        // **不可只看 d.ok**：停止/取消路径 run() 也正常返回、ok 同样是 true
        // （femo_bridge.py:261；Job 762/763 按停实测 bridge_run_ended ok=true），
        // 无条件发会把"按停"误报成"✅ 跑完"（复刻 1020 局僵尸通知）。
        // 失败/停止路径的通知各由 flow_error / flow_stopped 承担，此处不重复发。
        if (mirror.state === 'finished') {
          // giveups 汇总（v4 §8.3 门卫坑）：随 Job 走的 giveups 在此 flush→steer。
          // 标题中性——条目混有"报错后重试成功"（agent_error）与"超限跳过"
          // （agent_giveup），状态由每条 message 自带的尾巴区分。
          const doneGiveups = mirror.giveups
          mirror.giveups = []
          const doneSuffix = doneGiveups.length > 0
            ? `\n\n⚠️ 以下节点出现过剧本错误：\n- ${doneGiveups.map(g => g.message).join('\n- ')}\n完整清单见错误面板。`
            : ''
          // 警告汇总（2026-09-07 warning 桶）：与错误分开措辞——警告没拒绝
          // 任何东西、运行已完整跑完，主模型只需知情不必当错误处理。
          const doneWarnings = mirror.warnings
          mirror.warnings = []
          const doneWarnSuffix = doneWarnings.length > 0
            ? `\n\nℹ️ 以下警告出现过（不阻断，供修剧本参考）：\n- ${doneWarnings.map(w => w.message).join('\n- ')}`
            : ''
          // 通知主模型（对话流直达，必达）：Job 已完整跑完（终态不可续跑，
          // 断点字段已由引擎 finalize 作废）。
          steerMainAgent(ctx, sessionId, `[dsh-femo] 剧本运行结果：✅ Job ${jobId} 已完整跑完。若要重跑请用 fresh_start（不能 resume 续跑）。${doneSuffix}${doneWarnSuffix}`)
        }
        break
      }
      case 'node_retry': {
        // 行为信号（v4 §8.1）：交停靠经纪人按 parker.kind 分发租约——
        // subagent/main=steer（停靠循环消费后 steer），human=投影窗提醒。
        // 显示不在此投影：ai 节点由既有 ai_retry 承担（防双份），human 由
        // 租约的提醒行承担（v4 §5.2）。
        if (broker === undefined) {
          console.log(`[dsh-femo] node_retry received but broker not wired: wait_key=${String(d.wait_key ?? '')}`)
          break
        }
        broker.deliverRetry(String(d.wait_key ?? ''), String(d.feedback ?? ''),
          Number(d.attempt ?? 1), String(d.ai_name ?? ''))
        break
      }
      case 'notify_author': {
        const severity = String(d.severity ?? '')
        const message = String(d.message ?? '')
        if (severity === 'fatal') {
          // fatal：仅 log——实际作者投递由紧随的 flow_error 三通道承担（引擎
          // dispatch FATAL 后必 raise → worker flow_error，防双份，v4 §3.3/§8.1）。
          console.log(`[dsh-femo] notify_author(fatal) node=${String(d.node_name ?? '')}: ${message}`)
          break
        }
        if (severity === 'warning') {
          // 警告桶（2026-09-07 warning 桶）：引擎没拒绝任何东西、运行照常——
          // 只做知情：①错误面板留痕 ②聊天窗广播。不进 giveups（警告不是
          // 错误），改累计 warnings 随 flow_done/flow_error 分开措辞汇总 steer。
          recordError(session.id, message)
          broadcastCompat(ctx, session, projections, `ℹ️ ${message}`)
          mirror.warnings.push({ node: String(d.node_name ?? ''), message })
          break
        }
        // agent_error（报错即通知作者，2026-09-05 猫猫实测修订：不再等重试用尽
        // ——执行者可能"聪明规避"报错，作者必须第一时间知道）与 agent_giveup
        // （超限收场）同走三通道：①错误面板 ②聊天窗 ③giveups 累计——主模型
        // 通知走 flow_done/flow_error 汇总 steer（运行中直接 steer 必被
        // pre-step 门卫吞掉，门卫坑 v4 §8.3）。parker 解除由 node_settled 承担
        // （payload 无 wait_key；引擎超限路径 break→落盘→node_settled 确定性）。
        recordError(session.id, message)
        broadcastCompat(ctx, session, projections, `⚠️ ${message}`)
        // giveups 随 Job 走（§6.2：从 sid 键控改 mirror 内数组；flow_done/
        // flow_error 时 flush→steer）。
        mirror.giveups.push({ node: String(d.node_name ?? ''), aiName: String(d.ai_name ?? ''), message })
        break
      }
      case 'node_settled': {
        // 节点审结（ok/gave_up）：解除对应 parker（ai/human 同发，wait_key
        // 键控 par 分支隔离）。
        broker?.markSettled(String(d.wait_key ?? ''))
        break
      }
      default:
        break
    }
  })
}
