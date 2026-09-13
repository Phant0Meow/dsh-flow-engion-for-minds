# 0.1.5 dsh可零改动直接接入，低版本dsh不支持。
# 现在不成熟，还有很多bug。欢迎开发者一起来品鉴这个项目。它真的非常好玩。
# dsh-femo — FEMO 多智能体剧本引擎（dsh 自包含插件版）

> **Femo** 是 **Flow Emergence** 的缩写。
> 把"像写剧本一样编排多智能体"的 Femo 引擎做成一个 **DeepSeek Harness (dsh) 插件**。
> **引擎、桥接器、插件代码、用户数据目录全在这个文件夹里**——整个文件夹就是一个插件，
> 搬到哪里都能用，不需要任何外部 Femo 安装。

## 它是什么

Femo 会话 = **dsh 主模型会话 + 多智能体剧本引擎**：

- **主模型 = 导演**：可以正常聊天、写/改剧本（`femo-mount` 挂载到会话）、干跑自检（`femo-debug`，零 token 空跑）、运行剧本（`femo-run`）；剧本运行时引擎拥有会话（pre-step 只在**轮首步**拦截 plugin 注入，不让引擎噪音把主模型叫醒），空闲时主模型照常可用；**运行中你在主窗口跟主模型说话 = 完整的一轮原生对话**（工具可以连调多轮，2026-09-11 起）；**戏内戏外不掺一轮**：你这轮没说完时，剧本轮到你下场（含同节点重试）会先排队，等这轮收口再作为新一轮开场（2026-09-11 起）
- **上帝/角色视角 = 子代理投影窗**：每个角色一个投影窗（origin:subagent），角色发言投影进对应窗口；主会话表面只留戏外内容——主模型上下文天然干净
- 每轮发给 LLM 的 system prompt 与上下文由 **femo 引擎**按角色组装（soul 卡片 + 记忆 + scope 视角隔离）
- 聊天窗口是**舞台监视器**：角色发言渲染为彩色气泡、节点提示渲染为公告条、流程状态居中灰字
- human 节点等待时你的回复会桥接进引擎；非等待时打字 = 硬停止
- 主模型写剧本前，system prompt 会指路语法文档（`femo:docs` section），先读文档再写，不凭印象猜语法
- AI 节点可走 dsh 子 agent（工具调用 + 思考链），也可走引擎内置 LLM 桥
- 节点执行者支持 `ai` / `human` / `@mind` 动态分发：同一节点按运行时执行者自动分流（AI 走 LLM 路径、人类等待输入），执行者由变量指向、运行中可切换

剧本语言（.femo）：`meta / actors / code / vars / action / module / mainflow`，支持 scope 视角隔离、par 并行、fork/join 网关、断点续跑、`@mind` 运行时分发。AI 角色可用 `source` 指定模型（`source:模型id` 走默认 provider，或 `source:provider/模型id` 完全指定；省略跟随主模型），编译期校验，写错立即报错（详见语法文档）。

## 目录结构（自包含布局）

```
dsh-femo/                  ← 整个文件夹就是插件
├── hostAdapter/               dsh 接口侧（host/ 宿主进程 TS + client/ 聊天窗 bundle + python/ 桥进程，见 hostAdapter/README.md）
├── femoGen/                可视化剧本编辑器（React/Vite）
├── femoToolcall/           AI 工具箱：femo_debugger / chronica / femo-chat
├── femoCompiler/            femo 引擎：parser / runtime / 并发 / SQLite 记忆
├── femoBridges/             LLM 桥 + getDir（用户目录解析）
├── femoExamples/           示例与测试剧本（.femo）+ 伴生 @func 模块
├── user_data/              ★ 运行时数据：projects（你的剧本）/ memory（台账）/ host-history（会话显示：projections 投影窗 + drafts 草稿）/ jobs（后端 Job 状态）
├── host.manifest.json      宿主能力清单（thinking 档位/默认用户——接别的 harness 换这份文件）
├── build.mjs / package.json / cordis.patch.yml
```

**用户数据自包含**：数据库、剧本、checkpoint 都落在本文件夹的 `user_data/` 下——整个文件夹打包/拷贝，数据跟着走。

## 安装

> 本仓库目前为**私有**，公开后即可使用一键安装；当前请使用下方手动装配。

```sh
# 仓库公开后可用（安装时自动编译，包内含 prepare 脚本，装完重启 dsh web 生效）：
dsh plugin --profile web add github:Phant0Meow/dsh-femo
```

### 手动装配

```bash
# 1. 把整个文件夹放进 profile 的 node_modules（或 junction 指过去）
#    e.g. ~/.dsh/profiles/web/node_modules/dsh-femo

# 2. 环境要求
pip install requests          # Python 3 唯一必需依赖（引擎 LLM 调用）

# 3. 在 profile 的 cordis.patch.yml 注册
- insert:
    - id: dsh-femo
      name: 'dsh-femo'
      config:
        enabled: true

# 4. 重启 dsh web
```

配置里 `femoRoot` **可省略**（缺省 = 插件文件夹自身）；只有把引擎拆出去单独放时才需要指定。

## 配置（cordis.patch.yml 可覆盖）

| 键 | 默认 | 说明 |
|---|---|---|
| `femoRoot` | 插件包根 | 引擎根目录（缺省自包含；单独拆分引擎时指定） |
| `python` | `python` | Python 可执行名 |
| `provider` / `model` / `apiUrl` | deepseek / deepseek-v4-flash / api.deepseek.com | 引擎 AI 节点的 LLM 路由（引擎内置桥） |
| `hostAiBackend` | `true` | AI 节点走宿主子代理（原生工具调用 + 思考链）；旧配置名 `dshAiBackend` 兼容 |
| `dshProvider` | `deepseek-official` | 裸 id `source` 归属的 dsh LLM provider；空 source 跟随主模型（见语法文档） |
| `defaultActorTools` | `true` | 角色未声明 `tools:` 时的工具开关；剧本里可逐角色 `tools: true/false` 或白名单 |

## dsh 版本要求

插件往会话日志写入自定义事件类型 `dsh-femo/chat`。历史加载需要 dsh 的**事件注册面**
（`registerSessionEventType`，dsh 官方注释预留的特性，未随官方版本发布）：

- **0.1.3+ 官方构建**：插件启动时自动做**运行时白名单注册**（进程内存级，幂等，
  升级 dsh 后无需任何手工操作）——无需打任何补丁。
- **含注册面的 dsh**（本特性上游化后的官方版，或打补丁的构建）：完整功能，历史正常加载。
- **旧版官方原版**（既无注册面、注册又不可用的极端情况）：插件照常工作、live 会话完全
  正常；**唯一限制**——重启后，含 `dsh-femo/chat` 事件的旧会话历史无法加载（dsh 拒绝
  未知事件类型是设计行为）。新会话不受影响。

<details>
<summary>历史方案：给官方 dsh 打白名单补丁（已被运行时注册取代，留档）</summary>

### 给官方 dsh 打补丁（10 分钟）

让官方版也支持历史加载，只需把 `dsh-femo/chat` 加进 dsh 的**已知事件类型白名单**。
改动极小（一个文件一行），下面给出精确到行的操作步骤。

**目标文件**：`@deepseek-ai/dsh-session` 包内的 `KNOWN_SESSION_EVENT_TYPES` 定义处。

**源码运行版**（`node --import tsx` 启动的 dsh，文件在
`packages/core/session/src/known-event-types.ts`）：

找到这个数组（第 19 行起）：

```ts
export const KNOWN_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent-preset/selected',
  'agent/inbox/spliced',
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'assistant/chunk',
  'assistant/message',
  'command/done',
  'command/run',
  'compaction/end',   // ← 在 'command/run', 和 'compaction/end', 之间插入一行
```

**把**：

```ts
  'command/done',
  'command/run',
  'compaction/end',
```

**改成**：

```ts
  'command/done',
  'command/run',
  'dsh-femo/chat',
  'compaction/end',
```

**npm 安装版**（`npm install` 的 dsh，运行时加载的是编译产物）：

1. 定位包：`node -e "console.log(require.resolve('@deepseek-ai/dsh-session'))"`（或在
   `node_modules/@deepseek-ai/dsh-session/lib/` 下找）
2. 在产物文件里**全文搜索** `command/run`（白名单数组就在它附近），找到形如
   `"command/run", "compaction/end"`（或换行写法）的数组
3. 在 `"command/run"` 之后插入 `"dsh-femo/chat"`（保持数组语法一致）

**注意事项**：

- 该文件头部标注 `GENERATED ... do not edit by hand`——手改可用，但 dsh 升级/重装后**需要重打**（升级后重新执行本步骤）
- 改完重启 dsh 生效；这是白名单唯一需要动的地方，其余文件都不用碰
- 高级替代：把完整注册面特性（`registerSessionEventType` API + coordinator 消费）合入 dsh——改动更正规、可随上游升级，详见本项目文档与 dsh 的 `known-event-types.ts` 头部注释（"a registration surface ... deferred until such a consumer exists"）

</details>

## 剧本

`.femo` 剧本放在 `user_data/projects/`（子目录或直接文件）。侧边栏 🎭 按钮新建 femo 会话，会话顶部「femo 剧本」面板选择/编辑/保存并运行；👁 视角切换（上帝/角色视角/🎬 戏外主模型）。

### @func / `file:` 文件放置约定

剧本 `code:` 区通过 `file:"xxx.py"` 引用 Python 模块，地址按以下规则解析：

| 写法 | 解析 |
|---|---|
| 绝对路径，如 `file:"D:/a/b.py"` | 直接使用 |
| 相对路径，如 `file:"utils/battle.py"` | 相对**剧本文件所在目录**解析（不是项目根、不是 CWD） |
| 剧本未保存（纯文本运行）时用相对路径 | 报错：提示先「导出 .femo」保存剧本，或改用绝对路径 |
| 文件不存在 | 报错 `Python Bridge: 文件不存在 <完整路径>`（不静默兜底） |

官方示例 @func 模块只在 `femoExamples/func_code/` 作为参考样本存在（首启自动复制机制已于 2026-09-12 移除，也没有任何全局回退查找位置）。自定义模块请放在剧本同目录（或子目录），与剧本一起移动。

## 出错了怎么办（剧本容错）

写剧本不用怕演员演砸，运行时的错误各有个的去处：

- **网络/限流自动兜底**：模型限流、网络抖动这类临时毛病，请求层自动退避重试（最长约 15 分钟），你无感；实在连不上，该节点按"沉默收场"处理，剧本继续往下走，不会中途断掉
- **演错了自动重来**：演员忘了写 SET VARIABLE、写错变量名这类剧本错误，引擎会把报错发回给演员本人（子代理窗/主窗口能看到 ⚠️），让 ta 修正后重演；次数由节点 `max_retries` 控制（默认 2 次）
- **每次报错都告诉你**：每次剧本错误都会实时出现在聊天窗（⚠️）和错误面板，不管重试有没有救回来；被跳过的节点会在剧终汇总报给导演，不会悄悄吞掉
- **致命错误立即喊停**：配置缺失（没 key/没模型）、剧本语法错误这类救不回来的，立刻停下并把原因报给你

人类节点同样有容错：变量赋值不合法时输入框会带着错误提示重新打开，改到合法为止（同样受 `max_retries` 约束，超限按超时放行留痕）。

## 调试（零 token 干跑）

正式运行前先空跑一遍：`femo_debugger.py` 伪装成宿主（FakeHost），AI 动作与人类输入全部由调试器合成替答——**不调用任何模型**，引擎仍按真实管线跑完整流程（赋值校验、条件边、循环、par/fork、module、`@func` 落库全套走一遍），所以它既测剧本 bug，也暴露引擎 bug。

- **人看**：femoGen 左下角打开调试窗 → 头部「编译」按钮，DebugLogBus 流水（节点进出 / 变量 `old → new` / 合成赋值与来源 / 重试 / 告警）实时流进面板
- **AI 看**：主模型有 `femo-debug` 工具——把当前挂载的剧本干跑一遍，流水 + 终报（每轮结局与报错、节点执行顺序、边覆盖、变量快照 diff、未达节点）一次性回给主模型，写/改完剧本先自检再开演
- **无副作用**：不起 Job、不占会话、不写生产台账（引擎落库走独立沙盒 `cache/debug-sandbox/`，滚动保留最近 3 天）、可反复跑；同一时刻只允许一条干跑
- **更细的玩法**（CLI，用法见 `femo_debugger.py` 文件头）：`run <剧本> --module 名` 单测某模块、`--set 变量=值` 定向注入初始状态、`--assign-prob 0.7` 概率沉默、`--flaky 0.3` 注入无效赋值测重试链路、`--runs N` 多轮换种子

## 暂停与继续（运行控制）

每一次运行是一个独立的 **Job**，有自己的档案（`user_data/runs/`）：跑到哪个节点、变量世界什么样、正在演还是被挂起，全记在里面。所以：

- **暂停 ≠ 作废**：随时点「暂停」，演出挂起存档（断点保留可续跑），画布按钮变「继续」，点一下从断点接着演，不是从头重跑
- **「从头」**：作废断点重新开演（按钮就在「继续」旁边）
- **改了剧本再点「继续」**：会被拒绝并明说（改了剧本就是新戏）——想跑新版请点「从头」
- **断电/重启不丢**：引擎重启时自动对账，上次没演完的 Job 标记为挂起，「继续」照常可用
- **AI 也能找回戏**：`femo-run` 工具有 `fresh_start` / `pause` / `resume` / `list_jobs` 四个动作——主模型可以自己列出历史 Job、把落下的戏续上（哪怕隔了好几场）

> 备注：直连模式（不走 dsh 子代理、用引擎内置 LLM 桥）下 AI 调用失败时，演出同样走「挂起存档」而不是报错卡死；画布上显示的是「已暂停」，点「继续」即可重试该节点。

## 开发与测试

```bash
npm install
powershell -ExecutionPolicy Bypass -File scripts/link-workspace.ps1   # 建 @deepseek-ai 构建镜像（Windows junction）
npm run build                 # lib/index.js（host）+ lib/client.js（browser）
python hostAdapter/python/dev-bridge-test.py   # 桥接器协议冒烟
```

## 许可证

Apache-2.0
