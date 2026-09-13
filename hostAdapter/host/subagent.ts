/**
 * subagent.ts — AI 演员经纪人。
 *
 * 引擎 ai_request → 开一个 dsh 子代理演这个节点：组装 prompt（blocks：soul/
 * context/memory/prompt）、解析模型来源（跟随主模型或剧本 source 声明）、
 * 应用工具面过滤、空闲看门狗、事件镜像（子代理 turn 重映射 100001+ 并合成
 * turn/start / step/start，dsh 原生 assistant 节点渲染思考折叠/工具卡片/回答，
 * 上帝窗全量 + 角色窗按 scope 命中）、结果 trajectory 回传引擎、归档并移出
 * 子代理会话目录。从 index.ts 原样迁出（2026-08-23 重构）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { FemoBridge } from './bridge'
import type { ResolvedConfig } from './config'
import { buildTranscript, type TranscriptStep } from './engine-transcript'
import { sendActorFailure } from './bridge'
import { broadcastSse } from './http'
import { writeTurnScopeFile, mergeActorUsageFile, type ActorUsageRecord } from './state-files'
import { projectionAppend, dedupeIndexFor, projectionActorKey, type ProjectionRegistry } from './projection'
import { sectionGate } from './section-gate'
import { readSessionEvents } from './session-events'
import { apiRetry } from './api-retry'
import { broker, RETRY_STEER_TEXT, RETRY_TURN_TIMEOUT_MS } from './node-retry'
import { isNativeMode } from './windowing-native'
import { appendDebugLog } from './debug-log'

// ── 演员子代理诊断日志 ─────────────────────────────────────────────────────
/** 把"建演员子代理时钉了什么档位/来源"落盘（cache/logs/debug-effort-hook.log）。
 *  理由同 debug-projection-input.log：宿主 console.log 在生产实例里看不到，
 *  档位/模型这类请求参数只有落盘才能事后对账（2026-09-10 gemma 空台词事故
 *  就是靠 request/header 与 actor 会话日志反查出来的）。 */
export function debugEffortLog(resolved: ResolvedConfig, tag: string, detail: string): void {
  appendDebugLog(resolved.femoRoot, 'debug-effort-hook.log',
    '[' + new Date().toISOString() + '] ' + tag + ' ' + detail)
}

// ── 镜像簿记与白名单 ──────────────────────────────────────────────────────

// 子代理事件镜像到父会话时的 turn 号重映射（父会话可能连续多个 AI 节点，
// 每个子代理 turn 从 1 开始，直接转发会撞号）。每次 run 分配一个 base，
// 预留 100 个 turn 给该 run 内部递增，fork 并发多个子代理也不冲突。
export const turnBaseBySession = new Map<string, number>()
// 【2026-08-29 撞号根治】基必须是「进程启动纪元」而非固定值：内存 Map 随
// 3081 重启清空，固定基（旧 100_000）会让重启后首场从 100001 重来——与上一
// 进程写进投影窗日志的 turn/start / step/start 结构键（dedupeStructKey）
// 撞车，projectionAppend 与 ensureStepStart 的查重误判「重复」静默拦截：
// 演员骨架与 stream-host 直播锚全部不落盘 → 前端无直播渲染位 → 流式显示
// 全灭（922 场实证，症状=「位置对了但流式没了」）。纪元基随时间前进，跨
// 重启绝不与历史撞号；进程内仍按 run +100 递增防同进程撞号。turn 号量级
// ~18 亿仍在 JS 安全整数范围，消费面全为 number 透传无量级假设。
export const TURN_BASE_EPOCH = Math.floor(Date.now() / 1000)

/** 主会话镜像 turn → scope 映射（重映射后的 turn 号 → 节点 scope 演员名）。
 * 前端视角过滤用：god 全显示，角色视角按 scope 隐藏其他 turn。
 * 镜像始终全量（信息完整落盘），视角过滤只在显示层。
 * routes.ts 的 /dsh-femo/turn-scopes 读取（导出共用实例）。 */
export const turnScopesBySession = new Map<string, Map<number, string[]>>()

// ── 角色上下文占用（2026-08-31 角色窗圆环）────────────────────────────────
// 演员每次演出=一个全新子代理会话，其会话事件流里有两类官方数据：
//  request/context（adapter 解析出的 route capacity：provider/model/contextWindow）
//  assistant/chunk(usage) / assistant/message(usage)（provider 实报 token 用量）。
// usedTokens=最近一次请求的 prompt 侧占用（input+缓存读写，不含输出）——正是
// 「该角色上一次发言时发给 API 的那一堆文字的真实 token 量」（猫猫拍板语义，
// 每角色各算各的、零估算）。contextWindow 缺失（adapter 未广告容量）按 1M
// 兜底（2026-08-31 猫猫拍板，与 deepseek provider 默认一致）。
// 链路：onChildEvent 实时采样（内存表+SSE femo_actor_usage）→ 收尾落盘
// user_data/actor-usage/<sid>.json（重启恢复）→ 前端 useActorUsage。
export const actorUsageBySession = new Map<string, Map<string, ActorUsageRecord>>()

/** contextWindow 缺失时的兜底容量（1M；猫猫拍板，同 deepseek 默认）。 */
const ACTOR_CONTEXT_WINDOW_FALLBACK = 1_000_000

/** 子代理事件类型：镜像到父会话让 dsh 原生 assistant 节点渲染（思考折叠/
 * 工具卡片/回答，零自绘 UI）。导出供 subagent-native.ts（0.1.3 原生复用
 * 路径）共用同一镜像词汇。 */
export const FORWARD_CHILD_EVENTS = new Set([
  'turn/start', 'step/start', 'assistant/chunk', 'assistant/message',
  'tool/call', 'tool/result', 'step/end', 'turn/end',
])

/** surface-eligible 事件（会话 API 要求 surfaceOp 标记）；其余事件不能带。 */
export const SURFACE_OP_EVENTS = new Set(['assistant/message', 'tool/result'])

/** V6 turn 原子缓冲（2026-08-30）：这些镜像事件不在到达时落盘，攒进
 * mirrorBuffer、turn/end 到达时一次性按序落盘——同一 turn 的官方节点在窗
 * 日志里物理连续成块（「隐形容器」：chat 渲染=纯 anchorSeq 平面排序，落盘
 * 连续 ⇒ 排序连续 ⇒ 名字下恒为该角色的完整段落），par 交错与 react 工具
 * 间隔不再把段落撕碎。骨架（turn/start、step/start）与 speaker 名字行不在
 * 列——它们即时落盘，充当直播期的稳定锚（见 turn-nodes.tsx 回退 anchor）。
 * 导出供 subagent-native.ts（0.1.3 原生复用路径）共用同一镜像时序。 */
export const BUFFERED_CHILD_EVENTS = new Set([
  'assistant/chunk', 'assistant/message', 'tool/call', 'tool/result', 'step/end',
])

// ── 在飞子代理登记（2026-08-30 暂停/暂停全场掐断）──────────────────────────
// 旧世界 femoGen 自己发 API 请求，右上角暂停掐断自己的 fetch 即可；插件化后
// AI 演员的请求由 host 侧 dsh 子代理发出，引擎 runner.stop() 只取消引擎侧
// 协程，在飞子代理毫无感知、继续流式输出（上帝窗直播照走）。这里登记全部
// 在飞子代理的 AbortController，暂停/暂停/出错时由 engine-events 统一掐断
// （与空闲看门狗共用同一条 abort 通路：子代理终止 → 既有 finally 收尾——
// flush 镜像缓冲 + 合成 turn/end + femo_stream end 清直播桶 + 归档）。
// 【2026-09-09】interrupt 可选通路：0.1.3 原生复用子代理（subagent-native.ts）
// 是常驻 continuable child，controller.abort 只掐宿主侧等待，子代理在飞回合
// 须经官方 subagents.interrupt 掐断；one-shot 旧路径不设置 interrupt（=undefined，
// abort 语义与旧版完全一致）。
export interface ActiveSubagent {
  controller: AbortController
  node: string
  /** 所属 Job（清场域化维度：flow_paused/flow_error 只掐本 Job 的演员）。 */
  jobId: number
  /** 官方中断通路（原生复用子代理专用；缺省=one-shot 旧行为）。 */
  interrupt?: () => void
}
export const activeSubagents = new Set<ActiveSubagent>()
/** 在飞子代理登记（api-retry filter 数据源 + 通知定位，施工清单 v4 §6.1）：
 * childId → { 主会话 id, 节点 id, Job id }。spawn 成功后 set（早于引擎可能
 * 发出的任何慢层失败判定）；finally delete（run-control 掐断/异常路径都
 * 经过 finally，登记必清）。 */
export const activeChildRuns = new Map<string, { mainSid: string; node: string; jobId: number }>()

/** 被 run-control（暂停/暂停/出错/开跑清理）掐断的 controller：区别于空闲
 * 超时，这类中断不向引擎回传（引擎已在暂停流程中，ai 等待协程已被取消，
 * 空 output 回传无意义且有唤醒未退净等待协程的竞态），也不写面板错误表
 * （暂停不是错误）。导出供 subagent-native.ts 判定同一语义。 */
export const runControlAborted = new WeakSet<AbortController>()

/** Job 域中断（Job 模型 §9.1 清场域化）：只掐指定 Job 的在飞 AI 演员子代理。
 * 调用点=flow_paused/flow_error（引擎事件自带 job_id）。域化的互审实锤：
 * 全场 abort 会让 A 会话 stop 误杀 B 会话在飞演员 → B 的 subagent catch 走
 * 空回传 → B 引擎拿空 output 继续演——A 的暂停污染 B 的戏。返回本次实际
 * 掐断数量（仅日志用）。 */
export function abortJobSubagents(jobId: number, reason: string): number {
  let aborted = 0
  for (const entry of [...activeSubagents]) {
    if (entry.jobId !== jobId) continue
    if (entry.controller.signal.aborted) continue
    runControlAborted.add(entry.controller)
    entry.interrupt?.()
    entry.controller.abort(new Error(reason))
    aborted += 1
  }
  return aborted
}

/** 全场中断所有在飞 AI 演员子代理。返回本次实际掐断数量（仅日志用）。
 * 幂等：已中止的 controller 跳过。调用点=bridge onExited（引擎进程死亡）、
 * 插件 dispose、startJobOnSession 空闲槽清理（残留必然属于旧 Job，全场
 * 掐断合理）。 */
export function abortAllSubagents(reason: string): number {
  let aborted = 0
  for (const entry of [...activeSubagents]) {
    if (entry.controller.signal.aborted) continue
    runControlAborted.add(entry.controller)
    entry.interrupt?.()
    entry.controller.abort(new Error(reason))
    aborted += 1
  }
  return aborted
}

// ── prompt / trajectory 组装 ─────────────────────────────────────────────

/** 演员真实身份（soul）→ 真 system prompt（2026-09-05 猫猫拍板）：soul 不再
 * 拼进首条 user 消息，改为经 subagents.start 的 per-child persona 注入——在
 * 子代理 scope 注册 deployment:persona section，就近 shadow 掉 Femo preset
 * standing mount 的导演手册 persona（ScopedLayers.merge 就近优先）；无 soul
 * 的演员 persona=''，渲染时空 section 被 drop=标准模式。数据源：桥命令
 * get_soul（2026-09-07 B4——宿主不再直读 SQLite，路径推导/表结构回归引擎
 * 内部；未知 soul/桥异常 → ''，演员回落标准模式，容错语义不变）。
 */

/** Read one soul's persona text via the bridge get_soul command (B4)：查询、
 * 路径推导、容错全部引擎侧。unknown soul → ''（演员回落标准模式——身份不可得
 * ≠演出致命）；桥死亡/错误 → '' + log（不哑掉：console 至少留痕）。
 * 导出供 subagent-native.ts 共用。 */
export async function readSoulPersona(bridge: FemoBridge, soulId: string): Promise<string> {
  try {
    const res = await bridge.send('get_soul', { soul_id: soulId }, 15000) as { found?: boolean; description?: string } | undefined
    return typeof res?.description === 'string' ? res.description : ''
  } catch (error: unknown) {
    console.log(`[dsh-femo] read soul persona failed (soul_id=${soulId}): ${String(error)} — actor runs in standard mode`)
    return ''
  }
}

/** ai_request.blocks 词汇契约（femoCompiler/protocol.py BLOCK_KEYS——引擎拥有
 * 料包词汇表，拼装归执行后端，本函数即宿主模式正身）：宿主拼装消费其中的
 * 文本键；soul 不进 prompt（走 per-child persona，见下方 readSoulPersona）；
 * _actor_info 是引擎私有 dict（身份元数据），不得当文本拼。契约外键 = 剧本
 * 自定义 context 方法的产出（引擎 block_collector 收集），当前拼装器不识别
 * ——忽略并告警让它可见（静默丢弃会让宿主模式演员缺料且无人知晓）。 */
export const KNOWN_BLOCK_KEYS: ReadonlySet<string> = new Set([
  'basic_safety', 'basic_output', 'user_info', 'context', 'prompt', 'memory', 'soul', '_actor_info',
])

/** Assemble the subagent's initial prompt from the engine's blocks. soul 不在
 * 此列（走 per-child persona，见上方 soul persona 段注释）；引擎侧仍生产
 * blocks['soul']（_exec_ai 的 ai_name 三级兜底依赖它），宿主只不再拼接。
 * 导出供 subagent-native.ts 共用。 */
export function buildSubagentPrompt(blocks: Record<string, unknown>): string {
  const str = (key: string): string => (typeof blocks[key] === 'string' ? String(blocks[key]) : '')
  const system = [
    str('basic_safety'),
    str('basic_output'),
    str('user_info'),
  ].filter(Boolean).join('\n\n')
  const parts = [str('context'), str('prompt')]
  const memory = str('memory')
  if (memory.length > 0) {
    parts.push('---\n[回忆]\n根据以上情况，你偶然回忆起了以下记忆，可能有用也可能无用：', memory, str('prompt'))
  }
  const user = parts.filter(Boolean).join('\n\n')
  return [system, user].filter(Boolean).join('\n\n')
}

// ── 工具面 / 模型来源 ─────────────────────────────────────────────────────

/** 默认演员对 femo 工具隐身（2026-09-10 拍板：femo 工具不给演员）。femo-*
 * 六件套是插件在组合根全局注册的，不过滤就进每个子代理的目录（实测 @计数员
 * 目录 20 个，混着 femo-run 这类主模型专用工具）。兜底用 deny 而非 allow
 * 基础面：deny 名单是本插件自己注册的工具名，restrict 的 known 校验永远过
 * （allow 名单遇到缺工具的部署会直接抛错）；memory_*、ask_eyes 等其他根插件
 * 工具不归本插件管，保持原样。
 * femo-debug（2026-09-11 新增）同理 deny：干跑要起子进程跑整场剧本，
 * 演员既不需要也不该有——那是导演的剧本自检动作。 */
export const ACTOR_DENIED_TOOLS: readonly string[] = [
  'femo-mount', 'femo-run', 'femo-script', 'femo-soul', 'femo-chronica', 'femo-debug',
]

/** Assemble one AI node's subagent tool filter from actor + config.
 * 导出供 subagent-native.ts 共用。 */
export function toolFilterOf(
  resolved: ResolvedConfig,
  request: Record<string, unknown>,
): { toolFilter: { allow?: string[]; deny?: string[] } } {
  const actorTools = typeof request.actor_tools === 'boolean'
    ? request.actor_tools
    : resolved.defaultActorTools
  if (!actorTools) {
    // Actor opted out (or default false): no tools at all.
    return { toolFilter: { allow: [] } }
  }
  // Actor declares a whitelist (tools: [..]); otherwise the global附加
  // whitelist; otherwise deny the femo five——绝不裸放行：组合根注册的
  // femo-* 对子代理同样可见，不过滤演员就能 stop/remount 整场演出。
  const list = Array.isArray(request.actor_tool_list)
    ? request.actor_tool_list.filter((x): x is string => typeof x === 'string')
    : []
  const whitelist = list.length > 0 ? list : resolved.toolWhitelist
  if (whitelist.length > 0) {
    return { toolFilter: { allow: [...whitelist] } }
  }
  return { toolFilter: { deny: [...ACTOR_DENIED_TOOLS] } }
}

// ── 演员委派权限口径（2026-09-10 拍板：标准模式 workspace-write + ask）────
// 取代 2026-09-05 的 read-only 口径。与 dsh 本体标准会话钉子完全同款
// （dsh-base cordis.patch.yml：sessions pin workspace-write + ask）。
// 注意时序：dsh 委派会在子代理创建窗口内先继承父会话沙箱档位并把审批钉成
// never（captureDelegatedPolicyOverrides，start 请求无策略参数可覆盖），首轮
// runtime-context 快照因此可能仍显示父会话口径——本钉子在其后 append（fold
// 最后写胜出，工具执行必读到新值），femo:child-scope 澄清段则声明以本口径
// 为准、压过过期快照。
export const ACTOR_SANDBOX_MODE = 'workspace-write'
export const ACTOR_APPROVAL_POLICY = 'ask'
export const FEMO_CHILD_SCOPE_TEXT =
  'This Femo stage child runs under the standard workspace-write sandbox with interactive approvals: ' +
  'reads and file writes inside the current workspace need no approval; operations outside the workspace ' +
  'or otherwise approval-gated prompt the user, who can allow them — request such an approval for the ' +
  'specific operation instead of giving up or retrying blindly. This scope statement is authoritative ' +
  'over the delegation runtime snapshot: if that snapshot claims broader access or disabled approvals, it is outdated.'

/** 把演员权限钉子 append 到子代理会话（fold 语义最后写胜出）。两条路径
 * （subagent.ts / subagent-native.ts）共用，口径唯一。 */
export function appendActorPolicyPins(session: { append(type: string, data: unknown): void }): void {
  session.append('sandbox/mode', { mode: ACTOR_SANDBOX_MODE })
  session.append('approval/policy', { policy: ACTOR_APPROVAL_POLICY })
}

/** 主会话当前实际模型（未声明 source 的子代理跟随它）：
 * ① 主会话最近一次请求头（含 UI 会话内切换，对齐 dsh web selectionFor 语义）
 * → ② 用户保存的默认选择（agentDefaultModel）→ ③ undefined（调用方回退配置）。
 * 显式返回模型而非依赖 dsh 隐式默认，堵死"子代理落到部署默认（如 Pro）"的隐患。
 * 导出供 subagent-native.ts 共用。 */
export function resolveMainModel(
  parent: { session: { requestHeader?(): { config?: { provider?: unknown; model?: unknown } } | undefined } },
  defaultModel?: { currentSelection(): unknown },
): { provider: string; model: string } | undefined {
  const header = parent.session.requestHeader?.()
  const h = header?.config
  if (h !== undefined && typeof h.provider === 'string' && h.provider.length > 0
    && typeof h.model === 'string' && h.model.length > 0) {
    return { provider: h.provider, model: h.model }
  }
  const selection = defaultModel?.currentSelection() as { provider?: unknown; model?: unknown } | undefined
  if (selection !== undefined && typeof selection.provider === 'string' && selection.provider.length > 0
    && typeof selection.model === 'string' && selection.model.length > 0) {
    return { provider: selection.provider, model: selection.model }
  }
  return undefined
}

/** 剧本 source → 子代理 agentOptions。
 * 空 source 跟随主模型（最近请求头 → 保存默认）；裸 id 走 dshProvider
 * （部署按需配置，编译期白名单已校验）；provider/model 双写完全指定。
 * 均不可得时返回空对象——不写死 provider（2026-08-24 用户拍板「不要写
 * provider」）：交给 dsh 默认模型链，杜绝部署上不存在的 adapter 名导致
 * 整场戏 NO_ADAPTER。导出供 subagent-native.ts 共用。 */
export function resolveSourceModel(
  resolved: ResolvedConfig,
  source: unknown,
  mainModel?: { provider: string; model: string },
): { agentOptions?: { provider: string; model: string } } {
  const raw = typeof source === 'string' ? source.trim() : ''
  if (raw.length === 0) {
    if (mainModel !== undefined) {
      return { agentOptions: { provider: mainModel.provider, model: mainModel.model } }
    }
    return {}
  }
  const slash = raw.indexOf('/')
  if (slash >= 0) {
    return { agentOptions: { provider: raw.slice(0, slash), model: raw.slice(slash + 1) } }
  }
  return { agentOptions: { provider: resolved.dshProvider, model: raw } }
}

// ── 子代理会话归档 ────────────────────────────────────────────────────────

/** 子代理会话目录移出 dsh sessions 树（备份区 user_data/host-history/projections/subagents/）。
 * 不删文件、可移回；移出后不再出现在会话列表/投影缓存（镜像已全量落主会话，
 * 子代理日志只是冗余备份）。locate 需要 cwd 才能定位 workspace 分组目录。 */
async function moveChildSessionOut(
  ctx: Context,
  resolved: ResolvedConfig,
  run: { id: SessionId; localAgent?: { session: { events?: readonly unknown[]; header?: { cwd?: string } } } },
): Promise<void> {
  const header = run.localAgent?.session.header
  if (header === undefined || header.cwd === undefined) return
  const persistence = ctx.get('sessionPersistence') as
    | { locate?(meta: { cwd?: string; id: SessionId }): { path: string } | undefined }
    | undefined
  if (persistence?.locate === undefined) return
  const loc = persistence.locate({ cwd: header.cwd, id: run.id })
  if (loc === undefined) return
  const sessionDir = dirname(loc.path)
  const targetRoot = join(resolved.femoRoot, 'user_data', 'host-history', 'projections', 'subagents')
  const target = join(targetRoot, String(run.id))
  const { mkdir, rename } = await import('node:fs/promises')
  await mkdir(targetRoot, { recursive: true })
  // Windows 上会话日志可能仍在异步 flush（句柄占用），rename 会 EPERM：
  // 带重试（最多 10 次 × 500ms），flush 完成后再移出。
  let lastError: unknown
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rename(sessionDir, target)
      console.log(`[dsh-femo] moved child session ${run.id} -> subagent_sessions/`)
      return
    } catch (error: unknown) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  throw lastError
}

// ── 主流程 ────────────────────────────────────────────────────────────────

/** One engine AI turn executed through a dsh subagent. */
export async function runAiSubagent(
  ctx: Context,
  resolved: ResolvedConfig,
  bridge: FemoBridge,
  session: Session,
  request: Record<string, unknown>,
  recordError: (sessionId: SessionId, text: string) => void,
  defaultModel?: { currentSelection(): unknown },
  nodeActors: ReadonlyMap<string, string> = new Map(),
  projections?: ProjectionRegistry,
  nodeShowprompts: ReadonlyMap<string, string> = new Map(),
  jobId: number = -1,
): Promise<void> {
  // 唯一调用点（engine-events）总传 registry；守卫只为类型收窄（缺 registry
  // 时原实现会在首次投影处 TypeError，这里提前以明确错误失败，路径等价）。
  if (projections === undefined) throw new Error('projections registry unavailable')
  const waitKey = String(request.wait_key ?? '')
  if (waitKey.length === 0) return
  const subagents = ctx.get('subagents') as {
    start(name: string, req: unknown): Promise<{
      id: SessionId
      result: Promise<{ output: unknown; stopReason: string }>
      dispose(): Promise<void>
      localAgent?: {
        ctx: Context
        session: {
          events: readonly SessionEvent[]
          /** 委派权限 knob（2026-09-05）：子代理 session 的运行时切换写路径。 */
          append(type: string, data: Record<string, unknown>): void
        }
        /** Agent.steer（rc.1 agent-loop/agent.ts L135：next-step 注入+唤醒）——
         *  停靠重试经租约让执行者续跑（result settle 后、dispose 前合法，
         *  in-process-driver 实锤：localAgent=完整 Agent）。 */
        steer?(message: unknown): void
        /** Agent.whenIdle（rc.1 agent-loop/agent.ts L204，官方静止判定）。 */
        whenIdle?(): Promise<void>
      }
    }>
  } | undefined
  if (subagents === undefined) {
    throw new Error('subagents service unavailable')
  }
  const parent = ctx.agents.get(session.id)
  if (parent === undefined) {
    throw new Error(`parent agent for ${session.id} is not live`)
  }
  const blocks = (request.blocks ?? {}) as Record<string, unknown>
  const unknownBlockKeys = Object.keys(blocks).filter(k => !KNOWN_BLOCK_KEYS.has(k))
  if (unknownBlockKeys.length > 0) {
    console.log(`[dsh-femo] ai_request(node=${String(request.node_name ?? '')}) blocks 含契约外语料键（宿主拼装器不识别已忽略；自定义 context 块仅直连模式生效）: ${unknownBlockKeys.join(', ')}`)
  }
  const prompt = buildSubagentPrompt(blocks)
  // 演员身份：soul_id 随 ai_request 的 actor_info 到宿主（引擎 _get_actor_info
  // 产出；main 演员走主窗口回答制不经此处，human 等输入不产 ai_request）。
  // persona 语义与容错见 readSoulPersona。{{ 检测：persona 文本按 dsh 模板
  // 严格插值，未注册 {{var}} 会在组装时报错——前置 log 让来源一眼可见。
  const actorInfo = (request.actor_info ?? {}) as { soul?: unknown }
  const soulId = typeof actorInfo.soul === 'string' ? actorInfo.soul : ''
  const soulPersona = soulId.length > 0 ? await readSoulPersona(bridge, soulId) : ''
  if (soulPersona.includes('{{')) {
    console.log(`[dsh-femo] WARNING soul persona (soul_id=${soulId}) contains "{{" — dsh prompt assembly treats it as a template variable and will fail loud`)
  }
  // Debug voice: what one AI node feeds its subagent (context length answers
  // "did the scope filter leak / go empty" for this very node).
  const blk = (key: string): string => typeof blocks[key] === 'string' ? String(blocks[key]) : ''
  console.log(`[dsh-femo] ai_request node=${String(request.node_name ?? '')} scope=${String(request.scope ?? '')} soul_id=${soulId}`
    + ` blocks: context=${blk('context').length}ch soul=${blk('soul').length}ch memory=${blk('memory').length}ch prompt=${blk('prompt').length}ch`)
  console.log(`[dsh-femo] subagent prompt (${prompt.length}ch): ${prompt.slice(0, 300).replace(/\n/g, '\\n')}`)
  // A hung child must not wedge the engine node forever — but "hung" means
  // SILENT, not slow: a child that keeps emitting events (reasoning chunks,
  // tool calls, streamed text) is alive however long it runs, so the abort
  // timer is an idle watchdog that rearms on every child-session event.
  const controller = new AbortController()
  // 登记在飞子代理（暂停/暂停/出错时全场掐断用；finally 注销）。登记点在
  // 本函数首个 await 之前——ai_request 事件处理体的同步段内完成，flow_paused
  // 等后续事件必然晚于登记到达，不存在「掐断时还没登记」的窗口。
  const activeEntry: ActiveSubagent = { controller, node: String(request.node_name ?? ''), jobId }
  activeSubagents.add(activeEntry)
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const armIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      controller.abort(new Error(`子 agent 空闲超时（${Math.round(resolved.subagentIdleTimeoutMs / 1000)}s 无输出）`))
    }, resolved.subagentIdleTimeoutMs)
  }
  // 未声明 source 的子代理跟随主模型（最近请求头 → 保存默认 → 配置兜底），
  // 绝不落到 dsh 部署隐式默认（防"主模型 Flash 子代理跑 Pro"类问题）。
  const mainModel = resolveMainModel(parent, defaultModel)
  const run = await subagents.start(resolved.subagentProvider, {
    label: `femo-node-${String(request.node_name ?? '')}`,
    prompt: [{ type: 'text', text: prompt }],
    parent,
    signal: controller.signal,
    // 演员 persona（2026-09-05 猫猫拍板两步走）：先置空让演员摆脱导演手册
    // （「演员子代理拥有 dsh 的标准模式的 system prompt 就好了，他们不是导
    // 演」）；本轮再把 soul 从 user 消息挪进来——persona= 引擎 souls 表的
    // .description（桥命令 get_soul），在子代理自身 scope 注册
    // deployment:persona section，就近 shadow 掉 Femo preset standing mount 的
    // 导演手册（composeFrom 是 bind 不是 mount，preset row 落在 mount layer；
    // ScopedLayers.merge 就近优先）。无 soul/读库失败 → ''，渲染时空 section
    // 被 drop=标准模式（与「演员不是导演」拍板一致）。3081 部署无全局 persona
    // 配置，标准模式本就无 persona 段。导演主会话不受影响（本参数只作用于
    // spawn 子代理）；preset 工具面/compaction 不受影响（join 语义未动）。
    persona: soulPersona,
    // source → (provider, model)：剧本 actor 声明（编译期已校验白名单）。
    // 裸 id 走默认 provider（dshProvider）；provider/model 双写完全指定；空跟随主模型。
    ...resolveSourceModel(resolved, request.source, mainModel),
    // Actor-level tool access: the script's `tools: true/false` on the actor
    // wins; undeclared actors fall back to defaultActorTools (default true so
    // coding workflows keep their tools). An enabled actor with no whitelist
    // inherits the preset's full tool set (no filter); a disabled actor gets
    // an empty allow-list (no tools at all).
    ...toolFilterOf(resolved, request),
  })
  // api-retry 登记（v4 §6.2(a) 持久登记）：早于任何慢层失败判定——慢层 filter
  // 按 childId 命中本演员（mainSid=主会话，通知/错误表定位；node=节点 id）。
  activeChildRuns.set(String(run.id), { mainSid: String(session.id), node: String(request.node_name ?? ''), jobId })
  // node-retry 持久登记（v4 §6.2(a)）：同样早于引擎可能发出的第一个 node_retry
  // ——登记永远早于信号，不存在"信号到了没人接"的窗口。租约 steer：one-shot
  // run 的 localAgent 在 result settle 后、dispose 前一直是活 Agent（rc.1
  // in-process-driver 实锤：localAgent=完整 Agent，steer=Agent 层原语）。
  broker.register({
    waitKey,
    nodeName: String(request.node_name ?? ''),
    kind: 'subagent',
    jobId,
    mainSessionId: String(session.id),
    controller,
    steer: (text) => run.localAgent?.steer?.({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-femo' },
    }),
  })
  // ── 委派权限改写（2026-09-10 拍板「演员=标准模式 workspace-write + ask」；
  // 2026-09-05 的 read-only 口径退役）────────────────────────────────────
  // delegation 种子（创建窗口）把子代理 approval 钉死 'never'、sandbox 继承
  // 父会话（本部署父会话默认 danger-full-access——首轮快照因此可能口径偏大，
  // 以 femo:child-scope 澄清段对冲，见 ACTOR_SANDBOX_MODE 处注释）。两个
  // knob 事件（sandbox/mode、approval/policy）均为「最后一条=生效值」的 fold
  // （effectiveSandboxMode / effectiveApprovalPolicy），此处 append 运行时
  // 切换（source 省略=运行时切换语义）必胜出；执行面（bash/fs）每次 confined
  // call 逐次 fold 读取，工具执行必读到新值。dsh-base bundle 已装配
  // sandbox-policy + user-approval（profile 依赖实证）——'ask' 有 UI answerer
  // 应答。DSH 本体的 SUBAGENT_DELEGATION_CONTEXT 文本仍称「approval 自动拒绝」，
  // 与实际行为矛盾（本体红线不碰）——femo:child-scope 澄清段对冲，告知演员
  // 可以请求审批。事件不进镜像白名单，投影窗零感知；归档移动目录不受影响。
  if (run.localAgent !== undefined) {
    appendActorPolicyPins(run.localAgent.session)
    // 澄清段（本体文本不可改的补偿）：紧跟 delegation 声明（order 120）之后，
    // 读起来是它的修正案；名字唯一，不与本体 context 撞名。
    const childSystemPrompt = (run.localAgent.ctx as unknown as {
      systemPrompt?: { context(c: { name: string; order: number; text: string }): () => void }
    }).systemPrompt
    childSystemPrompt?.context({
      name: 'femo:child-scope',
      order: 121,
      text: FEMO_CHILD_SCOPE_TEXT,
    })
  }
  // 推理等级注入：子 agent（spawn 进程内）不走 apiproxy 的 model-selection
  // 安装（installSelection 只作用于会话 agent），导致用户在模型选择里调的
  // 推理等级对子 agent 永远无效（表现为"关了推理还在输出 cot"）。
  // 这里直接给子 agent 的请求链注入（2026-08-30 改造，语义对齐 dsh
  // installModelSelection 的「absent effort clears inherited effort」）：
  // 优先级 actor thinking 标签 > 插件配置 subagentReasoning > 全局默认模型
  // 选择；三层全无时显式剥离继承的 effort——落到适配器/部署默认（settings
  // 的 profile reasoning），不再由上游残留决定。钩子因此必须永远安装：旧版
  // 「有档位才挂」会让 default 态残留继承档位，而 pi-ai 的 zai 格式对缺省
  // 档位发 thinking disabled——glm-5.3-flash 强制思考网关直接 400 1210。
  if (run.localAgent !== undefined) {
    run.localAgent.ctx.on('agent/request', async (_payload, next) => {
      const resolvedCall = await next()
      const actorThinking = typeof request.actor_thinking === 'string' && request.actor_thinking.trim().length > 0
        ? request.actor_thinking.trim()
        : undefined
      const effort = actorThinking
        ?? resolved.subagentReasoning
        ?? (defaultModel?.currentSelection() as { reasoningEffort?: string } | undefined)?.reasoningEffort
      const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolvedCall
      return {
        ...withoutInheritedEffort,
        ...effort !== undefined && effort.length > 0
          ? { reasoningEffort: effort }
          : {},
      } as typeof resolvedCall
    })
  }
  // Watchdog starts once the child exists; every child-session event rearms
  // it. Listener is scoped to the child's session id and disposed in finally.
  armIdle()
  const sid = String(session.id)
  const nodeName = String(request.node_name ?? '')
  // Par 并发安全（2026-08-28）：演员名优先取本次 ai_request 自带的 ai_name
  // （引擎 _exec_ai 三级解析后随 payload 传递，每请求独立身份）。此前取共享
  // Map nodeActors[node_name]——par 循环体各分支 node id 相同而演员不同，
  // context_ready 互相覆盖后 Map 值取决于事件到达序，speaker 行会写上另一
  // 分支的演员名（流式 femo_stream 的 actor 同错，两演员直播混进同一桶）。
  // 旧引擎（payload 无 ai_name）回退 Map：单节点/串行语义下仍正确。
  const requestAiName = typeof request.ai_name === 'string' && request.ai_name.length > 0
    ? request.ai_name
    : undefined
  const actor = requestAiName ?? nodeActors.get(nodeName) ?? nodeName
  // ── 角色占用采样（2026-08-31 角色窗圆环）─────────────────────────────
  // onChildEvent 在镜像白名单过滤之前调用 captureActorUsage：request/context
  // 与 usage 事件不在 FORWARD_CHILD_EVENTS 里（镜像裁剪也不保留它们），但它们
  // 正是官方链路上「发给该角色 API 的真实占用」数据源（纯读取登记，不改任何
  // 镜像分支）。actorKey 用消毒后的窗 id 尾段——数据按投影窗索引，前端从
  // sessionId 解析出的就是该形态。usage 与 request/context 乱序无妨：publish
  // 只在拿到 usage 时发（分母取当下最新值，last-wins 与官方 projection 同语义）。
  const actorKey = projectionActorKey(actor)
  const usageCurrent: { provider?: string; model?: string; contextWindow?: number; usedTokens?: number } = {}
  const publishActorUsage = (): void => {
    if (usageCurrent.usedTokens === undefined) return
    const record: ActorUsageRecord = {
      provider: usageCurrent.provider ?? '',
      model: usageCurrent.model ?? '',
      contextWindow: usageCurrent.contextWindow ?? ACTOR_CONTEXT_WINDOW_FALLBACK,
      usedTokens: usageCurrent.usedTokens,
      updatedAt: Date.now(),
    }
    let byActor = actorUsageBySession.get(sid)
    if (byActor === undefined) {
      byActor = new Map()
      actorUsageBySession.set(sid, byActor)
    }
    byActor.set(actorKey, record)
    broadcastSse('femo_actor_usage', { sid, actorKey, ...record })
  }
  const captureActorUsage = (event: SessionEvent): void => {
    if (event.type === 'request/context') {
      const d = (event.data ?? {}) as { provider?: unknown; model?: unknown; contextWindow?: unknown }
      if (typeof d.provider === 'string') usageCurrent.provider = d.provider
      if (typeof d.model === 'string') usageCurrent.model = d.model
      if (typeof d.contextWindow === 'number' && d.contextWindow > 0) usageCurrent.contextWindow = d.contextWindow
      return
    }
    // usage 两源（token-meter usageOf 同款判定）：流式 chunk 的 usage 帧（早样本，
    // 请求失败也幸存）与 assistant/message 的终样本；同 turn/step 重复上报取后值。
    const data = (event.data ?? {}) as { chunk?: { type?: unknown; usage?: unknown }; usage?: unknown }
    const usage = event.type === 'assistant/chunk' && data.chunk?.type === 'usage'
      ? data.chunk.usage
      : event.type === 'assistant/message' ? data.usage : undefined
    if (usage === undefined || typeof usage !== 'object') return
    const u = usage as { inputTokens?: unknown; cacheReadTokens?: unknown; cacheWriteTokens?: unknown }
    const input = typeof u.inputTokens === 'number' ? u.inputTokens : 0
    const cacheRead = typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0
    const cacheWrite = typeof u.cacheWriteTokens === 'number' ? u.cacheWriteTokens : 0
    usageCurrent.usedTokens = input + cacheRead + cacheWrite
    publishActorUsage()
  }
  // 收尾落盘（锁内 read-merge-write，par 兄弟 run 不互相覆盖）：失败仅日志，
  // 内存表+SSE 已实时可用，档案只服务重启恢复。
  const persistActorUsage = (): void => {
    if (usageCurrent.usedTokens === undefined) return
    const record: ActorUsageRecord = {
      provider: usageCurrent.provider ?? '',
      model: usageCurrent.model ?? '',
      contextWindow: usageCurrent.contextWindow ?? ACTOR_CONTEXT_WINDOW_FALLBACK,
      usedTokens: usageCurrent.usedTokens,
      updatedAt: Date.now(),
    }
    void mergeActorUsageFile(resolved.femoRoot, sid, actorKey, record).catch((error: unknown) => {
      console.log(`[dsh-femo] write actor-usage failed: ${String(error)}`)
    })
  }
  // 节点旁白（context_ready showprompt）【V6.2】：随子代理骨架落盘，带 turn
  // 归属——渲染位由 femo-turn-head 决定（名字行上方），物理 seq 无关（speaker
  // V5 让位模式同款）。旧落点在 context_ready 瞬间（独立官方节点、无 turn），
  // par 并发/导演插话/重试下与角色区块分家，故迁移至此。
  const showprompt = nodeName.length > 0 ? nodeShowprompts.get(nodeName) : undefined
  // turn 首行：发言者名字（之后 cot/工具调用/回答由 dsh 原生 UI 渲染）
  const scopeInfo = Array.isArray(request.scope_info)
    ? request.scope_info.filter((x): x is string => typeof x === 'string')
    : undefined
  // 角色名字行：只投影进上帝窗 + scope 命中的角色窗。主会话表面绝不写入
  // （主窗口=戏外=纯 DSH 原生 user+主模型；名字行曾写主会话导致"光有名字
  // 没有内容"的幽灵行——内容 turn 本就只进投影窗）。
  // 【2026-08-29 V3.1】名字行写入点=「首个将真正落盘的镜像事件之前」（
  // onChildEvent 镜像段、裁剪判定之后调用 appendSpeakerLine）。结构性理由：
  // par 并发下每个演员的骨架（turn/start、step/start、stream-host 锚）在
  // 各自首个 chunk 到达时即全部落地，而内容块（流式裁剪后的 block 边界）
  // 必然晚于骨架——无论名字写在 ai_request 时（V1）、首个事件时（V2）还是
  // turn 骨架时（V3.0），所有名字都落在所有内容之前=「AI1 AI2 内容1 内容2」
  // 连排。镜像裁剪保证首个镜像事件之前本演员零内容落地，故此处写入的 seq
  // 恒紧贴内容开头。流式期的名字显示由 stream-host 锚承担（前端 !hasSpeaker
  // 接力），speaker 行只做历史归属标记；零事件子代理由 finally 兜底补写。
  // 【2026-08-30 V6 注】stream-host 锚已废（V5 改 turn 级节点、V6 再改缓冲）。
  // 名字行现在的角色=「直播区锚」：即时落盘（仍在本演员首个内容事件之前，
  // 只不过内容事件此刻进缓冲、turn/end 才落地），前端 femo-turn-head 在直播
  // 期用它回退 anchor（turn/start+0.5）把名字+直播桶钉在骨架旁；turn 落地
  // 后 head 改用区块首内容 seq−0.5 吸附段落头，本行历史归属语义不变。
  let windows = projections.get(sid)
  if (windows === undefined) {
    // 【cwd 守卫】同 engine-events flow_start：cwd 缺失绝不落 process.cwd()
    // （2026-08-23 分组键事故原则，routes.ts projection-windows 同款守卫）。
    // 此兜底建窗仅在 registry 无窗时可达；抛错交给 ai_request 调用方现有
    // catch（recordError + 空回传，该演员节点失败、引擎继续），优于建错
    // 分组产生 duplicate session id 炸整树。
    const headerCwd = (session.header as { cwd?: string } | undefined)?.cwd
    if (headerCwd === undefined || headerCwd.length === 0) {
      throw new Error(`session ${sid} cwd missing — projection windows cannot be ensured (process.cwd() fallback forbidden)`)
    }
    windows = await projections.ensure(sid, scopeInfo ?? [], headerCwd)
  }
  // 【2026-09-10 v7 段落闸门】同角色上一区块未落盘前不派发直播帧（防残留桶
  // 与新回合 (index,step) 同键拼串），随后登记本区块顺位（FIFO=ai_request 顺序）。
  await sectionGate.waitActorFlush(sid, actorKey)
  const baseTurn = (turnBaseBySession.get(sid) ?? TURN_BASE_EPOCH) + 1
  turnBaseBySession.set(sid, baseTurn + 100)
  sectionGate.begin(sid, baseTurn, actorKey)
  // 【2026-09-10 v7 直播轻锚】开跑即落（不进区块、不等闸门）：前端
  // femo-live-tail 以它为 start，把本演员的流式直播画在窗底直播区（锚恒在
  // 一切已落地区块之后）。区块落盘时本回合 turn/end 到位，轻锚节点随之隐藏；
  // 名字的正式归位由区块内的 speaker 行承担。
  projectionAppend(windows, 'dsh-femo/chat', {
    kind: 'live',
    actor,
    turn: baseTurn,
    ...scopeInfo === undefined ? {} : { visible: scopeInfo },
    seq: Date.now(),
  }, undefined, scopeInfo)
  let speakerWritten = false
  const appendSpeakerLine = (): void => {
    if (speakerWritten || windows === undefined) return
    speakerWritten = true
    mirrorBuffer.push({
      type: 'dsh-femo/chat',
      data: {
        kind: 'speaker',
        actor,
        text: actor,
        // 【V5】显式 turn 归属：speaker 事件不再由 femoChat 独立渲染（无
        // turn 的旧数据除外），而是作为 femo-turn-head 节点的 actor 数据源——
        // 渲染位由 head 的动态 anchor 决定（恒贴自己段落头），与本事件物理
        // seq 无关。
        turn: baseTurn,
        ...scopeInfo === undefined ? {} : { visible: scopeInfo },
        seq: Date.now(),
      },
      surface: undefined,
    })
  }
  // 【V6.2】旁白行：与名字行同款落点策略（首个将落盘镜像事件之前、幂等），
  // 但渲染权让给 femo-turn-head（chat-node 对带 turn 的 prompt 让位）——head
  // 把 📢 条渲染在名字行上方，两者同节点永不分离，恒贴自己区块头。
  let showpromptWritten = false
  const appendShowpromptLine = (): void => {
    if (showpromptWritten || windows === undefined || showprompt === undefined) return
    showpromptWritten = true
    mirrorBuffer.push({
      type: 'dsh-femo/chat',
      data: {
        kind: 'prompt',
        text: `📢 ${showprompt}`,
        turn: baseTurn,
        ...scopeInfo === undefined ? {} : { visible: scopeInfo },
        seq: Date.now(),
      },
      surface: undefined,
    })
  }
  // 【2026-09-10 v7.1】节点=一个回合：one-shot 子代理恒单回合，映射恒
  // baseTurn（保留常量映射而非直写，消费面与原生路径同形）。
  const mapTurn = (_childTurn: unknown): number => baseTurn
  // ── 【2026-09-10 v7】整段区块缓冲（原 V6 原子缓冲扩展）────────────────
  // 骨架（turn/start、step/start）、speaker/📢 行、错误行、内容块、turn/end
  // 全部进缓冲，由段落闸门（section-gate.ts）按开跑顺序一次性落盘——段落
  // 顺序=开跑顺序且段内恒完整；流式期可见性交给窗底 femo-live-tail 直播尾。
  // flush 全同步（projectionAppend 无 await，Node 单线程），中途不可能插入
  // 其他演员的事件 ⇒ 区块连续性是结构保证。工具名登记表供结果直播帧取名。
  const mirrorBuffer: Array<{
    type: string
    data: Record<string, unknown>
    surface: Record<string, unknown> | undefined
  }> = []
  const toolNamesByCallId = new Map<string, string>()
  const flushMirrorBuffer = (): void => {
    if (mirrorBuffer.length === 0) return
    const pending = mirrorBuffer.splice(0)
    for (const item of pending) {
      projectionAppend(windows, item.type, item.data, item.surface, scopeInfo)
    }
  }
  // 本回合区块的闸门释放（幂等）：缓冲全量落盘 + 合成收口 turn/end + 直播
  // end 帧放行。只在节点审结（finally）调用——子代理的 turn/end 不再镜像、
  // 不触发释放（收口由这里合成，v7.1 单回合折叠）。最后一轮仍以 error 收口
  // 的，落一条归属错误行（femo-turn-head 渲染在演员名字下方）。
  let sectionReleased = false
  let lastErrorReason: { message: string; code: string } | undefined
  const releaseSection = (): void => {
    if (sectionReleased) return
    sectionReleased = true
    sectionGate.commit(sid, baseTurn, actorKey, () => {
      if (lastErrorReason !== undefined) {
        mirrorBuffer.push({
          type: 'dsh-femo/chat',
          data: {
            kind: 'error',
            actor,
            text: `⚠️ 本轮运行失败：${lastErrorReason.message}${lastErrorReason.code ? `（${lastErrorReason.code}）` : ''}`,
            turn: baseTurn,
            seq: Date.now(),
          },
          surface: undefined,
        })
      }
      mirrorBuffer.push({ type: 'turn/end', data: { turn: baseTurn, reason: { kind: 'completed' } }, surface: undefined })
      flushMirrorBuffer()
      broadcastSse('femo_stream', { kind: 'end', sid: String(session.id), node_name: nodeName, actor, turn: baseTurn })
    })
  }
  // 合成 turn/step 起始事件（子代理 one-shot 会话没有这两个 start 事件，
  // 原生 assistant 节点以 step/start 为 start，缺了就不渲染）。
  let turnStarted = false
  let currentStep = -1
  const ensureTurnStart = (): void => {
    if (turnStarted) return
    // 幂等兜底：log 里已有同 turn 的 turn/start（可能由 dsh 内部机制补发）
    // 就不重复 append——重复的 turn/start 会让 deliverables 等以
    // turn/start 为 start 的节点收到两个 start Match（历史加载失败）。
    // ★ O(1) 去重索引（2026-08-26 性能修复）：旧实现 session.events.some()
    // 全扫——主会话 13.7 万事件级时每次子代理 turn 都是秒级全数组扫描。
    const dup = dedupeIndexFor(session).structKeys.has(`turn/start:${baseTurn}`)
    if (dup) {
      turnStarted = true
      return
    }
    turnStarted = true
    // 【V3.1】名字行不再随骨架落地（挪到镜像段首块前）——par 并发下所有
    // 演员的骨架先于一切内容落地，随骨架写=名字连排（V3.0 事故）。
    // 【2026-09-10 v7】骨架入区块缓冲，随整段按开跑顺序落盘。
    mirrorBuffer.push({ type: 'turn/start', data: { turn: baseTurn }, surface: undefined })
    // 记录镜像 turn 的 scope（合成 turn/start 时；子代理自身没有 turn/start）。
    // 持久化到插件文件而非会话日志事件——少一个需注册的自定义类型，
    // 重建也不再依赖主会话日志。fire-and-forget：写失败仅打日志。
    let scopes = turnScopesBySession.get(sid)
    if (scopes === undefined) {
      scopes = new Map()
      turnScopesBySession.set(sid, scopes)
    }
    scopes.set(baseTurn, scopeInfo ?? [])
    void writeTurnScopeFile(resolved.femoRoot, sid, scopes).catch((error: unknown) => {
      console.log(`[dsh-femo] write turn-scope file failed: ${String(error)}`)
    })
  }
  const ensureStepStart = (step: number): void => {
    if (currentStep === step) return
    // 幂等兜底：投影窗 log 里已有相同 turn:step 的 step/start 就不重复。
    // ★ O(1) 去重索引（2026-08-26 性能修复，同 ensureTurnStart）。
    let dup = false
    if (windows.god !== undefined) {
      dup = dedupeIndexFor(windows.god).structKeys.has(`step/start:${baseTurn}:${step}`)
    }
    if (dup) {
      currentStep = step
      return
    }
    currentStep = step
    ensureTurnStart()
    mirrorBuffer.push({ type: 'step/start', data: { turn: baseTurn, step }, surface: undefined })
  }
  const onChildEvent = (watched: Session, watchedEvent: SessionEvent): void => {
    if (String(watched.id) !== String(run.id)) return
    armIdle()
    // 角色占用采样（白名单过滤之前；纯读取登记，不改镜像逻辑——见定义处）。
    captureActorUsage(watchedEvent)
    // 【V6 时序（2026-08-30）】骨架与名字行即时落盘（turn/start、step/start、
    // speaker——直播期的稳定锚，前端 turn 级节点回退 anchor 挂在它们旁边）；
    // 内容镜像事件进 mirrorBuffer 缓冲，turn/end 到达时原子落盘成连续区块
    // （「隐形容器」，见 BUFFERED_CHILD_EVENTS 注释）。直播帧（SSE）照旧
    // 到达即广播，与落盘时机无关。V3/V5 的「到达即落盘 + 前端锚点追逐」
    // 方案已被实测证伪（par 交错下 head=最小seq/stream=最大seq 全部追着
    // 到达序物理位置跑：名字连排、Deep diving 满屏跳，god 窗日志诊断实锤）。
    const isChunk = watchedEvent.type === 'assistant/chunk'
    if (!FORWARD_CHILD_EVENTS.has(watchedEvent.type) && !isChunk) return
    const chunkWrap = isChunk
      ? (watchedEvent.data as {
          chunk?: { type?: string; index?: number; blockType?: string; text?: unknown; name?: unknown; argumentsDelta?: unknown; block?: { type?: string } }
          turn?: unknown
          step?: unknown
        })
      : undefined
    const chunk = chunkWrap?.chunk
    const sid0 = String(session.id)
    const raw = (watchedEvent.data ?? {}) as Record<string, unknown>
    const mappedTurn = mapTurn(raw.turn)
    const mappedStep = typeof raw.step === 'number' ? raw.step : 0
    // 骨架确保（turn/start+名字行、step/start+stream-host）——chunk 的任何
    // 帧（含首个 delta）都先把骨架与锚建出来，直播才有落点。step/start 也
    // 进本条件（2026-08-23 晚）：真实与合成的重复由 projectionAppend 结构
    // 等价查重拦截。
    if (watchedEvent.type === 'turn/start' || isChunk
      || watchedEvent.type === 'assistant/message' || watchedEvent.type === 'step/end'
      || watchedEvent.type === 'step/start') {
      ensureTurnStart()
      if (watchedEvent.type !== 'turn/start') ensureStepStart(mappedStep)
    }
    // 流式直播（chunk）：SSE 广播，零落盘。此刻骨架与 stream-host 锚已在
    // 窗流（session 推送先于 SSE 帧到达），前端把直播块画进镜像流末尾锚。
    if (isChunk && chunk !== undefined) {
      const sid0 = String(session.id)
      // 帧带 step：桶内块按 (index, step) 匹配——chunk index 每次 LLM 调用
      // 独立编号，react 多步必然复用（V6 起块保留在桶里，不做 step 作用域
      // 会把第2步的 delta 拼进第1步的旧块）。retain：块完成后保留在桶里
      // （V6 缓冲下镜像行要等 turn 落地才接管，即删会文字闪空）；导演路径
      // 无此标记，维持原「落地即移除」语义。
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
        broadcastSse('ai_token', { node_name: nodeName, actor, token: chunk.text })
        broadcastSse('femo_stream', { kind: 'delta', sid: sid0, node_name: nodeName, actor, blockKind: 'text', index: chunk.index, step: mappedStep, text: chunk.text })
      } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string' && chunk.text.length > 0) {
        broadcastSse('femo_stream', { kind: 'delta', sid: sid0, node_name: nodeName, actor, blockKind: 'reasoning', index: chunk.index, step: mappedStep, text: chunk.text })
      } else if (chunk.type === 'tool-call-delta') {
        // 工具调用参数流式：按源 chunk index 聚合（GLM 并行工具调用的多
        // tool-call 块 delta 交错，按「最后一个同类块」会拼参数）。
        const name = typeof chunk.name === 'string' && chunk.name.length > 0 ? chunk.name : undefined
        const argsDelta = typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : ''
        if (name !== undefined || argsDelta.length > 0) {
          broadcastSse('femo_stream', {
            kind: 'delta', sid: sid0, node_name: nodeName, actor, blockKind: 'toolcall', index: chunk.index, step: mappedStep,
            ...name !== undefined ? { name } : {},
            text: argsDelta,
          })
        }
      } else if (chunk.type === 'block-start' && (chunk.blockType === 'text' || chunk.blockType === 'reasoning')) {
        broadcastSse('femo_stream', { kind: 'start', sid: sid0, node_name: nodeName, actor, blockKind: chunk.blockType, index: chunk.index, step: mappedStep })
      } else if (chunk.type === 'block-end' && (chunk.block?.type === 'text' || chunk.block?.type === 'reasoning' || chunk.block?.type === 'tool-call')) {
        // 块类型字段是 block.type（llm StreamChunk 定义），旧代码读
        // chunk.block?.kind 恒 undefined → block_end 广播全丢 → 直播块只进
        // 不出，镜像落地后整轮双份。
        broadcastSse('femo_stream', {
          kind: 'block_end', sid: sid0, node_name: nodeName, actor, index: chunk.index, step: mappedStep, retain: true,
          blockKind: chunk.block?.type === 'tool-call' ? 'toolcall' : chunk.block?.type,
        })
      }
    }
    // 工具调用登记 + 结果直播帧（V6/V6.1）：tool/call 记 callId→name 供结
    // 果帧取名；tool/result 广播进桶由前端合并进同名 toolcall 块（官方一次
    // 调用一行：IN=args/OUT=result，前端官方行渲染）。纯 SSE 零落盘；正文
    // 截 2000 字防病态巨型结果刷屏（官方 OUT 卡 150px 内滚动，落地行承接全文）。
    if (watchedEvent.type === 'tool/call') {
      if (typeof raw.callId === 'string' && typeof raw.name === 'string') {
        toolNamesByCallId.set(raw.callId, raw.name)
      }
    } else if (watchedEvent.type === 'tool/result') {
      const msg = (watchedEvent.data as {
        message?: {
          source?: { callId?: unknown }
          content?: Array<{ content?: Array<{ type?: unknown; text?: unknown }> }>
        }
      }).message
      const callId = typeof msg?.source?.callId === 'string' ? msg.source.callId : undefined
      let text = ''
      for (const part of msg?.content ?? []) {
        for (const inner of part?.content ?? []) {
          if (inner?.type === 'text' && typeof inner.text === 'string' && inner.text.length > 0) {
            text = inner.text
            break
          }
        }
        if (text.length > 0) break
      }
      const name = callId !== undefined ? toolNamesByCallId.get(callId) : undefined
      broadcastSse('femo_stream', {
        kind: 'tool_result', sid: sid0, node_name: nodeName, actor, step: mappedStep,
        ...(name !== undefined ? { name } : {}),
        text: text.length > 2000 ? `${text.slice(0, 2000)}…` : text,
      })
    }
    // 镜像到投影窗：dsh 原生 assistant 节点渲染完整 turn（思考折叠/工具卡片/
    // 回答），零自绘 UI。上帝窗全量；角色窗按 scope 命中。主会话表面不再
    // 接收角色内容（主模型上下文保持干净）。
    if (!FORWARD_CHILD_EVENTS.has(watchedEvent.type)) return
    // 镜像裁剪（方案丙）：chunk 只镜像块边界（block-start/block-end 携带完整
    // 块内容），delta/usage/finish 不落日志——历史重放行数大幅下降，
    // 渲染由 block-end 的完整块 + assistant/message 兜底；流式走 SSE 通道。
    if (isChunk) {
      if (chunk?.type !== 'block-start' && chunk?.type !== 'block-end') return
    }
    // 【V3.1 名字行落点】走到此处=本事件已通过裁剪、必将真正落盘。名字行
    // 在首个落盘镜像事件之前写入（幂等，仅首个生效）——seq 恒紧贴内容开头，
    // par 并发下不连排（骨架期不写名字，理由见 appendSpeakerLine 处注释）。
    appendSpeakerLine()
    // 【V6.2】旁白行同款落点：跟随自己角色的骨架（首个落盘事件前），渲染
    // 位由 femo-turn-head 决定。
    appendShowpromptLine()
    // 结构事件不注 _srcSeq：dsh 迁移器对 turn/end 强制 data 两键
    // （hasOnlyKeys ['turn','reason']），第三键即冷加载拒载整窗。幂等由
    // projectionAppend 的结构等价查重兜底。
    const structural = watchedEvent.type === 'turn/start' || watchedEvent.type === 'turn/end'
      || watchedEvent.type === 'step/start' || watchedEvent.type === 'step/end'
    // _srcSeq 用「子会话id#seq」复合键（2026-08-24 故事接龙 bug）：one-shot 子
    // 会话的本地 seq 都从相近小值起步，兄弟子代理之间必然撞号——projectionAppend
    // 按 _srcSeq 全局判重会把后到者的尾部事件静默误杀（第5棒的 block-end 263/264
    // 与 message 267 被第2棒同号占用→悬空 block-start 渲染不出内容=「有名字没
    // 内容」）。加子会话 id 前缀做命名空间隔离；主会话镜像保持裸数字键（单一
    // 来源无撞号），且数字 !== 字符串，新旧键天然互不干扰。
    const data = structural
      ? { ...raw }
      : { ...raw, _srcSeq: `${String(run.id)}#${Number(watchedEvent.seq)}` }
    if ('turn' in data) data.turn = mappedTurn
    if ('step' in data && typeof data.step === 'number') data.step = data.step
    // 【2026-09-10 回合失败行归属】与 subagent-native 同款：error 收口的回合
    // ①先落带 turn 归属的 dsh-femo/chat error 行（femo-turn-head 渲染在该
    // 演员名字下方），②镜像 turn/end 的 reason 改写为 completed 抑制官方
    // turnError 行的错位显示（par 交错下会挂错演员名下）。只改投影窗镜像；
    // 子代理自身日志的原始 reason 不动；存量旧数据仍走官方渲染，互不重复。
    // 【2026-09-10 v7.1】子代理的 turn/end 不再镜像、不触发区块释放：整段
    // 只有一个回合，收口 turn/end 由 releaseSection 在节点审结时合成。error
    // 收口记下原因（重试成功会被后续回合覆盖），审结时若最终仍是 error 才落
    // 归属错误行。
    if (watchedEvent.type === 'turn/end') {
      const reason = (raw as { reason?: { kind?: string; error?: { message?: unknown; code?: unknown } } }).reason
      if (reason?.kind === 'error') {
        lastErrorReason = {
          message: typeof reason.error?.message === 'string' ? reason.error.message : '',
          code: typeof reason.error?.code === 'string' ? reason.error.code : '',
        }
      } else {
        lastErrorReason = undefined
      }
      return
    }
    // surface-eligible 事件（assistant/message、tool/result）要求 surfaceOp。
    const surfaceOp = SURFACE_OP_EVENTS.has(watchedEvent.type)
      ? ({ surfaceOp: 'append' } as Record<string, unknown>)
      : undefined
    if (BUFFERED_CHILD_EVENTS.has(watchedEvent.type)
      || watchedEvent.type === 'turn/start' || watchedEvent.type === 'step/start') {
      // 【2026-09-10 v7】骨架事件同样入区块缓冲（防绕过闸门即时写窗）；与
      // 合成件的重复由 projectionAppend 结构等价查重拦截。
      mirrorBuffer.push({ type: watchedEvent.type, data, surface: surfaceOp })
    } else {
      projectionAppend(windows, watchedEvent.type, data, surfaceOp, scopeInfo)
    }
  }
  const disposeListener = ctx.on('session/event', onChildEvent)
  // 响应模型标识（首轮与重试轮共用；重试轮的 usage 已由 captureActorUsage
  // 随新回合事件更新）。逻辑从原首轮回传处原样提取（零行为变化）。
  const modelIdNow = (): string => {
    const actualProvider = typeof usageCurrent.provider === 'string' ? usageCurrent.provider : ''
    const actualModel = typeof usageCurrent.model === 'string' ? usageCurrent.model : ''
    return actualProvider && actualModel
      ? `${actualProvider}/${actualModel}`
      : (actualModel || actualProvider || '')
  }
  try {
    const result = await run.result
    let output = typeof result.output === 'string' ? result.output : ''
    let steps: TranscriptStep[] = []
    if (run.localAgent !== undefined) {
      const built = buildTranscript(readSessionEvents(run.localAgent.session))
      steps = built.steps
      if (output.length === 0 && built.output.length > 0) output = built.output
    }
    if (steps.length === 0 && output.length > 0) {
      // 兜底：事件流没采到时把最终回复当单行，防该 turn 空 react（半行）
      steps = [{ step: 0, cot: '', reply: output, tool_calls: [], tool_results: [] }]
    }
    // 被 run-control 掐断（暂停/暂停/出错/开跑清理）：不写面板错误表、
    // 不向引擎回传（引擎已在暂停流程中，ai 等待协程已被取消）。
    const runControlAbort = runControlAborted.has(controller)
    if (!runControlAbort && result.stopReason !== 'completed' && result.stopReason !== 'max-tokens') {
      recordError(session.id, `子 agent 结束异常：${result.stopReason}`)
    }
    // 异常结束且零产出 = 执行体失败（B5）：显式上报引擎（沉默收场），
    // 不交空台词。有产出仍按正常交卷（内容优劣由引擎校验裁决）。
    let submitFailure = false
    if (!runControlAbort && output.length === 0 && steps.length === 0
        && result.stopReason !== 'completed' && result.stopReason !== 'max-tokens') {
      submitFailure = true
      await sendActorFailure(bridge, jobId, waitKey, 'executor_error',
        `子 agent 异常结束（stop=${result.stopReason}）且无任何产出`).catch(() => undefined)
    }
    // 思考链已在 onChildEvent 实时显示（带角色名的折叠行），这里不再重复。
    // 待办⑨：把响应本节点的实际模型带回引擎落 react_steps.model_id——
    // usageCurrent 由子代理 request/context 事件喂给（=真实请求配置，非声明值）；
    // main 节点引擎侧固定 'main'，不吃这个值。格式 provider/model（与 actor
    // source 声明格式一致），取不到任一端则退化为单值，全空为 ''。
    if (!runControlAbort && !submitFailure) {
      await bridge.send('human_input', {
        job_id: jobId,
        wait_key: waitKey,
        body: { output, steps, model_id: modelIdNow() },
      })
    }
    console.log(`[dsh-femo] subagent done: ${String(request.node_name ?? '')} stop=${result.stopReason} output=${output.length}ch steps=${steps.length}`)
    if (output.length > 0) {
      console.log(`[dsh-femo] subagent output head: ${output.slice(0, 300).replace(/\n/g, '\\n')}`)
    }
    // ── 停靠（2026-09-05 重构，施工清单 v4 §6.2(b)）────────────────────
    // 首次交卷≠节点审结：引擎校验失败会发 node_retry（宿主 steer 让执行者
    // 续跑），此刻子代理必须还活着。停靠等审结：retry → 经租约 steer → 等
    // 新回合 → 取新片段组装回传；done（node_settled ok/gave_up）→ 收尾；
    // aborted（暂停/出错/bridge 死亡/15min 超时）→ 落入既有 finally。
    if (!runControlAbort) {
      // 停靠=合法静默：先解除空闲看门狗（停靠期无子会话事件，不解除会被
      // 误判空闲掐断）；重试轮 armIdle() 恢复武装。
      if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined }
      let verdict = await broker.park(waitKey)
      while (verdict.kind === 'retry') {
        armIdle()
        const childAgent = run.localAgent
        if (childAgent === undefined) {
          // 理论不可达（远端 provider 才会缺 localAgent）：无法 steer——显式
          // 上报执行体失败（B5），引擎沉默收场；不伪装空台词。
          await sendActorFailure(bridge, jobId, waitKey, 'executor_gone', '重试轮无可执行体（localAgent 缺失），无法续答').catch(() => undefined)
          break
        }
        const snapshotLen = readSessionEvents(childAgent.session).length
        // 轮内 steer 重试：先清上一尝试的直播残留（(index,step) 同键，不清
        // 会把两次尝试的文字拼进同一块）；状态行保持常亮（整轮未结）。
        broadcastSse('femo_stream', { kind: 'end', sid: String(session.id), node_name: nodeName, actor, turn: baseTurn })
        // 【经租约 steer】统一路径——循环体不直接碰 localAgent。
        broker.steerLease(waitKey, RETRY_STEER_TEXT(verdict.attempt, verdict.feedback))
        // 等新回合收口=官方静止原语 whenIdle；abort / 5min 超时兜底退出。
        // race 结束后注销全部未触发 listener（防每轮泄漏一个）。
        const cleanupFns: Array<() => void> = []
        const abortPromise = new Promise<void>((resolve) => {
          const onAbort = (): void => resolve()
          controller.signal.addEventListener('abort', onAbort, { once: true })
          cleanupFns.push(() => controller.signal.removeEventListener('abort', onAbort))
        })
        const turnTimeoutPromise = new Promise<void>((resolve) => {
          const t = setTimeout(resolve, RETRY_TURN_TIMEOUT_MS)
          cleanupFns.push(() => clearTimeout(t))
        })
        await Promise.race([childAgent.whenIdle?.() ?? Promise.resolve(), turnTimeoutPromise, abortPromise])
        cleanupFns.forEach(fn => fn())
        // 对【新回合片段】调用 buildTranscript：两回合 step 号都从 0 起，全量调用
        // 会合并同桶（落库不重复：引擎按 turn_id+step_idx 落库，上轮行已落）。
        const retryEvents = readSessionEvents(childAgent.session).slice(snapshotLen)
        const built = buildTranscript(retryEvents)
        if (!retryEvents.some(e => e.type === 'turn/end') && built.steps.length === 0 && built.output.length === 0) {
          // 回合超时/执行体失效且零产出（B5）：显式上报引擎（沉默收场），
          // 不交空台词、不再停靠（引擎将终结本节点的重试环）。
          console.log(`[dsh-femo] 节点重试回合未观测到 turn/end 且零产出（node=${nodeName}），上报执行体失败`)
          await sendActorFailure(bridge, jobId, waitKey, 'turn_timeout', '重试回合超时且零产出').catch(() => undefined)
          break
        }
        output = built.output
        steps = built.steps.length > 0 ? built.steps
          : [{ step: 0, cot: '', reply: output, tool_calls: [], tool_results: [] }]
        await bridge.send('human_input', { job_id: jobId, wait_key: waitKey, body: { output, steps, model_id: modelIdNow() } })
        // 再停靠，再解除（重试轮看门狗随下一轮 armIdle 恢复）。
        if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined }
        verdict = await broker.park(waitKey)
      }
      if (verdict.kind === 'aborted' && !runControlAborted.has(controller)) {
        // 停靠超时（15min）/清场后引擎仍在等本回合回传（3600s 才超时）——
        // 显式上报执行体失败（B5），引擎沉默收场；Job 暂停场景投递会被
        // 引擎活跃校验拒绝，无害。
        await sendActorFailure(bridge, jobId, waitKey, 'park_timeout',
          '停靠等待超时（15min），执行体未在时限内交出重试回合').catch(() => undefined)
      }
    }
  } catch (error: unknown) {
    // Idle timeout or interruption: tell the engine this node produced
    // nothing and let it continue, recording the failure in the panel.
    // 【run-control 掐断例外】暂停/暂停/出错的全场中断：引擎已在暂停流程中
    // （ai 等待协程已被取消），不回传、不记错误（暂停不是错误），仅留日志。
    const message = error instanceof Error ? error.message : String(error)
    if (runControlAborted.has(controller)) {
      console.log(`[dsh-femo] subagent stopped by run-control: ${String(request.node_name ?? '')} ${message}`)
    } else {
      recordError(session.id, `子 agent 中断：${message}`)
      console.log(`[dsh-femo] subagent interrupted: ${String(request.node_name ?? '')} ${message}`)
      await sendActorFailure(bridge, jobId, waitKey, 'executor_error', message).catch((sendError: unknown) => {
        console.log(`[dsh-femo] 执行失败信号回传失败: ${String(sendError)}`)
      })
    }
  } finally {
    activeSubagents.delete(activeEntry)
    activeChildRuns.delete(String(run.id))
    // 停靠登记与 API 慢层计数兜底清（幂等；done/aborted/异常全路径都到这）。
    broker.unregister(waitKey)
    apiRetry.clearChild(String(run.id))
    // 角色占用落盘（演出收尾；中断/超时路径也写——usage 已采到的就值得留）。
    persistActorUsage()
    // 名字行兜底（V3）：零事件子代理（立即失败/空闲超时，一个子会话事件都
    // 没发过）没有骨架事件触发 appendSpeakerLine，这里补写让错误行/无输出
    // 空档有归属；正常路径已在 ensureTurnStart 写过，幂等跳过。
    appendSpeakerLine()
    // 【V6.2】旁白行兜底：零事件路径同款（带 turn 落盘，风险与 speaker 兜底
    // 等价）；正常路径幂等跳过。
    appendShowpromptLine()
    // 【2026-09-10 v7】区块释放（幂等；正常路径已在 turn/end 到达时释放）：
    // 缓冲全量落盘 + 合成 turn/end 兜底 + 直播 end 帧放行——落盘顺序由段落
    // 闸门裁决（更早开跑的区块先落），不再即时写窗。合成件结构键与子代理
    // 真实 turn/end 同款（turn/end:<turn>），幂等由 projectionAppend 结构
    // 等价查重拦截。turnStarted=false 说明本回合连骨架都没落过（与旧行为
    // 一致：不写骨架）。
    releaseSection()
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    disposeListener()
    await run.dispose()
    console.log(`[dsh-femo] subagent disposed: ${String(request.node_name ?? '')}`)
    // 【版本分流】归档/移出仅限旧版（meow fork）：0.1.3 原生版的常驻执行体
    // 子代理必须留在会话树里——冷恢复（persistence.stat + sendMessage）依赖
    // 持久化，移出目录即断身份；它不对用户展示（前端目录按 femo-actor-/femo-proj-
    // 前缀 ban，观看面是 femo-proj 角色投影窗），留在持久层也无拒载风险
    // （原生子代理只含官方词汇事件，投影/剧本行早已走窗侧，不落子代理会话）。
    if (!isNativeMode()) {
      // Archive the child session: its trajectory is already stored in Femo's
      // memory, so it only clutters the subagent list (dsh has no session
      // deletion API; archive hides it while keeping the durable log).
      const registry = ctx.get('workspaceRegistry') as { archiveSession?(id: string): Promise<unknown> } | undefined
      if (registry?.archiveSession !== undefined) {
        try {
          await registry.archiveSession(String(run.id))
          console.log(`[dsh-femo] archived child session ${run.id}`)
        } catch (error: unknown) {
          console.log(`[dsh-femo] archive child session failed: ${String(error)}`)
        }
      }
      // 子代理会话目录移出 dsh sessions 树（备份区）：不删文件、可移回；
      // 移出后不再出现在会话列表/投影缓存（镜像已全量落主会话，此目录是冗余备份）。
      await moveChildSessionOut(ctx, resolved, run).catch((error: unknown) => {
        console.log(`[dsh-femo] move child session failed: ${String(error)}`)
      })
    }
  }
}
