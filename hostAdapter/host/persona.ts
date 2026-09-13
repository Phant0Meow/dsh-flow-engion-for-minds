/**
 * persona.ts — Femo 会话的身份证 + 导演手册。
 *
 * 身份判定：presetOf / isFemoAgent（会话 header 的 agentPreset 标记 + UI 切换
 * 的 live override）。主模型注入面：femo:docs（语法文档指路），走
 * systemPrompt.section——不污染用户可见聊天。运行结果通知不走这里：
 * 已改为 agent.steer 对话流直达（见 engine-events.ts steerMainAgent，
 * 2026-08-23 废弃 femo:notify section）。registerPersonaHooks 负责
 * agent/created（override 重建）与 agent-preset/selected（切换时补注入/
 * 清除 docs section）两个钩子。从 index.ts 原样迁出（2026-08-23 重构）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: pulls the agent-preset domain's event declarations
// ('agent-preset/selected' merge into cordis Events).
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { packageRoot } from './config'
import { readSessionEvents } from './session-events'

/** Femo sessions carry this agentPreset marker in their session header. */
export const FEMO_PRESET = 'dsh-femo'

/**
 * Session-level preset overrides: the session header is a deep-frozen
 * creation fact, so a preset picked from the UI menu (agentPreset.select →
 * recompose) never rewrites it — the switch only lands as an
 * 'agent-preset/selected' log event. Mirrors dsh-agent-presets'
 * resolveSessionPreset: newest selection wins, header is the fallback.
 */
const presetOverrides = new Map<string, string>()

/**
 * femo:docs section 的 effect disposer 表（按 sessionId）：
 * - 防重：同名 section 在同一 agent scope 重复注册会抛错（systemPrompt 约束）；
 * - 切走 preset 时调用 disposer 清除，普通会话不留 Femo 文档段。
 * 会话销毁时 section 随 agent ctx 的 effect 自动清理（条目残留无害，disposer 幂等）。
 * run-control 的 handleCreateSession 在 setup 回调里写入（导出供跨模块共用同一实例）。
 */
export const femoDocsSections = new Map<string, () => void>()

/** One session's frozen creation facts, the minimum presetOf needs. */
export interface PresetBearingIdentity {
  readonly id: SessionId
  readonly header: { readonly agentPreset?: string }
}

/** The preset one session actually runs (override first, header fallback). */
export function presetOf(session: PresetBearingIdentity): string | undefined {
  return presetOverrides.get(String(session.id)) ?? session.header.agentPreset
}

/** Whether an agent belongs to a Femo session (subagents excluded: they
 * inherit the parent's agentPreset but must run normally). */
export function isFemoAgent(agent: Agent): boolean {
  return presetOf(agent.session) === FEMO_PRESET
    && agent.session.header.parentSession === undefined
}

/**
 * 向一个 agent ctx 注入 femo:docs section（语法文档指路，scoped：只对主会话
 * agent 生效，子代理不继承，角色不需要）。setup（create-session）与
 * agent-preset/selected 兜底（下拉菜单 recompose 路径）两条路径共用。
 * @returns section 的 effect disposer；无 systemPrompt 或注册失败（如同名
 * 重复）返回 undefined。
 */
export function injectFemoDocs(agentCtx: Context): (() => void) | undefined {
  const systemPrompt = (agentCtx as unknown as { systemPrompt?: { section(s: { name: string; order: number; text: string }): () => void } }).systemPrompt
  if (systemPrompt === undefined) return undefined
  try {
    return systemPrompt.section({
      name: 'femo:docs',
      order: 50,
      text: `femo 剧本语言完整语法文档在：${packageRoot}语法文档.md（速查表和最小模板已在你的 persona 里；memory/context/module/file: 地址规则等冷门语法查这里）。`
        + `示例剧本在：${packageRoot}femoExamples/（goal-loop.femo 循环+变量退出 / group-chat.femo par+@func 随机间隔 / discussion.femo for+if+par+人类拍板 / town.femo 动态 scope+add/remove 移动）。`
        + '写剧本前先读一个最接近需求的示例照着改；写复杂剧本前建议把 femoExamples/ 整体读一遍，学习 scope/vars/flow 的常见套路。'
        + 'file: 地址规则：相对路径=相对剧本文件所在目录解析；剧本未保存（纯文本直接运行）时只支持绝对路径。'
        + `干跑自检：用 femo-debug 工具（零 token，FakeHost 替 AI/人类发言）空跑当前挂载的剧本；要更细的玩法——单测某个 module、定向注入变量、概率沉默、注入无效赋值测重试链路——直接用插件根目录的调试器 CLI：${packageRoot}femo_debugger.py run <剧本> --module 名 / --set 变量=值 / --assign-prob 0.7 / --flaky 0.3（用法见文件头注释；它产出的流水与终报跟 femo-debug 返回同源）。`
        + `运行记录查询：每场演出的台账在 user_data/memory/Chronica.wor（SQLite/WAL，mode=ro 只读连接即可，不影响运行中的引擎，无需停演再查）；`
        + `插件根目录有现成查询器 ${packageRoot}chronica.py——「python chronica.py」看最新场次的发言流，「python chronica.py 场次号」看指定场次，「--list N」列最近 N 场一览，「--scope」让每行附带可见用户/可见角色信息（排查视野类问题用）。`
        + '输出分两幕：【对话流】=showprompt 旁白+AI 发言+人类输入（这是戏本身）；【幕后指令】=节点 prompt（教 AI 怎么说话用的，不属于对话流）。',
    })
  } catch (error: unknown) {
    console.log(`[dsh-femo] femo:docs section inject failed: ${String(error)}`)
    return undefined
  }
}

/**
 * 注册 persona 相关钩子（原 apply() 内的 agent/created + agent-preset/selected，
 * 由 index.ts 总装调用一次）。
 */
export function registerPersonaHooks(ctx: Context): void {
  // Preset switches from the UI menu land as 'agent-preset/selected' log
  // events (recompose does not touch the frozen header); keep a live override
  // so isFemoAgent sees the switch. Rebuilt from the log on agent creation so
  // a cold-resumed switched session still rejects.
  ctx.on('agent/created', ({ agent }) => {
    const events = readSessionEvents(agent.session)
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'agent-preset/selected') {
        presetOverrides.set(String(agent.session.id), event.data.agentPreset)
        break
      }
    }
  })
  // 'agent-preset/selected' 的事件声明由 @deepseek-ai/dsh-agent-presets 的
  // 模块增强提供；此处经宽化签名调用（运行时同一 ctx.on 同一字符串）。
  ;(ctx.on as (event: string, listener: (sessionId: SessionId, agentPreset: string) => void) => () => void)(
    'agent-preset/selected',
    (sessionId: SessionId, agentPreset: string) => {
    presetOverrides.set(String(sessionId), agentPreset)
    console.log(`[dsh-femo] preset override ${sessionId} -> ${agentPreset}`)
    // femo:docs 注入兜底：下拉菜单切 Femo 模式走 recompose，不执行 create-session 的
    // setup 回调（section 只在那条路径注入过）——这里补注入；切走时清除。
    const sid = String(sessionId)
    if (agentPreset !== FEMO_PRESET) {
      const dispose = femoDocsSections.get(sid)
      if (dispose !== undefined) {
        dispose()
        femoDocsSections.delete(sid)
        console.log(`[dsh-femo] femo:docs section removed (preset -> ${agentPreset})`)
      }
      return
    }
    if (femoDocsSections.has(sid)) return
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) {
      console.log(`[dsh-femo] femo:docs inject skipped: agent for ${sessionId} not found`)
      return
    }
    const dispose = injectFemoDocs(agent.ctx)
    if (dispose !== undefined) {
      femoDocsSections.set(sid, dispose)
      console.log(`[dsh-femo] femo:docs section injected (recompose path)`)
    }
    },
  )
}
