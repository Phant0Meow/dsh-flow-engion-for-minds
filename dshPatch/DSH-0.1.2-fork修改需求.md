# DSH 0.1.2 快照 fork 修改需求书（基于 0.1.2-alpha.1 实测调查）

> **用途**：0.1.2-rc.x 上 npm 后切新快照时，让接手 AI 按本文件**逐条**把新版快照恢复成喵版状态。与快照内 `MEOW_MODIFICATIONS.md`（rc.2 版）配套使用：rc.2 版记录的是"已完成的 diff"，本文件记录的是"0.1.2 上怎么重做"。
> **调查基线**：官方 tag `dsh-v0.1.2-alpha.1`（HEAD = cd5ef81 Merge PR #3248），源码 clone 于 `D:\myFiles\dsh\_review\dsh-alpha-0.1.2`（对照核验用，保留勿删）。
> **调查方法**：本地双仓库逐符号核验（rc.2 快照 vs alpha clone），全部行号/原文来自 alpha 实读，非推测。
> **⚠️ 行号免责**：行号以 alpha.1 为准；rc.x 落地后如对不上，按文中给出的**符号搜索词**重新定位（机制面大概率稳定，行号会漂移）。
> **红线路径**：`packages/core/session/src/known-event-types.ts` 是**生成文件**（`scripts/gen-persistence-catalog.ts` 生成、`pnpm run verify-persistence-catalog` 校验新鲜度）——**严禁手改**（M-004 的教训：手改行会被 revert 且校验报不新鲜）。所有扩展一律走运行时注册面（本文件条目 3）。

---

## 重放总览

| MEOW 条目 | 内容 | 0.1.2 状态 | 工作量 |
|---|---|---|---|
| 1 | CLI 入口拒绝默认 `~/.dsh` 家目录 | 需重放，**CLI 结构有变**（parseDshArgs 搬家） | 小 |
| 2 | web 端口外部化 | 机制无 diff，无源码改动 | 零 |
| 3 | 会话事件类型运行时注册面（M-013）| **需重放，本文档主体**——alpha 反而更依赖它（fail-closed 收紧+ignorable 删除） | 小（1 小时级） |
| 4 | tool-session-query 搜索排除规则 | 需重放，包路径未变，5 文件明细照旧 | 小 |

配套（插件侧，已就绪无需改）：dsh-femo `src/index.ts` apply 时经 `ctx.effect` 判存调用 `registerSessionEventType`（stock 构建优雅降级逻辑保留）；`build.mjs` 已 external `@deepseek-ai/dsh-session`（防双实例注册失效）。femo 插件自身的 0.1.2 适配（与本体 fork 无关的另一叠工作）见记忆库 topic `0mtc7jxe`（conversationEvents→uiConversation.events、ChatNodeViewProps→ui-chat、构建 externals/typeRoots 重接、composer 对齐、lineage-fork 重放）。

---

## 条目 3（M-013 重放）：会话事件类型运行时注册面

### 为谁 / 为什么
dsh-femo 往 Femo 会话写自定义事件 `dsh-femo/chat`（九种 kind 的剧本对话行），渲染靠官方 ConversationNodeDefinition 匹配事件流。**0.1.2 把读路径守卫收得更紧**：
- 读路径对不在生成白名单内的事件类型直接抛 `SessionFormatUnsupportedError` 拒绝**整个会话**（fail-closed，Agent Note 2026-08-25）；
- rc.2 时代的 `ignorable` 信封字段被**整体删除**（官方判定无生产写入者）；
- 官方注明白纸黑字：out-of-repo 类型的注册面 *"deferred until such a consumer exists"*。

后果：不打此补丁，**任何官方构建（含 3080）都无法加载含 `dsh-femo/chat` 的会话**——包括 Femo 主会话（sys 回执写在那里）。本条目把注册面在 0.1.2 上实现掉，并已同步在官方 Discussions 推进上游化（#4815 请愿 + #4204 消费者实证回复，若上游落地本条目归零）。

### 改动 A：新增 `packages/core/session/src/known-event-registry.ts`（全新文件，40 行）

rc.2 版（提交 `57662a0`）原文**逐字照搬**即可——它 import 的 `./known-event-types.ts` 在 alpha 同路径同导出，无需改动：

```ts
/**
 * Runtime extension of the persisted event-type vocabulary for out-of-repo
 * consumers.
 *
 * `KNOWN_SESSION_EVENT_TYPES` is generated from repository-internal
 * `SessionEventMap` declarations; downstream plugins cannot contribute to it.
 * This registry lets such a plugin admit the session event types its own log
 * appends, so the persistence read path interprets them instead of refusing
 * the log as newer-harness output. Registrations are process-global and
 * idempotent; the returned disposer removes the type (HMR-safe).
 * @module @deepseek-ai/dsh-session/known-event-registry
 */

import { KNOWN_SESSION_EVENT_TYPES } from './known-event-types.ts'

const registeredEventTypes = new Set<string>()

/**
 * Declare a session event type this runtime may read, in addition to the
 * generated vocabulary. Call during plugin setup, before any session whose
 * log contains the type is loaded.
 * @param type - the event type string to admit (for example `'dsh-femo/chat'`).
 * @returns a disposer that removes the registration.
 */
export function registerSessionEventType(type: string): () => void {
  registeredEventTypes.add(type)
  return () => {
    registeredEventTypes.delete(type)
  }
}

/**
 * Whether the persistence read path may interpret an event of this type:
 * generated vocabulary or an active runtime registration.
 * @param type - the event type to test.
 * @returns `true` when the type is known to this runtime.
 */
export function isKnownSessionEventType(type: string): boolean {
  return KNOWN_SESSION_EVENT_TYPES.has(type) || registeredEventTypes.has(type)
}
```

**为什么**：生成白名单是构建期封闭集合，插件类型天生不在内；注册面把"构建期封闭"在运行期开一个受控的口——插件声明"认识"，读取器才敢解释（不绕过 fail-closed，是声明式扩大已知集合）。

### 改动 B：`packages/core/session/src/index.ts`（+1 行导出）

- **位置**：L35（符号搜索：`KNOWN_SESSION_EVENT_TYPES } from './known-event-types.ts'`）
- **原文**：
  ```ts
  export { KNOWN_SESSION_EVENT_TYPES } from './known-event-types.ts'
  ```
- **改成**：紧随其后加一行
  ```ts
  export { isKnownSessionEventType, registerSessionEventType } from './known-event-registry.ts'
  ```
- **为什么**：coordinator 从 `@deepseek-ai/dsh-session` 包名导入（见改动 C），注册面必须经包入口重导出。

### 改动 C：`packages/session/session-persistence/src/coordinator.ts`（2 处）

**C-1. import 块加一个名字**
- **位置**：L9-17 的多行 import（来源 `@deepseek-ai/dsh-session`；符号搜索：`KNOWN_SESSION_EVENT_TYPES,`）
- **原文**（L12）：
  ```ts
    KNOWN_SESSION_EVENT_TYPES,
  ```
- **改成**：
  ```ts
    KNOWN_SESSION_EVENT_TYPES,
    isKnownSessionEventType,
  ```

**C-2. 拒绝校验点接线（本条目的灵魂）**
- **位置**：L1141，`private assertEventsSupported(meta, events)` 方法内（符号搜索：`KNOWN_SESSION_EVENT_TYPES.has(event.type)`）
- **原文**（alpha L1140-1143）：
  ```ts
      for (const event of events) {
        if (KNOWN_SESSION_EVENT_TYPES.has(event.type)) continue
        throw this.unsupported(meta, `session "${meta.id}" contains event type "${event.type}" (seq ${event.seq}) unknown to this harness; refusing to interpret the log — it was likely written by a newer harness`)
      }
  ```
- **改成**：
  ```ts
      for (const event of events) {
        if (isKnownSessionEventType(event.type)) continue
        throw this.unsupported(meta, `session "${meta.id}" contains event type "${event.type}" (seq ${event.seq}) unknown to this harness; refusing to interpret the log — it was likely written by a newer harness`)
      }
  ```
- **为什么**：这是 fail-closed 的**唯一拒绝点**（0.1.2-alpha.1 实测：`KNOWN_SESSION_EVENT_TYPES` 全仓只有 known-event-types.ts 定义、index.ts 导出、coordinator.ts 消费三处）。alpha 与 rc.2 的差异：校验从 rc.2 的 L1063 `isKnownSessionEventType(event.type) || event.ignorable === true` 收紧为纯生成集判断（ignorable 字段已删）——所以重放后**不需要也不应该**恢复 ignorable 分支。所在函数 `assertEventsSupported`、错误诊断文本、`unsupported()` 的 raw-log 定位均与 rc.2 同构，无其他接线点。
- **语义红线**：只把"生成集 ∪ 注册集"作为放行依据，不改诊断文本、不加静默跳过——官方 fail-closed 的忠实重建目标完整保留。

### 改动 D：`packages/session/session-persistence/tests/coordinator-contract.ts`（补测试用例）

- **位置**：文件 alpha 同路径存在；rc.2 版 `57662a0` 已写过这组用例（注册后接受 / dispose 后拒绝），照搬并对照 alpha 的测试写法微调（alpha 该文件的断言风格若有变，以 alpha 为准）。
- **为什么**：注册面是运行时行为，必须有契约测试钉住（disposer 移除注册后重新拒绝，证明 HMR 安全）。

### 应用方法与验证
1. 手改四处（浅克隆无 cherry-pick；可对照 rc.2 快照 `git -C D:\myFiles\dsh\dsh-meow0.1.1-rc.2 show 57662a0` 取原 diff）。
2. 验证：`pnpm run test packages/session/session-persistence`（rc.2 版为 505/509 过，sqlite symlink EPERM 为环境性失败与本题无关）；`pnpm run verify-persistence-catalog`（确认没碰生成文件）；3081 起后开一个含 `dsh-femo/chat` 的旧 Femo 会话，历史正常加载即成功。

---

## 条目 1 重放：CLI 入口拒绝默认 `~/.dsh` 家目录

### 为谁 / 为什么
同 rc.2（MEOW 条目 1）：喵版与官方版同机共存防误读写 `~/.dsh`。

### ⚠️ 0.1.2 结构变化：parseDshArgs 搬家了
rc.2 的 `parseDshArgs` 在 `apps/cli/src/bin.ts`；**alpha 里搬到了 `apps/cli/src/args.ts` L112**（bin.ts 只剩 L24 的调用行 `const invocation = parseDshArgs(process.argv.slice(2), readVersion())`）。

### 修改明细
- **位置**：`apps/cli/src/bin.ts`，`parseDshArgs(...)` 调用之后（L24 附近；或按 dda82f7 原风格放进 args.ts，二选一以最小 diff 为准）。
- **改法**：守卫块原样（代码见 rc.2 提交 `dda82f7`）：解析 home 与官方默认比较（Windows 忽略大小写），相同则打印 `dsh-meow: DSH_HOME is unset...` 并 `process.exit(1)`。
- **依赖确认**：`@deepseek-ai/dsh-home-paths` 在 alpha 存在且被使用（`apps/cli/src/profile-boot.ts` L32 就有 `import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'`），import 无障碍。
- **验证**：清空 DSH_HOME 裸跑应报错退出；设 `DSH_HOME=D:\myFiles\dsh\dsh-home` 正常启动。

---

## 条目 4 重放：tool-session-query 跨会话搜索排除规则

- **为谁 / 为什么**：见快照 rc.2 版 `MEOW_MODIFICATIONS.md` 条目 4（投影窗 `femo-proj-*` 是持久化会话，FTS 索引后同段戏内对话多份命中；本条目在工具层加部署可配置排除，搜索来源唯一化=主会话(戏外)+`femo-proj-*-stage`(戏内)）。
- **0.1.2 状态**：包路径 `packages/session-query/tool-session-query` 在 alpha 存在（文件树已确认）。5 文件修改明细（search-scope.ts 新增 / index.ts Config / operations.ts 谓词 / 测试 / 双语 README）**照 rc.2 条目 4 执行**。
- **诚实声明**：本条目 alpha 侧**未逐行核验**（本窗口调查焦点在事件词汇表），重放时以 rc.2 diff 对照 alpha 实际源码，若 `executeSessionSearch` 签名有变按 alpha 现状适配。
- **验证**：`vitest run packages/session-query/tool-session-query`（rc.2 版 105/105）+ 3081 重启后 agent 搜索验证 femo-proj-* 隐藏、`-stage` 豁免。

---

## 条目 2：web 端口外部化

机制条目（`port: !!js ctx.webStartup.port ?? 3080` + 启动脚本 `--port 3081`），本体零 diff。0.1.2 需复核一点：alpha 的 profile 配置 flag 语法未变（cordis.yml `!!js` 仍是条件装配机制，根 AGENTS.md 仍载明）。重放动作 = 仅确认 start-meow.ps1 无需改。

---

## 升级顺序总表（结合 femo 插件侧适配）

1. 下载 0.1.2-rc.x 快照 → 建 `dsh-meow0.1.2-rc.x` 目录（浅克隆）→ 全量 `pnpm run build`
2. **本体 fork 重放**：本文档条目 3（M-013，第一优先——不做则 femo 会话全灭）→ 条目 1 → 条目 4 → `MEOW_MODIFICATIONS.md` 重写为新版号
3. **femo 插件适配**（独立工程，清单见 topic `0mtc7jxe`）：构建 externals/typeRoots 重接 → import 三连改（uiConversation.events / ui-chat / ui-subagent）→ currentCwd 重写 → lineage-fork 重放 → composer 对齐 → `pnpm run build` → 重启 3081
4. **剧本冒烟**：debug神器 + notify-theater 跑通 = 验收
5. 观察注册面上游进展（#4815/#4204）：若官方接受并发布，后续快照删除本文件条目 3

---

## 版本备忘

- 本文调查对应 alpha.1（cd5ef81）；0.1.2-rc.x 落地后**先跑一遍符号搜索复核**：`KNOWN_SESSION_EVENT_TYPES.has`（coordinator 接线点）、`known-event-types.ts`（生成文件头部）、`parseDshArgs`（CLI 入口）——三处符号齐就说明本文档仍有效。
- 本文件的姊妹记录：`dsh-meow0.1.1-rc.2\MEOW_MODIFICATIONS.md`（rc.2 已完成态）、记忆库 `0mtc7jxe`（femo 插件侧适配）、`0mtc8uve`/`0mtcllkk`（上游推进与绕开路线验尸）。
