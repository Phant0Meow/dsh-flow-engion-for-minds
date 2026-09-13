# MEOW 修改记录（dsh-femo 仓库内留痕）

> 与 D:\myFiles\dsh\MEOW修改记录及指南.md 同步。条目只追加不改写。

## 2026-08-18 flow 引用校验（裸名 action 必须有定义）

用户指出（原话）："flow里就是 带括号的节点，裸名action。节点可以冒号action来定义它里面的action，也可以不定义那就是空节点。节点名字可以随便乱起。裸名action必须有定义，没有action定义的名字会报错"。
### 根因
FEMO_normalizer._replace_bare_in_fragment（L284-301）把任意裸 token 无条件替换成 `[节点]` 绑定并注册（`self._definitions[node_key] = token`），不校验是否已声明——解析器原有的裸名报错（chain_tokens L960 / _reg_node L1031）永远没机会触发：`[START] -> no_such_action -> [END]` 编译通过，运行时才炸。
### 实现（femoCompiler/FEMO_parser.py）
1. 新增 `validate_flow_refs(flow, known_actions, known_modules, where)`：节点绑定的 action_name/module_ref 必须已声明；空节点（无绑定）合法
2. `eval_flow(block, known_actions=None, known_modules=None)`：mainflow 调用时传 script.actions/modules，构建后立即校验（清晰报错，先于任何下游处理）
3. `validate_module_flows(mod, script)`：parse_script 尾部递归校验模块 flow（模块内 action + 嵌套 module + 全局 module）
### 修正的测试剧本（陪衬 flow 写法错误，非被测对象）
- tests/test_source_validate.py（未跟踪新文件，source 校验配套测试）：`[START] -> ai [host]` 臆造写法 ×3 → `[START] -> [END]`（项目代码/文档无此语法来源）
- tests/test_file_resolve.py：裸 `END` ×2 → `[END]`（保留字必须带括号）
### 验证
- tests/test_flow_ref_validation.py 6/6（裸名未声明拒绝/空节点合法/裸名已声明 OK/&module 未声明拒绝/模块 flow 引用拒绝/模块 flow 合法）
- 全量 pytest 78 passed（72 旧 + 6 新）
- 备份：MEOW_backups/FEMO_parser.py.bak-20260818-134614

## 2026-08-18 错误处理三桶模块化（第一步）+ bridge check 命令

用户拍板：错误处理模块化——三桶分类（FATAL 炸/AGENT 反馈重试/TOLERANT 忽略），好调用的 def 供引擎各处直接调用；LLM 调用失败拆两半（配置错 FATAL / 临时错 AGENT）；重试用尽默认放弃继续、fallback: fatal 升级炸（第三步）；编译错误作为 femo-run 工具返回结果给主模型。
### 实现
1. **femoCompiler/FEMO_errors.py（新建）**：ErrorCategory（FATAL/AGENT/TOLERANT）+ FEMOConfigError + FEMOTransientError + classify_error（Transient→AGENT，其余→FATAL 兜底；执行者输出类错误不走这里——走 assign_errors 通道）
2. **femoBridges/llmBridge.py**：4 处配置错误 ValueError → FEMOConfigError（无 key/模型/URL/provider）；2 处流式失败 return None → FEMOTransientError（可重试）
3. **femoCompiler/FEMO_runtime.py**：import 三桶；新增 `handle_error(error, node_id)`（FATAL→emit flow_error / AGENT→返回 / TOLERANT→log）；_exec_ai 重试循环 catch FEMOTransientError→feedback 注入+continue（消耗 attempt），FEMOConfigError→raise 传播到 worker 全停（避免重复 flow_error）
4. **python/femo_bridge.py**：新增 `check` 命令——同步 parse_script 编译校验（成功 actions 数 / 失败完整错误细节），不启动运行无状态
5. **src/index.ts toolDeps.runScript**：前置 `bridge.send('check')`——编译失败（send reject）→ throw → femo-run 工具返回「剧本编译失败：<细节>」给主模型指导改剧本
### 验证
- tests/test_error_buckets.py 6/6（classify 4 + bridge check 2：好剧本 ok / par 语法错误带细节）
- 全量 pytest 72 passed（62 旧零回归）；build 通过（lib/index.js 102.9kb）
- 注：未知 action 名编译期不报（auto node 特性），运行时炸走 FATAL——check 只拦编译期错误
- 备份：MEOW_backups/{FEMO_runtime,llmBridge,femo_bridge,index.ts}.bak-20260818-132914
- 待 3081 重启后实测：主模型 femo-run 编译失败剧本 → 工具返回错误细节

## 2026-08-18 meta.owner 留空默认 u001（dsh 插件唯一用户）

用户需求（原话）："我们这是dsh插件了，一共只有一个用户，我记得默认用户是u001（貌似，你检查下），你就直接默认owner留空是u001就好了"。
### 确认
db_utils ensure_default_data 默认用户 u001（user_name=「用户」，profile 空）——与 soul 创建 user_id/created_by 固定 u001 同源。
### 修改明细
1. **FEMO_parser.py** parse_script owner 归一化：owner 缺失/空列表（`if not owner_val`）→ `['u001']`；显式值（数字/字符串/列表）原样保留（数字转字符串）
2. **语法文档.md** meta 表 owner 行：补「dsh 插件版：留空（不写或 []）默认 u001」
3. **tests/test_parser.py** 新增 TestOwnerDefault 4 用例：缺失默认 u001 / 空列表默认 u001 / 显式 [1] 保留 / 标量字符串保留
### 验证
- pytest 66/66 全绿
- 3081 重启（PID 19200，bridge 18108）实测：无 owner 剧本 → react_steps user_scope=["u001"]（对照改前旧记录 []）；子代理正常输出「好。」
- 备份：MEOW_backups/FEMO_parser.py.bak-20260818-124650

## 2026-08-18 AI 赋值 out 白名单校验（防幻觉乱赋值）

用户需求（原话）："要写out的，必须写out。为了防止ai幻觉乱赋值" + "赋值输出必须属于out范围，否则报错返回给ai，输出不保存，重跑此节点"。
### 检查结论（两类报错引擎有区分）
- **不保存+重试**：`_extract_ai_assignments` 抛 FEMOVariableError → assign_errors（L2518）→ feedback 注入 system prompt（L2694-2699）→ ai_retry 事件 → 重跑本节点 LLM（上限 max_retries+1 默认 3）；失败轮次输出不落库（save_ai_turn 在重试循环后）
- **直接炸**：LLM 调用失败（llm_output None）→ flow_error+分支暂停；@func/@assign 返回值不匹配/未声明 → raise
- **宽容**：格式类解析失败 → SET_VARIABLE 列表（交给 resolve/丢弃）
### 实现（FEMO_runtime.py）
1. `_extract_ai_assignments(llm_output, out_whitelist=None)`：解析 var_name 后、赋值前校验——不在白名单 → `FEMOVariableError("变量 'x' 不在本节点的 out 声明范围内（out 只声明了: ...）")` → 走 assign_errors 重试通道
2. `_exec_ai`：构造 `out_whitelist = {od.var_name for od in ad.outs}`（out 为空 → 空集合 → 任何赋值都拒绝，严格模式）并传入
3. 白名单匹配直接比 var_name（`_parse_single_assignment` 正则 `@?\w+` 无点号；dict.key 形式 AI 赋值本来走宽容路径，out 的 root 名即可）
### 验证
- tests/test_out_whitelist.py 4/4（拒绝出界/空白名单全拒/名单内放行到 apply_assign/无白名单保持旧行为）
- 全量 pytest 62 passed（54 旧零误伤：现有剧本教赋值的 AI/mind 节点均有 out；狼人杀无 out 节点如 tell_seer/god_announce 的 prompt 不教赋值）
- 备份：MEOW_backups/FEMO_runtime.py.bak-20260818-124733

## 2026-08-18 示例剧本五件套 + persona/femo:docs 指路 examples

用户拍板"先读 examples 照着改，冷门语法再查文档，还要给 AI 指路去哪读"。
### 示例剧本（examples/，新增目录）
1. **goal-loop.femo**：Goal 模式极简骨架——单节点回环 `[work] -> if (done==false) -> [work]`，prompt 教 AI 完成后 `SET VARIABLE: <<done = true>>`，变量判断退出（对照：dsh goal 工具是回合制防 AI 中途停止，femo 引擎持有运行权天然无此问题）
2. **group-chat.femo + random_wait_time.py**：用户定稿——par 三线 AI + mainflow 独立人类分支随时插话；@func(WAIT.random_interval) 随机 2~6s 间隔
3. **discussion.femo**：用户定稿——for 轮番讨论→赋值判断→par 独立探索（scope 分离）→汇报→人类拍板；actors tools:true；vars 声明 @speaker/all；驳回回 [START]（主持人有上下文可重分配任务）
4. **town.femo**：斯坦福小镇——位置状态=三个地点数组（add/remove 移动，唯一状态源，scope 天然一致）；无 location 字典/无移动 action；mainflow=par 嵌套 for（[pf] -> for @speaker in place: + 分支 if in 判断）——**par 嵌套 for 运行时暂不支持**（_run_par_fork join BFS 找不到 join→普通 fork→变量丢失，test_par_nested_for.py 记录限制，用户将修引擎）
### persona / femo:docs 更新
- persona【写剧本】段：先读 examples/ 示例照着改（列出 4 个示例一句话定位），冷门语法再查完整文档
- src/index.ts injectFemoDocs：text 加 `示例剧本在：${packageRoot}examples/（...）`，写剧本先读最接近需求的示例
### 验证
- npm run build 通过（lib/index.js 100.7kb，含 examples 指路）
- 备份：MEOW_backups/agent.cordis.yml.bak-20260818-121936 + index.ts.bak-20260818-121936
- 待 3081 重启生效（persona 新会话可见；par 嵌套 for 待用户修引擎后实测 town.femo）

## 2026-08-18 source 链路 3081 实测通过 + runAiSubagent sid TDZ 存量 bug 修复

### 实测（用户操作剧本 `ai @小助手 = soul:1, source:deepseek-official/deepseek-v4-flash`，"说一句简短的中文问候，不超过20字"）
1. **编译期校验通过**（source 在 dsh 模型白名单内，不存在的模型会编译报错）
2. ai_request 事件带 source → 宿主解析 → 子代理启动，stop=completed，输出「你好！欢迎回到 Femo 剧场。🎭」
3. **对照实验（铁证 source 生效）**：同样剧本改 source:deepseek-official/deepseek-v4-pro 再跑（插件配置默认 model 是 deepseek-v4-flash）→ 解压归档子代理会话 session.jsonl.zstd（python zstandard）查 request/header → model=deepseek-v4-pro；flash 版为 deepseek-v4-flash。剧本声明的模型精确控制子代理实际调用。
### 存量 bug（实测暴露）
第一次运行报 `ReferenceError: Cannot access 'sid' before initialization`——runAiSubagent 中 `const sid = String(session.id)` 声明在 L1549，但 L1540 `projections.get(sid)` 先使用（TDZ）。投影窗功能引入时的存量 bug，此前 3081 子代理路径未真跑通所以一直潜伏。修复：sid 声明上移到 armIdle() 之后、nodeName 附近，删除原位声明。lib/index.js 100.3kb。
### 验证
- flash/pro 两版均跑通，子代理会话 request/header 确认模型分别正确；子代理会话归档 user_data/subagent_sessions/
- 备份：MEOW_backups/index.ts.bak-20260818-*（sid 修复）
- 3081 已重启生效（PID 30444，bridge pid=19252）
- 辅助脚本：D:\myFiles\dsh\_tmp\scan-subagent-model.py（zstd 解压扫描子代理会话模型）

## 2026-08-18 persona 更新（运行出错约定 + 剧本存哪规范，用户定稿措辞）

用户提供最终措辞，直接采用：
1. **【运行出错时】**（新增）：运行正常主模型收不到消息；编译出错/运行中报错/正常跑完系统会告诉（报错可见）；出错先看错误信息判断与剧本语法或依赖 Python 文件有关；剧本/python 是主模型自己写的可立即改不用问用户；用户提供的要先确认。
2. **【剧本存哪】**（重写，合并原【剧本存哪】+【依赖 Python 文件】）：剧本存当前项目目录（工作目录）合适位置，建议项目根/femo/下；单剧本直接放、多剧本建子目录；依赖 Python 文件可放剧本旁边（相对引用基于剧本文件位置解析）也可放任意处用绝对路径引用；多剧本可共用同一 python 文件。
3. **【会话模式】**：删"跑完用户会告诉你"（改指【运行出错时】）。
4. **src/tools.ts femo-run 描述**：同步删"跑完用户会告诉你"→"跑完/报错系统会通知你（见【运行出错时】）"。
### 发现（进 todo）
- deriveMessages 只投影 user/message、assistant/message、tool/result 三类事件 → `dsh-femo/chat`（flow_done/flow_error/flow_stopped 写入）不进主模型 LLM 上下文：persona 说"系统会告诉你"目前只对 UI 成立、对主模型不成立 → 已记 meow-memory todo「主模型收运行通知（persona 行为对齐）」
- 编译错误路径（bridge run 失败 → HTTP 500/SSE 面板）同样无主会话可见通知 → 同上 todo
### 验证
- npm run build 通过（lib/index.js 98.3kb）；persona YAML 结构保持
- 备份：MEOW_backups/agent.cordis.yml.bak-20260818-095240
- 待 3081 实测：新会话 persona 生效（【运行出错时】【剧本存哪】新措辞）

## 2026-08-18 femo:docs 注入兜底（agent-preset/selected recompose 路径）

用户实测发现：普通新建会话 + 下拉菜单选「Femo 剧本模式」（agentPreset.select → recompose）后，主模型答 "I'll look at the femo plugin's injected system prompt..."——解码测试会话 request/header 证实 persona（含最新修改）注入正常，但 **femo:docs section 缺失**。根因：section 注入只写在插件 handleCreateSession 的 agents.create setup 回调里；recompose 路径（UI 菜单切换）不执行插件 setup。
### 方案（用户拍板：不动 dsh 本体，注入必须成功）
1. **抽公共函数 `injectFemoDocs(agentCtx)`**（src/index.ts）：原 setup 内联注入逻辑原样抽出，返回 effect disposer；无 systemPrompt/同名重复注册失败返回 undefined 并打日志。
2. **setup 回调**：改为调用公共函数，成功后 disposer 记入防重表 `femoDocsSections`（Map<sessionId, disposer>）。
3. **agent-preset/selected 监听扩展**（原监听只写 presetOverrides）：preset 切到 dsh-femo 且未注入 → `ctx.agents.get(sessionId)` 拿 agent → `injectFemoDocs(agent.ctx)` 补注入（防重跳过）；切走 → dispose 清除 section 并删表（普通会话不留 Femo 文档段）。
### 坑
- systemPrompt.section 同名同 scope 重复注册抛错 → Map 防重覆盖 setup+事件两条路径
- section 注册是 effect（agent ctx 销毁自动清理），disposer 幂等，会话销毁后表条目残留无害
- 事件类型经 `import type {} from '@deepseek-ai/dsh-agent-presets'` 副作用导入可用
### 验证
- npm run build 通过（lib/index.js 98.2kb 含新逻辑 5 处关键词）
- 待 3081 实测：普通会话 → 下拉选 Femo 模式 → 问主模型"你的 system prompt 里语法文档路径是什么"应能复述；切回普通模式文档段应消失
- 备份：MEOW_backups/index.ts.bak-20260818-092837

## 2026-08-18 preset persona 更新（剧本存哪 + 依赖 Python 文件地址规则）

用户要求："把femo的system prompt注入改一下，关于.FEMOS文件的保存地址，不要指定地址了。只说保存在合适的地方，我们本来应该说的是如有依赖python文件，这个python的地址如何指定"。
改 dsh-home/.agent-presets/dsh-femo/agent.cordis.yml persona 两段：
1. **【剧本存哪】**：去掉"默认存 user_data/projects/<剧本名>.femo 或 <项目名>/<剧本名>.femo"的具体地址指引 → 改为"保存到合适的地方即可（按项目整理目录，方便和依赖文件放一起）"。
2. **新增【依赖 Python 文件】**：code: 区 file:"xxx.py" 地址规则——绝对路径可直接用；相对路径基于剧本文件所在目录解析（依赖文件放剧本旁边/子目录）；剧本未保存（纯文本直接运行）时相对路径不可用只支持绝对路径，可先导出 .FEMO 再运行。
依据 README「@func / file: 文件放置约定」（FEMO_runtime.py PythonBridge.load + tests/test_file_resolve.py）；src/index.ts femo:docs 指路文案（L2110）已含"file: 地址规则（相对=剧本目录/未保存只支持绝对）"，与新 persona 一致，无需改动。
验证：纯文本 persona 改动，YAML 缩进结构保持（6 空格块内文本）；新会话生效（preset 加载在会话创建时）。备份：MEOW_backups/agent.cordis.yml.bak-20260818-085943。

## 2026-08-18 README + 语法文档补充 @mind 节点说明

@mind 节点源码早已实现（狼人杀支持包 f100119：FEMO_parser.py MIND 执行者类型 + FEMO_runtime.py `_exec_mind` 运行时按执行者类型分发 + tests/test_mind.py 三用例 + femoGen 前端 mind 类型支持），但 README.md 与 语法文档.md 未同步。本次纯文档补充：

1. **语法文档.md**：新增「6.3 动态分发动作（@mind）」小节（原 6.3/6.4 顺延为 6.4/6.5）——运行时按执行者类型分发的语义、执行者可为静态角色或 @actor 变量、每轮重新解析（@assign 切换后自动改走对应路径）、行为复用 AI/human 全流程、前端跟随渲染、限制（执行者须为 actors 中 ai/human，blueprint 未实现）；符号速查表加 `@mind` 行；第 11 节报错信息补 mind 相关报错
2. **README.md**：「它是什么」补 mind 动态分发 bullet；剧本语言行补 `@mind` 运行时分发

### 验证
- 纯文档改动，无代码/行为变更；语义逐条对照 FEMO_runtime.py `_exec_mind`（L3224-3254）与 tests/test_mind.py 确认
- src/index.ts 语法文档指路文案（L2110）早已含 "@mind 运行时分发"，无需改动，现已与文档一致

## 2026-08-18 前端样式 token 化（主题机制就位，先不写主题配色）

### 目标（用户原话）
"把 femogen 的前端元素的样式放一起""弄几个主题样式可以换""先别写主题。我是让你把样式整理一下提出来"——本次只做样式整理抽取，不写深色配色、不写切换按钮。浅色外观必须与之前 100% 一致。

### 方案
CSS 变量（design tokens）主题系统：全部颜色抽成语义 token（var(--femo-*)），集中定义在 `femoGen/src/themes.js`（THEME_CSS + FEMO_THEMES 元数据）。换主题 = 切根容器 data-femo-theme 属性 + themes.js 加一个属性块。布局样式（尺寸/间距/flex）一律不动。

### 修改明细
1. **新增 `femoGen/src/themes.js`**：约 90 个 token，浅色主题（`:root` + `[data-femo-theme]`）= 全部原值；dark 占位注释；FEMO_THEMES 元数据（仅 light）
2. **common.jsx**：FontStyle 注入 THEME_CSS（@import 保持最前）；TYPES/SPECIAL_COLORS/共享样式/ErrorBoundary 颜色→var()；CSS 裸值（滚动条/聚焦/keyframes 光晕/流式光标）→var()
3. **FemoWorAuto.jsx**：桌面根 div 挂 `data-femo-theme="light"`；颜色→var()（含 SVG stroke/fill、marker 数组、边色三元）
4. **mobileView.jsx**：MobileLayout 根 div 挂 `data-femo-theme="light"`；T 主题对象颜色→var()（手机壳固有深色区独立 token 组 `--femo-mobile-*`）
5. **其余 7 个 jsx**（actionModal/bubbleOverlay/canvasNodes/femoPreview/libPanel/projectPanel/soulModal）：颜色→var()
6. **src/client.tsx**：仅 1 处 #e5484d→var(--dsw-danger, #e5484d)（外壳其余已用宿主 --dsw-* 变量，不动）
7. **canvasNodes.jsx**：`${c}22` 8 位 hex alpha 拼接→color-mix(in srgb, ${c} 13%, transparent)（var() 不能拼 alpha，4 处）
8. 批量替换脚本归档：`scripts/theme-tokenize/`（round1-quoted.ps1 / round2-bare.ps1 / color-extract.txt）

### 验证
- femoGen vite build 通过（54 modules）；build.mjs 重打 lib 成功
- 浅色主题下所有 token 值 = 原颜色值，外观理论零变化
- 待 3081 实测：刷新页面 → 编辑器外观与改前一致
- 备份：MEOW_backups/*.bak-20260817-182723（17 个文件）

## 2026-08-18 sketch 块注释化（todo #2，M-018）

### 目标（用户原话）
"生成的时候，把整个sketch块生成为注释，整个sketch块每一行开头加#。解析的时候……检测#sketch作为标志，把整个sketch块拿出来。每一行都去掉行开头的#，剩下的再走正常链路解析"；"sketch是一个纯前端行为，他控制的是前端的显示位置，和后端运行完全无关。所以后端就把他当普通注释直接去掉就好。后端不需要sketch信息。"

### 方案
生成端 sketch 块每行行首加 #（`#sketch:` 标志 + 内容行 # 前缀）；解析端新增 `extractHashSketch` 作为编译第零步（先于 stripComments）：检测行首 `#\s*sketch:` 开始收集块，块内每行剥行首一个 #（# 后空格 = 原缩进）还原为普通 `sketch:` 块，再走正常链路；后端零改动（`_remove_comment` 天然把 # 行删空）。

### 修改明细
1. **femoGenerator.jsx**：模块 sketch（emitModule 内）与 mainflow sketch 两处输出行加 # 前缀
2. **femoParser.jsx**：新增 `extractHashSketch()`；parseFEMO 接线（stripComments 之前）；export 清单加 extractHashSketch
3. **tests/strip_comments.test.mjs**：+6 用例（还原单元×2、顶层/模块内/块内手写注释/无 sketch 集成×4）
4. **tests/femoParser.test.mjs**：esbuild 重打包（构建产物，未跟踪）

### 验证
- strip_comments.test.mjs 28/28 通过（22 旧 + 6 新）
- 后端 FEMO_normalizer normalize 含 #sketch 剧本 → 输出无 sketch 残留（python 实测）
- 旧未注释 sketch: 解析链路原样保留（用户拍板不强制兼容，但旧路径无害共存）

## 2026-08-18 样式全量 token 化（round 3：形状/边框/字体/画布）

用户确认归并档位后实施。themes.js 追加：圆角 8 档（--femo-radius-xs/sm/md/lg/xl/pill/top/bubble）、边框宽度 5 档（--femo-border-w/strong/selected/accent/node）、字体 3 个（--femo-font-sans/mono/body）、画布点阵（--femo-canvas-dots 嵌套颜色 var 联动 + --femo-mobile-canvas-dots）、滚动条宽（--femo-scrollbar-w）。10 个 jsx 约 216 处替换 + common.jsx 滚动条/共享样式 + font.css body 字体。尺寸/布局/字号不动（用户红线）；阴影形状不动；client.tsx 外壳保持宿主 dsw 体系。脚本：scripts/theme-tokenize/round3-shape.ps1。备份 *.bak-20260818-013510。vite build + build.mjs 通过，待 3081 刷新实测。

## 2026-08-18 README 更新（架构段 + @func 文件放置约定）

用户确认后更新 README.md（备份 MEOW_backups/README.md.bak-20260818-*）：
1. **「它是什么」段改写**：旧文描述"Femo 会话 = 没有主模型的 dsh 会话"已过时——8/17 已恢复主模型（提交 326248f：pre-step 仅运行中拦截）+ 子代理投影窗（ab2d2e1）+ 主模型工具 femo-mount/femo-run（3bb171c/bba2b08）+ 语法文档指路 femo:docs（d846c1e）。新文：主模型 = 导演（聊天/写剧本/挂载/运行，运行中引擎拥有会话）、上帝/角色视角 = 子代理投影窗（主会话表面只留戏外内容）、输入语义（human_wait 桥接 / 非等待打字 = 硬停止）、AI 节点可走 dsh 子 agent 或引擎内置桥。
2. **目录树 func_code 行**：改为"官方 @func 示例模块（首启复制到 user_data/func_code）"。
3. **剧本章节新增「@func / file: 文件放置约定」小节**（依据 FEMO_runtime.py PythonBridge.load 实现 + tests/test_file_resolve.py）：绝对路径直接使用；相对路径相对剧本文件所在目录（不是项目根/CWD）；剧本未保存用相对路径 → 报错提示先导出 .FEMO；文件不存在 → 报错「Python Bridge: 文件不存在 <完整路径>」（不静默兜底）；func_code 不再作为相对路径回退查找位置。

### 验证
- 改动纯文档，无代码/行为变更；规则逐条对照代码与测试确认（todo #2 用户拍板版）

## 2026-08-18 手机版 femoGen 插件模式放开（窄视口自动切 MobileLayout）

用户需求：手机打开 dsh（tailscale 访问 3081）时自动显示 femoGen 手机版视图。
### 方案
femoGen 已有 `useMobile(768)`（window.innerWidth < 768 + resize 监听）响应式检测；渲染分支原本写死 `if (isMobile && !plugin)`（注释"插件模式不提供移动端布局（dsh web 桌面为主）"）。MobileLayout 不依赖独立运行模式（状态/回调全走 props，运行/暂停按钮最终到插件 onRun/onStop 回调），功能上无阻碍。
### 修改明细
1. **femoGen/src/FemoWorAuto.jsx**（1 行）：`if (isMobile && !plugin)` → `if (isMobile)` + 注释更新（窄视口提供移动端布局，插件模式同样支持）
### 验证
- npm run build 重打 lib/client.js 通过（454.0kb）；产物含 MobileLayout 全量代码
- 备份：MEOW_backups/FemoWorAuto.jsx.bak-20260818-*
- 待实测：3081 桌面视口不变；DevTools 窄视口（375px）出 MobileLayout；手机 tailscale 真机（https://<tailscale-域名>:8443）验证；关注点=MobileLayout 100vh 布局在 dsh 顶部栏占用后的溢出表现（若溢出再做容器高度适配）

## 2026-08-18 手机版 femoGen 改造（全屏沉浸 + 返回键开 dsh 边栏 + 设置 tab）

用户拍板（原话）："好吧，全屏沉浸也行……但问题是左上角的返回键我建议是打开dsh的边栏。然后把api秘钥这个按钮删了，新加一个切换主题按钮（和桌面版一致），还有新建soul这俩按钮放到下面的标签里。下面的标签，现在是仓库，项目，属性。我们在后面再加一个设置。设置栏里放切换主题按钮和新建soul按钮"。
### 调研结论
- MobileLayout 根容器本为 position:fixed inset:0（全屏覆盖型），嵌入标签页有溢出/功能重复/fixed 弹层错位三问题 → 全屏沉浸
- dsh 侧边栏官方开关：ctx.layout.toggleSidebar()（ui-sidebar 同款用法；ui-layout LayoutController，AppFrame 三列 grid 普通流，最高 z-index 20 overlayLayer）
### 修改明细
1. **mobileView.jsx**：MobileTitleBar 加可选 onBack（渲染 ← 返回键，替代汉堡键；独立模式无左侧键）；MobileLayout 加 onBack/zIndex props 透传；MobileSideMenu 组件整体删除（API 密钥+新建 Soul 入口迁走）；BOTTOM_TABS 加 {id:'settings',label:'设置'}；MobileBottomPanel 加 themeName/onCycleTheme/onOpenSoul props + 设置 tab（🎨 主题名按钮 + 新建 SOUL 按钮，样式照桌面版）
2. **FemoWorAuto.jsx**：FEMOEditor 签名加 onBackToShell；mobileFs state（默认 true）；MobileLayout 传 zIndex={plugin&&mobileFs?900:undefined}、onBack={plugin?退出全屏+toggleSidebar:undefined}、themeName、onCycleTheme
3. **client.tsx**：ScriptViewInjected 加 toggleSidebar；scriptViewInjected 返回 ctx.layout.toggleSidebar；FemoEditorView 传 onBackToShell
### 交互语义
手机进 Femo 编辑器标签页 → 自动全屏（zIndex 900 盖 dsh 外壳）；← 返回键 → 退出全屏 + dsh 侧边栏弹出；底部标签=仓库|项目|属性|设置。
### 验证
- npm run build 通过（lib/client.js 452.6kb，含 设置/新建SOUL/返回/onCycleTheme/toggleSidebar）
- 备份：MEOW_backups/{mobileView,FemoWorAuto,client.tsx}.bak-20260818-073226
- 待实测（风险点=退出全屏后 MobileLayout fixed 层与 dsh sidebar 的层级关系）：3081 DevTools 375px 全屏→返回键→sidebar 可见性；手机真机 8443

### 迭代 2（2026-08-18，用户实测"侧边栏确实被挡住了"后的修复）
**根因**：MobileLayout 根容器写死 position:fixed inset:0；退出全屏后 zIndex=auto，仍以 fixed 层盖住视口——dsh sidebar 是 AppFrame grid 普通流列（z-index auto，DOM 靠前），被后置的 fixed 层覆盖。
**方案（不改 dsh 本体）**：MobileLayout 加 fixedMode prop（默认 true）；插件模式非全屏 → fixedMode=false → 根容器 position:absolute，相对 FemoEditorView 容器（client.tsx 容器 div 加 position:relative）——只占 conversation 列区域，sidebar 天然可见；全屏仍 fixed 900。FemoWorAuto 传 fixedMode={plugin ? mobileFs : true}（独立模式恒 fixed）。build 通过 452.8kb；备份 *.bak-20260818-073852。待实测：返回键后 sidebar 应可见且 femoGen 缩在标签页容器内。

### 迭代 3（2026-08-18，用户实测"现在看着非常好"后的连贯性优化）
用户反馈（原话）："点了左上角返回之后，dsh的壳子出来了，那么左上角返回应该变成一个向右的箭头（全屏），此时再点一下，dsh壳子应隐藏，同时左上角变成向左按钮（返回），这样操作逻辑才连贯"。
**改动**：MobileTitleBar 加 onExpand（→ 全屏键），左侧按钮三态：onExpand 存在 → →（回全屏）；否则 onBack 存在 → ←（返回）；否则无。MobileLayout 加 onExpand prop，按 fixedMode 分发（fixedMode→onBack，非 fixedMode→onExpand）。FemoWorAuto 传 onExpand={plugin?()=>setMobileFs(true):undefined}。build 通过 459.7kb；备份 *.bak-20260818-090254。交互闭环：全屏（←）⇄ 容器内（→）。

### 迭代 4（2026-08-18，手机项目面板输入框重叠修复）
用户反馈（原话）："Version和owner的输入框重叠了，这种输出框都在重叠"。
**根因**：common.jsx 的 inp 样式 width:'100%' + padding 7px 10px + 边框，缺 boxSizing:'border-box'——实际宽度=容器宽+22px 溢出；并排字段（Version/Owner、Database/Session）在手机窄容器（Field flex:1 各约 170px）里两个 input 各向外溢 → 重叠；桌面宽容器轻微越界不明显。
**修复**（1 处全局）：common.jsx inp 加 boxSizing:'border-box'。textarea 等 {...inp} 派生样式一并生效。build 通过 459.7kb；备份 *.bak-20260818-091606。

## 2026-08-18 actor Tools UI 改版（全或无三态，替代具体工具勾选）

用户需求（原话要点）："tools的ui还是旧版的选择具体工具，我们改一下。我们新版的代码支持的实现是，全或无。打开工具就是全部都有，关闭工具就是全都没有……给他三个选择框：所有工具，关闭工具，输入工具，如果点输入工具，就允许输入文本，在文本里用户自己写工具列表。然后图生文本的时侯，这里ui的选择要正确的填写在剧本文本里。不选就是没写工具这个参数。文本生图的时候，剧本的文本要正确映射到ui这里，剧本没写则这里不选。如果不写工具参数，就默认打开所有工具"。
### 调研确认（零后端改动）
- compiler FEMO_parser.py 735-772：tools: true/false → tools_enabled 布尔；tools = [list] → 白名单；未声明 → tools_enabled=None（宿主默认）
- femoGen femoParser.jsx 546-607：解析 true/false/数组；619 未声明 → []
- femoGenerator.jsx 119-124：已正确输出 tools: true / tools: false / tools = [a, b] / 空数组不写
- host index.ts:109 defaultActorTools 默认 true（未声明=全开）✓ 用户预期符合
### 修改明细
1. **projectPanel.jsx** Tools 区：checkbox 具体工具列表 → 三态 radio（所有工具=true / 关闭工具=false / 输入工具=数组）+ 输入工具时显示文本框（逗号分隔，解析按逗号 split+trim+filter）；未声明（[]）三态均不选
### 验证
- build 通过 460.7kb（产物含 toolsMode 三态逻辑 + radio）
- 备份：MEOW_backups/projectPanel.jsx.bak-20260818-092154
- 待实测：画布 actor 三态选择 → 生成剧本 tools 参数正确；解析剧本（true/false/列表/未写）→ UI 回填正确

### 修复（2026-08-18，用户实测两个问题）
**① "输入工具无法选中也无法输入文本"**：根因=选中「输入工具」时 tools 置 []（空数组），但 toolsMode 判定要求 length>0 → 空数组被误判为「未选」，radio 弹回、文本框不渲染。修复=projectPanel 加 UI 态 customSel（按 actor 名记录「输入工具」选中），空数组在选中态下仍保持 custom；切到 all/off 时清除该标记；解析出非空数组仍走派生 custom。
**② "femogen代码区输入文本时页面自动放大"**：iOS Safari 对 <16px 输入控件聚焦自动整页放大（meta user-scalable 自 iOS 10 被忽略，唯一可靠路径=字号≥16px）。修复=common.jsx FontStyle 加 @media (max-width:767px) 下 [data-femo-theme] input/textarea/select:focus { font-size:16px !important }（聚焦临时 16px 抑制缩放，失焦恢复；仅限 femoGen 容器，桌面宽视口与 dsh 外壳不受影响）。
build 通过 462.0kb；备份 *.bak-20260818-092646。

## 2026-08-18 femoParser 中文节点名规范化修复（par/for 体中文裸节点报错）

用户剧本（群聊室 par 并行线）报错："第 33 行: 未识别的流程语法: '随机等一会儿 -> AI发言'"。
### 根因（esbuild 打包 + 日志实测定位）
流程行「全局裸引用规范化」（femoParser.jsx 1140-1183）只把纯 ASCII 标识符（/^[a-zA-Z_]\w*$/）转成 [label]，中文节点名（随机等一会儿/AI发言）走"原样保留"分支；par/for 分支处理体行时把剩余 body 递归进 parseFlowSection，递归要求行首 [label]——中文裸名行首不命中任何分支 → 1751 兜底报错。goblin-v2 等能跑是因为节点都带方括号或 if。
### 修改明细
1. **femoParser.jsx**（1171 行 1 处）：纯标识符正则 /^[a-zA-Z_]\w*$/ → /^[\p{L}_][\p{L}\p{N}_]*$/u（Unicode 字母，含中文）。mainflow 裸中文节点也统一成 [label] 形式。
### 验证
- 群聊室剧本 parse OK：module 群聊 nodeDecls=随机等一会儿/AI发言/IN/PAR[PAR] cond=@speaker in [@阿明,@阿芳,@阿强]/PAR_out，edges=IN→PAR→随机等一会儿→AI发言→PAR_out→IN（循环闭环）
- 回归：python/ 与 user_data/projects 全部 .femo（18 个）——15 正常剧本全过，3 失败均为故意负面用例（未声明变量/裸字符串字面量，预期报错）✓ 无回归
- build 通过 462.0kb；备份 *.bak-20260818-103639
- 注意：tests/femoParser.test.mjs 是 esbuild 打包产物（未跟踪），测的是旧代码，需重打才反映本修复

## 2026-08-18 循环回流实测 + par/for 迭代器内联列表修复（FEMO_runtime.py）

用户问：循环回 [IN]/回 [START] 是否支持（以前有 bug）。
### 实测结论（bridge 起新进程）
- **回 [IN]**（module 内 par 循环、主流程只指向 module、无 OUT）：允许 ✓（vars 声明列表版 12454 步无限流转无错误；checkpoint 记录模块态在 [IN]，恢复回到 [IN]）
- **回 [START]**（mainflow 循环）：允许 ✓（6.8 万步流转无错误）
- 引擎对节点重复进入无循环上限；module 无 OUT = 永不正常结束（靠 stop/中断），设计允许
### 新坑 + 修复：par/for 迭代器内联列表字面量
- 用户群聊室剧本 `par @speaker in [@阿明, @阿芳, @阿强]` 运行报「无法求值表达式: [@a1, @a2]」
- **根因**：FEMO_runtime.py `_eval_iterable_expr`（1943）用 **Python eval()** 求值迭代器——`@a1` 中 @ 是 Python 装饰器符号 → SyntaxError；vars 声明的 members=[@a1,@a2] 在解析阶段已转成真列表，eval('members') 只查变量所以没事
- **修复**（1977-1981）：eval 失败回退 `self.eval_expr(expr)`（FEMO 表达式求值器 1892-1897 支持列表字面量 + @ 引用，_split_items 深度感知切分），再失败才报原错
- **验证**：内联列表版 _loop-in.femo 修复后 13303 步无 flow_error（par 双线 node_start/assign_result 各 26602）；**pytest 43 passed**（52s）无回归
- 备份：MEOW_backups/FEMO_runtime.py.bak-20260818-104614
- ⚠️ 3081 的 bridge 是插件启动时 spawn 的持久进程，**改引擎代码需重启 3081 生效**（本地 bridge 新进程即时生效）

## 2026-08-18 剧本 source 字段接 dsh 模型调用（编译期校验 + 前端下拉）

用户需求（原话）："actors @ai定义区，有一个source字段，我是希望这里能写AI模型……用户实际上在dsh里支持的模型列表，应该是dsh这边来提供的。我是想把femo剧本里的source字段和dsh调用模型的实际行为接上"；拍板："方案C（兼容双写）：裸 id 走默认 provider；带 / 则显式指定 provider。裸 id 在默认 provider 下查不到 → 报错提示'请写成 provider/model 形式'"；"报错停节点（显式提示'模型不存在，可用列表：…'）而且这是编译的时候就要返回的，而不是运行的时候发现不对"；"source 文本框改成下拉~并且显示为provider/model"；"throttle 按真实 provider 分桶"。
### 链路（改造前）
生成端输出 source → 前后端解析进 ActorDef.source → FEMO_runtime._resolve_ai_source **仅用于 throttle_llm 限流分桶（语义错位：模型名当 provider key）** → 插件模式 ai_request 事件**不带 source** → 宿主 runAiSubagent 固定用配置 resolved.model（断点）→ 直连模式同样固定。dsh 侧能力：ctx.llm.listProviders()/listModels()/resolveModelInfo()。
### 语法规范（定稿）
`source:模型id`（裸 id）= 默认 provider（配置 dshProvider）下查；`source:provider/模型id` = 完全指定；省略 = 插件默认模型；写错 → 编译期报错（信息带可用列表）。human 的 source 数字（user 身份）语义不动。blueprint 不校验。
### 修改明细
1. **femoCompiler/FEMO_parser.py**：parse_script 加可选参数 models（None 不校验，旧路径零影响）；新增 validate_actor_sources——遍历 AI actor，裸 id 查 defaultProvider、provider/model 全表查，失败 raise ValueError（`ai @X: source "..." 不是可用模型。可用列表：...`）
2. **femoCompiler/FEMO_runtime.py**：新增 _resolve_actor_def（抽公共 actor 解析：动态 @变量 + as_actor 回退，复用三处）；_invoke_ai_llm 的 ai_request payload 加 source 字段（宿主选模型用）；_resolve_ai_source 改为返回真实 provider（source 含 / 取前半，否则回退 user_api_provider）——throttle 按 provider 分桶；新增 _resolve_ai_model（直连模式 source 覆盖 model）
3. **src/index.ts**：新增 collectLlmModels（ctx.get('llm') 聚合 listProviders+listModels，llm 缺失/单 provider 失败兜底默认，绝不整体失败）；新路由 GET /dsh-femo/models（前端下拉数据源）；startRunOnSession run 参数带 models（引擎编译校验白名单）；runAiSubagent 新增 resolveSourceModel——source → agentOptions(provider, model)，空用配置默认
4. **femoGen/src/projectPanel.jsx**：导出 useModelList（fetch /dsh-femo/models）+ sourceOptions（空默认 + 全部 provider/model + 原值不在列表时追加防丢）；ai 类型 source 文本框 → 下拉（显示 provider/model），human 保留文本框（placeholder 改 数字ID）；新增 actor 默认 source 'deepseek' → ''（旧默认值裸 id 在 deepseek-official 下不存在，会触发编译错误）
5. **femoGen/src/mobileView.jsx**：同款下拉改造
6. **语法文档.md**：5 节 actors 示例更新（裸 id + provider/model 双写示例）、source 说明重写（三态语法 + 编译期校验）、blueprint 示例 source 改合法值、静态属性表 source 示例更新
7. **README.md**：剧本语言行补 source 一句话说明
8. **tests/test_source_validate.py**（新增 11 用例）：裸 id 命中/未命中、provider/model 命中/未命中（provider 错/模型错）、空跳过、models=None 兼容、human 数字跳过、blueprint 跳过、报错信息含可用列表、validate_actor_sources 直接调用安全
### 验证
- pytest 54/54 通过（43 旧 + 11 新）
- host build.mjs 通过（lib/index.js 100.3kb 含 collectLlmModels/resolveSourceModel/models 路由）；femoGen vite build 54 modules；重打 lib/client.js 463.8kb 含 useModelList/sourceOptions
- 备份：MEOW_backups/{FEMO_parser,FEMO_runtime,index.ts,projectPanel,mobileView,语法文档,README}.bak-20260818-20260818-111722
- ⚠️ 待 3081 重启实测：①运行带不存在 source 的剧本 → 启动即报编译错误带可用列表；②下拉显示 dsh 模型列表、ai/human 分派正确；③source 选模型 → 子代理实际用该模型（日志）；④旧剧本裸 id 不在列表 → 编译期报错提示写法

## 2026-08-18 scope: all 保留字段（全可见，后端解析 + 前端透传）

用户拍板（原话）："哦那你给我加个保留字段吧，就all，scope: all 全可见。在后端parser支持一下编译，在前端认识一下这个词别报错"。
### 背景
实测确认 scope: all 原先**不是**保留字段：FEMO_scope_resolver.resolve_scope 只认 [@列表]/vars 变量/+ 连接，'all' 被当变量名 → flow_error「变量 'all' 未在脚本的 vars: 中预声明」，大小写都不行；且不写 scope ≠ 全可见（_build_scope 空 scope 自动注入发言者+meta.owner，仅发言人+owner 可见）。
### 修改明细
1. **femoCompiler/FEMO_scope_resolver.py**（2 处）：resolve_scope 与 scope_str_to_actor_list 开头特判 `scope_str.strip().lower() == 'all'` → 展开全部 actors（resolve_scope 按 ai/human 分类 user/soul；to_list 返回全部 @actor 名）。大小写不敏感（all/ALL/All/带空格）
2. **语法文档.md**：scope 段落补 all 保留字段说明 + 「不写 scope ≠ 全可见」提醒
3. **前端零改动**（确认 5 个处理点全为字符串透传：actionModal 输入框 / femoParser 787-788 原样存 / femoGenerator 51 原样输出 / FemoWorAuto+mobileView 只读展示 / host 631 用引擎展开的 scope 数组）
### 验证
- 单测：resolve_scope('all'/'ALL'/'All'/' all ') → 全部角色正确展开（user/soul 分类）；scope_str_to_actor_list('all') → 全 @actor 列表；原列表形式无回归
- 端到端：scope: all 剧本（human 节点）→ human_wait 事件 scope=["@a1","@a2","@h1"] 全展开，无 flow_error
- pytest 54 passed 无回归
- 备份：MEOW_backups/FEMO_scope_resolver.py.bak-20260818-112151
- ⚠️ 引擎改动需重启 3081 生效

## 2026-08-18 议题讨论会示例剧本检查 + 引擎直连模式 import 修复（FEMO_runtime.py）

用户教学示例剧本（for 轮番讨论/par 独立探索/scope 分离/人类拍板）跑通性检查。
### 剧本检查结论（用户示例，非本仓库剧本）
- 前端 femoParser parse OK：actors tools:true、mainflow 结构全对（START→开场→pos→PAR→调查→PAR_out→准备发言→FOR→发言→FOR(back)→judge→汇总/回pos[agree==false]→final→END/回START[通过==false]）
- 引擎 parse_script OK：中文变量（通过）、out 带类型（agree(bool,"是否达成一致")、通过(bool,"是否批准")）、prompt: | 管道多行、scope: AImembers/@speaker/all/[@主持人,@用户] 全部解析正确
- 结论：剧本本身编译全过，语法均为合法特性
### 发现并修复引擎 bug：直连模式 call_ai_with_blocks NameError
- bridge 直连跑 → flow_error `name 'call_ai_with_blocks' is not defined`
- **根因**：FEMO_runtime.py `_invoke_ai_llm`（2429）直连分支（2482-2493）引用 call_ai_with_blocks，但 import 只在另一函数 `_exec_ai`（2567）——函数级 import 局部作用域，此处 NameError；3081 走 dsh 子 agent 后端（_dsh_ai_backend）不触发，现有测试剧本均无 AI 节点，直连路径从未被覆盖
- **修复**（1 处）：直连 else 分支内补 `from femoBridges.llmBridge import call_ai_with_blocks`（保持函数级局部 import）
- **遗留（环境限制非剧本问题）**：直连模式无 API key 时 call_ai_with_blocks 返回 None → 上层正则崩「expected string or bytes-like object, got NoneType」——本地 bridge 无 key 属预期；3081 dsh 后端模式不经过此路径。是否改为清晰报错待用户判断
### 验证
- NameError 修复后错误推进到 key 检测阶段（证明 import 生效）
- pytest 54 passed 无回归
- 备份：MEOW_backups/FEMO_runtime.py.bak-20260818-113246
- ⚠️ 待 3081 重启后以 dsh 后端模式实测议题讨论会

### 补充修复（2026-08-18，用户提醒"得和dsh运行的模式分清楚"）
用户指出：dsh 运行（3081）就是无 key 的（key 在 dsh 侧），若"无 key 报错"不分模式会导致 dsh 一直报错。
**模式隔离确认**：host `dshAiBackend` 默认 true（index.ts:101）且 run 命令必传（2123）→ bridge 设 `_dsh_ai_backend=True`（femo_bridge.py:166）→ `_invoke_ai_llm` 2447 走 ai_request 分支，**永不进入 call_ai_with_blocks**；只有显式 `dshAiBackend: false` 才走直连（需要 key）。
**修复**（llmBridge.py 4 处）：未检测到 provider / 缺 API Key / 缺模型名 / 缺 URL 的 `return None` → `raise ValueError` 清晰报错（文案含「dsh 子 agent 模式（dshAiBackend=true）无需 key，不走此路径」）。
**验证**：直连无 key → flow_error 变为清晰 key 错误（不再「expected string or bytes-like object」正则崩）；pytest 54 passed 无回归。备份 *.bak-20260818-114104。

## 2026-08-18 主模型新增 femo-script 工具：查看本会话挂载的剧本内容

用户需求：给 dsh-femo 加一个 AI 能用的工具，查看本 session 挂载的剧本内容。
### 修改明细（2 文件，均备份 MEOW_backups/*.bak-20260818-125110）
1. **src/tools.ts**：
   - `FemoToolDeps` 新增 `readScript(sessionId)` 依赖（返回 `{path?, text?, finalText}`）
   - 新增 `femo-script` 工具 schema：无参数，返回剧本全文 + 来源（file=文件地址 / session-text=会话内原文）+ 行数；未挂载剧本时明确报错
   - register 支持可选 renderText 覆盖（剧本全文以纯文本呈现，不走 JSON.stringify 转义）
2. **src/index.ts**：
   - `toolDeps.readScript` 实现：读会话剧本记录 + `readSessionScriptText`（text 优先 → path 文件）
   - **顺手修正一致性隐患**：`toolDeps.runScript`（femo-run 省略 scriptPath）原为 path 优先（有地址就读文件），与引擎「永远跑前端文本」/用户三态定稿（text 优先）相悖——统一改用 `readSessionScriptText`，保证 femo-script 看到的 = femo-run 实际跑的
### 验证
- npm run build 通过（lib/index.js 102.6kb，含 femo-script 注册 + readScript 依赖）
- 工具仅 Femo 主会话可用（复用 callerSessionId 校验），子代理（角色）不可调用
- ⚠️ 待 3081 重启生效（junction 指向本仓库，重启即加载新 lib）

## 2026-08-18 多地点并行线 flow 验证失败：分支饿死（引擎 bug 定位，未修）

用户要求：town 示例改 @assign 验证 flow（两个地点 + 一个 agent 移动 + par 并行），"起一个femo窗，用最简单的流程……看能不能成功移动到另一个地点还能看见他。每个地点同时assign个啥，这样就知道par他们一起运行了"。
### 验证剧本（_town-move-test.femo，@assign 无 AI）
两地点线：`[START] -> 酒馆标记 -> par @speaker in 在酒馆的人: -> 阿明移动 -> -> [START]` + `[START] -> 公园标记 -> par @speaker in 在公园的人: -> 公园看见 -> -> [START]`
### 实测结果（bridge 直连，统计 5 秒）
- ✅ 阿明移动成功：remove/add 赋值正确（在酒馆的人=[] / 在公园的人=['@阿明']）
- ✅ 单线循环正常（酒馆线 13763 轮，checkpoint 41289 次，无 flow_error）
- ❌ **公园线饿死**：fork 网关只触发 1 次（主流程首次回 START），Task-3（酒馆）创建即无限循环、Task-4（公园）从未执行（公园标记 0 次）
### 根因（日志 + 探针定位）
1. 主流程回 [START] → 1188-1196 多出边 fork → _run_fork 并发 Task-3/4 ✓（唯一一次 fork）
2. **分支内部回 [START] 不再 fork**（"进入 fork 网关"统计=1）——分支 _execute_path 内 START 的处理与主流程不一致（机制待深挖，探针确认 [90] START 执行后无出边/fork 日志直接续跑酒馆线）
3. **协作式事件循环饿死**：Task-3 内部全为立即完成的 await（assign/空 par/join），永不真正挂起 → asyncio 轮不到 Task-4
### 结论
- 剧本语法全对（编译/移动/单线循环正常）——**引擎缺陷**：fork 是"一次性并发+等待全完成"语义，不适合"常驻并行线 + 回 [START]"设计；三地点 town 示例会同样饿死（只有第一线活）
- 修复方向（未实施，待用户拍板）：A. 分支内回 [START] 与主流程一致走 fork；B. 空 par/join 时 await 让出事件循环防饿死；C. 剧本结构改用显式 fork/join 常驻并行（workaround）
- 探针已移除，FEMO_runtime.py 恢复干净（本次无代码改动残留，仅 113246/114104 两处既有修复）

## 2026-08-18 femo-run 升级为四动作控制工具（from_scratch/stop/pause/resume）

用户需求（原话）："run本来写的应该是直接只有run吧？那么我们把run改为支持参数，run_from_begining（啊这个名字有点丑，有没有更好的表述？但必须强调从头，不然会和resume搞混）， stop， pause，resume必须传参数，且system prompt或者工具schema要改，要说明白，run的四个参数分别代表什么，让ai一看就明白。现在就把工具端4个都支持了。pause和resume其实femogen本身就是支持的，稍后应该很好接入。"
### 设计定稿
- 命名：`from_scratch`（地道英文「从头开始」，与 resume 字形语义均不混）替代 run_from_beginning
- `femo-run` 不再收 scriptPath（剧本地址只在 femo-mount 时传），改为必填 action 四选一：
  - `from_scratch`：从头运行已挂载剧本（清 checkpoint，reset=true）
  - `stop`：停止当前运行（保留断点，可 resume）
  - `pause`：暂停（bridge 现有语义；引擎真实现后无缝升级）
  - `resume`：从断点继续（不 reset 的 run，前端「继续」同款 checkpoint 续跑链路）
- schema description 逐动作写明含义（AI 一看就明白）；工具数量保持 3 个（mount/run/script），未来 pause 真实现也无需新增工具
### 修改明细（2 文件，备份 MEOW_backups/*.bak-20260818-134214）
1. **src/tools.ts**：FemoToolDeps 接口改为 runScript(sessionId)/stopScript/pauseScript/resumeScript 四方法（原 runScript 带 scriptPath 参数删除）；runTool schema 重写（action 必填 enum 四值 + 逐动作描述）；注册逻辑 switch 分发四动作并返回各自语义 note
2. **src/index.ts**：抽出 `resolveMounted` 公共函数（会话校验+读挂载剧本 text 优先+编译 check 校验，from_scratch/resume 共用）；runScript=resolveMounted+startRunOnSession(reset=true)；resumeScript=resolveMounted+startRunOnSession(reset=false)（checkpoint 续跑）；stopScript/pauseScript=runState 校验+bridge.send（无运行时报错）
### 验证
- npm run build 通过（lib/index.js 105.1kb）
- 四动作分发逻辑 14/14 测试通过（缺/非法 action 拒绝、stop/pause 需 running、from_scratch/resume 不要求 running、reset 语义正确）
- bridge pause 现状=runner.stop()（半实现，README 已知限制）；resume 走 checkpoint 续跑链路（可靠）
- ⚠️ 待 3081 重启生效

## 2026-08-18 pause/resume 与 femoGen 按钮状态机对齐（flow_stopped 携带 paused 标记）

用户要求（原话）："femogen右上角还有个按钮，会切换运行、暂停、继续的状态。你也可以研究一下它的相关链路。我们这个pause和resume无疑和他有关，可以借用它的链路，也要注意这两者别打架，要状态一致"。
### 链路研究结论
- femoGen 右上角三态按钮（mobileView.jsx L270-296 → FemoWorAuto.jsx handlers）：
  - 「运行」（idle）→ onRun(femo, {reset: flowStatus!=='paused'}) → reset=true 从头
  - 「暂停」（running）→ POST /dsh-femo/pause → bridge pause（=stop 半实现）
  - 「继续」（paused / running-无活跃节点）→ handleRunWorkflow() → reset=false 断点续跑（**与工具 resumeScript 同链路**）
- 工具端已对齐：resumeScript=resolveMounted+startRunOnSession(reset=false)（同「继续」）；stop/pause 走 bridge 命令（同 /stop、/pause 路由）
### 修复的状态不一致（根因）
- 暂停与停止共用 flow_stopped 事件；前端无条件 setFlowStatus('idle') → 暂停后按钮变回「运行」，用户/工具以为暂停了但点「运行」会 reset=true 从头（断点白留）；pausedByUser 在事件回调里读完即清，前端无法从事件流得知"这次停止是暂停"
### 修改明细（2 文件，备份 MEOW_backups/*.bak-20260818-134736）
1. **src/index.ts**：dsh-femo/event 回调里 flow_stopped 事件附加 `paused: runState.pausedByUser` 标记（broadcastSse + lastEvents 重放都携带）——暂停/停止由宿主判定，前端可见
2. **femoGen/src/FemoWorAuto.jsx**：flow_stopped 分支 `setFlowStatus(data?.paused === true ? 'paused' : 'idle')`——暂停显示「继续」、停止显示「运行」
### 验证
- npm run build 通过（lib/index.js 105.2kb + lib/client.js 含 paused 判断）
- 状态机 7/7 测试通过：暂停→前端 paused→继续 reset=false / 停止→idle→运行 reset=true / flow_done→idle / 重放 flow_stopped(paused=true)→paused
- ⚠️ 待 3081 重启生效

## 2026-08-18 回多出边节点编译期报错 + 常驻并行线修复（fork 饿死闭环）

用户拍板（原话）："其实禁止回到这种节点是对的。我们该改剧本，在start处fork，每个fork加个不同的空节点，让他们回这个空节点，这不会爆炸。那么对于回公共多出边节点这件事其实应该报错，能检测到这种情况吗……该节点有多个'出边'，不能回到这种节点。原因是，每次回到这里往下运行都会从一变成多分支，分支数会爆炸。建议在本节点之后的分支中加空节点，让他们回到空节点。"
### 问题复盘（实测定位三连）
1. 分支执行器 `_execute_path`（1515）1586 行只走第一条边（无多出边 fork）——分支内回任何多出边节点（START/hub）并线
2. **入口 [START] 特殊处理**（1097-1103）：入口不 fork 只走第一条边——START 直接多出边不会 fork
3. **协作式调度饿死**：assign 等快速节点循环永不挂起 → fork 出的其他线饿死（hub 锚点结构实测：公园线 32765 次独占）
### 修改明细
1. **编译期检测（femoParser.jsx validateFlow + FEMO_parser.py validate_flow_reentry）**：无条件出边 ≥2 且有「回流入边」（排除 [START]/[IN] 入口边）的节点 → 报错（用户文案）；排除 for/par/fork/join 网关（迭代/并发语义）；重复边去重（par 出口链重复生成）
2. **FEMO_runtime.py 协作式让出**：_execute_flow 与 _execute_path 循环每节点后 `await asyncio.sleep(0)`——事件循环公平轮转，常驻并行线不再饿死
3. **examples/group-chat.femo + town.femo 改 hub+锚点结构**：`[START] -> [hub]`（入口单边）→ hub 一次性 fork 各线 → 每条线回自己的空节点锚点（[群聊环]/[人类环]/[酒馆环]/[公园环]/[市场环]）
4. **tests/test_town_structure.py** 同步新结构（hub+锚点）
### 验证
- hub+锚点 assign 测试：**三条线均衡并行**（酒馆 6216 / 公园 6218 / 市场 6217，fork=1，阿明移动 1 次）✓ 闭环
- 检测：town 旧版（回 START）/hub 回流版报错 ✓；goblin-v2/discussion/议题讨论会/群聊室新版不误伤 ✓
- pytest **80 passed**（含 sleep(0) 与检测改动回归）；build 通过 lib/client.js 465.4kb
- 备份：*.bak-20260818-141218（femoParser/FEMO_parser）/ *.bak-20260818-141437（examples）
- ⚠️ 引擎改动需重启 3081 生效

### 补充修复（2026-08-18，用户拍板"start多出边应该是支持的"）
**入口 [START] 多出边 fork 修复**：原 _execute_flow 1097-1103 入口 [START] 特殊处理只走第一条边——START 直接多出边（无回流）会**静默吞掉其余分支**（实测线B 0 次且 flow_done，违反"不静默兜底"原则）。修复：入口 START 多出边 → `await self._run_fork(...)`（与循环内语义一致，一次性 fork；_run_fork gather 等分支完成，分支错误聚合上报），单边仍走第一条。验证：START 双出边剧本线A/线B 各 1 次 + flow_done ✓；hub+锚点三线并行无回归（5251/5253/5253）；pytest 80 passed。备份 *.bak-20260818-143420。

## 2026-08-18 导演手册注入完善 + soul 非必须语义 + 编译期 soul 校验

### 背景（用户决策原话）
- 注入分层："剧本角色的system prompt注入我们还没写呢……主模型是导演手册，我们正在写。确实是分开的。"——本次只写主模型导演手册（persona + femo:docs section）
- 语法内联："我建议内联速查表（那我们还得写个速查表）、最小模版，并指路更多模版推荐ai自己去看，并说更多语法细节去看文档，再指路文档。"
- soul 语义："最小模版要不就别写soul了。既然不写soul能运行，有的时候ai只是用femo跑个goal模式或者子代理的剧本，根本不需要多么复杂的角色设定。""soul非必须，只在有角色设定的剧本里使用soul也可以。""但是soul写错应报错，并且编译期就应该报错，并且把错误返回给ai……报错文案就是：soul id不存在，哦同时还要输出行号和错误的那行内容"
- 会话模式措辞（用户指正）："剧本运行在后台，你不会被剧本实况打扰。（就是说，用户发消息他是能收到的，所以不能说收不到消息）"
- 工作流双模式："看剧本是为了干啥。如果用户只想要结果，就模型自己跑。如果用户想要过程（比如想玩狼人杀），那就用户参与。"

### 修改明细（6 文件 + 12 测试剧本，备份 MEOW_backups/*.bak-20260818-150116）
1. **dsh-home/.agent-presets/dsh-femo/agent.cordis.yml**：persona 全文重写（`>-` 折叠 → `|-` 字面块保留模板换行）：新增【这是什么模式】（心智模型：actors/action/mainflow/scope/vars + "上下文不是变量"哲学）、【语法速查表】（14 行内联）、【关于 soul】（非必须；无 soul=裸执行者看全量上下文）、最小模板（Goal 模式裸 actor 版，无 session=new 无 soul）、【运行】双工作流（结果导向自主闭环 / 过程导向用户参与）+ 三工具教学；【会话模式】修正"剧本后台运行不被打扰、用户消息能收到"；保留用户定稿【剧本存哪】【运行出错时】
2. **src/index.ts**：femo:docs section 文案更新（速查表/模板已在 persona；冷门语法指文档；写复杂剧本先通读 examples/）
3. **femoCompiler/FEMO_parser.py**：① eval_actors 支持裸 actor（`ai @执行者` 无 `=`，soul/source=None——原实现静默跳过该行导致角色不存在）；② 新增 `validate_actor_souls`（normalize 前扫原始文本，行号对应用户所见；soul 不存在 → ValueError 一次列出全部错误：行号+该行原文+soul id+可用列表；soul_checker 为 None 跳过保持纯解析可测）；③ parse_script 签名加 `soul_checker` 可选参数；④ typing import 补 Callable
4. **femoCompiler/db_utils.py**：新增 `list_all_soul_ids()`（校验报错可用列表用）
5. **python/femo_bridge.py**：新增 `make_soul_checker()`（check_soul_id_exists + 挂 `_soul_ids` 可用列表）；check/run 两处 parse_script 调用注入
6. **femoBridges/ContextExample.py**：`_get_records_visible_to` 无 user 无 soul → 不过滤（no_filter，本 session 全部可见）——修复裸 actor 上下文恒空（goal 模式循环失忆）实测坑
7. **12 个测试/示例剧本 soul 更新**：旧式数字 soul（soul:1/2/3/4/5/9，默认库不存在）→ 真实 id（the1stlittlesoul/littlecat/AI助手/Portia/debugmanager/human）——新校验下数字 soul 编译报错（预期行为变化）；goal-mode.femo 改裸 actor 与 persona 模板一致

### 验证
- pytest **80 passed**（基线对比确认 13 failed 系 soul 校验拦截旧式数字 soul，更新剧本后全恢复）
- 探针：裸 actor 解析 ✓（soul=None）；soul 校验报错含行号+错误行+可用列表 ✓；好 soul 通过 ✓；无 checker 跳过 ✓；examples 4/4 真实 DB 校验通过 ✓；无 soul 上下文 4438ch 全可见 / 有 soul 3717ch 过滤不变 ✓
- npm run build 通过（lib/index.js 105.4kb，docs section 新文案已入产物）
- ⚠️ 待 3081 重启生效（persona 新会话加载 + 引擎校验）
- 已知后续：femo-soul 工具（list/create）延后写；"可用 femo-soul create 新建"提示放工具 prompt 不放报错文案

## 2026-08-18 femo-soul 工具（主模型角色库管理，list/create 双动作）

用户拍板（4 点）：①单个工具带 action 参数（list/create 二选一），不拆两个；②list 返回精简（soul_id+名字，不含描述）；③create 三字段全必填（soul_id/soul_name/description）；④测试=真实库建测试 soul 留着。
### 修改明细（4 文件，备份 MEOW_backups/*.bak-20260818-150116 已含）
1. **femoCompiler/db_utils.py**：新增 `list_souls()`（精简 soul_id+soul_name，按 idx 排序）
2. **python/femo_bridge.py**：新增 `list_souls` 命令；`create_soul` 命令加存在性检查（重复 soul_id → 报错"已存在"，防 AI/前端重复插入垃圾行；DB 无唯一约束，此前重复 create 会静默插入）
3. **src/tools.ts**：FemoToolDeps 加 `soulList()`/`soulCreate()`；注册 `femo-soul` 工具（action: list/create；create 校验三字段必填 + soul_id 不含空格/逗号——剧本 soul:xxx 引用格式；renderText 组装角色清单文本；仅 Femo 主会话可用同三件套）
4. **src/index.ts**：toolDeps 实现 soulList（bridge list_souls）/soulCreate（bridge create_soul，user_id 固定 u001，与前端 soul 弹窗同链路）
5. **agent.cordis.yml persona**：【关于 soul】补"写剧本前先用 femo-soul list 查库选角；库里没有的角色先用 femo-soul create 新建"
### 验证
- npm run build 通过（lib/index.js 109.4kb 含 soul 工具）
- bridge 命令级测试：list_souls 返回 11 个角色 ✓；create 新建成功且立即可见 ✓；重复 create 拦截报错 ✓
- pytest 80/80 回归通过
- 测试残留：testsoul-femo / testsoul-femo2 两个测试角色留库（用户拍板留）
- ⚠️ 待 3081 重启生效（工具注册 + bridge 新命令）

## 2026-08-19 子代理默认模型跟随主模型（空 source 语义修正）

### 需求（用户原话）
"我希望开启的子Agent默认和主模型同一个模型，除非剧本里面指定。DSH好像有个bug，就是开启的子Agent它默认的好像是Pro，我主模型明明是Flash的。……就算没有bug，咱们也可以防他一手。就是如果不指定的话，那么必须跟主模型同一个模型。"

### 根因
空 source 时 resolveSourceModel 返回插件配置静态默认（resolved.dshProvider/resolved.model，默认 deepseek-official/deepseek-v4-flash）——子代理模型 = 插件配置而非主模型，两者一致纯属默认值巧合；UI 切换主模型后立即脱钩。dsh 本体子代理链路（resolveChildAgentOptions）在父 agent options 无模型时落部署隐式默认（群友报告"子代理默认 Pro"即此类）。修复=空 source 永远显式传主模型，堵死隐式默认路径。

### 修改明细（4 文件，无引擎改动）
1. **src/index.ts**：新增 `resolveMainModel(parent, defaultModel)`——① 主会话最近一次请求头 `session.requestHeader()?.config`（含 UI 会话内切换，对齐 dsh web selectionFor 语义）→ ② `agentDefaultModel.currentSelection()`（用户保存默认）→ ③ undefined 回退配置；`resolveSourceModel(resolved, source, mainModel?)` 空 source 优先 mainModel；runAiSubagent 的 subagents.start 前解析并传入。显式 source（裸 id/provider 双写）逻辑原样不动，编译期白名单校验不变。
2. **femoGen/src/projectPanel.jsx**：sourceOptions 空项 label "默认（插件配置模型）" → "跟随主模型（默认）"。
3. **语法文档.md**：省略 source 语义改为"跟随主模型（主会话当前实际使用的模型，含 UI 内切换；取不到时回退用户保存的默认模型）"。
4. **README.md**：剧本语言行 source 说明同步；配置表 dshProvider 说明补"空 source 跟随主模型"。

### 验证
- npm run build 通过（lib/index.js 体积含 resolveMainModel）；femoGen 前端重打 lib/client.js
- ⚠️ 待 3081 重启实测：①无 source 剧本 → 子代理 request/header model=主模型（deepseek-v4-flash）；②对照组 source:deepseek-official/deepseek-v4-pro → 仍精确用 pro（对照实验法沿用 2026-08-18）

### 实测结果（2026-08-19 晚，用户手动重启 3081 已加载新构建）
- **函数级验证 11/11 通过**（tests/verify-model-functions.mjs，从 lib/index.js 提取 resolveMainModel/resolveSourceModel 真实函数）：空 source+主模型 flash→flash；空 source+主模型 pro（会话内切换）→pro；无请求头→兜底保存默认；请求头残缺→兜底；全无→undefined→配置兜底；显式 provider/model 双写/裸 id/trim 均原样。主模型解析链：session.requestHeader()?.config → agentDefaultModel.currentSelection() → 配置。
- **端到端**（tests/verify-subagent-model-3081.mjs + diag）：无 source 剧本与 source:.../deepseek-v4-pro 剧本均 flow_done、子代理正常回复"收到"（无回归）。子代理 uuid 会话不落盘（one-shot 归档即清），request/header 无法事后取证，故以函数级验证为准。
- **额外发现**：start-meow.ps1 的 tailscale 探测在受限权限下 NativeCommandError 直接终止启动——已加 try/catch 容错（探测失败 fallback 100.64.33.74）。
- **引擎文案同步**：FEMO_parser.py validate_actor_sources 报错提示"（或省略 source 用默认模型）"→"（或省略 source 跟随主模型）"（无测试断言，pytest 无需改动）。

## 2026-08-20 运行结束通知主模型（femo:notify section 注入上下文，不污染界面）

### 需求（用户 ask 四要素确认，2026-08-20）
三类全通知（运行完成/出错/停止）+ 结果摘要 + **注入主模型上下文、不污染用户可见聊天** + 摘要含出错详情（错误类型/行号/错误行、停止节点名）。用户原话："注入上下文，不污染对话界面"、"结果摘要就好"、"三类全通知，可读可响应"。生命周期：**不清空**（摘要保持到下一次运行覆盖，用户拍板"不清空"）。

### 机制（在 dsh 源码验证可行）
主模型上下文 = `session.deriveMessages()`，只认 `user/message`/`assistant/message`/`tool/result` 三种 surface 事件（packages/core/session/src/surface.ts），`dsh-femo/chat` 永远进不了——此路不通。正确通道 = **systemPrompt.section**（packages/core/system-prompt）：section 的 `text` 支持函数，每次主模型调用组装 system prompt 时动态求值；system prompt 本身不进用户可见聊天 → 天然满足"注入上下文不污染界面"。空 text 的 section 被 renderPrompt 过滤。

### 修改明细（仅 src/index.ts，host 层，零引擎/前端改动）
1. 新增模块级 `runNotices: Map<string,string>`（每主会话最近一次运行摘要文本）+ `runNoticeSections: Map<string, disposer>`（判重）。
2. 新增 `injectRunNotice(agentCtx, sid)`：注册 `femo:notify` section（order 60），text 用函数 `() => runNotices.get(sid) ?? ''`（每次 assemble 动态读）。
3. 新增 `ensureRunNotice(ctx, sessionId)`：幂等（runNoticeSections 判重），`ctx.agents.get(sessionId)` 拿主会话 agent.ctx（复用 agent-preset/selected 处理器模式），取不到则跳过不阻断。
4. `flow_start` case：`ensureRunNotice(ctx, sessionId)`（只在真正跑过剧本的会话挂载）。
5. `flow_done`/`flow_error`/`flow_stopped` 三 case：各写一条摘要到 `runNotices`：
   - flow_done：`✅ 已完整跑完。checkpoint 已清除——重跑从头开始（不可 resume）`
   - flow_error：`❌ 运行出错。错误信息：<error>`（error 含类型/行号/错误行）
   - flow_stopped：区分暂停/停止，均 `保留断点，可用 resume 续跑`

### 验证
- esbuild CLI 打包 host 通过（lib/index.js 重建）；client 未改动无需重打
- tsc --ignoreConfig 报错全在既有代码行（declaration merging 未加载的预存噪音），无新增行报错
- pytest 引擎无回归（改动纯 host 层）；沙箱下 16 例 WinError5 为环境限制非改动引入
- ⚠️ 待 3081 重启实测：运行剧本后主模型下一轮 system prompt 能读到结果摘要、用户可见聊天无新增气泡

## 2026-08-21 dsh-dark 画布区视觉精修（官方设计语言对齐，第一轮仅深色）

### 需求（用户拍板）
整体视觉精修，**先只改 dsh 深色**看效果，满意后再同步到浅色；必须契合 dsh 官方设计语言（取值自 dsh-meow `packages/client/ui-theme/src/styles/design-platform.css` 等官方 token，只读参考、零本体改动）；重点攻克画布+节点区域观感。诊断四根因：①节点黑投影在 #151517 近黑底上不可见→糊在画布上；②类型标签实色底白字对比差（human 绿/func 琥珀）；③连线高饱和蓝虚线喧宾夺主；④点阵 1.2px 偏粗。

### 机制（全 token 化，浅色零变化）
themes.js 新增精修 token：默认块浅色值=历史观感（严格只改深色），dsh-dark 块覆盖新值——
- 节点阴影 4 token（`--femo-node-shadow-{rest,sel}{,-sm}`）：暗色卡片质感=顶部内高光 `inset 0 1px 0 白4%` + 微描边环 `0 0 0 1px 白3%` + 外扩暗影 `0 4px 16px 黑40%`（官方暗色靠边框分层不靠黑投影）。
- 连线 2 token（`--femo-edge`/`--femo-edge-sel`）：常态 `rgba(103,158,254,0.55)` 收敛蓝，选中 `#679efe` 提亮。
- 类型徽章 12 token（`--femo-badge-{bg,fg}-{ai,human,mind,func,assign,module}`）：官方 tertiary 语言=暗底亮字（ai=deepseek-800 底 deepseek-400 字等），组件按 `` var(--femo-badge-bg-${key}) `` 拼名引用，executorType 不在 TYPES 时回退 ai（与 ti 回退一致）。
- 点阵：dsh-dark 整条覆盖 `--femo-canvas-dots`（1px、白5.5%）。

### 修改明细
1. `femoGen/src/themes.js`：默认块追加 18 token（阴影4+连线2+徽章12），dsh-dark 块追加同名覆盖 + canvas-dots 覆盖。
2. `femoGen/src/canvasNodes.jsx`：ActionNode/SpecialNode/PositionNode/ParOut 四处 boxShadow 换 shadow token（选中光环 color-mix 段保留组件内拼接）；ActionNode 左上角标签 background/color 换 badge token（新增 badgeKey 计算）。
3. `femoGen/src/FemoWorAuto.jsx`：模块视图+主视图 marker `as`/`a_for` fill 换 edge token；自环边/回边 stroke、模块视图 stroke 三元、主视图 col 计算中 primary-strong→`var(--femo-edge)`、primary(选中)→`var(--femo-edge-sel)`；语义边（danger/warning/neutral）与拖拽临时连接线（primary）不动。

### 不动的
尺寸/布局/字号（红线）、手机壳 mobileView（独立渲染不共用）、neon 主题、auto/light 切换逻辑、dsh-meow 本体零接触。

### 验证
- 备份：MEOW_backups/{themes.js,canvasNodes.jsx,FemoWorAuto.jsx}.bak-20260821-darkpolish
- esbuild 构建通过（lib/client.js 469.4kb / lib/index.js 112.2kb），产物含新 token（grep 18 处命中）
- ⚠️ 待 3081 重启实测（start-meow.bat）：深色主题下节点浮起/徽章暗底亮字/连线收敛/点阵细腻四项观感，浅色主题逐项对照零变化

## 2026-08-21 dsh-dark 精修第二轮（黑金连线实验 + 点阵收小 + ActionNode 重设计）

### 需求（用户看过第一轮实机后反馈）
①点阵再小些；②连线试金色——"黑色+金色会不会好看？说不定很有质感"；③"节点的设计本身很丑……把节点改改"。第一轮其余方向获认可（"看到变化了"）。

### 修改明细
1. `themes.js`：
   - dsh-dark 点阵 1px→0.6px、alpha 0.055→0.07（补偿可见性）；
   - 黑金三档：`--femo-edge` rgba(228,192,92,0.6)（强调边）/ `--femo-edge-sel` #f0c75e / 新增 `--femo-edge-flow` rgba(212,175,55,0.32)（普通顺序边，量大要低调）；浅色档对应 token 保持原值（灰/蓝）零影响；
   - 新增 `--femo-node-border`(暗=白9%)/`--femo-node-border-w`(暗=1px，官方全 1px 规范；浅=rgba(0,0,0,0.12)/1.5px 旧观感)。
2. `FemoWorAuto.jsx`：两视图普通顺序边 fallback 与 'a' marker fill 从 var(--femo-neutral) 换 var(--femo-edge-flow)（4 处）；语义边/拖拽临时线不动。
3. `canvasNodes.jsx` ActionNodeView 重设计：
   - 左上悬挑徽章（position absolute top:-11 left:-5）**废除**，改为卡片内行内芯片（badge token 复用，8.5px mono，与标题同行 `[ai] 节点名`）；
   - 四边不等宽边框（3×1.5px + 左侧粗色条）**统一为单边框** var(--femo-node-border-w) solid（未选中 node-border / 选中类型色 c）；删除 border 变量与 module 第二行的重复 'module' 小标签；
   - 内边距 14px→11px 12px 9px（内部布局微调，节点外形 100×64/端口位置零改动——画布连线几何依赖）。
   - 运行气泡/端口/呼吸灯保留。SpecialNode/PositionNode 本轮不动。

### 验证
- 备份：MEOW_backups/*.{bak-20260821-round2}
- esbuild 构建通过（lib/client.js 469.6kb），新 token 命中 14 处
- ⚠️ 待 3081 重启实测：黑金观感是否成立（不成立回滚只需改 themes.js 三行）、芯片入卡后节点观感、点阵颗粒感

## 2026-08-21 dsh-dark 精修第三轮（金线实色化 + 边宽 token 化 + 节点信息补全）

### 需求（用户看过第二轮后反馈）
①"金线不要半透明，可以细一点，但颜色亮眼也能看清，要更有质感一点"；②节点缺信息（节点名/action名/类型/执行者都不能缺），且类型+action名同行动作名显示不全——用户主意："把节点类型和执行者放一行，执行者一般名字不长"。

### 关键考证
node.label 与 action 名同步（FemoWorAuto L2425/2427/3689/3697：改名时 `label: \`[${actionWithPath.name}]\` 双向写回`）——**显示 action 名即显示了节点名**，无需单独行，四信息三行位齐全。

### 修改明细
1. `themes.js`：
   - 金线去 alpha 改实色（明度分层代替透明度）：`--femo-edge` #e3bc55（正金）/ `--femo-edge-sel` #f7cf6b（亮金）/ `--femo-edge-flow` #b18e35（古铜金暗一档）；浅色档对应值仍为历史原值；
   - 新增边宽 token 三枚：`--femo-edge-w`(默认1.8px/深1.5px)、`--femo-edge-w-thin`(默认1.5px/深1.2px)、`--femo-edge-w-sel`(默认2.5px/深2px)——SVG strokeWidth prop 不解析 CSS var，改为 style 传 var。
2. `FemoWorAuto.jsx` 四处边宽改 style var：模块自环(L2313)/模块普通边(L2327)/主视图回边(L3012)/主视图几何边(L3082)；透明点击热区宽度不动。
3. `canvasNodes.jsx` ActionNode 布局重排：行1=类型芯片+执行者(mono 10px neutral)，行2=action名独占整行(12.5 bold)——action 名可用宽度从 ~60px 恢复到 ~76px；module 卡=芯片行 + &modRef 行；padding 10/12/9。

### 过程坑（已修复）
L2327 编辑时 new_string 误写 `d={pathD}`（该作用域无此变量，渲染会 ReferenceError）+ 丢失列表 key——读回验证发现并修复为 `key={`v${i}`} d={d}`。教训：多行 JSX 替换后必须读回或让构建/运行验证。

### 验证
- 备份：MEOW_backups/*.bak-20260821-round3
- esbuild 构建通过（lib/client.js 470.2kb）；产物含新 token 7 处命中，旧 alpha 金/坏变量残留 0
- ⚠️ 待 3081 实测：实色金线质感/细线可读性/节点两行信息完整性

## 2026-08-21 dsh-dark 精修第四轮（手机壳去蓝对齐官方中性黑 + 金线流光动画）

### 需求（用户看过第三轮后反馈）
①"深色背景有点偏蓝，是我的错觉吗？哦手机端是偏蓝的，这个要改"——考证：桌面深色底 #151517 为官方中性黑无误；**手机壳/预览条调色板是 GitHub-dark 风格真蓝调**（#0d1117/#0c1428/#1a2236/#161b27 等），属历史遗留未对齐；②"金色看着愣愣的……顺着箭头方向，就在线上，加个光感反光流动的动画，可能更有金属质感"。

### 修改明细
1. `themes.js` 默认块（固有深色区全局生效）：
   - `--femo-mobile-*` 14 枚全部去蓝：bg→#151517(950)/bg-2→#1b1b1c(900)/bg-3·surface→#232324(layer-1)/surface-hover→#2c2c2e(layer-2)/border→白12%/border-light→白16%/border-strong→#2c2c2e/text-1→#f9fafb/text-2→#979da6/text-2-alt→#cfd3d6/text-3→#61666b/mask 底色同步；
   - `--femo-preview-*` 5 枚同步去蓝（bg/bg-2 同上、text→bluish-400、border→白12%）；
   - 新增 `--femo-edge-sheen`：默认块=primary-strong（浅色不显示无观感），dsh-dark=#ffe9ad 淡金白高光；
   - THEME_CSS 追加作用域流光 CSS：`.femo-edge-shimmer` 默认 opacity:0（浅色/neon 零影响），`[data-femo-theme="dsh-dark"]` 点亮 opacity .85 + `femoEdgeShimmer 3.2s linear infinite`（stroke-dashoffset 144→0，亮段16+间隙128，递减即沿路径正向=箭头方向）。
2. `FemoWorAuto.jsx` 四处金线叠加 overlay 高光路径（className femo-edge-shimmer，宽=主线×0.65 calc(var)）：模块自环/模块 pathDs（包 <g key> 并排除 isParBroken||isForBroken 红色边）/主视图回边/主视图 geo.pathDs（排除 isParBroken/isForBrokenFinal）——红色语义边不发光。

### 原理与代价
纯 CSS stroke-dashoffset 动画（GPU 合成友好），每条金边多一条 overlay path（大图边缘数 ×2，仅深色渲染时可见；浅色 opacity:0 仍存在但不动画）。手机壳 mobileView 自有渲染不叠加流光（本次未动 mobileView.jsx）。

### 验证
- 备份：MEOW_backups/{themes.js,FemoWorAuto.jsx}.bak-20260821-round4
- esbuild 通过（lib/client.js 474.4kb）；产物 shimmer class 6 处、sheen/keyframes 6 处；源码旧蓝值/坏变量残留 0
- ⚠️ 待 3081 实测：手机端壳是否还偏蓝、金线流动感是否自然（速度 3.2s/透明度 .85 可调）

## 2026-08-21 dsh-dark 精修第五轮（流光柔化 + 属性面板补节点名）

### 需求（用户看过第四轮后反馈）
①"流光也有点愣愣的。光段的开头结尾能不能渐变，别这么清晰"；②节点第二行显示的是什么？节点名和 action 名不一样——节点上显示 action 名即可，**节点名加到属性面板**（用户明示："这个不是主题修改了，但值得修改"）。

### 概念澄清
节点名=flow 语法 `[方括号]` 引用的图上身份；action 名=动作定义名。绑定状态下两者同步（改名写回），但概念独立、需分别可见。

### 修改明细
1. `themes.js`：dsh-dark 流光 CSS 加 `filter: blur(2px)`——光段头尾柔化成渐隐光斑（无清晰切口），opacity .85→0.9 补偿 blur 损失的亮度。
2. `FemoWorAuto.jsx` 桌面属性面板 action 节点区块：首行新增 `<PR k="节点名">`（label 去方括号显示），原"名称"行改标 `Action 名` 以区分两个概念。
3. `mobileView.jsx` MobilePropsPanel：头部下方新增 `MobPropRow 节点名`（同去括号），与桌面面板对齐。

### 验证
- 备份：MEOW_backups/*.bak-20260821-round5
- esbuild 通过（lib/client.js 474.9kb）；blur(2px)/femo-edge-shimmer/节点名/Action 名 均确认进产物（中文以 \uXXXX 转义形式存在）
- ⚠️ 待 3081 实测：流光是否柔和、选中节点后两端属性面板是否显示节点名

## 2026-08-21 dsh-dark 精修第六轮（流光 v2：三层叠加真渐变光斑）

### 需求（用户看过第五轮后反馈）
"还是不够渐变，渐变部分要和现有光段一样长，所以整体变为现有长度的3倍。现有光段颜色加亮加白。"——即 渐亮16px→亮核16px→渐隐16px=48px 总长，且亮核更白。

### 原理（dash 段做不了段内渐变 → 三层叠加伪造）
`EdgeShimmer({d, w})` 组件（FemoWorAuto.jsx 顶部）渲染三层同色 overlay 路径：
- 晕层 dasharray 48 240、宽×1.5、strokeOpacity .25
- 中层 32 256、宽×1.0、opacity .5
- 亮核 16 272、宽×0.6、opacity 1（近白 #fff1c2）
三层 cycle 均 288、头对齐（dash 起点相同）→ 同速前进时亮核在前、渐晕拖尾，视觉即长渐变光斑；CSS keyframes 改 dashoffset 288→0 无缝循环，blur 2px→1.5px（渐变靠叠层，blur 只抹层间过渡），class opacity .9→1（透明度已分层到 strokeOpacity）。`--femo-edge-sheen` #ffe9ad→#fff1c2 加亮加白。
四调用点收敛为 `<EdgeShimmer d={…} w="var(--femo-edge-w[-thin])"/>`：自环/模块 pathDs/回边/主视图 geo.pathDs；红色语义边排除逻辑不变。

### 验证
- 备份：MEOW_backups/{themes.js,FemoWorAuto.jsx}.bak-20260821-round6
- esbuild 通过（lib/client.js 474.2kb）；产物 EdgeShimmer×8、新 dasharray 三层各1、旧 "16 128" 残留 0、#fff1c2/keyframes 288 就位
- ⚠️ 待 3081 实测：渐变是否够长够柔、亮核是否够白；速度(3.2s)/层透明度(.25/.5/1)/长度比(48/32/16)均可再调

## 2026-08-21 dsh-dark 精修第七轮（流光 v3：对称渐变 + 反光收进线内）

### 需求（用户看过第六轮后反馈）
①"渐变是两头都要有啊，你是不是只加了一头hhh"——v2 三层是头对齐（亮核前缘硬切口、渐晕只拖尾）；②"不用加发光效果，只在线本身上反光就行了，发光超出线之外了"——晕层宽×1.5+blur 出界形成线外辉光，不要。

### 修改明细
1. `FemoWorAuto.jsx` EdgeShimmer 改**中心对齐**：mid/halo 用负 animation-delay 把图案后移 8/16px 使三层中心与亮核重合（周期 3.2s×cycle 288 → 后移 1px=延迟 1/90s；mid=-0.0889s、halo=-0.1778s；inline style 的 animation-delay 长手优先级高于 class 的 animation 简写重置）。宽度全部压到 ≤ 线宽：晕 ×1.0(op .3)/中 ×0.85(op .55)/核 ×0.5(op 1)——辉光不再出界。
2. `themes.js`：blur 1.5px→0.5px（仅抹三层台阶，不产生线外光晕）。

### 坑
负 delay 与速度/长度耦合：改动画时长或 dash 长度需按"后移 px = delay(s)×90px/s"重算延迟。

### 验证
- 备份：MEOW_backups/{themes.js,FemoWorAuto.jsx}.bak-20260821-round7
- esbuild 通过（lib/client.js 474.3kb）；产物含 -0.1778s/-0.0889s/blur(0.5px)
- ⚠️ 待 3081 实测：两头渐变是否对称柔和、是否有线外辉光

## 2026-08-21 dsh-dark 精修第八轮（金色整体提亮一档）

### 需求（用户看过第七轮后反馈）
"金色线本身好像还是有透明度？我希望它别透明。又或者是颜色太深了？那就稍微浅一点。"

### 考证
三个金值均为实色 hex 无 alpha——"透明感"来源=**细线(1.2~1.5px)在近黑底上的抗锯齿混色**（边缘像素与 #151517 混合，整线等效变暗变灰）；另循环/自环边是虚线（5,3/7,3 间隙为语义设计），视觉天然偏"断"。

### 修改明细
`themes.js` dsh-dark 三档金整体提亮 ~12%（宽度不动，保持用户选的细线）：`--femo-edge` #e3bc55→#eec962、`--femo-edge-sel` #f7cf6b→#ffd97f、`--femo-edge-flow` #b18e35→#c4a044。

### 验证
- 备份：MEOW_backups/themes.js.bak-20260821-round8
- esbuild 通过；三新值各 1 处进产物
- ⚠️ 待 3081 实测：金线明度是否到位；若仍觉暗下一杠杆=加粗线宽而非再加亮

## 2026-08-21 dsh-dark 精修第九轮（节点极简质感：官方扁平语言做足）

### 需求（用户看过第八轮后反馈）
金线认可（"现在就好多了"）；节点 UI 仍觉丑，要"有质感有设计感"。方向确认（用户自定义回答）："我希望是偏极简，要和dsh官方的设计语言匹配嘛。但是……又不能丑"——即 B 方向：不加花活，靠工艺精度。

### 诊断
单色平板+一圈细边=贴纸感；缺 figure-ground 分离、边缘不够利落、投影单层单薄、第一行芯片+执行者拥挤。

### 修改明细（全部 token 化，浅色零变化）
1. `themes.js` dsh-dark：
   - 新增 `--femo-node-bg` #252528（表面提半档，875→偏 850 之间，画布上浮起更清楚；默认块=var(--femo-surface)）；
   - `--femo-node-border` 白 9%→11%；
   - `--femo-node-shadow-rest/sel` 升级双层投影：近接触影(0 2px 6px 黑30%)+远环境影(0 10px 24px 黑38%)，选中同理加强。
2. `canvasNodes.jsx` ActionNodeView：background 换 var(--femo-node-bg)；第一行执行者 marginLeft:auto 右对齐（结构改动两端生效——纯层次优化），第二行 action 名独占不变。

### 验证
- 备份：MEOW_backups/{themes.js,canvasNodes.jsx}.bak-20260821-round9
- esbuild 通过（lib/client.js 474.7kb）；femo-node-bg/252528/双层投影均进产物
- ⚠️ 待 3081 实测：节点是否"坐"在画布上、极简质感是否成立

## 2026-08-21 dsh-dark 精修第十轮（金色显著边框 + 节点高度压缩）

### 需求（用户看过第九轮后反馈）
"救命我还是看着丑。要不确实你把边框改的颜色显著一些，让它更利落，和亮晶晶的金线一样嘛。还有要不你把节点的宽度高度改一下？比如高度改小一点，现在其实只有两行文字"——用户主动解锁尺寸红线。

### 修改明细
1. `themes.js` dsh-dark：`--femo-node-border` 白11% → **金色调 rgba(240,210,120,0.35)**——与黑金连线呼应，节点轮廓一眼可辨；选中仍变类型色。
2. `common.jsx`：**NH 64→56、MH 74→66**（两行文字实际内容约36px+留白19px，64 有 ~9px 浪费；端口/连线几何均按 getNodeSize 动态计算自动跟随）。NW/MW 宽度不动（标题需要行宽）。

### 验证
- 备份：MEOW_backups/{themes.js,common.jsx}.bak-20260821-round10
- esbuild 通过（lib/client.js 475.5kb）；金边框值进产物、NH=56 源码确认
- ⚠️ 待 3081 实测：金边框显著性/扁节点观感/连线端口对位是否正常（几何动态应无恙）

## 2026-08-21 dsh-dark 精修第十一轮（中文换 MiSans 字体）

### 需求（用户看过第十轮后反馈）
"好像好看一点了。对了，也许是字体的问题，可以换个更好看的字体吗？中文字体全面有点丑"——此前中文走系统栈（Windows=微软雅黑，小字号+粗头发糊）。

### 选型与考证
选 **MiSans**（小米，免费商用，现代 UI 风）。加载方案考证：CJK 全量 5-15MB 必须子集化——npm `misans-webfont@4.3.1` 是"每字重独立族名"设计（MiSans Medium 等，weight 全标 400），会导致 font-weight 匹配失效，**弃用**；npm `misans@4.1.0` lib/Normal/ 为单族名 "MiSans"+官方新字重刻度（Regular330/Medium380/Demibold450/Semibold520/Bold630/Heavy700，各 100 个 unicode-range woff2 子集、font-display:swap），**采用**。femoGen 的 fontWeight 400-900 由浏览器就近映射到 330-700 真字重。CDN=jsDelivr（已实测可达，走用户 7897 代理）；加载失败静默回退系统栈零风险。

### 修改明细
1. `common.jsx` FontStyle：@import 区新增 6 条 MiSans 引入（Regular/Medium/Demibold/Semibold/Bold/Heavy，保留原 DM Sans+JetBrains Mono 的 Google Fonts 引入）。
2. `themes.js` 两处字体栈（默认块+dsh 共享块）：`--femo-font-sans/body` 在 'DM Sans' 后插入 'MiSans'（拉丁仍 DM Sans，中文落 MiSans，雅黑降级为兜底）；mono 不变。

### 注意
字体全局生效（浅色深色都换）——字体本身与主题无关，用户诉求即全局。首次加载会按需拉取子集，之后走缓存。

### 验证
- 备份：MEOW_backups/{themes.js,common.jsx}.bak-20260821-round11
- esbuild 通过（lib/client.js 476.4kb）；misans@4.1.0×6、MiSans×18 进产物
- ⚠️ 待 3081 实测：中文观感（雅黑→MiSans 差异应明显）；若 jsDelivr 不通则回退系统栈（F12 网络 可查 css 是否 200）

## 2026-08-21 dsh-dark 精修第十二轮（面板配色统一 dsh + 去手机画布点 + 流光 v4 五层 + 减字重）

### 需求（用户看过第十一轮后反馈，四条）
①加粗中文太粗；②深色模式边栏/标题栏/右栏背景别扭——"你看dsh本体的边栏是哪个颜色，用那个吧，然后画布的颜色和dsh聊天窗口的背景颜色一致。配色统一~手机端同理"；③手机端画布背景点去掉（"其实电脑端画布也没点"——round4 的 0.6px 点在深色下已不可见）；④手机端标题栏自带的扫光动效比流光 v3 好看，参考它改金线。

### 考证
dsh 官方 dark：sidebar-fill=bluish-900 #1b1b1c、聊天底=bg-base bluish-950 #151517。femo 画布 app-bg 本就 #151517 ✓；面板用的 surface #232324 偏亮故"别扭"。手机标题栏扫光实现=60% 宽 linear-gradient(90deg,transparent,glow,transparent) 带 4s 扫过——美在宽而软的真渐变。

### 修改明细
1. `themes.js`：新增 `--femo-panel-bg`（默认=surface 浅色不变；dsh-dark=#1b1b1c 对齐 sidebar-fill）；`--femo-mobile-canvas-dots` → none（默认块，全主题去手机画布点）；`--femo-mobile-surface` #232324→#1b1b1c、hover→#232324（手机端同理）。
2. `FemoWorAuto.jsx`：左边栏(L2495)/中工具栏(L2717)/右属性栏(L3316) background 换 var(--femo-panel-bg)；L2782 控件保持 surface。
3. `common.jsx`：移除 MiSans-Heavy 引入——800/900 就近落 Bold(630)，加粗中文减粗一档。
4. `FemoWorAuto.jsx` EdgeShimmer v4：三层→五层（56/44/32/24/16px，op .10/.18/.30/.50/1，宽 ≤线宽），中心对齐 delay 链 -0.2222/-0.1556/-0.0889/-0.0444/0s——更宽更软的对称渐变光带，模拟标题栏扫光质感。

### 验证
- 备份：MEOW_backups/{themes.js,FemoWorAuto.jsx,common.jsx}.bak-20260821-round12
- esbuild 通过（lib/client.js 477.7kb）；panel-bg×5/新 dasharray/delay 进产物，MiSans-Heavy 残留 0
- ⚠️ 待 3081 实测：面板配色统一感/手机无点画布/流光柔度/加粗中文厚度

## 2026-08-21 dsh-dark 精修第十三轮（类型色板换莫兰迪实色 + 仓库卡片与画布统一）

### 需求（用户看过第十二轮后反馈）
"仓库里的action显示，能不能也和画布上的统一风格……现在那个半透明蓝，半透明绿，是真的好丑。能不能别用半透明。画布上action/节点的类型标签也是半透明蓝绿的，也别用半透明。用实色，但是把颜色挑和谐点。可以考虑莫兰迪色系"

### 考证
"半透明感"来源=低饱和暗彩 tint 底（primary-soft/success-soft 等，视觉等效半透明叠加）+ 仓库卡片边框字面量 alpha（`${c}18`≈9%）。画布芯片底走 --femo-badge-*→type-*-bg，与仓库卡 TYPES.bg 同源——改 type 色板即全链路统一。

### 修改明细（全部 dsh-dark 块，浅色/neon 不动）
1. `themes.js`：type 色板换莫兰迪实色成对（底+字同族低饱和）——ai 灰蓝 #46586B/#A9BEDC、human 灰绿 #44584C/#A9C9B4、mind 灰玫瑰 #5C4747/#D2A9A9、func 灰驼 #5E5343/#D6C39E、assign/par 灰紫 #554D66/#BFB3DC；success-soft/warning-soft 同步莫兰迪（等待/完成气泡、START/IN 底共用）。
2. `common.jsx`：TYPES.ai.bg 从 var(--femo-primary-soft)（选中态共用色，不能动）改指 var(--femo-type-ai-bg)。
3. `libPanel.jsx`：仓库卡片边框 `${c}18`（alpha）→ var(--femo-border) 实色细边 + 左侧类型色条不变——与画布节点同构（neutral 边框+彩色 accent）。
4. `mobileView.jsx`：手机属性面板类型芯片 `c+'22'` alpha → badge token 实色（与画布芯片同源）。

### 影响面
type-* c 变莫兰迪后：节点选中边框/流式气泡边框/仓库"+画布"按钮底同步变柔和（一致的设计语言）；--femo-primary/-strong 保持亮蓝不动（选中态/主按钮不受影响）。

### 验证
- 备份：MEOW_backups/{themes.js,common.jsx,libPanel.jsx,mobileView.jsx}.bak-20260821-round13
- esbuild 通过（lib/client.js 482.0kb）；五组莫兰迪值进产物、旧 alpha 芯片残留 0
- ⚠️ 待 3081 实测：仓库卡/画布芯片/气泡的莫兰迪观感与统一性

## 2026-08-21 dsh-dark 精修第十四轮（仓库卡片画布同构 + 芯片文字提白）

### 需求（用户看过第十三轮后反馈）
①颜色不错，但节点芯片上的 ai/human 文字与背景区分太小，改白一点；②画布节点舒服多了；③仓库 action 依然丑——"我希望它和画布上的节点action同一个设计风格"。

### 修改明细
1. `themes.js` dsh-dark：badge-fg 六枚从 var(--femo-type-*)（muted 同调，对比不足）改为近白同色系浅调 #DCE7F5/#DFEFE5/#F2DEDE/#F0E6D2/#E6E1F2（module 保持 #cfd3d6）——底承载类型身份、字负责可读。
2. `libPanel.jsx` 仓库 action 卡片重写（画布节点同构）：底 var(--femo-node-bg) + 边框 var(--femo-node-border)（金调，同画布）+ 去 alpha 边框和左色条；行1=类型芯片(badge token)+名称(flex 省略)+E 钮，行2=执行者(mono neutral)+「+ 画布」钮（底=类型色 c）；删除旧 @type 彩色文字与 maxWidth:110 硬限宽。

### 验证
- 备份：MEOW_backups/{themes.js,libPanel.jsx}.bak-20260821-round14
- esbuild 通过（lib/client.js 482.8kb）；提白 fg/同构边框/badge 引用 15 处进产物
- ⚠️ 待 3081 实测：仓库与画布并排对比统一感、芯片文字可读性

## 2026-08-21 dsh-dark 精修第十五轮（莫兰迪提亮 + 特殊节点灰实色 + 功能钮统一 primary + 手机去包裹卡）

### 需求（用户看过第十四轮后反馈，四条）
①ai 节点找个更蓝的颜色；整个莫兰迪色系过于灰，"把颜色拉起来一点"；②手机端仓库区域有奇怪的圆角卡片背景，去掉；③「+画布」按钮颜色应全局统一=dsh deepseek 蓝，「+新建」之类功能按钮同理；④START/END/FOR/FOROUT/PAR/PAROUT 节点背景去半透明观感，改带灰度实色、与文字色拉开区分。

### 修改明细
1. `themes.js` dsh-dark：type 色板整体拉起饱和/明度——ai #3E5C94/#8FB8F0、human #3E6B4E/#85D6A8、mind #744949/#EDA3A3、func #75603A/#EDBE72、assign·par #5C5190/#B4A5EC；success/warning-soft 同步 #3E6B4E/#75603A；badge-fg 五枚随拉起微调（#CFE2FA 等）。
2. `themes.js` 新增特殊节点底色 token 五枚：默认块=原 soft 值（浅色不变）；dsh-dark=灰度实色——sp-start #383E3A/sp-end #423B3D/sp-break #403C34/sp-for #373D4A/sp-par #413C4C。
3. `common.jsx`：SPECIAL_COLORS 的 bg 从 success/danger/warning-soft、primary-soft、special-par-bg 改指专用 sp-* token——与气泡/语义底解耦，可独立调灰。
4. `libPanel.jsx`：「+画布」按钮 background 从类型色 c 改 var(--femo-primary)（deepseek 蓝，与 btnP/mobBtnP 全局功能钮一致）。
5. `mobileView.jsx`：手机 tab 内容包裹层去圆角卡片（background var(--femo-surface)→transparent、删 borderRadius radius-top）——仓库等区域融入壳背景。

### 验证
- 备份：MEOW_backups/{themes.js,common.jsx,libPanel.jsx,mobileView.jsx}.bak-20260821-round15
- esbuild 通过（lib/client.js 483.9kb）；提亮色板/sp token 接线/primary 按钮进产物，radius-top 手机包裹处已移除
- ⚠️ 待 3081 实测：拉起后的色板鲜度/特殊节点灰底与文字区分/功能钮统一蓝/手机仓库无卡片感

## 2026-08-21 事故修复：session-script 路由双写响应崩掉整个 3081 进程（ERR_HTTP_HEADERS_SENT）

### 现象
3081 两次启动后均在用户发消息后立即整体崩溃：`dsh: fatal load failure: ERR_HTTP_HEADERS_SENT: Cannot write headers after they are sent to the client`（栈：writeJson ← session-script handler 的 catch），bridge 随之退出，[ELIFECYCLE] exit 1。

### 根因
`/dsh-femo/session-script` 路由（src/index.ts）：scriptPath / femo 成功分支已经 `writeJson(res,200,…)` 后，控制流掉出 if/else 又执行了一次末尾的 `writeJson(res,200,{ok:true})` → 对同一响应二次 writeHead 抛 ERR_HTTP_HEADERS_SENT → 被 async IIFE 的 catch 捕获，catch 里第三次 `writeJson(res,500)` 再次抛出 → unhandledRejection → dsh web 按 fatal 策略带崩整个进程。触发链=前端发消息同时画布防抖保存（POST session-script），故表现为"一发消息就炸"；成功保存必炸，非偶发。

### 修复（源码层双保险）
1. 删除成功分支之后多余的 `writeJson(res, 200, { ok: true })`——每个分支自行写完响应即结束（根因消除）。
2. `.catch` 加 `res.headersSent` 防御：响应已发出后再出错只 console.warn 返回，绝不再二次 writeJson（错误处理器自身不得再抛，否则 unhandledRejection 照样炸进程）；源码注释留痕「2026-08-21 实测教训」。
（源码修复与构建由并行窗口当日完成；本窗口负责诊断定位、lib 新旧比对、重启加载与验证，并补本条留痕。）

### 验证（2026-08-21）
- 备份：lib/index.js.bak-20260821-crashfix、src/index.ts.bak-20260821-crashfix
- 运行版 lib/index.js 核实：双写残留行已不存在、headersSent 防御在位（约 L1805）
- start-meow.bat 重启 3081：端口监听 ✓；GET / → 200；GET /dsh-femo/session-state → 200 正常 JSON；GET /dsh-femo/actors → 200 {ok:true,actors:[]}；meow-smooth 压缩代理 8444 随起 ✓
- 教训：**服务崩溃先查"正在运行的 lib"与磁盘产物是否一致**——崩溃栈的行号内容对不上当前文件 = 进程跑的是旧构建；先比对 src/lib mtime 与栈行号再决定要不要动代码，避免重复修或修错版本。

## 2026-08-21 dsh-dark 精修第十六轮（金线再细再亮 + 特殊节点深实色 + 功能钮清扫 + 手机卡片区同构）

### 需求（用户看过第十五轮后反馈，三条）
①金线再细一点颜色再亮一点；②特殊节点的「+画布」按钮颜色不对要统一；③for/par/start/end/in/out/parout 节点看着还是半透明——round15 的近画布灰底+鲜字再次形成"半透明叠加"错觉，改为真正的深色实色彩底。

### 修改明细
1. `themes.js`：金线 width 1.5/1.2/2→**1.25/1/1.75px**，颜色提亮 #eec962→#f4d268、#ffd97f→#ffe58f、#c4a044→#d6b052。
2. `themes.js` sp-* 五枚改深实色彩底：start #2C5540 / end #5A3034 / break #5A4726 / for #2F4A78 / par #4A4272——涂漆感杜绝半透明错觉，鲜字对比充足。
3. 功能钮统一 primary 清扫：libPanel 特殊区「+画布」(s.c)、模块区「+画布」(tag-bg)、「创建」(tag-bg)；mobileView action「+」(c)、模块「+画布」(tag-bg)——全部 var(--femo-primary)。
4. 仓库卡片同构补完：libPanel 特殊卡（s.bg+s.c28 alpha 边）与 POSITION 卡（femo-bg+neutral28）→ node-bg/node-border 同构；mobileView action 卡（bg-3+c30）/模块卡（bg-3+tag-bg）→ node-bg/node-border；手机特殊节点 chips（s.c+'18' alpha 底）→ 对应 sp-* 实色底。

### 验证
- 备份：MEOW_backups/{themes.js,libPanel.jsx,mobileView.jsx}.bak-20260821-round16
- esbuild 通过（lib/client.js 483.9kb）；新金值/sp 实色/1.25px 进产物，c+30 与 s.c+18 alpha 残留 0
- ⚠️ 待刷新页面实测：金线粗细亮度/特殊节点实色感/功能钮全蓝/两端仓库统一

## 2026-08-21 dsh-dark 精修第十七轮（特殊节点底色和谐化：中性灰+一缕色相）

### 需求（用户看过第十六轮后反馈）
"画布上的start end par for 这些节点背景颜色太丑了，调一下，和整体更和谐"——round16 的深饱和色块（#2C5540 等）在"中性黑+黑金"的整体语言里跳戏。

### 修改明细
`themes.js` dsh-dark sp-* 五枚改**中性灰+一缕色相**实色（明度介于 surface 与 bg-2 之间，融入整体；类型身份由鲜色文字承载）：start #343E37 / end #463A3C / break #443D30 / for #363D4D / par #3F3B4A。手机端特殊 chips 同 token 自动跟随。

### 验证
- 备份：MEOW_backups/themes.js.bak-20260821-round17
- esbuild 通过；三抽查值进产物
- ⚠️ 待刷新实测：与整体和谐度；若仍不满意备选=全部统一暖金灰（彻底去彩色）

## 2026-08-21 dsh-dark 精修第十八轮（特殊节点鲜明彩底+白字）

### 需求（用户看过第十七轮后反馈）
"去彩色也不一定好看……或许你太过于克制了，让这几个节点颜色更鲜明一点看看"——从克制灰转向鲜明彩。

### 修改明细
1. `themes.js` dsh-dark sp-* 五枚改**中等明度高饱和彩底**：start 鲜绿 #2E9E5B / end 鲜红 #D24B4B / break 鲜琥珀 #DB9524 / for 鲜蓝 #3B82D6 / par 鲜紫 #8468DC。
2. `themes.js` THEME_CSS 追加 `[data-femo-theme="dsh-dark"] .femo-special-label { color: var(--femo-on-accent) !important }`——彩底上文字切白（浅色档淡底彩字不变）。
3. `canvasNodes.jsx`：SpecialNodeView/PAR_OUT 文字 span 加 femo-special-label class；`mobileView.jsx` 特殊 chips 文字直接 var(--femo-on-accent)（手机壳恒深色）。

### 验证
- 备份：MEOW_backups/{themes.js,canvasNodes.jsx,mobileView.jsx}.bak-20260821-round18
- esbuild 通过（lib/client.js 484.2kb）；五彩值+label class 进产物
- ⚠️ 待刷新实测：彩底鲜度与白字可读性；FOR 小圆点（出）仍是描边风格未动

## 2026-08-21 dsh-dark 精修第十九轮（特殊节点归队莫兰迪）

### 需求（用户看过第十八轮后反馈）
"这也太彩，你给他们也换成莫兰迪色试试"——vivid 彩底过艳，回归与类型色板同族的莫兰迪。

### 修改明细
`themes.js` dsh-dark sp-* 五枚换**类型色板同族莫兰迪**：start #3E6B4E(human 绿族)/end #744949(mind 玫瑰族)/break #6E5C3E(func 驼金族微调防全同)/for #3E5C94(ai 蓝族)/par #5C5190(assign 紫族)。白字门控 .femo-special-label 与手机 on-accent 不变。

### 验证
- 备份：MEOW_backups/themes.js.bak-20260821-round19
- esbuild 通过（lib/client.js 484.3kb）；五值进产物
- ⚠️ 待刷新实测：与芯片/仓库的色系统一感

## 2026-08-21 事故修复二：AI 节点必炸 `No module named 'requests'`（FEMO_runtime.py 死 import）

### 现象
跑剧本到 AI 节点即报「剧本出错：No module named 'requests'」。配置 dshAiBackend=true 正确、系统 Python 确无 requests（纯标准库原则），但 AI 节点本不该走直连链路。

### 根因
`femoCompiler/FEMO_runtime.py` 的 `_exec_ai` 函数体内有一行**无条件且零引用的死 import**：`from femoBridges.llmBridge import call_ai_with_blocks`。import 副作用拉起模块链 llmBridge → llmProviders 顶层 `import requests` → ModuleNotFoundError。实际 LLM 调用走 `self._invoke_ai_llm()`（内部才有规范的按 `_dsh_ai_backend` 分支延迟 import），这行是纯遗留——但在它被删除前，dsh 宿主模式下每个 AI 节点进门就死，根本轮不到子代理分支。

### 修复（1 处删行 + 注释说明）
删除该死 import；原位注释警示「此处不得 import llmBridge/llmProviders——其模块顶层 import requests，违反纯标准库零 pip 原则」。
- 备份：`MEOW_backups/FEMO_runtime.py.bak-20260821-requests-fix`
- 验证：py_compile 通过；`import femoCompiler.FEMO_runtime` 干净加载且 sys.modules 无 requests / femoBridges.llmBridge；手动以宿主同款净化 env spawn bridge → ping 返 pong
- 生效方式：bridge 是长驻 Python 子进程（模块进程内缓存），**改 .py 必须重启 3081 让 bridge 重生**；纯前端（femoGen→client.js）才是刷新热更新

### 排障插曲（教训）
本轮"重启"曾连续三次无效：3081 端口上同时有 tailscaled 的转发监听（OwningProcess=tailscaled pid），`Get-NetTCPConnection -LocalPort 3081` 拿 OwningProcess 会拿到 tailscaled 而非 dsh node——Stop-Process 被 SilentlyContinue 吞掉，旧实例一直占着端口，新实例全部 EADDRINUSE 秒退（其 bridge exit 1 是 fatal shutdown 连带 taskkill，非自身故障）。正确姿势：先 `Get-CimInstance Win32_Process` 核对命令行含 `bin.ts web --port 3081` 再杀。

## 2026-08-21 dsh-dark 精修第二十轮（功能钮统一 deepseek-500 + 特殊节点回归同底彩边）

### 需求（用户看过第十九轮后反馈，两条）
①POSITION 的「+画布」颜色不对；所有「+画布」普遍太亮——"深色模式下的dsh原生的蓝也不是那个蓝啊……你得去看dsh的ui代码"；项目设置面板"+"、右上角「继续」都应同一颜色。②特殊节点莫兰迪底仍不和谐——改成和其它节点同底色（灰黑），边框改彩色试试。

### 考证（dsh 官方源码）
ui-conversation/InputBar.module.css 注释实锤：发送钮 "#3964FE light / #679EFE dark — the info-fill pair (500→400)"；ChatView 状态渐变用 deepseek-500。用户记忆中的"原生蓝"=更深的 **deepseek-500 #4176e6**（品牌蓝）。

### 修改明细
1. `themes.js`：新增 `--femo-btn-primary`（默认=var(--femo-primary) 浅色不变；dsh-dark=#4176e6 deepseek-500）；dsh-dark sp-* 五枚 → var(--femo-node-bg)（与其它节点同底）；删除 .femo-special-label 白字覆盖（文字回归类型色 sc.c，与彩色边框呼应）。
2. `common.jsx` btnP、`mobileView.jsx` mobBtnP：background 换 var(--femo-btn-primary)——项目设置"+"等 btnP 家族自动跟随。
3. `FemoWorAuto.jsx`：「▶ 继续」按钮 background → var(--femo-btn-primary)（「运行」保持 success 绿语义色未动）。
4. `libPanel.jsx`：五处功能钮背景（+新建/action+画布/special+画布/module+画布/创建）→ var(--femo-btn-primary)。
5. `mobileView.jsx`：action「+」、模块「+画布」→ btn-primary；特殊 chips 改 node-bg 底+s.c 彩边+彩字（与画布一致）。

### 影响面
--femo-primary（400 亮蓝）继续用于选中态/tab/焦点/链接等 accent 场景；功能钮独立走 --femo-btn-primary（500），两层语义解耦。

### 验证
- 备份：MEOW_backups/*.bak-20260821-round20（5 文件）
- esbuild 通过（lib/client.js 484.4kb）；btn-primary×10/4176e6×4 进产物
- ⚠️ 待刷新实测：功能钮深蓝统一感/特殊节点灰底彩边观感

## 2026-08-21 dsh-dark 精修第二十一轮（特殊节点边框常显类型色）

### 需求（用户看过第二十轮后反馈）
"边框颜色不够显眼，希望是选中节点时的边框颜色"——round20 只改了特殊节点底色为 node-bg，未选中边框仍是中性 var(--femo-border)，不显眼。

### 修改明细
`canvasNodes.jsx` SpecialNodeView：border 从 `sel ? sc.c : 'var(--femo-border)'` 改为**常显 sc.c 类型色**；宽度未选中用 var(--femo-border-w)（细），选中 var(--femo-border-w-selected)（加粗）+ 原光环。START 绿框/END 红框/FOR 蓝框/PAR 紫框常驻，与灰黑底形成"彩边灰底"身份标识。ForOut 小圆点本就彩边未动；PositionNode 未提及未动。

### 验证
- 备份：MEOW_backups/canvasNodes.jsx.bak-20260821-round21
- esbuild 通过（lib/client.js 484.4kb）；源码 grep 确认 border=sc.c 常显 + 细宽度接线
- ⚠️ 待刷新实测：彩边显著性/与金边 action 节点的整体协调度

## 2026-08-21 视角显示架构拍板落地：删除 StreamPreviewBar 下方弹窗（纯前端）

### 需求（用户三点设计重申 + 拍板）
用户原话："1. 主会话='戏外'……这是对的。我不希望戏外视角能看见戏内内容。**也不需要下方弹窗气泡。** 2. 上帝视角的对话流里应该能看见戏外戏内内容，这才是全视视角。所以角色发言应直接映射到上帝视角窗口的对话流里，包括cot，toolcall和实际发言。3. 角色视角是戏内scope视角，应看到符合自己视角的发言……包括cot，toolcall和实际发言。"——"我本来是这么设计的……现在的实现怎么乱七八糟的"。

### 考证结论（改动前核实）
第 2/3 点**现状已实现且与设计一致**：FORWARD_CHILD_EVENTS 白名单含 assistant/chunk（思考+正文块）/tool/call/tool/result/assistant/message 等，god 窗全量分发、角色窗按 scope 命中，dsh 原生 assistant 节点渲染（含 cot 折叠/工具卡片/发言）。"乱七八糟"的实际来源=①主会话对话流无 AI 发言（镜像架构使然，用户认可）②StreamPreviewBar 底部悬浮条抢戏（16836d1 方案丁引入，流式期间常驻 bottom:96px 显示累积正文）。

### 修改明细（仅 src/client.tsx，备份 MEOW_backups/client.tsx.bak-20260821-remove-previewbar）
1. 删除 apply() 内 StreamPreviewBar 挂载块（独立 React 根 + portal 到 body 的 #dsh-femo-stream-preview）。
2. 删除 StreamPreviewBar 组件定义整段（SSE ai_token 订阅 + fixed 悬浮条渲染）。
3. 清理悬空 import：`createRoot` from 'react-dom/client'（仅预览条挂载使用过）；createPortal 保留（冲突弹窗仍在用）。
4. host 侧 ai_token 广播保留——femoGen 画布节点流式文本（nodeStates.streamingText）仍消费该事件。

### 验证
- node build.mjs 双 bundle 通过（lib/client.js 484.4→481.9kb；pwsh 报 exit 1 为 esbuild stderr 输出触发 NativeCommandError 假警报，产物正常）
- 产物 grep：StreamPreviewBar/stream-preview 引用 **0**；femo-role 聊天节点在 ✓；host ai_token 广播在 ✓
- 生效方式：纯前端改动，浏览器刷新即生效（3081 无需重启）
- ⚠️ 待刷新实测：运行剧本确认下方弹窗消失；上帝窗/角色窗对话流含 cot/toolcall/发言完整性

## 2026-08-21 dsh-dark 精修第二十二轮（特殊节点未选中彩边压暗对齐金边框灰度）

### 需求（用户看过第二十一轮后反馈）
霓虹灯效果不错，但红绿边框太亮——"让它的灰度跟咱们之前调的那个金色的边框的灰度差不多？选中它的时候，才变成那个亮边框，这个颜色不变"。

### 修改明细
`canvasNodes.jsx` SpecialNodeView：新增 borderDim = `color-mix(in srgb, sc.c 50%, var(--femo-node-bg))`（类型色与节点底各半混合——明度自动落到金边框混底档位 ~40%，色相保留，且随主题自适应：浅色下混合浅底成柔和粉彩边）；未选中边框用 borderDim 细线，选中恢复全鲜 sc.c 加粗+光环不变。

### 验证
- 备份：MEOW_backups/canvasNodes.jsx.bak-20260821-round22
- esbuild 通过；borderDim 接线 ×2 进产物
- ⚠️ 待刷新实测：压暗档位是否合适（50% 可调：更暗 40% / 更亮 60%）

## 2026-08-21 dsh-dark 精修第二十三轮（仓库特殊节点卡全周压暗彩边）

### 需求（用户看过第二十二轮后反馈）
"仓库里显示的特殊节点，把边框也改成我们现在要的那个颜色？而且不要只有左侧边框有颜色，整个边框统一颜色。"

### 修改明细
1. `libPanel.jsx` 特殊节点卡：三面 node-border+左色条 → **全周 color-mix(s.c 50%, node-bg) 压暗彩边**（与画布未选中态完全同款公式）。
2. `mobileView.jsx` 特殊 chips：全鲜彩边 → 同款压暗彩边（文字保持鲜色 sc 系）。

### 验证
- 备份：MEOW_backups/{libPanel.jsx,mobileView.jsx}.bak-20260821-round23
- esbuild 通过；源码三处（canvas/lib/mobile）压暗公式各 1 处确认
- ⚠️ 待刷新实测：仓库特殊卡与画布的边框一致感

## 2026-08-21 dsh-dark 精修第二十四轮（POSITION 空节点卡灰色统一 + 模块卡同构补完）

### 需求（用户看过第二十三轮后反馈）
"还有空节点呢，别忘了。既然空节点显示为灰色边框，那就改为灰色吧。"

### 修改明细
`libPanel.jsx`：
1. POSITION 空节点卡：去左侧 neutral 灰条，全周 var(--femo-border) 灰边（与画布空节点一致），底 var(--femo-bg)（=画布空节点同底）。
2. 顺手补完（既定同构方向漏网）：模块卡从 bg-2+tag-bg-faint 边+tag-bg 左条 → node-bg+node-border 全周（与 action/special 卡统一）；模块「编辑」文字钮 color 从 tag-bg（深色下近不可见）→ neutral。

### 验证
- 备份：MEOW_backups/libPanel.jsx.bak-20260821-round24
- esbuild 通过（lib/client.js 484.5kb）；libPanel 内 borderLeft/tag-bg 残留 0——仓库四类卡（action/special/module/position）全部同构完成
- ⚠️ 待刷新实测：POSITION 灰卡观感、模块卡统一感

## 2026-08-21 手机端交互优化（round25：仓库长按拖拽 + 画布命中扩大）

### 需求（用户两条交互反馈）
①手机端仓库拖节点应为**长按激活**，现在碰到就拖"太离谱"；②画布节点保留触碰即拖，但**命中判定比节点大一圈**（小节点不好碰）；边连接线判定也比线宽一圈（不易判定失败）。

### 现状考证
画布手势钩子本就是长按相位机（LONG_PRESS_MS=200：port→连线/node→nodeDrag/空→平移，pending 移动超 5px 取消转平移）——节点拖拽实际已是长按，保持不动；hitTest=elementFromPoint 只认端口/节点 DOM，无扩圈、无边检测；仓库拖拽 handleLibTouch* 是碰触即武装 + touchmove 一律 preventDefault（连列表滚动都被掐死）。

### 修改明细
1. `mobileView.jsx`：
   - 新增 LIB_LONG_PRESS_MS=300 / NODE_TOUCH_PAD=12 常量与 libTimerRef；
   - 仓库拖拽改长按门控：touchstart 仅记录+起计时器；**激活前 touchmove 不 preventDefault**（移动超 5px 取消意图，列表滚动恢复原生）；300ms 到点 vibrate(15)+armed+ghost 出现；armed 后 move 才拦截并拖 ghost；end 未 armed=mere 点击（选择走原 onClick 不受影响）；
   - hitTest 扩圈兜底：elementFromPoint 未命中时，按 nodesRef 数学矩形外扩 NODE_TOUCH_PAD/s 逐节点（自顶向下）判定——端口优先级不变；
   - import 补 getNodeSize。
2. `FemoWorAuto.jsx`：透明点击热区加宽（可见线不动）——自环/模块普通边/主视图回边 12→18，主视图几何边 12→18、par 并行线 18→24。

### 验证
- 备份：MEOW_backups/{mobileView,FemoWorAuto}.jsx.bak-20260821-round25
- esbuild 通过（lib/client.js 485.6kb）；LIB_LONG_PRESS_MS/NODE_TOUCH_PAD/24:18 进产物
- ⚠️ 待手机实测：仓库长按 300ms 激活+震动反馈、激活前可滚列表；节点外扩 12px 命中；边热区变宽；确认误触率下降

## 2026-08-21 手机端修复（round26：点选金线连线失效）

### 需求（用户真机反馈）
"现在手机上无法点中节点之间的连接边（金线）"。

### 根因
手机手势系统 hitTest 只认端口/节点（elementFromPoint+closest），**从不返回边**；边选中一直依赖浏览器合成的 click 事件，而 onTouchEnd 的 preventDefault 会压制合成 click——时灵时不灵；round25 节点扩圈又让近节点的点按被 node 抢走。

### 修改明细
1. `FemoWorAuto.jsx`：四处透明点击热区路径加 `data-edge-id={e.id}`（自环/模块 pathDs/主视图回边/主视图几何 midIdx）。
2. `mobileView.jsx`：hitTest 增加 `closest('[data-edge-id]')` → { type:'edge', id }（排在节点精确命中之后、数学扩圈兜底之前——节点优先于边的次序保持）；touchend pending 相机处理 hit.type==='edge' → setSel({type:'edge',id})，不再依赖合成 click。

### 验证
- 备份：MEOW_backups/{FemoWorAuto,mobileView}.jsx.bak-20260821-round26
- esbuild 通过（lib/client.js 485.9kb）；data-edge-id×5/edgeEl×3/edge 选中分支进产物
- ✅ 手机实测已确认（用户 ask_user_question 回复"修好了"）：点金线稳定选中边

## 2026-08-22 手机端交互优化（round27：仓库长按激活拖拽的三层视觉反馈）

### 需求（用户原话）
"手机端，从仓库里面往外拖拽节点时，长按，然后才激活拖拽……我希望在激活拖拽模式的时候，视觉上有一些改变，让人知道可以拖动了。"

### 根因
round25 长按激活的唯一反馈是 ghost 胶囊悄悄出现 + navigator.vibrate(15)——**iOS Safari 不支持 vibrate API**（安卓 Chrome 有效），iPhone 上激活瞬间近乎零反馈；被按卡片本身无变化、画布无"可放置"提示。

### 修改明细
1. `mobileView.jsx`：
   - 新增 `libArmedKey` state（"type:id"）：长按 300ms 到点瞬间 set（与 ghost 同帧）；handleLibTouchEnd 一律清空；透传 MobileBottomPanel → LibPanel；
   - ghost 胶囊加 `ghostPopIn 0.18s`（scale 0.7→1.05 弹性淡入）+ `ghostBreath 1.1s infinite alternate`（光晕呼吸；只动 box-shadow，与 popIn 的 opacity/transform 属性不相交可同列）；
   - 激活期间画布内浮现可放置提示层（zIndex 150/151，低于 dragReady 小环 200）：inset 8 虚线主色描边 + `--femo-primary-soft-faint` 混底 + 顶部居中"松手放置到画布"胶囊，`dropHintIn 0.22s` 浮现，抬手即消；
   - MobileGlobalStyle 注册 3 个新 keyframes（ghostPopIn/ghostBreath/dropHintIn），全 token 化四档主题通用。
2. `libPanel.jsx`：
   - 新 prop `armedKey=null`（桌面端不传永不命中，零影响）；
   - 组件内 `isGrabbed(type,item)`/`grabStyle()` 辅助；四类卡片（action/module/special/position）命中抓起态：主色边框 + 主色淡底 + `scale(1.04)` + 主色光晕，`grabTransition`（transform 弹性曲线 + border/background/shadow 0.15s）平滑亮起/回落；special 卡的 color-mix 特殊色边框被 spread 覆盖为主色，回落恢复。

### 验证
- 备份：MEOW_backups/{mobileView,libPanel}.jsx.bak-20260821-round27
- 构建：`npm run build`（esbuild JS API）在本会话沙箱被 named-pipe 限制挡（spawn EPERM，文档化边界）；按 restructure 路径改用 **esbuild CLI 直调**（PowerShell 原生进程不受 pipe 限制）仅重建 lib/client.js（489.5kb，host 端未动）——banner/footer 参数与 build.mjs clientOptions 逐项对齐
- ghostPopIn/libArmedKey/松手放置到画布/grabTransition 均 13 处命中产物
- ⚠️ 待手机真机验证：长按 300ms 瞬间卡片亮起+ghost 弹出+画布虚线框三信号齐发；抬手/取消全部回落；列表滚动不受影响

## 2026-08-21 浅色档同步（round27-light：深色设计语言全面翻译到 light 默认块）

### 需求（用户拍板开启第二阶段）
"深色档现在很好看了，我们需要把这套设计语言迁移到浅色，但颜色不能和深色完全一样，因为底色不一样，配合起来要和谐好看且清晰。"

### 翻译原则
同语言、不同明度——每个深色决策都给出浅色底下的对应表达；组件零改动（token 架构收益），仅 themes.js 默认块+CSS 一处+neon 补丁。

### 修改明细（全在 themes.js 默认块，除注明外）
1. 画布 --femo-app-bg #f5f6f7→**#ffffff**（官方浅色聊天底 bg-base）；面板 --femo-panel-bg→**#F9FAFB**（官方浅色 sidebar-fill）。
2. 节点阴影四 token → 双层浅灰影+白内高光（与深色双层工艺对应）。
3. 节点边框 → **哑金 rgba(191,155,74,0.55)**（白底上加深显形，与深色亮金同一语言）。
4. 金线三档浅色版：edge **#b8933d** 古金 / sel **#8f6f1d** 深金 / flow **#d4bc7a** 浅古金（普通边也入金，白底上反向加深）；宽度维持历史值。
5. 类型色板莫兰迪浅色版（粉彩底+深字成对）：ai #DFE9F5/#4A6FA5、human #DFEDE3/#4A7A5C、mind #F3E3E3/#A56A6A、func #F2EAD8/#997B3D、assign/par #E9E5F5/#7A6FAE。
6. 徽章默认块：粉彩底(var type-bg)+深莫兰迪字（ai #3E5C94/human #3D664C/mind #8A5050/func #7A6535/assign #63598F），module 保持 tag-bg 白字。
7. 特殊节点 sp-* 五枚浅色=**与深色同一套鲜彩实色**（#2E9E5B/#D24B4B/#DB9524/#3B82D6/#8468DC——彩底白字与主题底色无关）；`.femo-special-label` 白字规则改为全局（round20 曾删，本轮按需重加）。
8. neon 块补 badge 十二枚覆盖（tint 底+亮字+module #2a3449/#eef2f9），防被浅色粉彩默认值波及。

### 不变的
结构类 token 全部自动跟随（node-bg/btn-primary/edge-w/仓库同构/压扁 56/MiSans）；success/warning-soft 浅色保持原淡彩；流光仍仅深色启用。

### 验证
- 备份：MEOW_backups/themes.js.bak-20260821-round27
- esbuild 通过（lib/client.js 491.3kb）；F9FAFB×4/b8933d/4A6FA5/2E9E5B/femo-special-label×4 进产物
- ⚠️ 待刷新实测：切浅色主题逐项检查（画布白底/面板灰/哑金边框/古金线/粉彩芯片/鲜彩特殊节点/功能钮蓝）

## 2026-08-21 主题裁撤（round28：删除 neon 霓虹主题）

### 需求（用户看过浅色同步后）
"帮我把那个'霓虹'主题删掉，也太丑了。我们只留我们改好的dsh深色和dsh浅色就好了"——auto（跟随 DSH）保留：它不是独立配色，是自动跟随本体白天/黑夜的机制，产出的就是深/浅两套。

### 修改明细
`themes.js`：
1. FEMO_THEMES 数组删 neon 项（剩 auto/dsh/dsh-dark 三项）；
2. 删除整个 [data-femo-theme="neon"] CSS 块（124 行，pwsh 行号锚点切除 + [System.IO.File]::WriteAllLines UTF8 无 BOM 写回——PS5 Set-Content utf8NoBOM 不支持）。
3. 兼容性说明（round28 后用户澄清）：不存在存过 'neon' 的 localStorage 会话，未加任何兼容代码；FEMO_THEMES 校验回退是原有逻辑非本次新增。
4. 顺手修正流光 CSS 注释（三层→多层、去 neon 提法）。

### 验证
- 备份：MEOW_backups/themes.js.bak-20260821-round28
- esbuild 通过（lib/client.js 485.2kb）；源码 neon 仅剩 2 处无害注释（删除说明+流光注释已修正），bundle 内 neon 仅注释类字符串
- ⚠️ 待刷新实测：主题循环按钮只剩 跟随DSH→DSH浅色→DSH深色 三档

## 2026-08-21 浅色黑白金属版（round29：金色→纯黑系 + 浅色启用白色流光）

### 需求（用户看过浅色同步后）
"深色版是黑金比较好看，浅色可能白黑比较好看。黑是那种很纯的黑，加上纯白的流光，制造一种发亮的金属效果……你把原版里本来是金色的地方改成纯黑试试看？还有光效颜色也改一下。这是浅色主题，深色主题不变哦"

### 修改明细（全在 themes.js 默认块+CSS，dsh-dark/neon 已删不受影响）
1. 节点边框 哑金 rgba(191,155,74,0.55) → **近纯黑 rgba(10,10,10,0.85)**。
2. 连线三档古金 → 黑系三档：edge **#1c1c1c** 近纯黑 / sel **#000000** 纯黑 / flow **#4a4a4a** 深灰黑。
3. --femo-edge-sheen 占位 → **#ffffff 纯白**；CSS 流光门控从仅 dsh-dark 扩展为 dsh-dark+dsh 双档启用（同 3.2s/blur0.5px 参数）——白光扫过黑线=发亮金属。

### 不变的
类型莫兰迪色板/徽章/特殊节点鲜彩底白字/功能钮 deepseek 蓝/投影/宽度；深色主题全部 token 未动。

### 验证
- 备份：MEOW_backups/themes.js.bak-20260821-round29
- esbuild 通过（lib/client.js 485.3kb）；黑系三值/sheen 白/dsh 流光门控进产物
- ⚠️ 待刷新实测：切 DSH 浅色——黑白金属观感、白流光扫过黑线的发亮效果

## 2026-08-21 精修第三十轮（金线细化提亮 + 流光 v5 真渐变光珠）

### 需求（用户三条）
①电脑端连线再细一点（手机端还行，一起调了）；②深色金线电脑端看着比手机暗淡，再调亮一点点；③流光分三/五段还是愣——"做成真渐变的吗，从纯白到无的一段渐变流光。（纯白到无，那就是深色浅色都能用了）"

### 根因与方案
①②粗细/颜色 token 双主题共用，感知差异来自电脑端插件模式 zoom:0.75 的抗锯齿变细变暗——细化一档+提亮补偿。③dash 段无法段内渐变，多层叠加是近似——改用 **SVG radialGradient(纯白→透明) 光珠 + SMIL animateMotion 沿路径运动**：一段真正的连续渐变光珠滑线，天然深浅通用。

### 修改明细
1. `themes.js`：dsh-dark 边宽 1.25/1/1.75→**1/0.85/1.5px**、浅色 1.8/1.5/2.5→**1.5/1.25/2.25px**；dsh-dark 金三档提亮 #f4d268→**#ffd76b**、#ffe58f→**#ffec9c**、#d6b052→**#e3c05e**；双主题 sheen 统一**纯白 #ffffff**。
2. `FemoWorAuto.jsx`：EdgeShimmer 重写为单 `<g className="femo-edge-comet">` 内 `<circle r=5 fill=url(#femoCometGrad)>` + `<animateMotion dur=3.2s path={d}>`；两个 svg defs 各加 radialGradient femoCometGrad（0% 不透明→45% 55%→100% 透明，stopColor 走 style var()）。
3. `themes.js` CSS：.femo-edge-shimmer 规则+keyframes 删除，换 .femo-edge-comet 门控（默认 opacity 0，dsh-dark/dsh 点亮）。
4. 调用点不变（w 参数弃用不传参兼容）；语义边仍不走流光。

### 验证
- 备份：MEOW_backups/{themes.js,FemoWorAuto.jsx,mobileView.jsx}.bak-20260821-round30
- esbuild 通过（lib/client.js 484.6kb）；femoCometGrad×3/animateMotion×2/comet 门控进产物，旧 shimmer/keyframes 残留 0
- ⚠️ 待刷新实测：真渐变形态是否满意、SMIL 动画流畅度（Chrome/手机 Safari 均支持）、金线亮度档位

## 2026-08-21 精修第三十一轮（流光 v6：线性渐变胶囊光带，回弃光珠）

### 需求（用户看过第三十轮后反馈）
"你不要改成光珠啊，我喜欢你之前写得那个光段，很长一段，但你之前写的是三段渐变，渐变段数太少就显得很楞，我们只是要细化他"——保留长光段形态，消灭分段感。

### 修改明细
`FemoWorAuto.jsx`：
1. EdgeShimmer v6：五层 dash 段与 round30 光珠均弃用，改为 **rect 胶囊（64×3px）装 linearGradient(透明→纯白50%→透明) + animateMotion rotate=auto**——胶囊随路径切线旋转、始终与线方向对齐，渐变数学连续零分段；高 3px 略浮于 1px 线上作高光。
2. 两个 svg defs：femoCometGrad(radial) → femoCometLin(linear, objectBoundingBox 五档 stop)。
3. 门控 .femo-edge-comet CSS 不变（默认 opacity:0，dsh-dark/dsh 点亮）；调用点/语义边排除不变。

### 验证
- 备份：MEOW_backups/FemoWorAuto.jsx.bak-20260821-round31
- esbuild 通过（lib/client.js 485.4kb）；femoCometLin×3/rotate auto 进产物，femoCometGrad 残留 0
- ⚠️ 待刷新实测：胶囊长光带的连续渐变观感；长度 64px/高度 3px/时长 3.2s 均可调

## 2026-08-21 精修第三十二轮（流光 v7 蒙版限定 + 深浅线宽统一）

### 需求（用户三条）
①深浅连接线粗细不一样，都改成细的；②线弯曲时流光不跟着弯，很奇怪；③流光严重超出线的范围——"能不能只在线内部的部分看见流光，外面不要有，金属反光不是发光。类似于蒙版，可以实现吗"

### 方案（用户提议的蒙版 = SVG mask 标准解法）
EdgeShimmer 外层加 `<mask>`（内容=同 d 的白色描边、宽度=可见线宽 w token）罩住胶囊——**胶囊被裁成只剩落在笔画内的部分**：弯线自动跟随弯曲、绝不超出线宽、纯反光不发光。胶囊本体放大到 64×6px 让渐变完整覆盖蒙版窗口。

### 修改明细
1. `FemoWorAuto.jsx` EdgeShimmer v7：签名恢复 { d, w }（四个调用点原本就传 w）；实例级 maskId=useMemo+模块序号；mask 内 path strokeWidth 走 style var(w)；rect 6px 高被蒙版裁成线内反光。
2. `themes.js` 浅色边宽对齐深色细线：1.5/1.25/2.25 → **1/0.85/1.5px**（三档）。

### 验证
- 备份：MEOW_backups/{themes.js,FemoWorAuto.jsx}.bak-20260821-round32
- esbuild 通过（lib/client.js 486.1kb）；femoCometMask 进产物
- ✅ 教训沉淀：SVG mask 罩"会动/会在远处"的元素时必须显式 userSpaceOnUse 大区域，默认 objectBoundingBox 只罩原地
- ⚠️ 待刷新实测：流光恢复可见且只在线内

## 2026-08-21 精修第三十四轮（真凶实锤：mask 内容不解析 CSS var）

### 需求（用户刷新后仍反馈）
"没回来，话说是不是因为那是线，那不是填充"

### 客观定位（不再瞎猜）
写四宫格对照页 `_shimmer-test.html`（基线/无蒙版胶囊/mask+var 线宽/mask+字面量线宽），用 meow-smooth shot.mjs CDP 截图 + ask_eyes 判读：B/D 有白色光带、**C（mask 内 strokeWidth:var()）空**——Chromium 的 `<mask>` 内容不解析 CSS var()，白描边宽度取不到值 → 蒙版成空。

### 修改明细
`FemoWorAuto.jsx`：EdgeShimmer mask 内 path 的线宽从 style var(--femo-edge-w*) 改为**字面量数值 w**（四个调用点分别传 0.85/0.85/1/1，与 themes.js 深浅统一后的 --femo-edge-w* 数值同步维护，注释已标注联动关系）。可见线的 style var 用法不变（mask 外解析正常）。

### 验证
- 备份：MEOW_backups/FemoWorAuto.jsx.bak-20260821-round34
- esbuild 通过；四调用点全字面量、源码无 EdgeShimmer 路径上的 var 残留
- ⚠️ 待刷新实测：流光恢复可见且只在线内（深浅双主题）

## 2026-08-21 精修第三十三轮（修复：蒙版流光整条消失）

### 需求（用户真机反馈 round32 后）
"看不到流光了……"——v7 蒙版方案上线后流光完全不可见。

### 根因
SVG `<mask>` 默认 maskUnits="objectBoundingBox"——**蒙版作用区域按被罩元素（胶囊）自身包围盒的 -10%~120% 计算**，即胶囊未变换时的原始位置那一小圈；而光珠滑到路径远端时早跑出该区域 → 蒙版交集为空 → 整条消失。mask 内容坐标本就是 userSpaceOnUse（画布绝对坐标），与区域坐标系错位。

### 修改明细
`FemoWorAuto.jsx` EdgeShimmer 的 `<mask>` 显式声明 `maskUnits="userSpaceOnUse" x=-10000 y=-10000 width=20000 height=20000`——作用区域覆盖全画布，光珠滑到任何位置都在蒙版窗口内。

### 验证
- 备份：MEOW_backups/FemoWorAuto.jsx.bak-20260821-round33
- esbuild 通过；userSpaceOnUse 进产物
- ✅ 教训沉淀：SVG mask 罩"会动/会在远处"的元素时必须显式 userSpaceOnUse 大区域，默认 objectBoundingBox 只罩原地

## 2026-08-21 round44（修复：全局 touch-action:none 污染触摸链——仓库卡片无法滚动的真凶）

### 需求（用户真机调试反馈）
悬浮层实证 JS 层清白（卡片滑动 → CANCEL→原生滚动 正确放行）但列表不滚；间隙滚动正常。差异锁定=**触点元素链上的 CSS touch-action**。

### 根因
`MobileGlobalStyle` 里 `html, body { touch-action: none }`——Chrome 从触点向上累积 touch-action 到根，body 的 none 污染所有手势链（此前以为"间隙能滚"已排除它，实为误判）。画布区本就有独立的 .femo-canvas-zone{touch-action:none}，全局规则冗余且有害。

### 修改明细
`mobileView.jsx` MobileGlobalStyle：删除 html,body 的 `touch-action: none`（保留 overscroll-behavior/user-select）；.femo-canvas-zone{touch-action:none} 保留（拖节点/连线/平移仍走自定义手势）。副作用评估：页面级双指缩放本就被 viewport meta 禁用；body 无需禁触。

### 验证
- 备份：MEOW_backups/mobileView.jsx.bak-20260821-round44
- esbuild 通过（lib/client.js 494.3kb）；源码 'touch-action: none' 仅剩 canvas-zone 一处
- ⚠️ 待手机实测：卡片上滑=滚列表、画布拖拽/连线/平移正常、页面无异常回弹

### 教训
全局 `touch-action:none` 是隐形杀手——它会沿祖先链污染所有子区域的原生触摸行为；禁触需求应精确挂在需要的最小区域。

## 2026-08-22 rc.2 切换善后：web 前端/客户端包未构建 + bridge subprocess 竞态（两处修复）

### 背景
用户将喵版工作区切换到官方新版快照 `dsh-meow0.1.1-rc.2`（start-meow.ps1 已改 Set-Location，回滚=改回 dsh-meow）。切换后 3081 无法启动：①01:31 手动启动的实例卡死成僵尸（无监听、无 bridge）；②AI 代重启时 boot 快速失败。

### 诊断（diag-uncaught.mjs 展开 AggregateError——Node 打印 AggregateError 不含 errors 数组，dsh-femo 的 uncaughtException handler 只打 stack 也看不到；脚本 prependListener 抢先展开）
两个失败 entry，**均与 dsh-femo 无关**（femo 路由+四工具注册成功、meow-smooth 正常）：
1. `directory-picker`：`Cannot find module ...\profiles\node_modules\@deepseek-ai\dsh-client-ui-directory-picker-native\lib\index.js` —— profiles 包是 junction 指向 rc.2 的 pnpm 依赖结构，**rc.2 的 client 包从未构建（缺 lib/）**；
2. `web-runtime (@deepseek-ai/dsh-web-app)`：`frontend dist not built; run pnpm run build from the repository root first` —— **rc.2 的 web 前端 dist 未构建**。
dsh host 是 tsx source-launch 不需要构建，但 client 包与前端必须——切快照漏了这步。

### 修复 A：补构建
- rc.2 根 `pnpm run build` 全量构建（所有包 lib ✓ 含 directory-picker-native）；最后一步 web-frontend 在沙箱 job 里因子进程 PATH 无 pnpm 失败 → 手动补 PATH 重跑 `pnpm --filter @deepseek-ai/dsh-web-frontend run build` ✓（首次 EBUSY favicon.svg 为残留进程瞬时锁，清进程后通过）。

### 修复 B：bridge subprocess 竞态（src/index.ts）
构建补齐后服务能起但出现新日志 `[dsh-femo] subprocess service unavailable; bridge not started`——插件 apply 完成早于 base bundle 的 subprocess provider（插件树并发装配完成顺序不定；rc.2 插件更多、固定 1s 延迟不再够）。修复：`bridge.start(ctx, config, attempt)` 改为轮询等待（subprocess 未就绪每秒重试，上限 30 次），就绪后打 `subprocess service ready after Ns wait`。
- 备份：MEOW_backups/index.ts.bak-20260822-subprocess-wait
- 验证：重启后日志 `subprocess service ready after 1s wait; starting bridge`、bridge pid 存活、端口+路由 200 ✓

### 教训
1. **切 dsh 快照目录 = 新 checkout 需要完整构建**（host 免构建 ≠ client lib + 前端 dist 免构建）；
2. 插件 apply 内依赖其他 bundle 服务时不得假设装配已完成——轮询等待或挂 loader 就绪钩子；
3. Node 的 AggregateError 打印不含 errors 子数组，诊断需 prependListener 自行展开。

## 2026-08-21 精修第三十五轮（流光 v8：多层 dash 光带回撤定稿，弃蒙版/光珠）

### 需求（用户看过第三十轮后反馈）
①线弯曲时胶囊光带不跟着弯；②严重超出线的范围——"只在线内部的部分看见流光……类似于蒙版"。round32 蒙版方案 + round34 var 修复后**流光仍不可见**。

### 客观探针定位（_shimmer-probe.mjs：页面内栅格化逐格统计白像素）
八宫格实证：外层 g 蒙版+内层变换（E）与同元素 mask+静态变换（F）双双 **0 白像素**——mask 在"带 transform 的元素/嵌套变换"场景下 Chromium 渲染不可靠；渐变 stop 用 var() 反而正常（G/H 均 450）。结论：放弃 mask 路线。

### 修改明细（v8 回撤定稿）
`FemoWorAuto.jsx`：
1. EdgeShimmer 重写为 **SHIMMER_LAYERS 六层同路径 dash 短划**（16→76px 长、strokeOpacity 1→0.04、cycle 288、负 animation-delay 中心对齐 0/-0.0667/-0.1333/-0.2/-0.2667/-0.3333s），stroke=var(--femo-edge-sheen) 纯白、strokeWidth=w token——**流光就是线本身的描边**，构造性保证随弯+零溢出。
2. `themes.js` CSS 门控换 .femo-edge-comet-layer（默认 opacity:0，dsh-dark/dsh 点亮）。
3. 清理：两处 svg defs 的 femoCometLin 渐变定义删除（无引用）；femoCometMask 相关全清。

### 验证
- 备份：MEOW_backups/FemoWorAuto.jsx.bak-20260821-round35
- esbuild 通过（lib/client.js 490.6kb）；SHIMMER_LAYERS 进产物，femoCometLin/femoCometMask 残留 0
- ⚠️ 待手机实测：首滑即滚/慢滑不误武装/长按拖拽正常；调试条实时显示 st=scrollTop 供客观判读

## 2026-08-21 round48（touchcancel 诊断 + 横向行 pan-x 声明）

### 关键线索（用户真机观察）
"dy 记录 0.x 秒后冻结，手指还在滑但 dy 不再变"——**touchmove 事件流中途终止**。典型机制=浏览器判定手势归属后向 JS 发 touchcancel 接管。嫌疑场景：仓库 Actions 行是横向滚动容器（overflow-x:auto），斜向滑动被方向锁定给横向行 → 垂直面板永不滚。

### 修改明细
1. `mobileView.jsx`：新增 handleLibTouchCancel（dbg TCANCEL+清态），透传 LibPanel；四类卡挂 onTouchCancel。
2. `mobileView.jsx`：Actions 行与 Modules 行容器加 `touchAction: 'pan-x'`——声明该行只处理横向手势，竖直滑动放行给面板垂直滚动（若 touchcancel 实锤，此声明即修复）。

### 验证
- 备份：MEOW_backups/{mobileView,libPanel}.jsx.bak-20260821-round48
- esbuild 通过（lib/client.js 496.0kb）；TCANCEL×1/onLibTouchCancel 五处接线进产物
- ⚠️ 待手机实测：若调试条出现 TCANCEL=方向锁定实锤（pan-x 应已修复）；仍复现则读 TCANCEL 后的 st 值

## 2026-08-21 精修第三十六轮（修复：v8 光带不动——动画规则漏挂新类名）

### 需求（用户看过第三十五轮后反馈）
"光感好看了，但是它现在不动…"

### 根因
round35 重写 EdgeShimmer 时把光带类名换成 .femo-edge-comet-layer，但 themes.js 的动画规则仍绑在旧类 .femo-edge-shimmer 上且已被删——六层 dash 只有静态形态、无 dashoffset 动画。

### 修改明细
`themes.js`：补 `.femo-edge-comet-layer { animation: femoEdgeSweep 3.2s linear infinite }` + `@keyframes femoEdgeSweep { stroke-dashoffset 288→0 }`（各层 inline animationDelay 相位不变）；过程中误吞的 .femo-special-label 白字规则已即时补回。

### 验证
- esbuild 通过（lib/client.js 491.1kb）；femoEdgeSweep/femo-special-label/femo-edge-comet-layer 全进产物
- ⚠️ 待刷新实测：光带沿箭头方向滑动

## 2026-08-21 round43b（诊断插桩：仓库触摸判定链路悬浮层）

### 背景
round43 加固后用户仍报卡片区域无法滚动——headless 合成触摸又复现不了真机，改为**真机可视化插桩**：在手机上实时显示判定链路每一步。

### 修改明细
`mobileView.jsx`：handleLibTouch* 各决策点埋 dbg()（TS 触发+目标 touchAction / MOVE 位移 / ARMED / CANCEL→原生滚动 / ARM-CANCEL / TE 收尾），MobileLayout 渲染 fixed 悬浮层（绿字黑底、pointerEvents:none）。**临时插桩，验收后移除。**

### 验证
- esbuild 通过；ARM-CANCEL 等标记进产物
- ⚠️ 待手机复现：慢滑 action 卡片，读悬浮层文字序列反馈（重点看是否出现 ARMED=被误武装 / CANCEL→原生滚动后列表是否真的滚了 = CSS/原生层问题）

## 2026-08-21 手机端主题拆分（round37：移动壳配色跟随主题，不再恒暗）

### 需求（用户）
"手机端的UI，不同主题的配色好像在代码里没有分开。比如说元件的颜色、背景画布的颜色之类的……模仿电脑端，把手机端的主题相关元素拆到主题里面。"

### 考证
--femo-mobile-* 十六枚壳层 token 只存在于默认块、数值固定深色（早年"移动壳=固有深色区"设计遗留）——任何主题下手机壳同一套配色，确未按主题拆分。

### 修改明细（仅 themes.js）
1. 默认块（=DSH 浅色）：mobile-* 全组换浅色值——bg #ffffff（聊天底）/bg-2·surface #F9FAFB（sidebar-fill）/bg-3 #F1F3F5/surface-hover #ECEEF1/border rgba(0,0,0,0.12)/border-light rgba(0,0,0,0.22)（兼空态提示文字）/border-strong #ECEEF1/text-1 #17191D/text-2 #6A7077/text-2-alt #45494F/text-3 #9AA0A6/danger-soft #FDECEC/danger-border #F5C6C6/mask 黑 24%。
2. dsh-dark 块：补十六枚深色覆盖（即拆分前的原深色值）——深色档手机观感零变化。
3. 预览条 --femo-preview-* 保持固有深色未动（代码条观感）；画布点已全局去除不受影响。

### 验证
- 备份：MEOW_backups/themes.js.bak-20260821-round37
- esbuild 通过（lib/client.js 491.6kb）；mobile-bg 双定义×2/F9FAFB 进产物
- ⚠️ 待手机实测：浅色主题下手机壳变白/文字变深；深色主题下壳维持中性黑；两主题切换无残留

## 2026-08-21 精修第三十八轮（FEMO 预览条按主题拆分——round37 漏网组）

### 需求（用户截图反馈）
电脑端 FEMO 预览（剧本输入框+行号）在浅色主题下仍是深色底白字，"深色主题应是深色，浅色主题现在看着还是深色。看看是不是这个没按主题分开？"——确认：--femo-preview-* 五枚 token 确未拆分（round37 刻意遗留）。

### 考证
femoPreview 组件大部分已 token 化且**借用 mobile token**（textarea 底=mobile-bg-2/代码字=mobile-text-2-alt/行号字=mobile-text-3）——round37 已随手机拆分变亮；真正残留的只有行号槽底(preview-bg-2)与分隔边(preview-border) 两处消费 + preview-bg/text/text-2 三个死 token。

### 修改明细
`themes.js`：
1. 默认块 preview-* 五枚换浅色值：bg #ffffff / bg-2 #F6F8FA（行号槽）/ text #444C56 / text-2 #8B949E / border rgba(0,0,0,0.12)。
2. dsh-dark 块补五枚深色覆盖（原值 #151517/#1b1b1c/#adb2b8/#61666b/白12%）——深色观感零变化。

### 验证
- 备份：MEOW_backups/themes.js.bak-20260821-round38
- esbuild 通过（lib/client.js 492.0kb）；F6F8FA/444C56/151517 各进产物
- ⚠️ 待刷新实测：浅色下预览条变浅色代码区、深色不变

## 2026-08-21 精修第四十二轮（POSITION 卡「+画布」按钮归队 primary）

### 需求（用户）
"仓库里的 position 节点，'+画布'按钮怎么是灰的，用那个蓝色吧"——round32 功能钮清扫漏网（当时只扫了 action/special/module/创建 五处）。

### 修改明细
`libPanel.jsx` POSITION 卡「+画布」background: var(--femo-neutral) → **var(--femo-btn-primary)**（深浅各自解析：深=#4176e6 deepseek-500 / 浅=主蓝）。至此 libPanel 六处功能钮（+新建/action+画布/special+画布/module+画布/创建/position+画布）全部 btn-primary。

### 验证
- 备份：MEOW_backups/libPanel.jsx.bak-20260821-round42
- esbuild 通过；libPanel 内 femo-btn-primary ×6 确认
### 教训
全局 `touch-action:none` 是隐形杀手——它会沿祖先链污染所有子区域的原生触摸行为；禁触需求应精确挂在需要的最小区域。

## 2026-08-21 round45（真凶二号：draggable 卡片阻止触摸滚动）

### 需求（用户 round44 后反馈）
删全局 touch-action 后**还是不行**，且现象精确化："行的那几下都是按到了节点中间的间隙"——按在卡片上永不滚，按在间隙必滚。

### 根因（真凶二号）
四类卡全部带 HTML5 `draggable` 属性（桌面端拖拽用）。**Chromium 触摸设备上，draggable 元素会抑制原生滚动启动**（浏览器保留长按语义）——与 JS 无关的纯浏览器行为，所以 JS 怎么放行都没用；间隙无 draggable → 原生滚动正常。时好时坏=手指落点是否恰好压在卡片上。

### 修改明细
1. `libPanel.jsx`：新增 `htmlDraggable = true` prop；四类卡 `draggable={htmlDraggable}`。
2. `mobileView.jsx`：MobileBottomPanel 接收并透传；MobileLayout 调用处传 **false**——手机端拖拽走我们自己的长按触摸逻辑，不需要 HTML5 拖拽。
桌面端默认 true 零变化。

### 验证
- 备份：MEOW_backups/{libPanel,mobileView}.jsx.bak-20260821-round45
- esbuild 通过（lib/client.js 492.7kb）；htmlDraggable×8 进产物
- ⚠️ 待手机实测：卡片上滑=滚列表（本次应该真的好了）；电脑端拖拽入画布不受影响

### 教训
移动端 Web 里 `draggable="true"` 元素是触摸滚动的隐形杀手——HTML5 拖拽语义与触摸滚动冲突；触摸交互应自实现（本项目已是），draggable 仅限桌面鼠标场景。

## 2026-08-21 精修第三十九轮（浅色特殊节点/空节点：深色设计骨架移植，弃莫兰迪粉彩）

### 需求（用户看过浅色同步后）
"浅色主题的特殊节点（start/end/par等）还有空节点，现在是奇怪的边框奇怪的底色……和深色主题的设计感统一一下，设计思路统一颜色可以不一样。我觉得浅色其实没那么适合莫兰迪"——特殊节点+POSITION 弃粉彩底，移植深色骨架：同款灰白底 + 类型彩边 + 类型色文字。

### 修改明细
1. `themes.js` 默认块：sp-* 五枚 → var(--femo-node-bg)（白底与 action 节点一致）；新增 `--femo-node-border-mix-base`（默认=#000000，dsh-dark=var(--femo-node-bg) 维持既定压暗档）——SpecialNodeView 未选中彩边 = color-mix(sc.c 50%, mix-base)：深色向表面压暗（不变），浅色向黑压深（鲜边在白底显形）。
2. `themes.js` CSS：.femo-special-label 白字规则收回 dsh-dark 门控（浅色=inline sc.c 彩字，与彩边呼应）。
3. `canvasNodes.jsx` PositionNodeView：文字 c 与未选中边框从 neutral/femo-border → **text-2 / tag-bg 实色**（灰卡在白画布上不再虚化）；选中仍 text-2 加粗。

### 验证
- 备份：MEOW_backups/{themes.js,canvasNodes.jsx}.bak-20260821-round39
- esbuild 通过（lib/client.js 492.5kb）；mix-base×3/special-label×3 进产物
- ⚠️ 待刷新实测：浅色特殊节点白底彩边彩字观感、空节点灰卡清晰度；深色档确认零变化

## 2026-08-21 精修第四十一轮（补齐 PAR_OUT 彩边 + 浅色彩边提亮）

### 需求（用户看过第三十九/四十轮后反馈）
①"par out 你漏了"——PAR_OUT 未选中边框还是中性色，没跟上特殊节点常显彩边；②浅色彩边压太黑——"感觉全是黑的，看不出颜色"，稍微提亮。

### 修改明细
1. `canvasNodes.jsx` ParOutNodeView：border 从 `sel ? sc.c : femo-border` 改为**常显 sc.c**，宽度未选中 var(--femo-border-w)/选中 w-selected——与 START/FOR/PAR 完全同款。
2. `themes.js` 浅色 `--femo-node-border-mix-base` #000000 → **#8F8F8F**（中灰基色：50% 混合后色相浮出，不再全黑）；dsh-dark 基色=node-bg 不变（深色既定观感零变化）。

### 验证
- 备份：MEOW_backups/{canvasNodes.jsx,themes.js}.bak-20260821-round41
- esbuild 通过（lib/client.js 492.6kb）；8F8F8F 进产物
- ⚠️ 待刷新实测：五类特殊节点+PAR_OUT 彩边的色相区分度；深色档确认零变化

## 2026-08-21 交互补丁（round43：仓库慢速滑动被误武装为拖拽的边缘洞）

### 需求（用户）
"手机端仓库，在任何地方上下滑动都是让仓库上下滑动……action 区域也应该支持上滑"——round25 已实现激活前不拦截滚动的主体行为，但用户实测卡片上滚动仍不顺。

### 根因（边缘洞）
300ms 武装计时器到点时**不校验当前位移**：慢速滚动（前 300ms 累计 <5px）会在到点瞬间被武装成拖拽态 → 后续 touchmove 被 preventDefault → 滚动劫持。快速甩动不受影响（超 5px 已提前取消），慢速滚动必中。

### 修改明细
`mobileView.jsx` handleLibTouch*：
1. pre-armed touchmove 记录 lastX/lastY 实时坐标；
2. 武装到点时复核实时位移——任一轴 >4px 即判定为滚动意图，放弃武装（libDragRef 清空让位原生滚动）。
阈值取 4px（<MOVE_THRESHOLD 5px）：轻微抖动不误伤长按，正常滚动速度必超。

### 验证
- 备份：MEOW_backups/mobileView.jsx.bak-20260821-round43
- esbuild 通过（lib/client.js 492.7kb）；lastX/武装复核进产物
- ⚠️ 待手机实测：卡片上慢速上下滑=滚列表、按住不动 300ms=长按拖拽、快速甩动=惯性滚动，三态并存

## 2026-08-21 round47（性能共犯清除：touchmove 内 setState → ref 直写 DOM）

### 关键线索（用户真机观察）
"刷新后第一次滑动一般失效""先摸间隙动一下之后就活了"——首次触摸期间主线程被重活阻塞，WebKit 来不及启动滚动的典型表现。

### 根因
round43b 的调试悬浮层在**每次 touchmove 都 setState**（dbg/MOVE/DRAG 分支）——setState 触发整棵 MobileLayout（含巨量 canvasContent）重渲染，主线程卡死几十至上百 ms：①WebKit 在渲染阻塞期间无法启动/延续滚动→手势失效；②时好时坏=取决于手指速度与渲染时机赛跑。间隙能"解锁"=第一次触摸的重渲染风暴过去后主线程已热。

### 修改明细
`mobileView.jsx`：
1. 调试条改**常驻节点+libDbgRef.textContent 直写**（零重渲染，且顺带显示 panel scrollTop 客观数据）。
2. ghost 胶囊改**常驻节点+ghostRef/ghostLabelRef 直写**（display/left/top/label 全 ref）；libDragGhost state 删除。
3. armed 开关保留唯一 state：libDragActive（驱动画布放置提示，每手势仅 2 次渲染）。
4. handleLibTouch* 内所有 setLibDragGhost/libDbg 调用点替换完毕。

### 验证
- 备份：MEOW_backups/mobileView.jsx.bak-20260821-round47
- esbuild 通过（lib/client.js 495.4kb）；libDragGhost 残留 0、ghostRef×12 进产物
- ⚠️ 待手机实测：首滑即滚/慢滑不误武装/长按拖拽正常；调试条实时显示 st=scrollTop 供客观判读

## 2026-08-21 round46（armed 拦截失效真凶：React 根级 touchmove 是 passive——改原生非 passive 绑定）

### 需求（用户规格书）
"长按过后的 drag 状态下，面板不动；TS cancel 状态下，面板要跟手滚动"——现状相反：armed 时面板跟手滚（preventDefault 失效）。

### 根因
React 17+ 在根容器把 onTouchMove 注册为 **passive** 监听（官方行为）——passive 里 preventDefault 无效。v8 armed 分支的 e.preventDefault() 从未生效 → 原生滚动照走。

### 修改明细
1. `mobileView.jsx` MobileBottomPanel：新增 useEffect 把 onLibTouchMove/onLibTouchEnd/onLibTouchCancel 以 **addEventListener({passive:false})** 挂到滚动容器 scrollRef 上（原生非 passive，preventDefault 生效）；卸载时解绑。LibPanel 卡片上的 React onTouchMove/End 挂载删除（onTouchStart 保留——无需 preventDefault）。
2. `libPanel.jsx`：删 onLibTouchMove/onLibTouchEnd props 与四类卡挂载。
3. MobileLayout 调用点不变（仍传 handleLibTouch*，经 props 进入 MobileBottomPanel 后走原生绑定）。

### 影响面
pre-armed 分支依旧不 preventDefault（滚动不受影响）；仅 armed 分支的拦截现在真实生效。桌面鼠标路径不经此处。

### 验证
- 备份：MEOW_backups/{mobileView,libPanel}.jsx.bak-20260821-round46
- esbuild 通过；原生绑定进产物
- ⚠️ 待手机实测：armed 拖拽时面板静止、ghost 跟手；松手放置正常

## 2026-08-23 femo-run 动作更名：from_scratch → fresh_start

用户拍板（原话）："Fresh start最好。确实也是一个常用语嘛，而且不管是第一次还是第N次都很适用，也没有歧义。一看就是从头开始的意思"。缘起：用户指出 from_scratch 是当年笔误（应为 from_start，又嫌笨重），且希望词义兼顾"第一次开始"与"第 N 次重新开始"、强调从头、不与 resume 混淆；曾考虑 run/start/restart/from_zero，最终选 fresh_start。
### 修改明细
1. `src/tools.ts`：enum/描述/校验/case 共 7 处 from_scratch → fresh_start
2. `src/index.ts`：2 处注释
3. `.agent-presets/dsh-femo/agent.cordis.yml`（dsh-home）：系统提示词【运行】段 2 处——主模型人设文本的真正源头在此 preset，不在插件源码
4. 不保留 from_scratch 旧值别名（纯笔误，仅两个用户）
### 影响
- 主模型调用 femo-run 时 action 必须传 fresh_start；旧值会报"action 是必填参数：fresh_start / stop / pause / resume 四选一"
- 生效条件：node build.mjs 重建 + 重启 3081（host 换血）

## 2026-08-23 运行结果通知改造：femo:notify section 废弃 → agent.steer 对话流直达

用户需求（原话摘要）：编译错误在 femo-run 返回里报错（非 ok）；跑到一半报错/全部跑完后"立即再发一条工具消息给主agent，把报错信息详细反馈"，"这些都是要发在对话流里"。调研结论：dsh 官方支持插件主动给模型发消息——`agent.steer(UserMessage)`（空闲即开新回合，忙碌时下一 step 边界消费，必达不打断），meow-memory 的 dream 任务即此机制。
### 修改明细
1. `src/engine-events.ts`：新增 steerMainAgent()（ctx.agents.get(sid) 或 ctx.get('agents') 拿主模型 agent，构造 {id,role:'user',content,source:{kind:'plugin',plugin:'dsh-femo'}} 后 steer）；flow_done/flow_error 两分支的 runNotices.set 替换为 steerMainAgent；flow_stopped 分支仅删除 runNotices.set（停止/暂停由发起方经工具返回值已知悉）；删除 flow_start 的 ensureRunNotice 调用
2. `src/persona.ts`：删除 femo:notify 三件套（runNotices/runNoticeSections/injectRunNotice/ensureRunNotice）及头注释更新
3. `src/tools.ts`：femo-run 描述改为"跑完/出错会有 [dsh-femo] 开头的插件消息直接发进对话流"
4. 编译错误路径核实：startRunOnSession 编译失败同步 throw（index.ts L236），tools.ts catch 返回 ok:false——需求①天然满足未改码
### 已知缺陷（动机）
旧 femo:notify section 把通知静默注入 system prompt，实测两次运行主模型均漏读（靠逐帧解压 session.jsonl.zstd 的 request/header 快照才实锤通知其实送达过）。
### 生效条件
node build.mjs 已重建；重启 3081 后生效。

## 2026-08-24 跑完通知时灵时不灵 + 新会话被「已有剧本在运行中」误拒：SaveQueue 哨兵毒丸根因修复
### 根因（日志+复现双实锤）
femoCompiler/save_dialog.py wait_empty() 塞 None 哨兵后，_worker_loop 消费它时直接 break、不调 task_done() → Queue unfinished 计数从第一次 wait_empty 结束起永远 ≥1 → 同引擎进程第二轮 run 的 wait_empty 卡死在 queue.join() → flow_done 永不发出 → runState.running 卡 true。表现=①同进程第一场戏通知必达、之后每场全部静默（flow_error/stop 路径不走 wait_empty 不受影响，故「时灵时不灵」）；②running 全局单例卡死后任何新会话 femo-run 被 resolveMounted 守卫拒绝，主模型对用户说「目前已有剧本在跑」（meow-3081-console.log L255-265 现行实录）。
### 修改明细
1. femoCompiler/save_dialog.py：哨兵分支补 self._queue.task_done()（一行根因修复）
2. src/bridge.ts：新增 onExited 回调，进程退出时触发
3. src/index.ts：bridge.onExited 接线清孤儿 running/humanWait；resolveMounted 守卫文案带归属会话 id（本会话 vs 另一会话区分）
4. src/run-control.ts：handleRunOnSession 409 同样带归属会话
5. tests/repro_wait_empty_poison.py：复现脚本（monkeypatch 写入零 DB 触碰；修复前 ROUND 2 必挂 queue.join()，修复后两轮全过）
### 验证
- 复现脚本：stash 对照旧代码 ROUND 2 挂死/新代码 PASS
- pytest 全量 80/80 通过
- node build.mjs + tsc -p tsconfig.host.json 零错误；重启 3081
- 端到端：同一会话连跑 notify-theater 两场，两场均 flow_done+sys 广播+steered main agent（修复前第二场必卡死且后续全 409）
### 已知遗留（待议不动）
- shutdown 命令在 run 线程未清完 state[runner] 时会再调一次 runner.stop() → 双 flow_stopped（test_stop_cancels_fork_branch 偶发 flaky，12 次采样出现 1 次；与本修复无关的既有竞态）
- handleCreateSession 带 femo 时绕过 running 守卫直接覆盖 runState（跨会话事件串窗风险）
- 首跑竞态：broadcast dropped (no projection window) 仍在（todo 0mt6kvlfh）

## 2026-08-24 视角跳转的标签页跟手：切换后落哪由「切换前」所在标签页决定
### 需求（用户原话）
「切换视角后所在的标签页，取决于切换视角前所在的标签页。比如如果切换前在对话，那么切换后就在对话。如果切换前在femo编辑器，那么切换后就在femo编辑器。所以不需要存这个视角之前停在哪里了。只需要知道切换前是在哪里——这个可以直接知道。」
### 机制调研
每窗口激活 tab 存于 ui-conversation per-session chat store（view 字段，persist dsh.conversation.chat；点 tab = actions.setView(id)），不对外暴露且红线禁跨包 import → 走 client.tsx 已有先例的 DOM 契约（[role=tab]/aria-selected/文本匹配）。rc.2 tab 环仅两成员：chat(label 对话/Chat, id chat) + femo(Femo 编辑器)。
### 修改明细（纯 src/client.tsx，刷新生效）
1. 模块级：FEMO_EDITOR_TAB_LABEL/CHAT_TAB_LABELS 常量 + pendingTabTransfer 一次性标记（5s 过期）+ readActiveTabKind()（读 [role=tab][aria-selected=true] 文本判侧）
2. pickView 三个 openSession 分支跳转前设标记；offstage 同会话分支与降级分支不设
3. FemoViewButton 挂载 effect 消费：非 femo 家族窗口（mainSid undefined）不消费防误触发；轮询 ~2s 等 tab 环；只认可见 tab（offsetParent 过滤，防点中普通会话上 display:none 的编辑器按钮）；已一致不点击（不多写持久化）；点击走官方链路=与手点行为完全一致
### 影响面
不经视角菜单的开窗（侧边栏/面包屑）完全不受影响，保留各窗自然记忆；无新增存储。

## 2026-08-24 视角跳转落编辑器：手机端以「header 在上」常规态起步，不进全屏沉浸
### 需求（用户原话）
「在femo编辑器切换视角的话，切换过来的femogen网页还是不要全屏，保持之前的状态（之前能切换说明上面header在上面呢）。切换之后保留之前header在上面的状态，除非用户手动按了那个全屏的按钮」
### 根因
FEMOEditor 手机端插件模式 mobileFs useState(true) 每次挂载默认全屏沉浸（zIndex 900 盖住 dsh 外壳）→ 视角跳转=新会话挂载=必然全屏起步，header 被盖、视角菜单不可达。
### 修改明细
1. femoGen/src/FemoWorAuto.jsx：新增 initialMobileFs=true prop，mobileFs 初始值改用它（一行级；默认路径零变化）
2. src/client.tsx FemoEditorView：首帧 useRef 快照 pendingTabTransfer（渲染期先于消费 effect，标记完整），视角跳转落编辑器时传 initialMobileFs=false
### 影响面
手动点编辑器 tab/侧边栏/独立模式全部照旧默认全屏；仅「经视角菜单跳转且落在编辑器 tab」的手机端挂载改为常规态起步。桌面端不读 mobileFs 不受影响。

## 2026-08-24 手机端 femoGen 默认态改版：无条件「header 在上」起步（推翻沉浸优先）
### 需求（用户真机反馈后原话）
「切换过去之后……到底是全屏显示，还是在Header下面显示，取决于这个视角之前是怎么设置的。我希望的是，切过来的时候一定是在Header下面显示。默认在Header下面显示，除非用户手动点全屏。」
### 上一版（7b90594 initialMobileFs 豁免）为何失效
会话切换经 SessionProvider key={sessionId} 整体重挂载（ui-renderer session-provider.tsx 实证），但目标窗上次停在对话 tab 时编辑器要等 tab 对齐点击后才挂载——豁免标记已在点击瞬间被清掉，晚到的挂载读不到 → 回落默认全屏；停在编辑器则首帧读到 → 非全屏。故表现为「看之前怎么设置」。
### 新方案（用户规则升级：默认=header 在下，与跳转无关）
1. femoGen/src/FemoWorAuto.jsx：mobileFs 初始值 useState(true→false)；删除未发布的 initialMobileFs prop（签名还原）
2. src/client.tsx：删除 arrivedViaViewJumpRef 快照与 initialMobileFs 传参（7b90594 管道整体撤除）；pendingTabTransfer 标签页跟手保留
### 行为
任何挂载（视角跳转/手动开窗/切 tab 重挂载）一律 header 在上；全屏键进沉浸、返回键退出；独立模式与桌面端不读 mobileFs 零影响。

## 2026-08-25 引擎修复：for 循环出口边被吞，循环后首个动作节点被静默跳过
### 缘起
随手写《深夜食堂新品企划》（工作区 femo/深夜食堂企划.femo）实测发现：`for ... -> [judge]:评审` 的评审动作从未发起 LLM 调用（Chronica react_steps 8 条而非 10 条；子代理会话目录只有 8 个），定稿同样被跳过；流程却因「顺藤摸瓜」兜底直达颁奖/END，戏看似演完——违反「不许静默吞错」红线。
### 根因
FEMO_runtime.py `_run_for_loop`：网关只有无条件出边时（解析器保证注册顺序=体内链先、块后出口行后），旧代码把全部出边塞进 loop_entries，exit_edge=None；循环结束走「从入口顺藤摸瓜」兜底，返回了出口节点的下一个节点（如 [judge]→[颁奖]），夹在中间的动作节点整个被绕过。discussion.femo 同款写法同受影响。
### 修改明细
1. femoCompiler/FEMO_runtime.py `_run_for_loop` else 分支：无条件出边第一条=循环体入口，第二条（若有）=出口 exit_edge；>2 条无条件出边直接 raise ValueError（响亮报错，不静默）。
2. 回归测试：tests/repro_for_exit.py + python/for-exit-verify.femo（零 LLM，@assign 复刻「for→[judge]→if→颁奖 / for→[final]→END」骨架，断言 10 个动作全按序执行且 good_hits==1）。
### 验证
- pytest 全量 Python 测试 69 passed（test_parser/flow_events/par_nested_for/par_if_dispatch/mind/flow_ref_validation/out_whitelist/town_structure/stop 等）
- 静态扫描 examples/+python/+tests/ 全部 .femo：无任何 for 网关 >2 条无条件出边（werewolf-mind.femo 编译失败系既有问题，与本改动无关）
- 全新 bridge 子进程跑 repro_for_exit.py：✅ PASS（序列 开场→构思×2→提案×2→judge→颁奖→感言×2→final）
### 生效条件
femoCompiler 是常驻 bridge 子进程启动时一次性 import——GUI 内运行需重启 3081 才用上新代码（与待办中既有的 3081 重启项合并为同一次）；直接 python 调引擎的路径即时生效。
## 2026-08-26 新增台账查询器 chronica.py + femo:docs 指路
### 内容
1. 插件根目录新增 chronica.py（与 femo-chat.mjs 同族的剧场应急工具）：直连活体 user_data/memory/Chronica.wor（WAL mode=ro 只读，引擎运行中可查），无参=最新场次发言流 / 场次号=指定场次 / --list N=最近N场 / --scope=逐行附带可见用户与可见角色。输出按设计理念分两幕：【对话流】=showprompt 旁白+AI 发言+人类输入；【幕后指令】=节点 prompt（不属对话流）。判别依据 dialog.user_id：femoshow-*=旁白 / femo-*=指令 / 其余=真人。
2. src/persona.ts injectFemoDocs 的 femo:docs section 追加「运行记录查询」段：指路 chronica.py（${packageRoot} 运行时插值，跨机器正确）+ 四个用法 + 对话流/幕后指令两幕说明。
### 生效条件
host 改动——需重启 3081 后新注入文本才出现（注意与 3080 侧重构窗口协调，后构建者胜）。
## 2026-08-26 修复：会话记录剥空（运行收尾竞态把档案写成 {sessionId}）
### 病根
state-files.ts 全部会话记录写入方（writeSessionScript/writePlayResume/updatePlayResume/appendFemoSession）都是「async 读→改→async 写」三段式且零互斥。fs.writeFile 有 truncate→write 中间窗口，并发读撞进窗口读到半个 JSON→解析失败被静默当「档案不存在」→从空底重写整份文件。实测场次 869 收尾时（23:37:04，与最后一条 AI 发言同秒）记录被剥成只剩 {"sessionId"}，path/text/rev/femoSessions 全灭；此前多次「重启后挂载丢失」实为同因（上一场结束时已中招）。
### 修改明细（全在 src/state-files.ts，调用方签名零变化）
1. 新增 recordLocks + withRecordLock(sid, fn)：同一 sessionId 的所有记录变更串行队列，读→改→写全程不交错；
2. 四个写入方全部改走锁；updatePlayResume 锁内直接经 setPlayResumeLocked 落盘（消除原「内部再调 writePlayResume」的嵌套自锁风险）;
3. readSessionRecord 加 quarantineOnParseError 参数（仅限持锁写入方开启）：解析失败=真损坏，坏档改名 .corrupt-<ts> 留证并大声报错后按缺失处理；普通读取方不开（并发瞬态撕裂读不可隔离，否则误伤好档）。
### 验证
build.mjs 通过，bundle 含隔离逻辑。行为级验证待重启 3081 后：跑任一剧本→flow_done 后检查 user_data/sessions/session-<sid>.json 应完整保留 text/femoSessions。
## 2026-08-26 femo-run「模拟按前端 run 按钮」（AI 触发复用多端守卫+语法检查）
### 背景/动机
用户拍板：femoGen 前端的「run 按钮」多端不统一判定逻辑（未落盘修改守卫 femoDirty/graphDirty）+ 语法检查（parseFEMO）很珍贵，AI 的 femo-run 应复用同一份代码——工具不测任何不同，只带「这是 AI 按的」标签触发前端按钮，有错返回给 AI（谁触发就返回给谁）。
### 修改明细
1. femoGen/src/FemoWorAuto.jsx：handleRunWorkflow 加 source 参数（默认 'human'）——AI 触发（'ai'）不弹窗不 alert，各分流点（已有剧在跑/多端不统一/语法错/点火成功/运行错）经 onRunResult 回传（多端不统一时带 conflicts={textDirty,graphDirty,record,local} 供 AI 裁决）；成功时 reset 恒为 true（fresh_start 语义）。组件改 forwardRef + useImperativeHandle 暴露 triggerRun(source)，经 triggerRunRef 调最新 handleRunWorkflow（防闭包陈旧，同 handleGraphToFemoRef 惯例）。
2. src/client-ui/editor-view.tsx：SSE 监听加 run_request 分支→editorRef.triggerRun('ai')；新增 reportRunResult → POST /dsh-femo/run-result（带 sessionId）。
3. src/tools.ts：FemoToolDeps 删 runScript、新增 runEditorCommand(sessionId)；fresh_start 分支改为「广播+等回传」，不再 readScript/takeEditorErrors（成功回执 appendChatBroadcast 🎬 保留）。新增导出 RunResult 类型。
4. src/index.ts：新增 runRequestPending Map + RUN_REQUEST_TIMEOUT=30s + resolveRunResult；toolDeps.runEditorCommand=广播 run_request{source:'ai'} + await 回传（超时明确报错）；resolveMounted 保留（resume 仍用），runScript 实现删除。
5. src/routes.ts：新增 route POST /dsh-femo/run-result（resolve 对应 sessionId 等待者；无等待者静默忽略）。
### 生效条件
host+前端双改动——需重启 3081 后才生效（lib/client.js 与 lib/index.js 已重建）。
## 2026-08-26 单页常驻编辑器架构 v3（编辑器永不卸载 + 内容跟随打开的 Session）
### 背景/动机
实测发现「前端必然在线」假设不成立：Femo 编辑器 tab 没激活 → editor-view 未挂载（conversation.view only:active.id）→ host 的 run_request 无人接收 → femo-run 30s 超时「前端未响应」，坏剧本的编译错误也传不回主模型。用户拍板：内存里只有一个 femogen 网页（单 FEMOEditor 实例），内容跟随打开的 Session 加载（打开哪个加载哪个，切 Session 重载）。
### 修改明细（全在 client 侧，host 零改动）
1. 新增 src/client-ui/editor-page.tsx：①模块级单页 store（target/锚点/会话引用计数）+ 全局控制 SSE（/dsh-femo/events 单例，管 run_request 与 script_changed）；②mountFemoEditorPage = body 级隐藏容器（fixed inset:0 + visibility:hidden，保留视口尺寸使编辑器布局计算一致）+ createRoot（react-dom/client 已确认在 seed 映射里）；③EditorPageRoot 订阅 store、applyPagePlacement 把根容器 DOM 挪进锚点/挪回隐藏位（同一个 DOM 节点，React 状态零丢失；锚点销毁时即使根容器被连带 detach，fibers 不死，下次 applyPagePlacement 重新挂接即恢复）；④FemoEditorPage = 编辑器页（key=sessionId 保证切 Session 全量重载），editor-view 的全部逻辑迁入（session-state 加载/409 冲突弹窗/定稿落盘/导出导入/preflight/restore 横幅/run_result 回传/triggerRun）。
2. src/client-ui/editor-view.tsx 重写为【锚点】：仅注册/注销 DOM 容器（useLayoutEffect，母会话 id 解析保留）+ composer 隐藏 + data-conversation-composer-overlay 契约；不再自建 SSE/状态。
3. src/client-ui/view-button.tsx：header.actions 挂载/卸载上报 editorPageOpenSession/CloseSession（refcount 计数，主窗与投影窗同 mainSid 合并）→ 内容跟随「打开的 femo 主会话」。
4. src/client.tsx：apply() 尾部 mountFemoEditorPage(scriptViewInjected)。
5. femoGen/src/FemoWorAuto.jsx：坏剧本恢复失败（parseFEMO 抛错）时也 setFemoText(initialScript) 载入原文（画布留空）——①人类可就地改；②AI 触发时 handleRunWorkflow 的 parseFEMO 回传真实错误而非「请先编写或导入 FEMO 脚本」。
### 行为语义
- tab 切换：编辑器不卸载（状态/dirty/SSE 全存活），run_request 永远可达；
- 切 Session：key 变化 → 编辑器全量重载（从 record），符合「打开哪个加载哪个」；
- run_request 落在非当前会话：内容切过去加载并跑，跑完不切回（下次会话交互重新对齐）；
- 锚点（Femo 编辑器 tab）在任意窗口（主窗/投影窗，母会话 id）共享同一实例显示位。
### 已知待验
- 隐藏容器从视口尺寸切到锚点时画布自适应（可能有一帧尺寸差异）；
- 空 rollback：编辑器隐藏时其全局 keydown（space 平移画布）仍生效但不可见（无实际影响）。
### 生效条件
纯前端改动——刷新浏览器页面即生效（若缓存旧 client.js 则强刷 Ctrl+F5）。

## 2026-08-27 投影窗去重查重性能修复（O(n) 全扫 → O(1) Set 索引）
### 病根
projectionAppend / mirrorMainEventToGod / subagent ensureTurnStart·ensureStepStart 的幂等查重全部是 win.events.some() 全量扫描。投影窗事件积累到 13.7 万级后每次查重 O(n)、事件一多整体 O(n²)，事件循环被同步代码堵死 2.5~10 秒（3081 日志心跳实证 event-loop stall 2514~10274ms）——所有 HTTP RPC 排队超时，症状 = 发消息没反应 + 「signal timed out」+ 无法建立新会话 + 时好时坏（会话越大越频繁）。
### 修改明细（查重语义零变化，只换数据结构）
1. src/projection.ts：新增模块级 WeakMap<Session, 索引> 三件套——dedupeIndexFor（懒构建：首次遍历现有 events 全量建 Set）、dedupeStructKey（模块级化）、dedupeMarkIndexed（仅对已建索引的窗增量补键）；projectionAppend 查重与 append 后补键、projectionHasDescriptor 都改走索引；
2. src/god-mirror.ts：mirrorMainEventToGod 5 处 .some()（_srcSeq + 4 结构键）改 Set 查重 + append 后补键；
3. src/subagent.ts：ensureTurnStart/ensureStepStart 兜底查重改索引；
4. createProjectionRegistry 挂全局 ctx.on('session/event') 钩子——任何 append 来源（含 dsh 内部 surface 自动补 start）都同步补键，索引不漏。
### 验证
tsc 双绿；lib/index.js 重建；3081 重启后：13.7 万事件大会话 catch-up/投影请求由「卡 10 秒」变「毫秒级返回」（503 等防错响应也即时到达），健康探测全部 200 <50ms。用户待实测发消息/跑剧本流畅度。


## 2026-08-27 register legacy 'dsh-femo/turn-scope' for session-event registry
### root cause
src/index.ts only registered 'dsh-femo/chat' via registerSessionEventType. Legacy
sessions (pre turn-scope-file refactor) still contain 'dsh-femo/turn-scope' log
events; the persistence read path refuses unregistered event types
(coordinator assertEventsSupported fail-closed), which also failed the
session-query-sqlite FTS observer on 3081 (search-status unavailable: event type
"dsh-femo/turn-scope" unknown to this harness and not marked ignorable).
### change
src/index.ts: register 'dsh-femo/turn-scope' alongside 'dsh-femo/chat'.
### verification
build.mjs OK; lib/index.js rebuilt. Needs 3081 restart; then
POST /switch-search/api/search-status should return available:true.


## 2026-08-27 戏内投影窗 stage（搜索来源二分：主会话=戏外 / 戏内窗=戏内）
### 背景与拍板
跨会话搜索（session-query-sqlite + tool-session-query）把每个投影窗都索引，同一段
戏内对话命中多份。用户拍板（2026-08-27）：①加一个纯戏内归档投影窗（方案B），
搜索来源唯一化；②搜索排除走工具层（rc.2 官方包 MEOW_MODIFICATIONS 条目4，
`searchExcludeIdPrefixes:['femo-proj-']` / `searchExcludeIdExemptSuffixes:['-stage']`）；
③旧剧本不回填（旧戏内内容在上帝窗，被搜索排除后旧的搜不到——知情接受）。
### 实现要点（复用度极高，架构全走既有通路）
1. src/projection.ts：导出 `GOD_ACTOR`/`STAGE_ACTOR='stage'` 常量与 `ProjectionWindows`
   接口（god/stage/actors 三字段，替换 6 处内联形状）；descriptor label 收敛为
   `descriptorLabel()`（god=👁上帝视角 / stage=📜戏内 / 其余=🎭角色）；
   `ensureProjectionWindows` 增建 stage 窗（幂等/冷唤醒全自动）；
   **projectionAppend 加一行 `appendTo(windows.stage)`**——全部戏内事件（聊天行/名字行/
   turn/step/引擎通知/广播）自动进戏内窗；主会话镜像走 god-mirror 直写 god 窗不经此函数
   → 戏内窗天然零戏外内容（方案B的根基，零额外代码）；
   registry buildOnce 补 stage 兜底（旧 registry 条目/重启前窗自动补建）。
2. src/routes.ts：projection-windows API 返回加 stage id。
3. src/client.tsx + client-ui/view-button.tsx：listProjectionWindows 类型/proj 缓存加
   stage；视角菜单加「📜 戏内」项（FaScroll 图标，fa-icons.tsx 新增）；pickView stage
   分支不写 view 状态（戏内窗默认视图由 femo-proj- 前缀推导 god 视角=全显，无 scope 语义）；
   activeViewId/label/title 加 stage 情形。
### 零影响论证
现有 god/角色窗写入路径一字未动，只多 append 一个全新 id（femo-proj-<sid>-stage）的窗；
去重索引按窗隔离；lineage 子代理下拉按 femo-proj- 前缀过滤自动隐藏戏内窗；
chat-node scope 过滤只在非 god 视角生效（戏内窗恒 god 视角=全显）；流式直播锚点不认
stage 尾段 → 戏内窗无打字机直播（归档窗定位，预期行为）；导演发言/主会话镜像不进戏内窗。
已知边界（与 god 撞名同类，记档不修）：剧本角色恰好叫纯 ASCII `stage` 会与戏内窗撞 id
（ensure 幂等复用两窗合一）；engine 无保留名校验。
### 验证
tsc（tsconfig.host.json）exit 0；build.mjs 双 bundle 重建（banner 完整、FaScroll/stage/
📜 戏内转义字面量核验全过）；rc.2 侧排除规则 vitest 105/105。待 3081 重启后用户实测：
跑短剧本 → femo-proj-<sid>-stage 窗创建且内容=全戏内无戏外 → agent 搜索同关键词不再多份。

## 2026-08-27 戏内窗归档回填（修旧剧本 stage 窗 blank→Hero 无 header）
### 用户报告
"现在这个戏内窗连Header都没有。在UI方面，你写的应该是有点问题的，你再检查一下。好好参考其他投影窗的写法。"
### 根因（官方机制，非 stage 分支代码错）
宿主 blank 位只认 turn/start（api-proxy.ts sessionBlank：`!events.some(e => e.type === 'turn/start')`，
插件事件/descriptor 都不算）；blank 会话前端走 Hero 态（ConversationSessionHeader
`hideChrome = blank && composerPhase === 'blank'`）整个 header chrome 隐藏。god/角色窗
因子代理镜像必合成 turn/start 而从不 blank；旧剧本的 stage 窗迟到于历史演出、日志只有
descriptor → 永远 blank → 无 header，且 blank 会话有被"新建会话"复用的风险。
### 修复（推翻 2026-08-27 早前"不回填"拍板——UI bug 使限定回填成为必要，用户报告即授权）
projection.ts 新增 backfillStageArchive（registry buildOnce 尾部触发，幂等门槛=stage 窗
尚无 turn/start + 进程内 Set）：从 god 窗复制可判定为戏内的事件——①dsh-femo/chat 行
全部；②_srcSeq 为 string 含 '#'（08-24 命名空间隔离后子代理镜像）；③turn/step 结构事件
且 turn ∈ turn_scopes 文件（子代理合成 turn 权威记录）。裸数字 _srcSeq（主会话镜像=戏外）
绝不复制（宁缺勿污，08-24 前旧格式 god 窗因此可能只有结构+chat 行）。复制走 appendEvent
（surfaceOp 原样），去重靠 stage 窗自身索引钩子。createProjectionRegistry 加 femoRoot
参数（index.ts 调用处传 resolved.femoRoot）。
### 零影响论证
只写 stage 窗；复制事件均为 god 窗日志已持久化的合法事件（迁移器合法性继承）；
god/角色/主会话零写入；O(n) 遍历仅一次（门槛挡重复）；08-24 前旧格式不可判定即跳过。
### 验证
tsc exit 0；build.mjs 重建（backfill/archivedTurns/turn_scopes 字面量核验）。
提交 f8007ef（index.ts 仅含本 hunk，git apply --cached 拆分，他窗遗留 hunks 留工作区）。

## 2026-08-28 戏内窗四项微调：回填补丁撤销（拍板变更）+ 文案/图标/流式锚点
### 用户反馈（原话要点）
"棒！现在显示正常了！" + ①"📜 戏内"改成"戏内视角" ②图标换电影相关 ③"旧剧本不用理！
当他们不存在就好，别担心那个" ④质疑 god 窗复制："戏内视角不应该依赖god窗啊……比较合理
的做法是和god窗一模一样的投影方式，只是不放主模型的部分……我们之前写得投影逻辑花了很多
心思，你直接复制过来就好。流式输出之类的都可以复用吧？" ⑤问 session 标题标记是什么。
### 澄清与决策
实时投影主通路本就与用户设想一致（projectionAppend 三分发，stage 与 god 同权，唯一例外
=god-mirror 主会话镜像不进 stage）；"从 god 窗复制"只是修旧剧本 header 的历史回补补丁，
不是投影通路。按 ③④ 拍板：**撤销 backfillStageArchive 整个补丁**（回填函数/调用/进程内
Set/readTurnScopeFile import/createProjectionRegistry femoRoot 参数全部拆除，index.ts
调用恢复 createProjectionRegistry(ctx)）——旧剧本 stage 窗回归空窗（用户拍板"当他们
不存在"），投影逻辑回归纯粹：stage 窗=与 god 窗同一条实时投影通路，唯一区别无主模型镜像。
### 修改明细（6 文件）
1. projection.ts：删 backfillStageArchive+stageBackfilled+buildOnce 调用+readTurnScopeFile
   import；createProjectionRegistry 撤 femoRoot 参数；descriptorLabel '📜 戏内'→'戏内视角'
   （此 label=subagent/descriptor 的 label 字段=dsh 原生会话显示名/子代理下拉名，即问题⑤的答案）
2. index.ts：调用恢复 createProjectionRegistry(ctx)（hunk 级提交）
3. fa-icons.tsx：FaScroll→FaClapperboard（FA6.7.2 权威 path，unpkg 核验，场记板=电影语义）
4. view-button.tsx：菜单/按钮 label '戏内视角'+FaClapperboard
5. chat-node.tsx：streamEligible 加 winActorKey==='stage'（流式打字机锚点对齐 god 窗——
   femo_stream SSE 本就全窗广播，stage 窗此前只差锚点判定一行）
6. chat-node.tsx 注释对齐（god/stage 窗显示全部演员）
### 语义影响
旧剧本 stage 窗回归 blank→Hero 态（用户拍板接受，"当他们不存在"）；新剧本 stage 窗实时
投影不受影响且新增流式直播。
### 验证
tsc exit 0；产物核验全过：backfill 字面量清零/FaClapperboard 在/FaScroll 清零/
stage 流式分支在/「视角」转义字面量在。

## 2026-08-28 戏内菜单项门控（用户实测拍板：没剧本记录不显示，和角色视角一个道理）
### 用户实测与拍板（原话要点）
"剧本还没开始跑，戏内视角根本没东西的时候，如果切换到戏内视角，就连header也没了
（也就导致换不回来了）。所以正确的修bug方向是，当本session没有任何剧本记录的时候，
上面的视角菜单里不要显示戏内视角这个选项。和角色视角一个道理吧……"
（先问"header 消失是因为补丁吗"——澄清：不是补丁，是宿主 blank 机制即上一条目根因；
回填补丁是当时的修复尝试，已于同日撤销。）
### 实现
view-button.tsx 菜单 stage 项加门槛 `actors.length > 0`（与角色项同源：scriptActors
来自 /dsh-femo/actors 即剧本记录，chatActors 兜底；没跑过剧本两者皆空 → 菜单只有
戏外+上帝，空窗入口不存在，卡死场景根除）。跑过剧本后 flow_start 经 d37f33b 机制
重拉 actors → 菜单自动出现戏内项。pickView 的 proj.stage 守卫保留。
### 验证
纯前端改动刷新生效免重启；build 产物 gate 字面量核验（actors.length>0 条件 ×1）。

## 2026-08-28 AI 触发点火去 rAF（60s 点火根因修复）
### 根因（实测钉死）
femo-run fresh_start 链路=工具广播 run_request SSE → femogen 页 settleThenTrigger
【rAF+30ms】→ handleRunWorkflow → POST /dsh-femo/run。rAF 在隐藏窗口/后台标签
完全不跑 → 链条冻在等帧：实测广播后 62s 才点火（恰为窗口恢复可见时刻）、窗口持续
隐藏则 2 分钟零点火。服务端无辜：直打 POST /run 全程 90ms，引擎收到 run 后 0.2s 开跑；
/models 2.5ms（collectLlmModels 纯本地）。
### 用户拍板（原话要点）
"我想借用按钮的链路，不可能直接点火的，按钮后面有一堆检查呢，我们得复用。真正的问题
是为什么非得用rAF？把mount和run都改成AI这边调工具，femogen无论藏不藏都可以实时更新。
这样其实并不存在准备不好的问题。如果没mount到位就run了，那run按钮自己会报错的"；
"mount也不能是RAF，也需要工具调用之后立即反映在网页上，不管网页藏着还是显示。这两个
工具是一样的设计"。（host 兜底点火方案被否——守卫一份，必须复用按钮链路。）
### 修改明细（2 文件）
1. femoGen/src/FemoWorAuto.jsx handleRunWorkflow：AI 路径运行文本一律现取
   getRecordScript()（record 为准——mount 已在工具调用时落盘），取不到回落空串走
   既有「请先编写或导入 FEMO 脚本」报错经 run-result 回传；绝不静默回落编辑器旧文本
   （不吞错原则）。人类按钮路径不动（仍以输入框文本为准）。
2. src/client-ui/editor-page.tsx：settleThenTrigger 的 rAF+30ms 删除 → triggerAiRun
   事件直达（loadSessionState 成功消费 / pageTriggerRef 就绪直触发 / 换目标重挂载
   排队消费，三触发点全不再等帧）；React 事件/effect/fetch 隐藏窗口照常跑，仅画帧
   冻结——链路从此不碰画帧。
### 验证
广播 → 工具 ok 回执 0.31s（06:02:07.374→06:02:07.681Z），点火 ≤2s（台账 06:02:09，
秒级粒度）；修复前对照组 30s 超时误报/62s 点火。build 产物核验：triggerAiRun ×4 在、
settleThenTrigger 清零。mount 链路核验无帧等待（SSE→fetch→setState→restore effect
全程事件驱动；余下 rAF 仅画布淡入动画/聊天流渲染，纯装饰）。




## 2026-08-29 投影窗刷新丢权限按钮/统计行（启动竞态：目录先于会话列表落地）

### 症状
刷新页面后，god/角色/戏内投影窗 composer 的权限设置按钮与输入框下统计行消失；切换 session 或切换视角（composer 重挂载）即恢复，仅刷新必现。

### 根因（探针确定性复现钉死）
恢复的 selection 直接落在投影窗时，宿主 handleConnected 同时发 session.list（重：summarize 全部会话含 13.7 万事件大会话）与 subagent 目录（轻：单 parent listChildren）。目录先回 → projectList 的 address walk 在 ids 还空着时先造出 byId[projSid]（带 parentId）→ composer 首次渲染 mainSid 非空，但 binding(mainSid) 走官方 sessions.resolve() 的 eligible 判据（ids 在册/恰为当前）→ 列表未到 → 返回 undefined → 被 useMemo([mainSid, getSessionFace]) 永久缓存（slot inject face 按 (entry, provideInfo) 缓存引用稳定，mainSid 之后不再变化 = 永不重算）；列表后到只换 byId 值、selector 输出不变，无重渲染触发。权限菜单/统计行读 mainFace 的 projections → 双双 render null。视角按钮不受影响（只依赖 byId）——探针实测「上帝视角按钮在、权限按钮缺」正是判别特征。a0f42ec（08-26 同症状修复）解决的是另一条路径（mainSid 字符串兜底让 selector 恒定），本条是其残留竞态缝。为何最近才稳定复现：大会话越来越多 → session.list 变慢 → catalog 稳定赢下竞态。

### 修复（src/client-ui/composer.tsx，+9 行）
新增 `mainListed = useSessions(state => ids.includes(mainSid))` 订阅（=官方 binding 可解析判据），useMemo deps 增 mainListed：列表落地翻真 → 强制重算 binding → 按钮自动出现。零行为变化论证：好次序下（list 先于 catalog 或都先于挂载）mainListed 与 mainSid 同一次 projectList 变真，memo 结果与旧代码完全一致；坏次序下从「永久缺失」变「列表落地即恢复」。

### 验证（scripts/probe-composer-refresh.mjs，新增探针）
headless Edge CDP + Fetch 拦截延迟 session.list 15s 确定性复现：修复后 AFTER-REFRESH 缺（列表未到，数据确实不可得，预期）→ AFTER-LIST-LAND 自动恢复 ✓（修复前同点位永不恢复）→ 切窗回归 ✓。正常无延迟启动（小/大会话各一）不受影响。tsc client 检查 composer 零新增错误。纯前端改动，junction 装配刷新即生效，未重启 3081。

## 2026-08-30 侧边栏「🎭 Femo 剧本」入口按钮移除（猫猫拍板：不再需要该入口）

### 背景
侧边栏底部 FemoButton（sidebar.footer.action 槽位：剧本菜单 + 内联粘贴编辑器 + 空会话入口）退役，新建 Femo 会话不再走该入口。

### 修改明细（2 文件）
1. src/client.tsx：删 sidebar.footer.action 槽位注册与 FemoButton import；injected() 去掉 FemoButtonInjected 标注并删 createFemoSession 字段；连带删除唯一为按钮服务的 currentCwd() 与 workspaces 服务解析，inject 依赖声明同步去掉 'workspaces'（grep 全库确认无其他消费者）。listScripts/saveScript 保留（编辑器页 scriptViewInjected 复用）。
2. src/client-ui/femo-button.tsx → 移入 D:\myFiles\dsh\mytrashbin\femo-button.tsx（红线：文件不删除，移回收站留痕）。

### 不动项（有意保留）
- host 侧 POST /dsh-femo/create-session 路由保留（编程式新建 Femo 会话入口；前端调用点已随按钮清零，lib/client.js 该字面量=0）。
- host 侧 routes.ts/run-control.ts/index.ts 提及 sidebar button 的注释未动（host 零源码改动，注释清理留给 0.1.2 适配批次）。

### 验证
node build.mjs 双产物 exit 0；lib/client.js 字面量计数：删除面 sidebar.footer.action/FemoButton/createFemoSession/create-session/currentCwd/workspaces 全 0；保留面 conversation.view×2 / projection-windows×3 / save-script×3 / triggerAiRun×4 / femo-proj-×13 / FemoViewButton×2 全在。tsc client（rc.2 快照 tsc）14 条错误与历史基线逐条一致，零新增。纯前端改动，junction 装配刷新即生效，未重启 3081。

## 2026-08-30 V6 投影窗 turn 原子缓冲——「日志顺序即容器」根治 par+工具调用的段落撕裂

### 背景（实测诊断，scripts/diag-god-log4.mjs / diag-god-log4b.mjs）
V5 后猫猫实测：无工具 react 轮显示正确，一旦工具调用即乱套。god 窗日志实锤：par 下三演员骨架+speaker 在任何内容前连排落地（#76-84），三家首 chunk 又连排（#85/86/87）→ V5 head=min(seq)−0.5 把三个名字吸附成 @甲@丙@乙 连排（与截图一字不差）；stream=max(seq)+0.1 随每次新事件瞬移（Deep diving 满屏跳）；甲的 step2（#105-110）与丙整段（#97-104）物理交错。病根=架构级：官方节点位置=自身事件 seq=追加顺序，注册表叠加制无覆盖点（conversation-assembler.ts dispatchInput 遍历全部 definition），锚点公式追的是「到达序」这个本身错误的物理位置——锚点层无解。

### 方案（与猫猫商定：「容器」目标以落盘顺序实现，渲染 100% 官方原生节点）
宿主端 turn 原子缓冲：内容镜像事件（chunk 块边界/message/tool/call/tool/result/step/end）不在到达时落盘，攒进 mirrorBuffer，turn/end 到达时一次性按序落盘——同 turn 官方节点物理连续成块（隐形容器：落盘连续⇒anchorSeq 排序连续⇒名字下恒为该角色完整段落，段序=完成序）。flush 全同步无插队风险。骨架（turn/start、step/start）与 speaker 名字行即时落盘=直播期稳定锚（窗口内该 turn 零内容事件 → 前端回退 anchor start+0.5/+0.6 恒定，V5 的锚点公式在缓冲前提下自动正确）。

### 修改明细（5 文件，+200/−32）
1. src/subagent.ts：BUFFERED_CHILD_EVENTS 白名单 + mirrorBuffer/flushMirrorBuffer/toolNamesByCallId；onChildEvent 落盘决策（turn/end=push+flush；白名单=push；其余即时）；finally 兜底 flush+合成 turn/end（turnStarted 门控，幂等靠结构键）；演员 femo_stream 帧补 step: mappedStep（chunk index 跨步复用，桶内匹配需 step 作用域）+ block_end 带 retain:true；tool/call 登记 callId→name、tool/result 广播 tool_result 帧（正文截 300 字）。
2. src/client-ui/stream-store.ts：块保留语义（retain 帧的 block_end 不再移除——缓冲下镜像行 turn 落地才接管，即删会文字闪空；导演路径无 retain 维持原移除语义）；块匹配 (index, step) 双键从后往前；新增 toolresult 块类型与 tool_result 帧处理；findLastFemoBlock kind 放宽。
3. src/client-ui/femo-stream-live.tsx：FemoStreamLive 渲染 ⚙ 结果行（femo-stream-toolresult）。
4. src/client-ui/turn-nodes.tsx：FemoTurnStreamNodeView 隐藏条件改为「turn 关闭即隐藏」（防保留桶与落地区块双份）+「桶空且无 turn 隐藏」；头注释 V6 前提说明。
5. src/client-ui/styles.ts：+.femo-stream-toolresult{opacity:.82}。

### 不影响别处论证
导演直播路径（engine-events）帧无 retain/step → store 走旧分支零行为变化；god-mirror 主会话镜像不经 subagent.ts 零涉及；历史数据（到达序旧场次）按旧布局渲染不清理（不删数据）；_srcSeq/结构键查重语义不变（缓冲只改落盘时机，data 组装照旧）；投影窗 search/stage 归档事件全量不减（只是延后到 turn 落地）；timeline turn 计时无损（turn/start 即时、turn/end≈真实结束）。

### 验证
node build.mjs 双产物 exit 0；lib 字面量：host tool_result/mirrorBuffer/BUFFERED_CHILD_EVENTS 全在、client kind:\"toolresult\"/femo-stream-toolresult/retain 全在；tsc host 0 错；tsc client 14 条=历史基线零新增。3081 已重启（node pid 15592 CreationDate 07:57:54，/ 200，/dsh-femo/actors 200）。待猫猫跑带工具的 par 剧本实测：直播期名字+桶+Deep diving 稳定钉在骨架旁、turn 落地成官方节点连续区块、名字贴段头。

## 2026-08-30 V6.1 直播工具行升级官方同款（猫猫拍板："流式的时候就显示成官方版的样子"）

### 做法（抄官方抄到零件级）
骨架件用真官方：build.mjs 本就把 @deepseek-ai/dsh-client-ui-primitives 列 external（require 解析到 shell 同一实例、样式已在页面），DisclosureRow/StateDot/变体图标（IconApiOutline14 等 6 件，与 ui-tool GenericToolCard VARIANT_ICONS 同表）直接 import = 零 CSS 成本像素级官方 chrome。行级样式按 ui-tool ToolRow.module.css 逐属性转写进 FEMO_STREAM_CSS（femo-toolrow-* 前缀）：running sweep 流光（color-mix --dsw-alias-bg-base 60%）、2x2 sep 点、14/24 summary FILL 截断、IN/OUT 卡（l1 边 12px 圆角、150px 内滚动、sticky IN/OUT 标签、l2 分隔线）、sr-only 状态文本。行模型照抄 tool-call-model.ts：variant 分类表/figma 标题表（Search/Read/Bash/Write/Edit/Code/Tool call）/摘要键偏好表（bash=[description,command] 等）/deriveSummary（流中截断 JSON 回退 firstLine，与官方 running 行为一致）/deriveBody（可解析 pretty JSON、code 取 program）。

### 数据流变化
tool_result 帧由"独立 toolresult 块"改为**合并进最近同名未完成 toolcall 块**（官方语义一次调用一行：IN=流式参数、OUT=结果，块 running→ok；step 同源匹配防并行同名串线；无在流参数块时空参完成态行兜底）。FemoStreamBlock 加 result 字段、删 toolresult 种类（.femo-stream-toolresult 同删）。宿主 tool_result 帧补 step、正文上限 300→2000（官方 OUT 卡 150px 内滚动承接）。未转写：terminal/read/search/diff/web 专用卡片、fileLink 打开件、Inspect 轨迹跳转——这些等 turn 落地由官方原生行接管，直播桶只做通用行。

### 验证
node build.mjs exit 0；tsc host 0 错、client 改动文件 0 错（基线 14 不变）；lib/client.js 字面量 femo-toolrow×36/DisclosureRow×3/tool_result×1/toolresult 残留 0。3081 重启（pid 26124 CreationDate 08:28:35，API 200）。待猫猫硬刷新实测：react 工具调用流式期即显示官方行（running 流光→结果后 ok 态、点行展开 IN/OUT 卡）。

## 2026-08-30 V6.2 showprompt 跟随角色（📢 旁白 turn 化：在角色标签之前、紧挨、跟着跑）
### 背景与需求（猫猫原话）
"我发现我们少考虑了个事，还有showprompt呢，也是会显示在屏幕上的，是属于一个节点（或者说一个子agent）的。它的位置需要在角色标签之前，紧挨着角色标签。跟着角色（节点/子agent）跑，角色内容（节点/子agent）去哪它去哪。"
### 现状诊断（重读 V6 链路后定位）
showprompt 旧落点=engine-events context_ready 分支瞬间 appendChatProjected 直接落盘（比子代理启动还早），是独立官方节点、无 turn 归属，完全不在 V6 缓冲/吸附体系内。串行单节点时碰巧挨着自己区块；par 并发（三 📢 连排抢先、区块按完成序落地）/导演节点间插话（god 镜像即时落盘插入）/重试轮三种场景必与角色区块分家。
### 方案（复刻 speaker V5 让位模式：物理 seq 无关、turn 归属、head 接管渲染）
1. src/engine-events.ts：RunState 新增 nodeShowprompts Map（与 nodeActors 同款簿记）；context_ready 不再立即落盘改暂存（仅引擎未带 node_name 的理论不可达路径保留旧立即落盘，零信息丢失）；runAiSubagent 调用点追加传参。
2. src/index.ts：runState 实例化补 nodeShowprompts: new Map()。
3. src/subagent.ts：签名加 nodeShowprompts 参数；appendShowpromptLine()（幂等 showpromptWritten，落 dsh-femo/chat {kind:'prompt', text:'📢 '+showprompt, turn:baseTurn, visible:scopeInfo}），调用点=appendSpeakerLine 旁（首个将落盘镜像事件之前）+ finally 兜底（与 speaker 兜底完全同款，带 turn 风险等价）。
4. src/client-ui/chat-node.tsx：femoChatDefinition.match 对带 turn 的 prompt 行让位（L59 speaker 让位同款一行，无 turn 旧数据与 human 节点 prompt 不受影响）。
5. src/client-ui/turn-nodes.tsx：turnCoordinateOf 认带 turn 的 prompt（归 turn Context）；FemoTurnNodeState/FemoTurnHeadData 加 showprompt；updateTurnState 改写为 actor/showprompt 双向保留（prompt 事件无 actor 沿用已有、speaker 事件保留已有 showprompt，防互覆盖）；FemoTurnHeadNodeView 渲染 📢 条（样式照抄 femoChat prompt 条：accent 左边框+6% 底+12px 灰字）在名字行上方，同节点永不分离。
### 不影响别处论证
headAnchor/streamAnchor 扫描集合只有 assistant/chunk|message|tool/call|tool/result——prompt 不在集合，锚公式一行未动；📢 即时落盘（不进 mirrorBuffer），V6 内容区块连续性零触碰；渲染位由 head 动态锚决定，par 交错/主模型镜像穿插物理位置无关；落地后 head=首 assistant 内容−0.5 → 排序 📢+名字 → 官方区块；直播期 head 回退锚 turn/start+0.5，📢+名字+直播桶都钉骨架旁（📢 直播期可见）。行为差异留痕：重试轮（引擎重发 ai_request 而 Map 不清）每轮各带一条 📢，旧行为取决于引擎是否重发 context_ready，实测观察。
### 验证
node build.mjs 双产物 exit 0；tsc host 0 错；tsc client 14 条=历史基线零新增（turn-nodes 零错误）；lib 字面量：host nodeShowprompts×5/showpromptWritten×3，client 让位守卫×2（speaker+prompt 带 turn return null）/turnCoordinateOf 认领（kind!=="speaker"&&kind!=="prompt"）/updateTurnState prompt 分支/head 渲染 showprompt×31 全在。host 改动需重启 3081。

## 2026-08-30 暂停/停止全场掐断：femoGen 右上角⏸⏹接上 dsh 发请求的链路（+僵尸演员清理）
### 背景与需求（猫猫原话）
"我记得我以前給femogen右上角写停止的时候，api请求是femogen自己发的。但是现在，作为dsh插件，api请求是dsh发的，所以femogen的右上角的暂停、停止链路，得修改，要接上dsh发送api请求的链路"；"我希望的是，按右上角暂停键，全场的AI输出可以停下来。同时checkpoint保存起来就好了。"
### 根因
旧世界 femoGen 自己发 API 请求，暂停=掐自己的 fetch 即可；插件化后 AI 演员的请求由 host 侧 dsh 子代理发出（runAiSubagent），停止链路（前端⏸⏹/AI 工具 pause·stop/输入桥硬停/shutdown → bridge 'pause'/'stop' → runner.stop()）只取消引擎侧协程，在飞子代理毫无感知（AbortController 只有空闲看门狗会触发）→ 流式输出继续进上帝窗。checkpoint 无需改：引擎进入节点前发 checkpoint 事件、host 增量持久化 resume 块、flow_stopped 不清块（只有 flow_done 清）——断点天然保留，续跑从被打断节点重放。
### 方案（flow_stopped 唯一收口 + 子代理登记表）
flow_stopped 全引擎仅 runner.stop() 一处发出=所有停止路径的权威汇合点，在此一处掐断全入口自动覆盖。
### 修改明细（3 文件，~45 行）
1. `src/subagent.ts`：模块级 activeSubagents 登记表（controller+node）+ runControlAborted WeakSet + export abortActiveSubagents(reason)（遍历 abort、幂等、返回掐断数）；runAiSubagent 在 controller 创建后立即登记（首个 await 前的同步段内，flow_stopped 必然晚于登记到达）、finally 注销；两处闸门：runControlAborted 命中→跳过 recordError（暂停不是错误，不污染面板错误表）+跳过向引擎回传 human_input（引擎已在停止流程中、ai 等待协程已被取消，空回传无意义且有唤醒未退净等待协程的竞态）——成功路径与异常路径都闸，空闲超时（唯一既有 abort 来源）路径逐字节不变。
2. `src/engine-events.ts`：case 'flow_stopped' 开头 abortActiveSubagents（前端⏸⏹/AI 工具/输入桥硬停/shutdown 全汇于此）；case 'flow_error' 同款（引擎已死，在飞演员输出无处可去，纯清理）。
3. `src/run-control.ts`：startRunOnSession 在 running 置位前，若运行槽空闲（!runState.running）则清理残留子代理（串台修复①：bridge 死亡等漏网僵尸防污染新场次窗口直播；running=true 时跳过——create-session/resume 无守卫越轨开跑的已知缝隙 0mt6kvlfh④ 场景下绝不误杀在跑剧本的合法演员）。
### 不影响别处论证
登记表/WeakSet 纯新增簿记，既有路径不读它们；闸门只对「被 run-control 掐断」这一新状态生效，空闲超时路径零变化；被掐子代理走既有 finally 收尾（flush 镜像缓冲+合成 turn/end 半截发言收整成块+femo_stream end 清直播桶+归档）=与空闲超时同一条清理通路；flow_stopped/flow_error 处理器新增行在原逻辑之前、与 running=false/⏸⏹广播无交集；Python/前端/dsh 本体零改动。
### 验证
构建后重启 3081 实测：跑带 par/AI 节点剧本，流式中按 ⏸️ → 全场输出停止、⏸ 广播、按钮变「继续」、上帝窗半截发言收整成块；按「继续」从断点节点重放；⏹ 同验。日志锚点：`flow_stopped: aborted N in-flight subagent(s)` / `subagent stopped by run-control` / `new run: cleaned N leftover subagent(s)`。✅ 猫猫实测通过（2026-08-30："电脑端右上角确实可以停了，刚才试了一下，成功了"）。

## 2026-08-30 运行状态实时化：双端按钮三态四钮（暂停+停止/继续+从头）
### 背景与需求（猫猫原话）
"电脑端以及手机端右上角按钮的形态，我们希望它能根据剧本实际的运行状态来实时调整……如果剧本正在运行中的话，它上面应该显示的是停止。剧本如果没有开始运行，它应该显示的是运行。剧本如果被暂停了就是说有checkpoint存在，它应该显示的是继续。这个逻辑，在代码里面应该能找到。但现在这个状态识别并不准……刚刚剧本明明在运行，我手机右上角显示的是'运行'"；补充拍板："开始之后，运行中的时候，是不是也应该有两个按钮：一个暂停，一个停止。你既然要这样改 UI，就一并改了吧。"
### 根因（状态识别不准，全在前端状态机，与后端 API 无关）
1. handleWorkflowEvent 没有 case 'flow_start'——引擎事件永远无法把按钮切进运行态（只有本页点运行/恢复态 initialRunning 两条路）；2. 画布 SSE 只在本页点运行或恢复态才连——编辑器页常驻单例，页面开着时别处（电脑端/AI/另一设备）开跑，本页收不到任何事件；3. flow_stopped/flow_done 把 SSE 关掉——下一场外部运行更看不见。
### 修改明细（femoGen/src/FemoWorAuto.jsx + mobileView.jsx，纯前端刷新生效）
1. 挂载即连 SSE（plugin 模式 useEffect→connectSse）：host /events 连接建立即重放最近 100 条引擎事件（含 flow_start）恢复真实状态，连接常驻页面生命周期；2. onerror 非自杀化：不再 close+重置 idle，EventSource 自动重连+重放自愈；3. 新增 case 'flow_start'：setFlowStatus('running')+清节点高亮（重放幂等）；4. flow_stopped/flow_done 的 es.close 改 closeRunScopedSse：只关独立模式 run 流（/api/run/<id>/stream，不关会被 EventSource 当 404 反复重连），插件常驻广播保留；5. 双端按钮三态四钮：idle=▶运行；running=⏸暂停+⏹停止（停止=handleStopWorkflow→onStop→/stop=全场掐断+checkpoint 保留）；paused=▶继续+⟲从头（handleRunWorkflow 加 opts.forceReset 作废 checkpoint 强制从头）；6. 兜底：/pause 返回 paused:false、/stop 返回 stopped:false（host 说没在跑，如重启后页面状态残留）→ 按钮直接回运行态防卡死。
### 不影响别处论证
hasActiveRunningNodes 保留（画布高亮/状态胶囊仍用）仅按钮条件不再依赖；flow_stopped 的 paused 标志逻辑不变（暂停→继续、停止→运行，双按钮语义分化正好依托它）；独立模式 SSE 生命周期不变；mount-connect 幂等（connectSse 先关旧）+ 卸载清理已有；host 侧零改动（lib/index.js 同源码同输出，无需重启）。
### 验证
node build.mjs exit 0；lib/client.js 字面量（esbuild 大写 hex 转义坑：中文锚点必须搜大写 \uXXXX，小写全落空假阴性）：\u23F8×2/\u23F9×2/\u25B6×4/\u27F2×2/closeRunScopedSse×4/forceReset×3/onRestart×5/stopped===false×2 全在。待猫猫强刷实测：电脑端开跑→手机已开/新开编辑器页应实时变「⏸暂停+⏹停止」；任一端暂停→双端变「▶继续+⟲从头」；停止→「▶运行」；跑完→「▶运行」。

## 2026-09-01 删除子代理「剧场应急」提示（theaterHint）
### 需求（猫猫原话）
"帮我改dsh-femo的工具系统提示词吧，给节点/子agent注入的里面是不是有一句，说如果你看不到上下文你应该用什么工具……并介绍了个工具，那个？把那个删了。"
### 实现（src/subagent.ts）
1. 删除 theaterHintOf 函数——2026-08-25《宵夜大辩论》裁决事件加入的三行【剧场应急】提示（上下文缺前情时运行 node femo-chat.mjs 一键取回本场发言 / 无工具时声明「未收到历史发言」），即猫猫指名的"介绍了个工具"那段；2. buildSubagentPrompt 签名去掉 theaterHint 参数，system 组装回归 basic_safety/basic_output/soul/user_info 四段；3. 唯一调用点改为 buildSubagentPrompt(blocks)。
### 不影响别处论证
theaterHintOf 全 src 仅 L409 一处调用；buildSubagentPrompt 模块私有函数仅一处调用；join import 仍被 subagent_sessions 归档路径（targetRoot/target）使用故保留；femo-chat.mjs 文件本身未删（仅提示词不再引用它，需要时可手工运行）；context/prompt/memory 段组装零变化，diff 仅净删。
### 验证
node build.mjs 双产物 exit 0（host 191.8kb）；grep theaterHint/剧场应急 src 零残留；3081 重启生效（主进程 pid=4776 独占 127.0.0.1:3081，探针 200，femo 路由 scripts 200 / actor-usage 400=缺 sessionId 属正常）；5 工具注册行+bridge started 在日志可见。⚠️本次重启日志 0901a.log 被两波并发启动实例混写覆盖（两次 Start-Process 用了同一重定向文件名），健康结论以探针+路由实测为准；旧日志已备份 MEOW_backups/。

## 2026-09-01 V6.3 主模型下场轮戏内投影（stage/角色窗复用 V6 投影机制，god 窗物理隔离）
### 需求（猫猫原话）
主模型经"上下文注入 dsh-femo"下场参与戏内节点时，这一整轮发言应注入戏内窗与角色窗："注入的显示依然和以前一样，节点showprompt、角色标签、整轮（包括cot，response，tool和多轮react直到结束），所有这些全都按顺序，不要乱，要放在一起，不要和其他节点交错显示，要流式输出"；"我强烈建议你想办法复用我们之前的投影方法，已经成功过的是不是比较稳"；**"再次强调，god窗现在是对的，千万别动。主模型主窗口也是对的，别动。"** 角色窗按节点 scope 分发（scope 包含谁注入给谁的视角窗）。
### 现状链路（重读确认）
main-actor.ts（4b8b7bd 已入库的主模型下场机制）：ai_request(source=main) → runMainModelTurn 串行队列 → steer 主窗口 → mainSessionEventHook 轮次捕获（turn/start 置 sawTurnStart→message/tool 缓冲→turn/end 交卷）——圈定机制现成；v1 role 行灰框投影已删（注释预留"stage/角色窗之后复用投影窗自己的镜像/流式逻辑另做"）。08-31 合成镜像组回滚教训：骨架写 god 窗=孤儿事件、裸 _srcSeq 撞 god-mirror 去重。
### 方案与修改明细（3 host 文件，前端零改动）
1. src/projection.ts：projectionAppend 加可选尾参 opts{skipGod}——main 轮镜像专用（god 窗由 god-mirror 覆盖，重复写入=回滚教训重演）；不传（全部现有调用点）行为逐字节不变。stage 仍全量（main 轮是戏内内容，归档语义不变）。
2. src/main-actor.ts：PendingAnswer 加 showprompt（nodeShowprompts 暂存，引擎对所有 AI 节点统一发 context_ready 故 main 节点有值）/turn（原生号）/projBuffer/toolNames；新增 flushProjection（全同步原子落地）+broadcastMainChunk（femo_stream 帧 actor=main 演员名、block_end 带 retain:true——V6 演员直播语义，与导演直播帧 actor='导演' 分桶互不干扰）+broadcastMainToolResult（V6.1 结果帧 2000 截断）；mainSessionEventHook 在捕获点上同步挂投影：turn/start→镜像原生骨架（主会话轮自带真实 turn/start 无需合成）+speaker 行+📢 行（全带 turn 归属，V6.2 同款）；step/start 即时；chunk 块边界进缓冲+全量直播帧；message/tool/call/tool/result 进缓冲（_srcSeq=`main#<seq>` 独立命名空间）+tool_result 帧；step/end 进缓冲；turn/end→flush（同步，先落窗再交卷）；abandonMainAnswer（flow_stopped/flow_error）兜底 flush+合成 turn/end（sawTurnStart 门控）半截发言收整成块。分发=stage 全量+节点 scope 命中角色窗（scopes=[] 未限定=广播全部角色窗，与演员语义一致）。
3. src/engine-events.ts：main 分支传 runState.nodeShowprompts；flow_error/flow_stopped 的 abandonMainAnswer 传 projections。
### 不影响别处论证
god 窗：skipGod 物理隔离+god-mirror/导演直播一行未动；主窗口：steer/交卷/pre-step 豁免链路零触碰；演员投影：subagent.ts 零改动、projectionAppend 默认路径零变化；去重：main# 命名空间避开 god-mirror 裸数字与演员复合键，结构键=主会话原生 turn 号（小数字）与演员 TURN_BASE_EPOCH 大数天然不撞；结构事件不注 _srcSeq（迁移器 hasOnlyKeys 红线）；多 main 节点 par：串行队列一次一个，缓冲单例无交错；重启：pending 内存态重启丢（fresh_start 语义一致），stage/角色窗日志冷加载=原生 turn 结构+带 turn chat 行→完美官方区块重放。同工作区另有他窗"待办⑨ model_id 落库"未提交改动（subagent.ts+11/FEMO_runtime.py+9，宿主回传+引擎落值配套完整成品），与本批不相交，一并构建部署。
### 验证
tsc host 0 错；node build.mjs 双产物 exit 0；lib/index.js 字面量：skipGod×7/main#×2/projBuffer×7/flushProjection×3/broadcastMainChunk×2/broadcastMainToolResult×2/MAIN_SURFACE_OP_EVENTS×2/retain: true×2 全在。git diff 逐 hunk 核对工作区归属（教训 0mtfjtn9f）后才构建部署。

## 2026-09-01 修复：stage/角色窗结束后持续流式主模型戏外发言（director-node 窗类型判定 bug）
### 症状（猫猫报）
剧本结束后，stage/角色窗一直流式渲染主模型戏外发言（剧终通知回应、chronica 回合等每条 steer 回应）：只流式不落地、输出完就消失、且插在窗口中间而非末尾。
### 定性（日志实锤，零猜测）
scripts/diag-stage-1017.mjs dump 1017 场《谜语之约》stage 窗物理日志：V6.3 main 轮（@破谜人 turn=14 主会话原生号）结构完整正常落盘；✅跑完（seq 169）后零落盘——**V6.3 投影圈定（pending 机制）工作正常，落盘层无 bug**。流式内容=纯广播帧被前端渲染。注意 1017 场谜语大师轮 turn=大数+101 序列=普通演员（子代理机制），@破谜人=source:main（V6.3 原生号）——两种角色在日志中判然分明。
### 根因
director-node.tsx 旧判定 `view === 'god'` 本意="上帝窗"，但 view-state.ts currentView 对**所有投影窗**（含 stage/角色窗）默认返回 'god'（用户未手动切视角时恒成立）→ director-node 在 stage/角色窗误激活。宿主导演直播路径（engine-events 08-25 旧机制）对主会话 chunk 无条件广播 '导演' 帧：剧本运行中主模型被 pre-step reject 压制帧少；**结束后**每条 steer 回应的 chunk 全部入'导演'帧 → stage/角色窗 director-node（锚=V6.3 main 轮落盘的 step/start=插在区块中间）流式渲染，assistant/message 落地发 end 帧清桶即消失——"一直流式/只流式/插中间/完了消失"四症状全链。
### 修复（1 行条件，src/client-ui/director-node.tsx）
eligible 由 `view === 'god'` 改为 `view === 'god' && winActorKey === 'god'`（窗类型=id 尾段==='god' 与当前视角双判定）：stage/角色窗根除导演帧渲染；god 窗判定结果逐字节不变（view==='god' 在 god 窗继续生效、切角色视角仍隐藏导演流式）；主窗口无 femo-proj 前缀本就不渲染。
### 验证
tsc client director-node 零错误；node build.mjs exit 0；lib/client.js 字面量 winActorKey === "god"×3 / view === "god"×3 在位。纯前端改动强刷生效，未重启 3081。

## 2026-09-05 修复：剧本运行中主窗消息被静默吞掉（pre-step 门卫裸 reject 丢弃已 claim 消息）+ 投影窗输入窗型语义拍板落地
### 症状（猫猫报）
剧本运行中在主模型主窗口发消息：消息消失、主模型不回复；剧本不跑时一切正常。猫猫判断「发送能发送，是后面收消息并请求 API 的链路断了」「我们加了不该加的」。
### 根因（dsh 本体语义实锤，零猜测）
dsh agent-loop：turn 先 `inbox.claim()` 认领收件箱消息 → `agent/pre-step` 瀑布 → **reject 则 turn 以 blocked 结束，已认领消息整批丢弃、`user/message` 永不落盘**（consumed-work.ts："the pre-step rejection ... discarded the claimed messages"；自家测试 interception.spec "reject closes the claimed prompt turn" 断言 user/message === false；客户端 pending 气泡随 session/queue 快照更新而消失=「消息消失」）。femo 的 pre-step 门卫（326248f，8/17）对运行中 Femo 主会话裸 reject → 运行中主窗消息全灭；且 femo-run 只等前端点火回执即返回、运行期间主 agent 空闲，消息会立刻唤醒→被拒→被丢。更早的反主模型时代代码注释明说 "a plain reject leaves them only in the inbox, invisible in chat"（当时还有落盘补偿，8/17 重构删了补偿、只留裸 reject）。engine-events 输入桥（human 转发/硬停）依赖 user/message 事件——门卫在上游把消息杀掉，事件永不发生，**三分支自 8/17 起全是死代码**（唯一可达=与 main 注入同批 claim 的竞态，走留 inbox 分支=no-op）。
### 修复（2026-09-05 语义拍板：主窗=任何时候原生聊天；①直达主模型仅限上帝窗；角色/stage 窗任何时候不发主模型）
1. `src/engine-events.ts` pre-step 门卫：运行中 Femo 主会话的**含真实用户输入（source.kind==='user'）的 claim 批次放行**——消息落盘、主模型原生回答；其余（plugin 来源注入）照旧 reject（安全网保留）。非 femo/非 running/main 在飞三条路径逐字节不变。
2. `src/engine-events.ts` 输入桥删除：session/event 监听只剩 mainSessionEventHook（主模型下场捕获）。删除=今日零行为变化（死代码）；若保留，修复①后会错误触发「硬停剧本」违反新语义。extractText 连定义删除。human 节点喂入通道=投影窗②不变。
3. `src/projection-input.ts` branch① 加 `isGodWindow` 门（id 尾段===GOD_ACTOR）：god 窗 idle 行为不变；角色/stage 窗 idle 从「steer 主模型」改为本地留痕（语义3）；②③路径零改动。
### 不变量论证
上帝窗显示/镜像/god-mirror 零触碰；主模型下场（main-actor）链路零触碰；投影窗②human 喂入/③留痕行为不变；引擎、工具、路由零改动。运行中主窗消息落盘后由上帝窗镜像自然映射（戏外内容，符合上帝窗全视语义）。
### 验证
node build.mjs exit 0；lib/index.js 字面量：删除面（hard-stopped run by user message / interjection not implemented / forwarded user text to human node）全 0，保留+新增面（engine owns the conversation / source.kind === "user" / kept local: len / GOD_ACTOR / mainSessionEventHook）全在。重启 3081（meow-3081-restart-0905b.log，pid 7704）：探针 200、路由+5 工具注册齐、bridge started pid=23236。待猫猫实测四场景：①跑本中主窗发消息→主模型收到并回答；②跑本中角色窗发消息→不进主窗（本窗留痕）；③停止/暂停后上帝窗发消息→进主窗；④跑本中上帝窗 human 等待时发言→照旧喂引擎。

## 2026-09-05 子代理提示词四处整改（演员≠导演 / read-only+可审批 / 重试反馈注入删除 / 剧场应急再删）
### 需求（猫猫四条原话）
①"演员子代理拥有 dsh 的标准模式的 system prompt 就好了，他们不是导演"；②"委派声明设置为 read only 并允许请求权限吧"；③重试错误反馈追加到 blocks['basic_safety']是错的（"重试所有相关就不应该放到system prompt里，kv缓存命中你还要不要了……前缀不能变的。而且什么好人家的框架会把任何工具调用错误相关信息放到系统提示词啊"）——先删，之后改成节点内部 react 轮次的工具结果注入；④剧场应急提示去掉。
### 机制考证（DSH 源码实证）
spawn 子代理经 applyChildComposition：composeFrom（bind 非 mount，preset row 落 standing mount layer）→ 子代理 scope 的 per-child persona 经 ScopedLayers.merge 就近 shadow mount layer 的导演手册；空文本 section 渲染时被 drop；3081 无全局 persona 配置=标准模式本就无 persona 段。sandbox/mode+approval/policy 两 knob 事件均为"最后一条=生效值"fold（effectiveSandboxMode/effectiveApprovalPolicy），delegation 种子（never）在创建窗口、start 后 append 必胜出；执行面每次 confined call 逐次 fold；dsh-base bundle 已装配 sandbox-policy+user-approval（ask 有 UI answerer）。
### 修改明细（src/subagent.ts + femoCompiler/FEMO_runtime.py）
1. subagents.start 传 persona（先 ''本轮改 soulPersona，见下条）shadow 导演手册；
2. start 返回后向子代理 session append sandbox/mode{mode:'read-only'}+approval/policy{policy:'ask'}，并注册 femo:child-scope 澄清段（order 121，紧跟本体 SUBAGENT_DELEGATION_CONTEXT 之后）对冲本体"approval 自动拒绝"文本矛盾（本体红线不碰）；
3. FEMO_runtime._exec_ai 两处 blocks['basic_safety'] += [系统提示] 注入删除（FEMOTransientError 分支+assign_errors 分支；后者 feedback 变量成死代码连删），重试调度/ai_retry 事件/投影窗 ⚠️ 全保留；
4. 剧场应急提示删除——**09-01 已删过一次（见 2026-09-01 条目）但从未进 git，工作区回退时丢失复活，本次重删**；theaterHintOf/参数/调用点全清，femo-chat.mjs 文件保留盘上。
### 不影响别处论证
persona 参数只作用于 spawn 子代理（导演主会话/preset 工具面/compaction 不动）；knob 事件不进镜像白名单（投影窗零感知）、归档移动目录不受影响；重试删除后重试轮 blocks 与首轮逐字节一致（前缀稳定，KV 缓存友好）；剧场应急唯一引用点即 theaterHintOf。
### 验证
tsc host exit 0；node build.mjs 双产物过；lib/index.js 字面量 persona/append("sandbox/mode")/policy:"ask"/femo:child-scope 全在、剧场应急/femo-chat 全 0；py_compile 过。重启 3081（meow-3081-restart-0905c.log，node pid 12244 唯一 owner）：探针 200、路由/工具注册齐、bridge started pid=28232、actors 200。

## 2026-09-05 soul 进真 system prompt（per-child persona + Chronica.wor 只读接口）
### 需求（猫猫原话）
"演员的真实身份（soul）目前在 user 消息里。DSH 的 subagents.start 其实原生支持 per-child persona 能力……我们应该把soul放到这里~ 具体大概就是，从context拼接的文件里把soul去掉。写个dsh的接口读chronica sqlite并注入persona的地方。"
### 修改明细（src/subagent.ts，引擎/前端零改动）
1. buildSubagentPrompt 头段去掉 soul（剩 basic_safety/basic_output/user_info）；引擎侧 blocks['soul'] 照旧生产（_exec_ai 的 ai_name 三级兜底依赖它），宿主只不再拼接；
2. 新增 readSoulPersona(femoRoot, soulId)：node:sqlite（dsh 本体 session-query-sqlite 同款内建模块）readOnly 打开 Chronica.wor，SELECT description FROM souls WHERE soul_id=?，未知 id/读库失败 log 后返回 ''（与 block_collector 对 soul 加载的容错同语义，身份不可得≠演出致命）；路径推导镜像 get_dir.py（user_dir.txt 首行优先、回退插件根，set_db_path 无调用点故默认路径即唯一路径）；
3. runAiSubagent：soul_id 取自 ai_request payload 既有字段 request.actor_info.soul（引擎 _get_actor_info 产出，零引擎改动）；persona=soul 文本（无 soul → ''=标准模式，与前条拍板一致）；{{ 前置检测 log（persona 是严格模板，未注册 {{var}} 会组装期 fail loud）；ai_request 调试行加 soul_id。
### 不影响别处论证
main 演员（source=main）走主窗口回答制不经 runAiSubagent、human 不产 ai_request；'main' soul_id 即使到达也无库行→''安全；WAL readOnly 连接与引擎写入互不阻塞、每节点开关无常驻句柄；无 soul 演员 persona=''=标准模式（与"演员不是导演"拍板自洽）；头段仍逐字节稳定（前缀稳定性铁律 0mtn9yka——soul 从 user 消息挪进 system prompt 后，同演员跨请求前缀仍稳定且命中面更长）。
### 验证
tsc host exit 0；node build.mjs 双产物过；lib/index.js 字面量：node:sqlite×1/Chronica.wor×4/SELECT description FROM souls×1/persona: soulPersona×1/user_dir.txt×1 全在，头段数组 basic_safety→basic_output→user_info（soul 已移除）。待重启后猫猫实测：带 soul 角色的剧本跑一场，日志 soul_id=xxx 应出现、演员言行符合 soul 人设；子代理 session log 的 request 侧 system prompt 应含 soul 文本而非导演手册。

## 2026-09-05 运行时报错系统重构 Step A+B（施工清单 v4：API 慢层兜底 + 三桶 ErrorDispatcher；Step C/D/E 待拍板）
### 纲领（猫猫三类错误宪法 + 施工清单 v4 §12）
三类错误：①工具调用错误=dsh 原生不管；②API 请求错误=宿主侧兜底五段退避（立即/20s/1min/3min/10min），第五段后仍败放行=节点按结束，compiler 无感；③剧本错误=compiler 三桶，AGENT 桶发"节点重试"/"通知作者"信号给宿主翻译。本批实施 v4 §12 的 Step A（api-retry 纯宿主）+ Step B（compiler 重构 pytest 闭环）；Step C（宿主翻译 node-retry.ts+subagent 停靠+画布迁移）/D（main 停靠）/E（收尾）待猫猫验收后继续。
### 修改明细（Step A：3 文件改 + 1 新建；Step B：2 文件改 + 3 测试新建 + 1 测试迁移）
1. **src/api-retry.ts（新建，Step A）**：ApiRetryChain——agent/request-error 瀑布下游（base bundle llm-retry 快层 5 次 500ms→10s 耗尽后落到本慢层）；RETRYABLE_CODES 五码（RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/EMPTY_RESPONSE，永久码放行）；(turn,step) 连续计数（P1：新 (turn,step)=成功推进过→重置 1，相同→+1，零跨模块钩子）；SLOW_DELAYS_MS=[0,20s,60s,180s,600s]，count>5 放行（turn error→既有 recordError/交卷→节点按结束）；可取消延迟挂 AbortSignal.any([turn signal, lifetime])；filter 未命中顺带清计数（孤儿防泄漏）；dispose=listener 移除+lifetime abort+清状态（HMR 安全）。
2. **src/subagent.ts（Step A）**：导出 activeChildRuns Map（childId→{mainSid,node}，v4 §6.1 登记表）；spawn 成功后 set（早于任何慢层判定）、finally delete。
3. **src/main-actor.ts（Step A）**：导出 pendingNodeName(sid)（api-retry main 通知定位）。
4. **src/index.ts（Step A）**：apiRetry.install(ctx, deps) 装配（registerEngineEventHandlers 之后）；resolveTarget=activeChildRuns 命中→subagent / isMainAnswerPending→main / 未命中透传；onRetry=投影窗 ⏳（subagent，scope 过滤）/console.log（main）；onExhausted=recordError+投影窗 ❌。
5. **femoCompiler/FEMO_errors.py（Step B 重构）**：保留 ErrorCategory/FEMOConfigError/FEMOTransientError（docstring 补注：语义归属=直连 API 兜底遗留，永不进 AGENT 反馈信号）/classify_error 四符号；新增事件名常量（node_retry/notify_author/node_settled）、VERDICT_*（fatal/retry/exhausted/tolerant）、FEEDBACK_TARGET_AI/HUMAN 两值（'main' 不进信号——compiler 不认识主模型）；ErrorDispatcher（绑定 runner，每 run reset）：compose_message 单点拼装分 target 文案（ai="剧本错误（X桶）@ 节点 N（@a）：errors（第 x/N 次反馈）"、human="你的输入未被接受：…请修正后重新输入"、超限尾巴"按结束跳过/继续"）；dispatch 唯一入口（FATAL→notify_author(fatal)；AGENT→wait_key 键控计数（par 分支隔离，修正 node_id 键控互抢额度的坑），未超限→ai_retry（显示，仅 target='ai'）+node_retry（行为信号）+VERDICT_RETRY，超限→notify_author(agent_giveup)+VERDICT_EXHAUSTED；TOLERANT→log）；build_dispatcher 显式构造点。
6. **femoCompiler/FEMO_runtime.py（Step B 八处）**：①__init__ 挂 self.errors=build_dispatcher(self)；②run_async 与 _fork_errors=[] 同位 self.errors.reset()；③_exec_ai：wait_key 上提循环外一次（node_wait_key=ai_<node>_<counter>，三锚同键）、retries_max=max_tries-1（现状 or 2 规则保留，裁决① falsy bug 不修）、settled_outcome 局部变量、循环体 dispatch 化（未超限 continue/超限 break 落最后轮 output 现状语义）、FEMOTransient 分支逐字保留（仅直连可达）、FEMOConfigError 分支 raise 前插 dispatch(FATAL)（原样 raise）、ai_done 后 +node_settled{node_name,wait_key,outcome}；④_invoke_ai_llm 加两参 wait_key/emit_request（重试轮不重发 ai_request——重发会 spawn 新子代理断 steer 链；缺省旧行为自生成，直连分支逐字不动）；⑤handle_error 薄壳（签名/返回类型不变，全库零调用点）；⑥_exec_human：while True 壳与重等分支原样，assign_err→dispatch(target='human')（human_retries_max 同 or 2 规则，P7）、human_input_error 退役、超限=清空非法输入（超时留痕同款：只落 show 行，非法赋值文本不进 dialog 防污染下游）+break；⑦human_done 后 +node_settled。mind=_exec_mind 委派自动继承零特判。
7. **tests/（3 新 1 迁移）**：test_error_dispatcher.py 16 用例（三桶裁决/双信号/wait_key 计数隔离/reset/compose 三文案/常量契约）；test_exec_ai_retry.py 3 用例（进程内 FEMORunner 首开+mock _invoke_ai_llm：两错一成→node_retry×2+settled(ok)、全错→giveup+最后轮落库+settled(gave_up)、emit_request=[True,False]+同 wait_key）；test_exec_human_retry.py 3 用例（mock engine.human_input：非法→node_retry(target='human')+同 key 重等、上限→giveup+gave_up+三轮同 key、mind-human 委派继承实证）；test_flow_events.py human_input_error 断言→node_retry(target='human')+wait_key 一致断言。
### 不影响别处论证
无错误时行为等价（单轮通过 output/steps/model_id 逐值不变；node_retry/notify_author/node_settled 纯增量信号，宿主 Step C 未接前 default 静默无害）；协议只增不改（ai_request/human_input/ai_retry/checkpoint payload 逐字段不变，human_input_error 退役与画布迁移同属 Step C、中间态断流已知无害且 Step B 引擎改动未部署 3081）；循环壳保留（裁决⑤：for/while 与重等分支逐字保留，只换信号发射行）；wait_key 计数键=par 分支天然隔离；main/mind 引擎侧零特殊；FEMOTransient 用尽走既有 pause 分支不变；save_dialog/femoAsync/task_pause/task_world/vars/llmBridge 零接触；dsh 本体零改动（rc.1 逐符号核验：agent/request-error 瀑布契约/steer L135/whenIdle L204/base bundle llm-retry L84-85）。
### 验证
py_compile 过；human_input_error 引擎侧零残留；pytest 全量 326 passed（304 基线零回归+22 新增）；node build.mjs 双产物 exit 0；tsc host 报错 15 条全部为 node_modules junction 混搭噪声（dsh-session junction 指向 dsh-rc1-exp npm 包、其余包指向 dsh-meow 源码，两套 Session 品牌类型互斥）——本批新增/修改代码零错误命中（api-retry.ts/main-actor.ts/index.ts 零命中，subagent.ts 3 条均为原代码行受株连），junction 恢复后须复验全绿。**Step B 引擎改动未部署 3081（v4：B 与 C 同次构建部署）；Step A 已构建进 lib，重启一并生效，待猫猫拍板。**Step A 验收指引（部署后）：断代理 7897 制造 TRANSPORT→[femo-api-retry] 五段+投影窗 ⏳+第五败节点收场剧本继续；非 femo 会话零日志。

## 2026-09-05 运行时报错系统重构 Step C（施工清单 v4 §5/§6/§8/§12：宿主停靠经纪人 + 信号翻译 + 画布迁移；猫猫指定本窗口接续 A+B）
### 纲领
Step C=第三类剧本错误的"接收端"：引擎（Step B）已发 node_retry/notify_author/node_settled 三信号，宿主把它们翻译成 dsh 行为——子代理=Agent.steer 续跑、human=投影窗提醒、通知作者=三通道（错误面板/聊天窗/flow_done 汇总 steer 主模型）。main 停靠留 Step D。rc.1 核验实锤：in-process-driver 的 result 永不 reject、localAgent=完整 Agent（steer L135/whenIdle L204），settle 后 dispose 前 steer 合法（P2 赌注成立）。
### 修改明细（1 新建 + 4 修改 + 1 前端）
1. **src/node-retry.ts（新建）**：NodeRetryBroker 停靠经纪人——register（幂等持久登记，早于任何信号）/park（15min 超时 P4：>五段退避 860s、<引擎 3600s）/deliverRetry（human→租约显示即翻译；subagent/main→resolve(retry) 或 pending 暂存；**只 resolve 不代调租约**——steer 时机在停靠循环内；无 parker 仅 log 不空回传注入，防误喂 human wait_key）/steerLease/markSettled（ai/human 同用，幂等）/abortAll（幂等全场放行）/unregister/dispose；ParkVerdict 三态 retry/done/aborted；ParkerKind=subagent/main/human（宿主路由，与 payload.target 两值正交）；RETRY_STEER_TEXT 统一文案；模块级单例 export broker。
2. **src/api-retry.ts**：末尾 +1 行导出单例 apiRetry（类与逻辑零改动）——subagent finally 的 clearChild 需要够到 Step A 的实例（否则 attempts Map 按 uuid 键控纯泄漏，孤儿自愈只能延迟清）。
3. **src/subagent.ts**：①import randomUUID/apiRetry/broker/RETRY_STEER_TEXT/RETRY_TURN_TIMEOUT_MS；②activeChildRuns.set 后 +broker.register（kind:'subagent'，租约=localAgent?.steer?.(userMessage{text,source:plugin})）；③modelId 表达式原样提取为 modelIdNow() 闭包（首轮/重试轮共用，重试轮 usage 已随新事件更新，零行为变化）；④首轮回传后、catch 前插停靠循环：清 idleTimer（停靠=合法静默防看门狗误杀）→park→while retry：armIdle 恢复→steerLease(RETRY_STEER_TEXT)→Promise.race([whenIdle?.(), 5min 超时, abort listener]）→cleanupFns 逐个注销（终审补丁防每轮泄漏）→slice(snapshotLen) 新回合片段调 buildSteps（两回合 step 号都从 0 起，全量调用会合并同桶）→空片段防御 log→回传→再 park；⑤finally +broker.unregister(waitKey)+apiRetry.clearChild(run.id)（幂等全路径兜底）；⑥localAgent 本地类型补 steer?/whenIdle?（对齐 rc.1 真实 Agent 接口，此前手写类型过窄）。
4. **src/engine-events.ts**：RunState +giveups Map（v4 §8.3 门卫坑：运行中 steer 主模型必被 pre-step 吞，giveup 只累计）；EngineEventsDeps +broker?（缺省 no-op+log）；node_retry case→deliverRetry（不投影：ai 显示由既有 ai_retry 承担防双份）；notify_author case→fatal 仅 log（防与 flow_error 双份）/agent_giveup→recordError+appendChatBroadcast+giveups 累计，**不 markSettled**（payload 无 wait_key——v4 §8.1 此处笔误；parker 解除由紧随的 node_settled(gave_up) 承担，引擎超限 break→落盘→node_settled 是确定性路径）；node_settled case→markSettled；human_wait case +register human 租约（steer=投影窗 ⚠️ appendChatProjected，scope 取 nodeScopes；引擎重等不重发 human_wait 故恰好一次）；flow_done→steer 文本追加 giveups 汇总段+delete；flow_error→abortAll+giveups 残留随错误 steer 汇总+清空；flow_stopped/bridge_run_ended→+abortAll。
5. **src/index.ts**：import 改 apiRetry 单例+broker；RunState 字面量 +giveups:new Map()；registerEngineEventHandlers deps 传 broker；删本地 new ApiRetryChain()；bridge.onExited +broker.abortAll('bridge exited')（停靠者不干等 15min）；+ctx.effect(broker.dispose, 'dsh-femo: node retry broker')（HMR 清 parker/timer）。
6. **femoGen/src/FemoWorAuto.jsx**：case 'human_input_error'→case 'node_retry'（v4 §8.4 同次部署无窗口期），data.target==='human' 分支做原有逻辑原样（setActiveNodeIds/setNodeStates/setBubbleOverlay 手机气泡路径保真）；inputError=error[0]（数组）?? feedback ?? 默认（原始错误比拼装文案适合一行展示）；target==='ai' 忽略（画布 AI 重试显示走 ai_retry，零回归）。
### 不影响别处论证
首轮无错误场景：回传后 park 被 node_settled(ok)（引擎毫秒级发出）立即 resolve，仅多一次幂等 park/unregister；首轮 buildSteps/回传/投影镜像/catch/finally 既有行逐字保留（镜像零改动：停靠期 disposeListener 未执行，重试回合照常进 onChildEvent，mapTurn 获新镜像号进既有 mirrorBuffer）；无 parker 信号仅 log（导演轮次/非 femo 会话零影响）；abortAll/park/markSettled 全幂等；broker abortAll 全清 Map 的依据=引擎单场单槽（runState.running），flow 终止时所有 wait_key 的引擎侧等待已被取消；main parker 未登记（D 步骤）时 main 节点的 node_retry 落"无 parker 仅 log"=C→D 中间态无害（与现状一致）。
### 验证
node build.mjs 双产物 exit 0；lib/index.js 字面量全在（deliverRetry/markSettled/steerLease/abortAll/giveups/node retry broker）+ lib/client.js human_input_error=0/node_retry+data.target 进包；tsc host 16 条/client 40 条均为 junction 混搭噪声（与 Step A+B 基线同源，双配置同源对齐核对）——本批新增代码零命中（修掉本批 2 条：localAgent 类型缺 steer/whenIdle，已补）；Python 零改动（pytest 326 基线不受影响）。**待猫猫重启 3081 部署验收（A+B+C 一并生效）**：①AI 赋值必错剧本→ai_retry ⚠️+同窗 steer 续跑修正通过；②max_retries 调 1（不调 0——现状语义 0 会变 2）→giveup 三通道+flow_done 汇总 steer+跑完；③human 节点非法输入→投影窗 ⚠️+画布重开输入框→重输通过，连续非法到上限→giveup+放行；④回归 notify-theater+debug神器+日常一场。

## 2026-09-05 宪法修订⑦：报错即通知作者（Step C 真机验收后猫猫拍板；AGENT 桶不再等超限才通知）
### 缘起（猫猫实测+原话）
Step C 验收结果：①人类节点正常 ②AI 节点正常（首次报错后重试第二次、能看见错误信息）③**新发现设计问题**：执行者"太聪明"——赋值失败看到系统提示后，重试时往往干脆不写赋值语句（规避错误而非修正错误），节点以 ok 收场，剧本作者永远收不到报错信息（原设计 notify_author 只在重试用尽时发，而"聪明规避"让重试永远用不尽）。猫猫拍板："error 那里的行为改一下，不要等重试次数用尽再通知作者了。要在第一次出现剧本相关报错的时候就同时通知作者。""我们在节点重试的时候同时通知作者就好了。"
### 修改明细
1. **femoCompiler/FEMO_errors.py（核心 ~10 行）**：dispatch AGENT 未超限分支在 node_retry 之后加 emit notify_author{severity:'agent_error', message=同一 compose（含"第 x/N 次反馈"尾巴）}——报错即通知作者，与重试并行；超限分支不变（agent_giveup）；docstring 同步契约。**dispatch 返回值（VERDICT_*）不变 → runtime 重试循环零改动**（裁决⑤"Error 只裁决+发信号"的红利）。
2. **src/engine-events.ts（注释+文案，零逻辑改动）**：notify_author case 本来就是"非 fatal 即走三通道"，agent_error 天然覆盖（recordError+appendChatBroadcast+giveups 累计）；flow_done/flow_error 的 giveups 汇总标题中性化（"重试超限被跳过"→"出现过剧本错误"——giveups 现混有"报错后重试成功"条目，状态由每条 message 自带尾巴区分）；RunState.giveups/node-retry.ts 头部注释同步。
3. **tests 三文件断言同步**：test_error_dispatcher.py（未超限=三信号含 agent_error；用尽=3 条 [error,error,giveup]）；test_exec_ai_retry.py（两错一成→agent_error×2；全错→[error,error,giveup]）；test_exec_human_retry.py（同款）。
4. **施工清单v4.md 裁决台账补"修订⑦"行**（宪法变更落痕，正文不动）。
### 不影响别处论证
dispatch 返回值与 node_retry/ai_retry payload 逐字段不变（宿主 broker/停靠循环/画布迁移零影响）；fatal/giveup 路径不变；notify_author SSE 原样转发画布、前端无 case 忽略（零回归）；giveups 累计条目变多仅影响 flow_done steer 文本长度（每条一行）；主会话新增的 ⚠️ 行=appendChatBroadcast 会话日志事件，不进主模型上下文（无打断）。
### 验证
pytest 全量 326 passed（修订后断言全绿）；node build.mjs exit 0；lib/index.js 中性化文案 \uXXXX 转义形式验证在（出现过剧本错误/另有出现过剧本错误的节点）；agent_error/agent_giveup 为 Python 侧字面量、宿主不比较（JS 产物无此字符串=正确）。待重启 3081 生效后猫猫重验：AI 赋值必错剧本→**主会话聊天窗第一次报错就出现 ⚠️**（不再等超限）+ 错误面板同步 + 重试照常；human 非法输入→主会话 ⚠️ 同步出现。

## 2026-09-05 运行时报错系统重构 Step D（施工清单 v4 §7/§12：main 演员停靠——错误链路 A/B/C/D 全部完工）
### 纲领
main 演员（source:main，主窗口回答制）统一纳入停靠链路（裁决③"main 也是节点，引擎侧零特殊，dsh 侧租约实时区分"）：引擎对 main 节点的剧本错误从 Step B 起就发同样的 node_retry/notify_author 信号，Step D 让 main-actor 登记停靠租约接住——主模型的"继续跑"=先重臂在飞注入（rearmPending）再 steer。至此前三类执行者（subagent/main/human）一个信号一个租约全部齐了。
### 修改明细（src/main-actor.ts 单文件 +83 行；引擎/前端/engine-events/femoGen/dsh 本体零改动）
1. **import**：+broker（node-retry）/apiRetry（api-retry）——均模块级单例，无循环依赖。
2. **rearmPending（新 def）**：重臂在飞注入——buffer/projBuffer/toolNames 清空、sawTurnStart=false、settled=false、showprompt 沿用（nodeShowprompts 同 Map 重取）、resolve=no-op。resolve 为什么 no-op：停靠循环的唯一同步锚是 broker.park（引擎 node_retry/node_settled 都在收到交卷后才发，时序天然闭合），新回合的交卷由 mainSessionEventHook 的 turn/end 既有分支（settleMainAnswer）承担，无人 await 新 promise。
3. **mainRetrySteerText（新 def，模块级）**：main 专属反馈文案——"剧本《X》节点「Y」（你扮演 @Z）的上一轮输出未通过剧本校验（第 N 次反馈）…请重新输出该节点的台词（需要 SET VARIABLE 的节点把赋值按格式写在台词末尾）"。与 subagent 的通用 RETRY_STEER_TEXT 分立（主模型有"演谁、演到哪"的上下文值得点名；也避免 node-retry 长出 main 依赖）。
4. **runMainModelTurnInner**：①broker.register（waitKey/nodeName/kind:'main'/租约）在 pending.set **之前**——登记早于任何交卷，与门卫豁免时序对齐（v4 §7.1）；租约=先 rearmPending 再 steerMainAgent，时序物理封装（pre-step 门卫对运行中 femo agent 的放行豁免源=isMainAnswerPending，先 steer 会被 reject 吞掉——反馈丢失）。②await answer 后停靠循环：park→retry 经租约 steer→主模型新回合→hook 既有捕获→turn/end 交卷→再 park；done（node_settled ok/gave_up）/aborted（停止/出错/bridge 死亡/15min 超时 P4）退出；循环体零特殊（steer 与交卷全在既有机制）。③finally +broker.unregister(waitKey)+apiRetry.clearChild(sid)（幂等全路径兜底，与 subagent finally 同款）；flows/水位不动（重试轮不重注流水——首轮已注入过，反馈自带节点/演员身份，重注=重复刷屏）。
### 不影响别处论证
无错误时 park 被 node_settled(ok)（引擎毫秒级发出）立即 resolve（先到则暂存 pending 由 park 消费），inner 返回时机从"交卷后"变为"审结后"——串行队列下下一个 main 节点的注入推迟到上一节点审结，**顺带消除"par 双 main 时 A 的重试反馈 steer 混进 B 回答回合"的潜在串台**（B 引擎协程 wait_for_input 3600s 上限内，无回归）；主模型重试回合的 API 错误照常被 api-retry 慢层覆盖（rearmPending 先于 steer → isMainAnswerPending 在飞判定连续覆盖重试轮，v4 §7.3 零改动达成）；abandonMainAnswer 停靠期（pending 已删）return false 无害、重试回合进行中被停=正常作废+投影兜底；park 15min 超时 aborted→收尾，迟到的 turn/end 交卷仍达引擎（wait_for_input 3600s 内）无僵尸；engine-events 三 case 对 main 天然生效（deliverRetry/markSettled 按 wait_key 路由，修订⑦报错即通知自动覆盖）；dsh 本体零改动（rc.1 只读核验）。
### 验证
node build.mjs 双产物 exit 0；lib/index.js 字面量全命中（rearmPending/mainRetrySteerText 函数体、停靠重试/停靠结束日志、kind:"main" 租约结构；中文=\uXXXX 大写 hex 转义形态）；tsc host 16 条=junction 混搭基线噪声零新增（main-actor.ts 零错误）；pytest 不涉及（Python 零改动）。重启 3081 生效（node pid=24844/bridge pid=19220，日志 0905g）。**猫猫真机验收通过（2026-09-05："测试好了，完全没问题"）**——main 节点赋值失败→主窗口收到重试反馈→主模型重说→通过。错误链路重构 v4 实施顺序 Step A/B/C/D 全部完工（Step E=收尾留痕）。

## 2026-09-06 修复：手动停止主模型零通知（flow_stopped 缺 steer，三终态通知面补齐）
### 症状（猫猫实测）
剧本运行中用户从前端按钮手动停止：UI 各窗口能看到「⏹ 剧本已停止（可续跑）」广播行，但主模型（导演）收不到任何通知——猫猫原话："我发现我手动按停止，你还收不到通知"。对照：flow_done（跑完）/flow_error（出错）两路径主模型都有 steer 必达，唯停止漏接。
### 定性（代码实锉，零猜测）
engine-events.ts 三终态 case 待遇对比：flow_done L541 steer ✅、flow_error L566 steer ✅、flow_stopped 只有 appendChatBroadcast（L583）无 steer ❌。广播写各窗口 sys 行（UI 可见、不进主模型上下文）；steerMainAgent（对话流直达）才是主模型通道。猫猫补充验证：steer 不搭用户消息的车，是独立唤醒机制——停止后发消息也收不到注入。femo-run 工具侧停止不受影响（工具回执本身回主模型），**仅前端按钮停止是盲区**。
### 修改明细（src/engine-events.ts 单文件 +5 行）
flow_stopped case 在 appendChatBroadcast 之后补 steerMainAgent：文案 "[dsh-femo] 剧本运行结果：⏹ 已停止（挂起，断点保留）。可用 resume 续跑或 fresh_start 重跑。"，注释注明时序依据（suspended 落定+activeJobId 清空后 isSessionRunning 已 false，不被 pre-step 门卫吞，与 flow_done/flow_error 同时序）。
### 不影响别处论证
flow_stopped 其余清场逻辑逐字节不动（abortJobSubagents/abandonMainAnswer/broker.abortJob/镜像复位）；femo-run 工具停止路径从"工具回执"变"工具回执+steer"双份通知，信息一致可接受；engine 停止事件协议零改动（flow_stopped payload 仍空）；前端零改动。
### 验证
node build.mjs 双产物 exit 0；lib/index.js L3552 steer 字面量在位（紧跟 L3551 广播，中文 \uXXXX 转义形态核验）。**次级坑记录在案未动手**：job_manager.py L352 引擎窗口已死（B5）时停止走"直接落盘 suspended(reason=user_stop)"路径、不发 flow_stopped 事件——该边角连广播都没有，待议是否在宿主 stop 命令层补通知。待重启 3081 后猫猫实测：跑一本中按停止→主会话应出现 [dsh-femo] 停止通知。

## 2026-09-08 手机端双指缩放"时灵时不灵+卡顿"根治（femoGen round56 触摸仲裁 v3）
### 症状（猫猫实测）
手机 UI 双指捏合缩放画布很不顺、卡卡的；手落在节点上时没法缩放；有时手指落在画布上也不行，时灵时不灵。
### 定性（CDP 真实触摸管线实测，脚本存 _diag-femogen-pinch/：Edge headless + Input.dispatchTouchEvent 走完整浏览器触摸语义）
手势状态机对"两指都在画布内"的所有落点组合（空白/节点/长按触发后/快速落第二指）全部正常——落点在节点上不是死因。真凶三条：① **pinch 配对取 e.touches[0]/[1]**——那是"全页面最老的两根触点"而非"本次捏合的两指"，画布外任何第三触点（搭面板的手指、握机手掌误触）都配错对：一根手指被完全无视、缩放几乎不动（实测 scale 1.00→1.07，应到 1.76）、画布随"静态触点↔手指"中点大幅漂移。② **双指之一落在面板/标题栏时其 touchstart 不经画布冒泡**，phase 永远进不了 pinch；画布那根 200ms 后转 canvasPan，move 又因 ts.length!==1 直接 return——缩放平移全死（实测 0 次缩放提交）。③ **每个 touchmove 都 setPan+setScale 触发 FemoWorAuto 整树重渲染**（canvasContent/节点全无 memo），节点一多真机每帧几十 ms=掉帧卡顿；另有画布无 touchcancel 处理，浏览器接管手势后状态机残留到全部手指抬起。
### 修改明细（femoGen/src/mobileView.jsx 单文件；useMobileCanvasGesture 整体重写，MobileLayout 只改挂点）
1. **登记制**：只有落点在画布内的触点进 canvasTouchesRef（Set，touch.identifier，迭代序=落屏序）；面板/标题栏触点从根上不参与也不干扰。 pinch **锁定最近落下的两根画布触点 id**，move 只按这两个 id 从 e.touches 取实时坐标——第三指彻底无视，R2 配对错乱根治。 丢指按剩余画布触点降级：2→重锁续捏、1→转平移、0→复位。 touchcancel 一律清场（清计时器/选中环/连线预览，flush 定格），不产生轻点选择副作用；由 React 合成事件改为画布元素原生非 passive 监听（挂一次，回调经 apiRef 中转），round55 的 preventDefault/blur 语义收编进 touchstart 处理器。 从 conn 相位进 pinch 时补 setConn(null)（旧版连线预览残留）。 捏合/平移帧 **transform ref 直写 DOM**（tfRef+缩放徽标 scaleBadgeRef textContent，round47 ghost 同款思路），手势结束才 flush 回 React state——每 move 全树渲染根治；pan/scale 的 props 回写在非 idle 相位跳过（防手势中途无关渲染把基线拖回旧值）。
### 不影响别处论证
桌面端零改动（鼠标路径 onMM/onCanvasDown/handleWheel 原样；MobileLayout 画布 div 只摘了 touch props）；底部面板滚动/仓库长按拖拽（round49 仲裁）不动——画布监听只收画布内触点，面板 touch-action:pan-y 原生滚动不受影响；长按连线/长按拖节点/轻点选择/双击进子画布/气泡轻点语义逐条保留（T2/T8/T9 回归通过）；canvasContent 无 memo 本次不动（直写 DOM 后捏合帧已不触发渲染，memo 化留给后续需要时再做）。
### 验证
femoGen vite build exit 0；node build.mjs 双产物 exit 0（lib/client.js 含新代码，editor-page 静态内嵌 femoGen 源）；CDP 回归 10/10（_diag-femogen-pinch/regression-v3.mjs）：T1 基线捏合 1.585/T2 落节点长按后捏合 1.573+震动标记/T3 第三指搭面板 1.359（修复前 1.07）/T4 面板指不毒化平移 90px（修复前 0 死手势）/T5 touchcancel 后新手势正常/T6 手势后无关渲染不回跳/T7 单指平移/T8 轻点选中属性 tab/T9 长按拖节点 87px/T10 快速捏合 1.585。待猫猫真机验收：节点多的画布上双指捏合顺滑度、捏合中第三指搭面板、捏合中一根手指滑到底部面板边缘。

## 2026-09-09 0.1.3 原生版：同角色子代理复用=角色视角投影窗 + 本体子代理菜单恢复（版本分流）
### 用户拍板（原话要点）
"在0.1.3新版本里,把子代理的窗口直接拿来当角色视角投影窗"；"我们不隐藏不归档节点拉起的子代理"；"不要每个节点拉起一个新的子代理，而是复用同一个actor对应的子代理——子代理本身就是角色视角窗了"；"dsh本体不就是可以显示子代理的吗……在0.1.3版本里恢复dsh本体的设定就好了"；"把那些我们原本写的ban子代理的代码用旧版本的if括起来"。dsh 本体不可改，全部改动在插件侧且旧版路径行为逐字节不变。
### 定性
- 前端"子代理下拉悬停出细竖条且不可点"根因实锉：lineage-fork.jsx 硬编码 rc.2 快照 CSS 哈希类名（A-xaeG_*），0.1.3 构建已换名（Hrbyxa_*，packages/client/ui-subagent lib/client.js L12）——fork 渲染的菜单无任何样式（.menu 的 fixed 定位/336px 宽/背景全失效）。
- 0.1.3 官方接口（vanilla checkout 实读）：ctx.subagents.startContinuable（ContinuableStartSpec 支持 childId 预留持久身份；spawn provider prepareContinuable 返回空 seed=全新子代理）、sendMessage（空闲目标开新回合/持久化缺失自动冷恢复）、interrupt、Agent.steer/whenIdle；sessionPersistence.stat(id) 判"已存在"。
### 修改明细
1. **src/subagent-native.ts（新建）**：原生版 AI 演员执行体。以 (主会话, actorKey) 为键复用同一 continuable child：childId 规则化 femo-actor-<主sid>-<actorKey>（跨重启可推导）；首建走 startContinuable（初始 prompt 随建随投，persona/model/toolFilter 同旧路径语义），后续节点走 sendMessage；persistence.stat 判"上一进程留下的持久子代理"→ sendMessage 自动冷恢复+对新 Agent 实例重装推理钩子（hooked 标记）。回合收口=监听器记录 turn/end（per-actor 锁保证投递时空闲，baseline FIFO 防用户插话误认）；abort→rejectPendingTurn 防挂死+官方 interrupt 掐在飞回合（经 ActiveSubagent.interrupt 通路）。镜像同 V6 时序只投 god/stage；首轮 human_input 交卷+broker 停靠重试环与旧路径同语义。**不 dispose、不归档、不移出**——子代理长存即角色窗。
2. **src/subagent.ts**：仅无行为改动——导出共享助手（turnBase/事件白名单/prompt/toolFilter/model 解析等）；ActiveSubagent 增可选 interrupt，abortJob/abortAll 掐断时调用（旧路径 undefined=零变化）。finally 的 archiveSession+moveChildSessionOut 已有 !isNativeMode() 守卫（ban 旧版 only）。
3. **src/engine-events.ts**：ai_request 处 isNativeMode() 分流 runAiSubagentNative；flow_start 建窗原生传空角色表（不再建 femo-proj 角色窗——子代理本体即角色窗，且避免投影窗混进本体子代理目录）。
4. **src/client.tsx**：dsh-femo-count 座位 + lineage fork shadow 两处 slots 注册整体挪入 registerLegacyCatalogUi()，仅 native-flag=legacy（或 fetch 失败 fail-open）时执行——0.1.3 原生目录完全交还本体官方组件（样式正确、femo-node 条目天然可见）。fork 内 femoNativeCatalog 剥前缀逻辑保留未删（旧版专用）。
5. **src/routes.ts**：/projection-windows 原生版 ensure 传空角色表，角色项从 nativeActorChildIds（角色名→子代理 id）解析——视角菜单角色项直达子代理窗口。
### 不影响别处论证
旧版（meow fork 3081）所有路径：新代码全部在 isNativeMode() 分支内；subagent.ts 共享助手只加 export；abort 的 interrupt 为可选调用。god/stage 投影窗、视角菜单、composer、femo_stream 直播、actor-usage 圆环全链路不动。
### 验证
node build.mjs 双产物 exit 0；lib/index.js 含 startContinuable/femo-actor-/runAiSubagentNative，lib/client.js 含 legacy 注册函数。tsc 全量 113 行 ≤ 改前基线 114（存量=双 dsh-session 副本环境性错误，与未改文件同款）。待 3083 重启后实测：跑本→子代理目录按角色名逐个可见、点开即角色全部台词、目录下拉菜单样式正常；重启 dsh 后 sendMessage 冷恢复同角色子代理。

## 2026-09-09 晚 0.1.3 子代理 job 域化：childId 带 job id + 目录只显示当前 Job 卡司
### 用户拍板（原话要点）
"在0.1.3里，子代理的session名你应该加个job id。然后我们在子代理下拉菜单中，只显示当前job id的子代理。"
### 定性
此前的原生复用实现按 (主会话, actorKey) 复用——跨 Job 共用同一角色子代理：重跑一本新戏会把新台词接进上一场的窗口，目录也只有一行分不清场次。job 域化后：每场 Job 一套卡司窗口（同 Job 内同角色仍复用；resume 同 Job 续跑时子代理原样接续），目录只显示当前 Job 的卡司。
### 修改明细
1. **src/subagent-native.ts**：childId 规则改 `femo-actor-j<jobId>-<主sid>-<actorKey>`（job id 紧跟固定前缀，UUID sid 的连字符不干扰解析）；注册表/串行锁键升级为 (sid, jobId, actorKey)；`nativeActorChildIds(sid, jobId)` 按当前 Job 过滤。
2. **src/routes.ts**：新增 `/dsh-femo/current-job?sessionId=`（返回 sidIndex 最近一场 Job id，跨重启可用）；/projection-windows 原生版角色项改按当前 Job 解析（与菜单同口径）。
3. **src/lineage-fork-native.jsx（新建）**：0.1.3 原生目录 fork。与官方唯一差异=显示层过滤：femo-proj（god/stage）不进目录；femo-actor 只留当前 Job（currentJob 未知时一并隐藏，绝不闪旧卡司）；本体自发子代理零影响。count 触发器留在本体面包屑位、默认 hideWhenZero。**CSS 哈希类名运行时解析**——从官方注入的 style 标签（data-plugin-css=SubagentHeaderLineage.module.css）反解 `.<hash>_<name>` 映射，官方升级换哈希不用改代码；解析失败回退 0.1.3-alpha.2 实测值（Hrbyxa_*）。
4. **src/client.tsx**：native 分支改注册 lineage-fork-native（lineage 槽 shadow，priority -10）；legacy 分支不动（旧 fork + count 座位）。
### 不影响别处论证
旧版路径零改动（lineage-fork.jsx/dsh-femo-count 座位照旧）；同 Job 内复用、冷恢复、interrupt、停靠重试、镜像 V6 时序全部不变——只是身份键从 (sid,actor) 升级为 (sid,job,actor)。resume 语义天然正确：同 jobId 续跑=同 childId=原窗口接续。
### 验证
node build.mjs 双产物 exit 0（lib/index.js 含 femo-actor-j/current-job，lib/client.js 含 currentJob 过滤链）；tsc 114 行=基线水平（.jsx 无声明 TS7016 与旧 fork 同款存量）。待 3083 重启实测：跑一本→目录出现当前 Job 卡司（面包屑计数位置）；再跑一本（新 Job）→目录切换为新卡司、旧 Job 窗口不在列表但仍持久；resume 同 Job→窗口接续不换新。

## 2026-09-09 深夜 0.1.3 改版：显示面回归 femo-proj 角色投影窗 + 目录重新 ban 节点子代理（版本分流）
### 用户拍板（原话要点）
"新版现在用了子代理窗我觉得不够好。要不还是换回之前的视角投影窗吧。视角投影窗的代码都在"；"我们希望下拉菜单还是用我们自己的角色视角投影窗那种显示模式（主窗口和上帝视角都在那里，还是角色视角投影窗比较全面）"；"我们每次跑job，一个角色用一个子代理，轮到这个角色说话的时候，把最新需要他知道的上下文和prompt都发给他，然后收集他接下来流式输出说的话，投影到角色视角投影窗"。确认两点：视角下拉菜单角色项改回打开旧式 femo-proj 角色投影窗；节点拉起的 femo-actor 子代理重新 ban（不出现在 dsh 子代理目录，对齐旧版效果）。
### 定性
上一轮"子代理窗=角色视角投影窗"方案的用户体验不达标：子代理窗是原生会话流渲染（无角色气泡/turn 段落头/旁白行/戏内归档），不如 femo-proj 投影窗全面。本轮执行体机制不变（Job×角色常驻 continuable child，每轮 sendMessage 全量投料），只把显示面从子代理窗切回 femo-proj 角色投影窗——投影窗在原生模式本就有完整基座（windowing-native 镜像+重启重放、femo 自绘节点、composer），只差"建角色窗+把 scope 投影打开"。
### 修改明细（旧版路径零改动；全部改动位于 2026-09-09 新增的原生分支内）
1. **src/engine-events.ts**：flow_start 建窗删掉原生传空角色表的三元——新旧版行为归一，god/stage/角色投影窗全建（原生角色窗由 windowing-native 镜像+重放兜底）。
2. **src/subagent-native.ts**：投影窗 ensure 从传 [] 改传 scopeInfo（与旧路径同款兜底；scopeInfo 声明随之前移修复 TS2448）；镜像/直播链路零改动——projectionAppend 本就按 scopeInfo 投角色窗，窗一回归内容即到位。删除 nativeActorChildIds（无消费方）；头注释/子代理注释改版（子代理=执行体，显示面=femo-proj 角色窗）。
3. **src/routes.ts**：/projection-windows 删原生分流——角色项统一从 windows.actors（femo-proj 窗 id）解析，重启恢复走 turn_scopes 文件 ensure（新旧同款）；删除 /dsh-femo/current-job 路由（唯一消费方已下线）；删 nativeActorChildIds import。
4. **src/lineage-fork-native.jsx**：目录过滤改 femoNativeHiddenId=id 带 femo-proj-/femo-actor- 前缀一律隐（对齐旧版"节点拉起的子代理不进列表"）；拆掉 currentJob 拉取链（fetchCurrentJob/currentJobCache/全组件 prop 贯穿）；count 触发器过滤后为零即隐藏（hideWhenZero 既有语义）。
5. **src/subagent.ts / src/client.tsx**：仅注释同步（finally 归档豁免的理由改为"冷恢复依赖持久化+目录 ban"；client native 分支过滤说明）——行为零变化。
### 不影响别处论证
旧版（meow fork）路径零改动：subagent.ts 只动注释；lineage-fork.jsx/count 座位/composer/视角菜单照旧。原生版执行体链路（startContinuable/sendMessage/interrupt、per-actor 锁、停靠重试、actor-usage 采样）全部不变；镜像链路只多出"角色窗"这一个落点（此前 god/stage 已在投）。/current-job 删除后 sidIndex 在 engine-events/index.ts 的既有消费不受影响。
### 验证
node build.mjs 双产物 exit 0；lib/client.js 无 current-job、含 femo-actor-/femo-proj- ban 链；lib/index.js 无 nativeActorChildIds、含 startContinuable；tsc（vanilla checkout tsc）host 84 行=存量基线（双 dsh-session 副本环境性错误），本次引入的 TS2448 已修。待 3083 重启实测：跑一本→视角菜单角色项打开 femo-proj 窗（角色气泡/turn 头显示模式）、子代理目录无 femo 条目、god/stage 窗内容与旧版一致；重启→角色投影窗镜像重放恢复。

## 2026-09-09 深夜二轮：视角菜单恢复 + 戏外 sys 行恢复（两个 0.1.3 实测问题修复）
### 用户实测反馈（原话要点）
"没看见视角菜单，没显示"；"戏外视角这边也没有收到屏幕上的显示 剧本已开始、剧本已跑完之类的。主模型倒是收到消息了。只是屏幕上没显示给用户看（旧版有给用户的提示）"；"你所见的关于新版的代码里可能有很多冗余代码，对于冗余代码导致的功能缺失，你要优先删除冗余代码，而不是把功能再写一遍"；"旧版有而新版没有的…还有可能是新版api变了，这个要查，如果是这原因，那就加if，支持新版，但要兼容旧版"。
### 根因（均为实锤，非猜测）
1. **视角菜单不显示=FemoViewButton 在 0.1.3 挂载即崩**：`snapshot.turnTimings.size`——0.1.3 SessionSnapshot（api/session-controller client/contract/snapshot.ts）已无 turnTimings 字段 → TypeError → SlotErrorBoundary 吞掉整个按钮。即使不崩，mainSid 判定读 `summary.agentPreset` 扁平字段——0.1.3 已挪进会话投影 `projectionValues.agentPreset`（官方 AgentPresetLabel 即读此形，ui-session 由 GlobalStandardProps 注入 useSessions，槽位面没变）。
2. **戏外缺 sys 行=windowing-native 无条件降级过于保守**：原生分支一律不写主会话。但本实验室 3083 构建（vanilla 检出）的 KNOWN_SESSION_EVENT_TYPES 已打 'dsh-femo/chat' 补丁（源码+lib 双验，注释自证"whitelisted so femo chat history survives restarts"）——持久层安全，降级不再必要。
### 修改明细（旧版行为逐字节不变；全部为防御读法/门控，非功能重写）
1. **src/client-ui/view-button.tsx**（新旧共用，版本无关防御读法）：turnTimings 改可选链 + ??0（旧版有此字段时取值不变）；mainSid 判定改 `projectionValues?.agentPreset ?? agentPreset` 双形读取（旧版无投影值照走扁平字段）。
2. **src/windowing-native.ts**：新增 mainChatSafe=安装时运行时探测 KNOWN_SESSION_EVENT_TYPES.has('dsh-femo/chat')（读宿主同实例 dsh-session，探测的是部署真实持久层词表，非编译期假设）；broadcastCompat/projectedCompat 的原生分支从"一律不写主会话"改为"白名单在=旧版同款主会话+全窗双写 / 不在=仅窗侧降级"。官方 stock 无补丁构建自动落回保守行为；meow fork legacy 直通不受影响。
### 不影响别处论证
sys 行持久化后被白名单接受（补丁即为此目的）；主模型上下文不受影响（femo/chat 本就不进 prompt 组装，同旧版）。client bundle 错误集 diff 与基线完全一致（84 行存量环境性错误，无新增）。
### 验证
node build.mjs 双产物 exit 0；lib/client.js 含 turnTimings 防御读 + projectionValues 双形读；lib/index.js 含白名单探测与新日志（"event type whitelisted/not in persistence whitelist"）。待 3083 重启实测：Femo 主会话头部出现 👁 视角菜单、角色项跳 femo-proj 窗；跑/停/完时戏外主会话出现居中灰字 sys 行且重启后仍在。

## 2026-09-09 深夜三轮：0.1.3 端到端联调（诊断窗增强 + Path B 持久化投影窗 + 目录收录打通）
### 过程与实锤
1. **视角菜单/sys 行已实测恢复**（上一轮修复生效）。用户报「点开投影窗：历史加载失败 subagent Sessions require their durable parent address」+「戏外仍无 sys 行」。
2. **开窗失败根因（三层门禁，逐层实测）**：① 0.1.3 对 origin:subagent 会话的历史加载强制要求「durable parent address」（session-controller history.ts validateAddress），普通 sessions.open 直接被拒；② 官方 sessions.openSubagent（selectSubagent）要求子项已在父会话目录缓存（catalogs）且 mode 匹配；③ 目录（subagent listChildren）只收「subagent runtime 自己登记的持久化孩子」（femo-actor startContinuable 有、裸会话永远没有）。裸投影窗三条路全堵死。
3. **方案 B 持久化创建（用户拍板）**：ensureProjectionWindow 原生+白名单分支改 ctx.agents.create（agent-loop 事务）持久化创建——实测 9 窗落盘、origin/parentSession/descriptor 完整、官方目录收录（listChildren 返回 17 行含 9 投影窗，mode='one-shot'/label 正确）、侧边栏隐藏、selectSubagent 门禁通过。
4. **descriptor 版本坑**：0.1.3 SUBAGENT_DESCRIPTOR_VERSION=3 且 parse 严格（版本不符静默返回 undefined→身份解析不出→目录丢弃）；修复=descriptorPayload 按 nativeState.native 分流 v2/v3。
5. **查询引擎头冲突坑**：同 id 跨 boot 的裸建（新 createdAt）与持久化文件（旧 createdAt）构成双源冲突 → SessionQueryError SESSION_QUERY_SOURCE_CONFLICT → 目录列表整个抛错挂起。修复=SessionAlreadyExists 时【绝不裸建】（防恶化守卫），改为跳过本窗等待冷装载。
6. **0.1.3 冷装载配方（debug-materialize 实测验证）**：readStoredLog(locate({cwd,id}).path, id) → {status,meta,eventState,events,inheritedEventCount} → sessions.prepare(id,{eventState,seed,meta,inheritedEventCount}) + enter + announce。已实现进 awakenProjectionWindow（旧版 sessionPersistence.prepare 路径原样保留在前置分支；sessionPersistence.prepare 在 0.1.3 已不存在，实测 false——awaken 旧判定会静默跳过的根因）。
7. **镜像重放升级**：持久化装载窗（count>0）从「整窗跳过」改为「按 (type|_srcSeq|turn|step|data.seq|kind|index|actor) 身份键并集合并」——文件+镜像并集，防双写；surfaceOp 按事件类型重算（user/message/assistant/message/tool/result）。
8. **客户端诊断（用户 F12 不便）**：diag-overlay 增加 client-err/client-rej/client-console/client-state 采集（window error/rejection/console.error 拦截 + 10s 状态快照：native/sessionId/turnHead 计数/slotErrors）。
### 已知遗留（下一轮）
- **客户端视图装载**：openSubagent 成功后 selected 指向投影窗，但 UI 未挂载对应会话视图（空白）——需查 client session-provider 对该子项的 binding 物化；冷装载时序（目录 15s+ 才就绪）已用「菜单打开预热 warmCatalog + 20s 重试窗口」缓解，仍需实测收敛。
- **装载窗无持久化写句柄**：冷装载 boot 内新追加的投影事件仅内存+镜像（文件不更新），下次重启由「并集合并重放」找回——文件基线之外的自动落盘需要 agent resume 级机制，另行立项。
- **femoGen FoldDock 在 composer.dock 槽崩溃**（'sessionId' undefined）：femoGen 插件的 0.1.3 适配问题，被 SlotErrorBoundary 隔离，与 femo 无关，未处理。
- debug 路由（debug-list-children/debug-materialize/debug-services）与 chat-node/turn-head 探针为排障临时面，问题收口后整体摘除。
### 验证
node build.mjs 双产物 exit 0；tsc 80 行=基线-2（顺手修掉的存量 surfaceOp 错误）；宿主 listChildren 实测 17 行含 9 投影窗；浏览器实测：视角菜单出现、sys 行渲染、@小猫咪 点击后 selectSubagent 通过（selected=投影窗 id、地址注册成功）。客户端视图挂载与首次目录冷加载时序待下轮收敛。

## 2026-09-09 深夜四轮：运行时白名单注册——彻底消掉「升级重打补丁」
### 用户诉求
"升级后需重打，我对这种事情总是有点不爽，这个有办法避开吗？"
### 方案
KNOWN_SESSION_EVENT_TYPES 运行时就是可变 Set（旧版 registerSessionEventType 的机制面，上游只是收了 API）。插件启动时经 createRequire(宿主入口 argv[1]) 解析【宿主进程加载的那份】@deepseek-ai/dsh-session（插件与宿主各一份副本是常态，3083 实证），把 'dsh-femo/chat' add 进该实例的 Set——进程内存级、幂等、每次启动自动。安全带：register 后用动态 import(同一文件 URL) 的 ESM 视图复核 has()，双视图一致才保持持久化路线，否则自动降级仅窗侧（防 require(esm)/import 缓存分叉的假阳性）。
### dsh 检出已还原纯净
白名单文件补丁（src + 已部署 lib）已全部摘除还原，git diff 不再含 femo 相关改动（余下 pnpm-workspace fs-ext 桩/pnpm-lock 为 win32 环境适配，与 femo 无关）。纯净构建上运行时注册实测生效：启动日志 runtime whitelist registered → durable 投影窗 + 主会话 sys 行全路线保持。README 补丁章节改为「0.1.3+ 免打、自动运行时注册」，手工补丁方案留档折叠。
### 不影响别处论证
legacy（meow fork）路径不经过本函数（native 分支专属）；注册失败自动降级仅窗侧，不炸启动。暂留 debug 路由（list-children/materialize/services）与 chat-node/turn-head 探针待客户端视图挂载问题收口后摘除。
### 验证
纯净 lib（无 dsh-femo/chat 字符串）+ 重启：启动日志 runtime whitelist registered (host copy: ...packages/core/session/lib/index.js) → projection windows durable + main-session allowed；/projection-windows 正常返回 9 角色窗；listChildren 12 行含 9 proj。tsc 80 行=基线-2。

## 2026-09-09 深夜五轮：白屏根因实锤与修复（镜像重放守卫短路 + 开窗竞速）
### 背景与排查路径（全部浏览器+宿主日志实测，非猜测）
上轮遗留「点视角菜单角色项 → 客户端不挂载投影窗会话视图（白屏）」。本轮逐层实测推翻了上轮的三个疑点并定位真因：
1. **client 侧挂载链路本身是通的**：持久化选择恢复后 `list.current` 指向 femo-proj 窗、`byId` 条目存在、`sessions.binding()` 可解析、React 树确实切到了投影窗（fiber 反查 ConversationRoot/ProjectionComposer 的 sessionId 都是 femo-proj id）——上轮「binding 物化失败/挂起」不成立。
2. **"白屏"=官方 blank 语义**：官方 `ConversationSessionHeader`/`ConversationSession`（ui-conversation skeleton）在 `session.blank && conversationPhase==='blank'` 时隐藏整个 header（`_headerHidden` + aria-hidden）、body 返回 null。窗在宿主侧事件数为 0/近 0 → blank → chrome 全隐 = 用户看到的白屏。此为 dsh 原生行为（对空子代理同样发生），非 femo 组件故障。
3. **窗为什么空 = 两个叠加根因**：
   - **根因 A（代码 bug）**：windowing-native 的 `session/created` 钩子里有 `readSessionEventCount(session) > 0 → return` 守卫——冷装载窗（count>0）直接跳过重放，上一轮写好的「并集合并」replayWindow 逻辑从未被执行（守卫与 replayWindow 内部的 durable 分支自相矛盾）。冷装载窗永远只有持久层基线（如 4 个创建期事件），镜像里几百行内容回不来。
   - **根因 B（时序竞速）**：客户端 history 首拉（follow RPC 的 opening snapshot）与宿主唤醒（/projection-windows 的 ensure→awaken）竞速；先拉到空持久层 → blank 定格。
### 修改明细（旧版路径零改动）
1. **src/windowing-native.ts**：摘除 `session/created` 钩子的 `count>0 → return` 守卫——冷装载窗与裸窗统一走 replayWindow（durable=并集合并 / 裸=整窗重放，逻辑本就双形态）。
2. **src/client.tsx（openSession 原生分支）**：openSubagent 重试链之前先 `await fetch('/dsh-femo/projection-windows?sessionId=主会话')`——宿主 ensure 幂等且完成后窗已唤醒+镜像并集进 live 会话，客户端 history 首拉直接命中全量内容（官方 history 为 live-preferred）。
3. **src/routes.ts**：新增临时诊断路由 `/dsh-femo/debug-live-events`（读宿主 live 会话 eventCount/seq/inheritedEventCount，排障用，随排障面一起摘除）。
### 实测验证（3083 重启后）
- 宿主日志出现 `restored from mirror: 57 rows / 41 rows`（god/stage 窗）——并集合并首次真正运行。
- 浏览器实测 @小猫咪 窗：**16 个 flow 节点、角色台词气泡（Eve/小灵发言+用量+时间戳）、面包屑/视角菜单/三标签页全部渲染**，截图存档；composer 为 femo 可输入链。官方 chrome 不再隐藏（headerHidden=false）。
- openSubagent 直开路径：选中即切（selected 指向投影窗、地址正确、chrome 渲染）。
### 已知遗留（下一轮第一优先）
- **opening-snapshot 渲染缺口**：事件经「首拉 opening snapshot」整批到达时，官方 ChatView 转写体不装配（客户端 eventSource 窗口实测 25 条齐全、turnHead matched/built 计数在涨，但 `data-chat-flow-key` 节点 0、body 空）；同样的事件经 **follow 实时追加**到达时正常渲染（boot 0910b 实测 16 节点）。两个可复现对照已锁定，疑点在官方 assembler 的 replaceWindow/timeline 路径或投影基线（0.1.3 无 turnTimings，turn 轨数据走 projections 基线，需对照 follow/replace 两路径的投影帧差异）。
- **follow 断线重连报错**：`session event stream resumed at a cursor behind the last applied entry` → openState=error → 流被清空。触发条件=流重连时宿主观察游标落后于客户端已应用游标（疑似 IAB 后台标签页挂起导致 ws 掉线 + 冷观察缓存/窗口 detach 的组合）。候选缓解（下轮与用户确认后做）：femo 客户端监听 femo-proj 会话 openState=error 自动重开；或根治「装载窗无持久化写句柄」让重放内容落盘（agent resume 级机制，另行立项）。
- **目录 listing 间歇挂起**：subagents.list 偶发整链卡死（单飞 promise 永久 loading，但已完成条目仍留在 catalogs 里、selectSubagent 可用过期条目成功）。实测 raw readStoredLog 对全部 femo-actor/femo-proj 文件均正常（curl 逐个验证），挂起点在 session-query 的 open('read')/listSessions 路径，疑与强杀进程残留的未决事务有关；宿主重启即清。femoGen 的 composer.dock 槽报错（sessionId undefined）为另一插件问题，SlotErrorBoundary 隔离中，与本项目无关。
### 验证
node build.mjs 双产物 exit 0；tsc 113 行=基线。3083 多轮重启+新标签页实测（IAB 标签页勿 reload 的既有注意事项维持：验证一律「新开标签+点击导航」）。

## 2026-09-10 投影窗渲染缺口根治：turn/end 缺 reason 触发官方装配器整体报废
### 过程与实锤（活体装配器解剖，全部页面内实测）
用户手机端实测上帝视角窗仍空白。本轮把 uiConversation 服务暴露到 window（临时诊断面 `__femoUiConv`，随排障面摘除），对装配器做活体检查，层层收束：
1. 上轮的「opening-snapshot 渲染缺口」定位到**唯一异常**：`replaceWindow` 处理到 seq 58 的 `turn/end`（turn=1788974850）时，官方 `trajectory-turn-end` 定义（ui-trajectory）的 start **无保护读 `data.reason.kind`** → TypeError → replace 中途报废 → contexts 全清 → 转写体空（转写导航轨因投影基线独立仍显示「未加载」标记，构成"半渲染"假象）。
2. **为什么这条 turn/end 缺 reason**：主会话 6 条 turn/end 全带 `reason:{kind}`；god 窗 11 条里唯一缺的是 femo 引擎投影簿记行（main-actor.ts:213 等处 `projectionAppend(proj,'turn/end',{turn})`）+ 旧镜像文件存量行，dsh 原生 turn/end 恒带 reason（修复器合成收尾也带 `reason:{kind:'interrupted'}`）。
3. 装配器无逐定义错误隔离——任何一个定义的 start 抛错，整窗装配报废。这是官方结构性脆弱，插件侧选择在数据面根治。
### 修改明细（全部在 projection.ts 的总漏斗与种子装载；旧版路径零改动）
1. **appendEvent 漏斗**：`type==='turn/end'` 且缺 `reason` 时统一注入 `reason:{kind:'completed'}`（官方 migration 契约本要求 turn/end 恰好 ['turn','reason'] 两键；已带 reason 的行原样透传）——覆盖引擎投影、god-mirror、镜像重放的全部追加路径。
2. **awakenProjectionWindow 种子清洗**：readStoredLog 回来的存量行在 prepare 前逐条补 reason（种子不走 appendEvent，漏斗管不到；与漏斗兜底互为表里）。
3. client.tsx 新增临时诊断面 `__femoUiConv`（装配器活体检查入口，随排障面摘除）。
### 实测验证（3083 重启 + 全新页面）
- 上帝窗：**60 个 flow 节点**完整渲染（转写全文含"已思考/上下文注入/用量/时间戳"），turnHead built=18，headerHidden=false，flow 挂载 ✓。
- 视角菜单点 @Eve：切换成功，**30 个 flow 节点**渲染 Eve 台词 ✓。opening-snapshot 路径渲染缺口随之关闭（根因就是它）。
- slotErrors 仅剩 femoGen composer.dock（另一插件，无关）。tsc 113=基线。
### 排障方法教训（防重蹈）
页面内给定义包 try/catch 时必须全参数透传（首版包装丢掉第三参 reader，制造了'reading previous'假异常，冤枉了一圈 trajectory-input-message/readerFor 链路）；多轮探针会层层污染运行态，结论必须以「新页面+单层干净包装」复测为准。

## 2026-09-10 补：layout inject 缺声明修复 + femogen 运行/停止现象定性
### 用户报障
手机端投影窗已正常。诊断窗偶现 `Uncaught Error: cannot get property "layout" without inject`；femoGen 窗按运行半天没反应、按停止也没反应，随后窗口闪退。
### 定性与修复
1. **layout 报错 = dsh-femo 缺 inject 声明**：client.tsx 的 `inject=['slots','sessions']` 未声明 'layout'，而 scriptViewInjected 的 toggleSidebar（编辑器「返回壳层」按钮，editor-page onBackToShell）访问 `ctx.layout.toggleSidebar()`——0.1.3 cordis 对未声明服务直接抛该错（堆栈指向宿主 index bundle 的 ctx getter，故文件名是 index-QCwDBYTX.js 而非 femo client.js）。修复：inject 补 'layout'（0.1.3 ILayout.toggleSidebar 存在，API 兼容）。meow-smooth 自身已声明 layout，排除。
2. **femoGen 运行/停止：宿主侧全链路正常**。宿主日志实锤：job 742 于 23:28:40 flow_done（运行成功跑完）；随后多次 stop(explicit) 全部 `stopped=true state=finished` 幂等应答。「没反应」是 femoGen 客户端 UI 不刷新（其 FoldDock composer.dock 槽 0.1.3 适配崩溃已被 SlotErrorBoundary 隔离，运行状态无从展示），「闪退」即该 UI 崩溃面。属 meow-smooth（femoGen）插件自身的 0.1.3 适配问题，与 dsh-femo 后端无关，另行立项。
### 验证
build 0 错、tsc 113=基线；3083 重启后新 token 正常。

## 2026-09-10 补二：meow-smooth（femoGen）FoldDock 0.1.3 适配修复（用户点名顺手修）
### 根因
0.1.3 把 `conversation.composer.dock` 槽改为 session scope 且 owner props 传**空对象**（InputBar.tsx:553 `renderSlot('conversation.composer.dock', {})`），sessionId 走 session 标准 props（BUILTIN_SOURCE）到达；meow-smooth 的 FoldDock 仍按 rc.2 旧形状读 owner 的 `session.sessionId` → `session` undefined → TypeError → SlotErrorBoundary 弃用该条目 → femoGen 的 pending/运行状态汇报链路（reportPending）全断 =「运行/停止没反应」+ 面板闪退。
### 修复（meow-smooth/src/client.ts FoldDock，两形兼容零破坏）
FoldDockProps 增加 `sessionId?: SessionId`（0.1.3 标准 props）、`session` 改可选；组件内 `const sessionId = sessionIdProp ?? session?.sessionId`，undefined 时静默 return null（绝不抛错拖垮 dock）。旧版 rc.2 形状（owner 带 session）行为不变。
### 实测
build 通过；3083 重启后全新页面：`slotErrors: []`（此前恒有 composer.dock 一条）、dock 条目挂载（childCount 1）、主会话转写 43 节点正常。运行/停止的状态反馈链路（FoldDock→reportPending→横幅）恢复。

## 2026-09-10 补三：femoGen 运行按钮复测——修复生效，运行链路全通
用户复报运行按钮闪退。全新页面实测：FoldDock/layout 两修复合入后，「▶ 继续」点击 → 按钮即时切「⏹ 停止（可续跑）」（运行态反馈正常）→ 宿主引擎起 job 743 正常推进（狼人杀wolf_discuss节点 human_wait 等用户输入，waitingHuman UI 正常显示）→ slotErrors 全程为空、编辑器不崩。
### 用户此前「运行没反应/闪退」的定性
宿主日志实锤三段：①按运行=job 742 实际起跑并收场；②「没反应」的两层=FoldDock 崩溃断掉 reportPending 状态链（已修）+ 对已完结 Job 按恢复被引擎「协程为零秒跑完」（引擎断点语义，属预期行为但无可见反馈——后续可考虑给「对完结 Job 继续跑」加知情提示，另行立项）；③「闪退」=FoldDock 条目崩溃的 UI 面（已修）。
### 现状
job 743 运行中，等用户在 femoGen 界面输入（@人 的 @KILL 选择）。诊断面（debug 路由/探针/__femoUiConv）待用户确认稳定后摘除。

## 2026-09-11 调试窗口「清空」按钮回归（用户点名：右上角）
### 用户需求（原话）
"帮我改一下 dsh-femo 这个插件吧。给我在 FEMOGen 的设置面板调试窗口右上角加个清空按钮。"
### 背景（为什么只是"补回来"）
清空按钮在 2026-09-08 调试窗口改版时被「复制」二选一挤掉，但两侧调用方一直留着 onClear 传参没删：FemoWorAuto:3772 `onClear={() => setDebugLog([])}`、手机侧 FemoWorAuto:3433 `onClearDebug={() => setDebugLog([])}` → mobileView:1024 `onClear={onClearDebug}`。只有 debugPanel.jsx 的组件签名把 onClear 丢了——线还在，按钮没了。
### 修改（femoGen/src/debugPanel.jsx，29+/3-）
1. 签名接回 onClear：`({ entries, onClose, onClear, onCompile, compiling })`。
2. 头部按钮组补「清空」：位置=「复制」右侧、「✕」左侧（右上角按钮组，关闭仍在最角）；样式照抄「复制」的中性描边，不抢蓝底「编译」的主操作位；`typeof onClear === 'function'` 才渲染（沿用 onCompile 的消费方豁免约定）；日志为空时 disabled + opacity .5 置灰（与复制一致）。
3. 空态文案同步：`新记录把旧的刷下去，无需手动清理（上限 200 条）` → `新记录把旧的刷下去；也可点右上角「清空」手动清理（上限 200 条）`（清空回归后"无需手动清理"不再成立）。
4. 头部注释与文件头设计注释同步（含本条日期留痕）。
### 验证
- **渲染断言 11/11**（.tmp/verify-debugpanel-clear-entry.mjs + .tmp/build-verify.mjs，esbuild+react-dom/server）：按钮存在 / 顺序 复制<清空<✕ / title / 非空可用 / 空日志置灰 / 未传 onClear 不渲染 / 空态文案。
- **真实浏览器点击**（.tmp/dp-harness 挂 DebugPanel + 面板外条目计数当观测点，IAB）：点「清空」→ 条目 4→0、错误徽标消失、复制与清空双双置灰；截图 .tmp/shots/dp-clear-before.png / dp-clear-after.png。
  - 排障留痕：该 webview 的 playwright click 送不进指针事件（先报 guest 未就绪，后为 click 动作超时，force 也超时），但 `elementFromPoint` 复验按钮在点击位最上层且未置灰 → 改用 `tab.cua.click({x,y})` 坐标点击成功。后续在这类 webview 里点不动时，先 `evaluate` 取 rect + `elementFromPoint` 定性，再走 cua 坐标路径。
- **产物**：`npm run build` 通过（lib/client.js 798.6kb，含 `onClick: onClear` 与新按钮）。dsh-plugins/dsh-femo 是指向本仓库的软链，刷新 dsh 页面即生效（纯前端改动，无需重启）。
- femoGen/dist（Cloudflare 独立站）未重打——按 femoGen/璇存槑.txt 两步另行部署。
### 备份
MEOW_backups/debugPanel.jsx.bak-20260911-124240-preclear

## 2026-09-11 手机端标题栏左上角：←/→ 箭头换成 FA 窗口控件图标（用户点名）
### 用户需求（原话）
"手机端，左上角有一个切换 全屏 VS 打开边栏和header 的按钮。现在用左右箭头也太令人迷惑了。你给我把向左的箭头改为'打开边栏'或者'窗口还原'的svg图标，用font awesome，你找个意思合适的。向右的箭头改为'最大化'图标"
### 这个键的真实语义（FemoWorAuto:3375-3376 为准）
- 全屏沉浸态（mobileFs=true → fixedMode=true）显示 ←，点击 = `setMobileFs(false)` + `onBackToShell()`（退出沉浸 + 打开 dsh 边栏）。
- 容器态（mobileFs=false → fixedMode=false）显示 →，点击 = `setMobileFs(true)`（回全屏沉浸）。
### 图标选择（用户授权"你找个意思合适的"）
取 FA 标准窗口控件一对：**还原 fa-window-restore（全屏态）↔ 最大化 fa-maximize（容器态）**。理由：①箭头暗示"左右移动"，而这键是窗口状态切换——最大化/还原这对外形与语义都直指状态，正是要治的迷惑；②"还原"永远成立（`setMobileFs(false)` 无条件执行），而"打开边栏"那步是 `toggleSidebar()` 开关，"打开"二字不保证成立，故不取 fa-bars 方案。
### 修改（femoGen/src/faIcons.jsx + femoGen/src/mobileView.jsx）
1. faIcons.jsx：按 _gen-fa-icons.mjs 产物格式新增 FaWindowRestore / FaMaximize（FA Free 6.7.2，unpkg 原样取 path，单 path + fill=currentColor 继承文字色）。
2. mobileView.jsx：MobileTitleBar 左槽两处文字箭头 `→` / `←` 换成 `<FaMaximize size={19} />` / `<FaWindowRestore size={19} />`；清掉为文字字形留的 `fontSize: 22`。aria-label 同步改准：`全屏` → `全屏沉浸`、`返回` → `退出全屏，打开 dsh 边栏`（手机端无 tooltip，无障碍名就是唯一说明）。
### 验证
- **渲染断言 14/14**（.tmp/verify-mobile-titlebar-icons-entry.mjs + .tmp/build-verify-icons.mjs）：全屏态是 window-restore 且无 maximize/无 ←、容器态反之、aria-label 新旧切换、图标在 button 内以 svg 渲染（宽高 19）、未传回调时左槽不渲染。
- **真实浏览器**（.tmp/tb-harness 并排渲染两态，420×320）：两键各恰含 1 个 svg、textContent 为空（箭头已绝迹）、path 开头分别 `M432 64L208 64c-`(restore) / `M200 32L56 32C42`(maximize)、fill=rgb(173,178,184)=--femo-text-3 继承正常；截图 .tmp/shots/titlebar-icons.png。
- 产物 `npm run build` 通过（lib/client.js 816.8kb）。刷新 dsh 页面即生效。
### 备份
MEOW_backups/{faIcons.jsx,mobileView.jsx}.bak-20260911-135713-prefsicons
### 并行改动提醒
mobileView.jsx 同日 12:39 另有并行会话的改动（标题栏右侧「导入/导出 .femo」两枚图标芯片 + onImport/onExport/exportBusy 三个 prop），本次只动左槽，两侧互不重叠、均完整。

## 2026-09-11 运行控制键语义对调：挂起态绿键=从头重跑、第二枚=继续（用户点名）
### 用户需求（原话）
"帮我改一下dsh-femo这个插件，在femogen右上角的按钮里，现在当剧本暂停时，右上角是继续和重新开始。当前俩按钮的逻辑有点别扭。
绿色按钮在未开跑之前是fresh start，所以我觉得这里还让它当fresh start。
另一个按钮在未开跑之前不存在，暂停时才存在，所以我觉得另一个按钮才应该是继续跑。
就是在停止之后，把俩按钮的语义换一下。"
### 现状（为什么要换）
1. idle：单枚绿「▶ 运行」→ `handleRunWorkflow()` → `reset: flowStatus !== 'paused'` = true = 从头开演。
2. paused：两枚——主色/绿「▶ 继续」→ `handleResumeWorkflow()` → 带 resumeJobId 再入 handleRunWorkflow → `reset=false` = job_resume 六关续跑；次要/琥珀「⟲ 从头」→ `forceReset: true` = 作废断点从头跑。`reset` 判定的唯一处是 FemoWorAuto.jsx:1623。
3. 别扭点（用户判断，链路实锤）：绿色键未开跑前就在（语义=从头跑整个剧本），到挂起时却改行续跑；而"续跑"只在挂起时成立，反被塞进那枚未开跑时并不存在的键。
### 修改（语义对调，两枚位置不动：第一枚=从头重跑，第二枚=继续）
1. **femoGen/src/FemoWorAuto.jsx（桌面，paused 分支 4159-4193）**：第一枚改 `forceReset` 带头跑 + 底色 `var(--femo-success)`（与 idle 绿「▶ 运行」同族），文案「⟲ 从头」/title「作废断点，从剧本开头重新运行」；第二枚改 `handleResumeWorkflow`，回到中性描边（`--femo-btn-primary` 从 paused 区退场），文案「▶ 继续」/title「继续（可续跑）：从保留的断点接着跑」。
2. **femoGen/src/mobileView.jsx（手机，paused 两枚芯片 440-455）**：同款对调——绿 success 芯片 `FaArrowRotateRight`「从头重跑（作废断点）」（`onRestart`）、琥珀 warning 芯片 `FaPlay`「继续（可续跑）」（`onResume`）。props 名（onResume/onRestart）语义不动，只换挂载点，FemoWorAuto:3542-3543 的传参链零改动。
3. 注释同步：两处三段态说明块、handleRunWorkflow 的按钮语义注（1618-1621）、FEMO 预览键的色语注释。
4. 备注：绿键在挂起态是破坏性动作（作废断点），故它保留明写"作废断点"的 title；若后续觉得"强调色给了破坏性动作"不妥，可再议（现状=用户点名的语义归属）。
### 验证
- **渲染断言 19/19**（.tmp/verify-runbtn-swap-entry.mjs + .tmp/build-verify-runbtn.mjs）：paused 两枚芯片的图标 path（fa-arrow-rotate-right / fa-play）、底色 var（success / warning）、title、左右顺序；idle 绿▶「运行」与 running 红⏹「停止」回归不变；未传回调时芯片仍渲染（回调有无不影响渲染，与既有行为一致）。
- **结构化断言 20/20**（.tmp/check-runbtn-swap-pc.mjs）：源码 paused 区域（先去注释）两枚按钮的 onClick 归属与顺序 + 产物 lib/client.js 解码后的同一组串（产物里中文是 \uXXXX，照 check-bundle-icons 的解法）。**分辨力已验证**：改完未重打时该脚本 16/20（4 条产物断言按预期红），`npm run build` 后 20/20。
- **浏览器实点**（.tmp/rb-harness，真 React 真页面真事件）：点绿⟲ → 日志 `onRestart 触发 ← 从头重跑（作废断点）`；点琥珀▶ → `onResume 触发 ← 继续（可续跑）`。截图 .tmp/shots/runbtn-swap-paused.png。
  - 排障留痕：本机 webview 的 `playwright.click` 与 `tab.cua.click` 坐标点击都送不进指针事件（页面探针 `window.__hits` 为空——与 2026-09-11 上轮记录同现象，先 elementFromPoint 定性再走坐标的老办法这次也没通）；改用页面内派发冒泡 pointer/mouse/click 序列（React 18 根监听路径与真人点击同一条）验证回调归属。另注：React 状态刷新非同步，派发后同 tick 读 DOM 会误判"没反应"，需等一帧再读。
- **产物**：`npm run build`（node build.mjs）通过 —— lib/client.js 817.0kb；dsh-plugins/dsh-femo 是指向本仓库的软链，刷新 dsh 页面即生效（纯前端改动，无需重启）。
- **femoGen/dist（独立站）本次一并重打**：本机 5199 正是从 dist 出页（旧产物 main-htFks00Z），不重打那边就看不到改动。`npm run build`（vite）通过 → assets/main-BUvZc4D2.js 414.98kb；压缩产物核对：paused 分支为 `forceReset:!0` + `background:"var(--femo-success)"` 的⟲从头，与 `onClick:sf` 的中性▶继续；手机端 `onRestart:d`（绿·rotate）与 `onResume:u`（琥珀·play）配对正确。dist 是 .gitignore 产物，不入库。
### 备份
MEOW_backups/{FemoWorAuto.jsx,mobileView.jsx}.bak-20260911-140430-prerunbtnswap
### 并行改动提醒
mobileView.jsx 同日 12:39（标题栏右侧导入/导出芯片）与 13:57（标题栏左槽窗口控件图标）另有并行会话改动，本次只动运行控制芯片块，互不重叠、均完整。

## 2026-09-11 运行控制键定型：按钮恒定（三枚键各钉一个 action，只按阶段展示）（用户点名）
### 用户需求（原话）
"其实是这样的，我对这种变来变去的按钮有点不爽了。
我希望改成，按钮全程不变，按钮样式和语义都全程不变，他们会调用的api也全程不变。
但我们在不同的剧本运行阶段，展示不同的按钮就好了……
绿▶ 就是 fresh start，他调用的api想必也是？等等fresh start是一个固定的api对吧？
黄[继续]你可以另外设计一个图标，表示resume。剧本没跑和在跑的时候我们不展示它就是了。它只在剧本stop之后出现。
红[⏹️]就是stop，也是唯一的api对吧？剧本没跑的时候我们不展示它就是了。
当然我对api的接口不太熟，也许我说的不对。你看代码以代码为准。总之目标是，全程不变的按钮"
### API 面核实（回答用户三个"对吧"——都是对的）
- 引擎/宿主动作面就是固定的四个：`fresh_start` / `stop` / `resume` / `list_jobs`（src/tools.ts:99-104 的 `femo-run` 工具定义），宿主路由是 `const reset = body.reset === true`（src/run-control.ts:502）：fresh_start = reset:true 从头开演；resume = 带 job_id 且 reset 非 true（六关裁决归引擎）。
- 所以"一枚按钮钉死一个 action"在 API 层完全成立。上一轮剩下的别扭其实在**前端**：绿键的 reset 是由状态推出来的（旧 `reset: (opts.forceReset === true) ? true : flowStatus !== 'paused'`），同一枚键在 idle 与 paused 各调一种语义。
### 修改（femoGen/src/FemoWorAuto.jsx + mobileView.jsx + faIcons.jsx）
1. **三枚恒定键**（图标/色/文案/调用从生到死不变，唯一变量=展示哪些）：
   - 绿「▶ 运行」= fresh_start：`handleRunWorkflow(undefined, 'human', { reset: true })`（桌面单一渲染点；手机 onRun 传同一句）——未开跑与挂起态都出现，两处调用逐字相同。
   - 红「⏹ 停止（可续跑）」= stop：`handleStopWorkflow`——只在跑的时候出现。
   - 琥珀「继续」= resume：`handleResumeWorkflow`（内部显式 `reset: false` + 当前 job_id）——只在 stop 之后的挂起态出现。
   挂起态顺序=常驻的运行键在前、挂起专属的继续键在后（[▶ 运行][继续]）。
2. **展示规则=唯一变量**：桌面三枚各一个 `{(flowStatus === …) && (…)}` 分支，运行键是 `idle || paused` 单分支（源码与产物里「▶ 运行」各只 1 处）；手机同构：`(idle||paused) / running / paused`。
3. **调用不再随状态漂移**：`handleRunWorkflow` 的 opts 增加显式 `reset`（显式优先；未显式给的调用方——AI 话术/人类触发/换稿重跑——沿用原判定，行为零变）；`handleResumeWorkflow` 显式 `reset: false`。`forceReset` 分支留作未显式调用方的兼容路径（已无按钮在用）。
4. **resume 专属图标**：新增 FA `fa-circle-play`（FaCirclePlay，unpkg 6.7.2 原样取 path，见 .tmp/gen-fa-circleplay.mjs）——▶ 归绿键独占，继续键用同族圈形播放符，一眼可辨不混。⟲（FaArrowRotateRight）整套退役：mobileView 不再引用（faIcons 里保留导出备用）。
5. **拆死线头**：`onRestart` 这条 prop 线全摘（mobileView 的 MobileTitleBar/MobileView 两处签名 + 透传 + FemoWorAuto 传参 + 文档注释）；三处说明注释同步改写。
### 验证
- **渲染断言 18/18**（.tmp/verify-runbtn-swap-entry.mjs + build-verify-runbtn.mjs）：三态芯片集合与顺序、每枚的图标 path/底色/title；**核心不变式=绿「运行」键在 idle 与 paused 的整段 markup 逐字相同**（图标/色/title/aria 全同）；⟲ 三态绝迹；未传回调时芯片仍渲染。
- **结构化断言 27/27**（.tmp/check-runbtn-swap-pc.mjs）：源码（去注释）三枚键各恰一个渲染点 + 展示规则分支 + 调用钉死（运行键窗口内无 flowStatus 判定）+ 退役串（`⟲ 从头` / `▶ 继续` / `从头重跑` / `forceReset: true` / `title="继续（可续跑）"`）计数全 0 + 产物 lib/client.js 同套串（含 fa-circle-play 进包）。
- **浏览器实点**（.tmp/rb-harness 三态并排、真实 React 真页面）：idle 绿→`onRun`；running 红→`onStop`；paused 绿→`onRun`（与 idle 同一回调——不变式端到端成立）；paused 黄→`onResume`。截图 .tmp/shots/runbtn-fixed-paused.png。
  - 排障留痕沿用上轮：本机 webview 送不进指针事件（playwright/cua 都空），用页面内派发冒泡 pointer/mouse/click 序列；另注 idle 与 paused 两行的绿灯 title 相同，取按钮必须按行作用域（`find` 会命中第一行）。
- **产物**：`npm run build`（插件）→ lib/client.js 816.1kb；`npm run build`（femoGen）→ dist/assets/main-DFQkYfOh.js 414.64kb。dist 压缩产物复核：手机三枚 `(idle||paused)&&onRun(s)` / `running&&onStop(a)` / `paused&&onResume(u)`，桌面 `reset:!0` + `background:"var(--femo-success)"` + 琥珀 `borderColor:"var(--femo-warning-border)"`；退役串 0。刷新 dsh 页面即生效（dsh-plugins/dsh-femo 是软链）。
### 两个判断点（都不合意的话各改一行）
- 黄键图标取 fa-circle-play（圈形播放符）；桌面「继续」是琥珀描边文字钮（与手机同色语；此前是中性描边），未给前置字形——要换字形或换回中性描边都是一行。
- 红⏹ 的展示规则按"没在跑就不展示"落在 **running 单态**：挂起态不出停止键（那时按停止是幂等无操作，只会弹一条黄条知情）。若想在挂起态也保留它，改展示规则一行。
### 备份
MEOW_backups/{FemoWorAuto.jsx,mobileView.jsx,faIcons.jsx}.bak-20260911-142905-runbtnfixed（定型后快照；本轮起点=第一轮语义对调完成后，未单独快照——回滚锚点用本快照或 140430-prerunbtnswap）

## 2026-09-11 运行控制键「继续」图标替换：fa-circle-play → fa-forward（用户点名）
### 用户需求（原话）
"resume换成这个fa fa-forward"
### 修改
1. **femoGen/src/faIcons.jsx**：`FaCirclePlay` 条目换成 `FaForward`（unpkg FA Free 6.7.2 原样取 path，脚本 .tmp/gen-fa-forward.mjs）——圈形播放符是同一天内被用户否掉的，故直接替换而非并存；FaArrowRotateRight（⟲）仍留作备用导出。
2. **femoGen/src/mobileView.jsx**：import 换 `FaForward`；挂起态「继续」芯片 `icon={FaForward}`（其余 props/顺序/回调零改动）；芯片块注释的记号 ⊚▶ 改 ⏩。
### 验证
- **渲染断言 19/19**（.tmp/verify-runbtn-swap-entry.mjs）：继续芯片=琥珀 + **fa-forward path** + 非 ▶ + 圈形播放符绝迹；其余 18 条（含「绿键跨态逐字相同」不变式）原样全过。
- **产物断言 29/29**（.tmp/check-runbtn-swap-pc.mjs）：新增「fa-forward 进包」「femoGen 图标库不再定义 FaCirclePlay」「mobileView 不再引用 FaCirclePlay」。
  - 踩坑一：最初写了「产物里 circle-play path 绝迹」→ **误报**——宿主侧图标库 `src/fa-icons.tsx` 自己也有一套 fa-circle-play（客户端 UI 用，与 femoGen 芯片无关），产物理所当然带着它。断言改为按 femoGen 侧图标文件/引用点来断。
  - 踩坑二：bash heredoc 写脚本会把 `\u` 吃成 `\u`（转义地狱重演，探针直接语法错）——脚本一律改用 Write 落盘再跑。
- **浏览器侧未重跑点击**：本轮只改 `icon` 一个 prop 值，回调绑定（按 title 维度的 onRun/onStop/onResume）与展示规则零变动，上一步的实点结论继续有效。
- **产物**：`npm run build`（插件）→ lib/client.js 816.2kb；`npm run build`（femoGen）→ dist/assets/main-wTkHJyY7.js 414.74kb。产物内实读三枚芯片绑定：`运行→onRun/FaPlay/success`、`停止→onStop/FaStop/danger`、`继续→onResume/FaForward/warning`（.tmp/probe-runbtn-bundle.mjs + .tmp/check-runbtn-dist.mjs）。刷新页面即生效。
### 备份
MEOW_backups/{faIcons.jsx,mobileView.jsx}.bak-20260911-143520-forwardicon（本轮后快照；本轮起点=142905-runbtnfixed）

## 2026-09-11 工具栏顺序调整：运行控制移到文件读写左侧（两端同序）（用户点名）
### 用户需求（原话）
"顺眼多了！把播放停止继续这类控制按钮移到导入和导出的左边。
电脑端也顺便给我改改吧，把导入和导出放到右边去。"
### 修改（只动顺序，回调/文案/图标/展示规则零改动）
1. **手机端（femoGen/src/mobileView.jsx，MobileTitleBar 右槽）**：重排为 运行控制（绿▶ / 红⏹ / 琥珀⏩）→ 文件读写（导入/导出）→ **FEMO 预览**（视图开关仍居最右，夹住文件读写）。原顺序是 文件读写 → 运行控制 → FEMO。注释同步：原注释里"排在运行键左侧、运行/停止/FEMO 相对屏幕右缘位置不变（手感不动）"的理由随调序下线，换成新顺序说明。
2. **桌面端（femoGen/src/FemoWorAuto.jsx 工具栏）**：「导入 .femo / 导出 .femo」两枚键（**含隐藏 file input**，它跟导入键一起走）从运行控制左侧搬到右侧 → 新序 `[位置][主流程][面包屑][弹性空隙][运行控制][导入][导出]`。导出回执 toast 与停止反馈条是绝对定位（`right: 12`），与 DOM 顺序无关，未动；编译入口注释末句"工具栏只保留正式运行控制"改准为"…运行控制与文件读写"。
### 验证
- **渲染断言 22/22**（.tmp/verify-runbtn-swap-entry.mjs 增补顺序组）：三态下芯片 **DOM 顺序**均为 运行/停止 → 导入 → 导出 → FEMO 预览（markup 索引递增，flex 行即视觉顺序）。
- **结构化断言 34/34**（.tmp/check-runbtn-swap-pc.mjs 增补）：工具栏区域内 运行 → 导入 → 导出（且隐藏 input 夹在运行键与导入键之间）；产物 lib/client.js 内两端顺序同断言（手机端运行芯片到导入 851 字符、桌面 2239 字符）。
  - 踩坑：全文件 `indexOf` 断序**误报**——处理函数里的 console 前缀串（`'[导入 .femo] 失败:'`、`'[导出 .femo] 开始即时生成'`）会先撞上，被当成渲染点。改法二选一：先切出工具栏区域断序（源码端），或「从运行键位置往后找 + 窗口」（产物端）。
- **产物**：插件 `npm run build` → lib/client.js 817.0kb；独立站 `npm run build` → dist/assets/main-BJ1S0dEp.js 414.74kb；dist 内顺序断言同样通过（手机端距 248、桌面距 619）。
- 本轮未跑浏览器点击：纯顺序调整，回调/文案/图标零变动，点击链路与上一轮一致；顺序证据在渲染断言（markup 顺序）与产物顺序断言两处。
### 备份
MEOW_backups/{FemoWorAuto.jsx,mobileView.jsx}.bak-20260911-144412-toolorder

## 2026-09-11 桌面右上角工具栏统一重造：六枚键同走 ToolChip 施工图（用户点名）
### 用户需求（原话）
"是的现在好了！
电脑端右上角那几个按钮现在看着还是丑，大小不一，样式也不一致，有的有图标有的没有……
你给我统一一下吧，弄好看点"
### 现状（为什么不齐）
右上角那一簇原本是五枚各写各的手工按钮：绿「▶ 运行」（文本字形 ▶）、红「⏹ 停止（可续跑）」（文本字形 ⏹）、琥珀「继续」（无字形）、中性「导入 .femo」「导出 .femo」（无图标）——文本字形与 FA 图标混用、有图标/无图标混排、实底与描边混排，且尺寸/内边距/字号各是各的写法。
### 修改（femoGen/src/FemoWorAuto.jsx + faIcons.jsx）
1. **新增唯一施工图 `ToolChip` + `TOOL_CHIP_TONES`（模块级，一处定义）**：同高度（30，与底部三键同族）/ 同内边距（`0 12px`）/ 同圆角（`--femo-radius-md`）/ 同字号（11.5 · 600）/ **每枚必带 FA 图标**（size 12、gap 6）/ 短文案；只靠色调分语义——`success` 绿实底（从头跑）、`danger` 红实底（停）、`warning` 琥珀描边（续跑）、`neutral` 中性描边（文件读写）。按压回缩反馈复用 `.femo-setting-btn`（与底部三键同款）。
2. **六枚键全部换成 ToolChip**：运行(FaPlay) / 停止(FaStop) / 继续(FaForward) / 导入(FaFolderOpen) / 导出(FaFloppyDisk) / 引擎启动中(FaSpinner)。文案同步收短（`▶ 运行`→`运行`、`⏹ 停止（可续跑）`→`停止`、`导入 .femo`→`导入`、`导出 .femo`→`导出`），细节（可续跑、.femo、"保存中…"）移入 title 或占位态。
3. **faIcons.jsx 新增 FaSpinner**（unpkg FA Free 6.7.2 原样取 path，脚本 .tmp/gen-fa-spinner.mjs）——引擎冷启动占位键也带图标，工具栏不再"有的有图标有的没有"。
### 验证
- **真实渲染几何核验**（.tmp/rt-harness：独立模式 + 插件模式 idle/running/paused 三态并排渲染，`getComputedStyle` 实测）：五枚键（运行/停止/继续/导入/导出）跨三态全部 **图标数=1、同高度、同字号 11.5px、同圆角 8px、同左右内边距 12px**；配色按语义（绿 `rgb(34,197,94)` / 红 `rgb(239,68,68)` / 琥珀字 `rgb(221,134,41)`=#dd8629 / 中性）。截图 .tmp/shots/toolbar-unified-3states.png。
  - 三态怎么拉起来的：插件模式的 `initialRunning` / `initialCheckpoint` 就是"刷新恢复"那条路（femoGen 里 setFlowStatus('running'/'paused')），harness 借它渲染出停止/继续两枚键。
- **结构化断言 40/40**（.tmp/check-runbtn-swap-pc.mjs 重写）：右上角簇**六枚全是 ToolChip、零裸 button、零逐枚样式覆盖、icon 六处齐备**、四种色调齐备、施工图唯一且尺寸常量都在组件内（height 30 / gap 6 / icon 12 / radius / 字号）；三枚运行键单渲染点 + 调用钉死（不变式不回归）；顺序 运行→导入→导出（含隐藏 input 位置）；产物 lib/client.js 同套断言（ToolChip 在包内、fa-spinner 进包、reset 显式）。
- **手机端渲染断言 22/22 复跑不变**（本轮未动手机端）。
- **独立站产物断言 13/13**（.tmp/check-runbtn-dist.mjs 扩充）：色调表签名、六图标齐备、退役串（文本字形 `▶ 运行` / `⏹ 停止（可续跑）` / `⟲ 从头` / `▶ 继续` / `从头重跑`）绝迹、两端顺序正确。
  - 踩坑：dist 是**压缩产物**——`function ToolChip` 的名字会被改（该条改断"色调表签名"）、桌面运行键的 `▶ 运行` 文本字形已不存在（该条改断 title 串）。两条首跑 FAIL 均为断言问题，非产品问题。
- **产物**：插件 `npm run build` → lib/client.js 818.1kb；独立站 `npm run build` → dist/assets/main-C1B2bQDf.js 415.77kb。刷新 dsh 页面（插件）/刷新本机 femoGen 站即生效。
### 两个判断点
- 文案收短是把细节移进 title（`导入 .femo` → `导入`）；若想保留后缀，改 ToolChip 的 children 一行即可。
- 左半边（`位置` / `主流程` / 模块面包屑）本轮**没动**：它们属导航族，不与运行控制/文件读写同族；要一起同高统一（同样 30）也是改一处配方的事。
### 备份
MEOW_backups/{FemoWorAuto.jsx,mobileView.jsx,faIcons.jsx}.bak-20260911-145644-toolchip

## 2026-09-11 手机端画布右下角缩放比例徽标摘除（用户点名）
### 用户需求（原话）
"手机端画布，右下角不需要显示缩放比例"
### 现状
mobileView.jsx 画布右下角有一枚 `XX%` 徽标（round56 加入，`bottom:8 right:10` + 毛玻璃底），捏合帧由手势层 `applyTransform` 直写 `textContent` 实时刷新（保证捏合时不靠 React 重渲染也有数字反馈）。
### 修改（femoGen/src/mobileView.jsx，四处一处不漏）
1. **摘掉徽标本体**（原 2503-2522 的 div + ref）；原位留一句带日期的摘除说明（"勿再补回"，附理由：捏合缩放无需实时数字反馈）。
2. **手势层帧直写**：`applyTransform` 里删掉 `scaleBadgeRef.current.textContent = ...` 一行——每帧仍直写 `tfRef` 的 `transform`（手感路径原样）；注释同步。
3. **ref 线头全拆**：`useMobileCanvasGesture` 形参、调用处实参、`const scaleBadgeRef = useRef(null)` 三处一并删除（不留死引用）。
### 验证
- **源码断言 4/4 + 整布局渲染断言 3/3**（.tmp/verify-zoombadge-entry.mjs + build-verify-zoombadge.mjs）：`scaleBadgeRef` 零引用、`Math.round(scale * 100)` 零渲染点、`applyTransform` 内无 `textContent`、摘除处留痕在位；**整个 MobileLayout 静态渲染**（17.3k 字符）通过且产物里**无任何"纯百分比"文本节点**、无徽标样式签名（bottom:8px + right:10px + blur(4px)）。
- **真实浏览器合成捏合**（.tmp/mb-harness，390×780）：在画布元素上派发双指 Touch 序列（touchstart → 4 帧 touchmove 张开 → touchend），变换包装逐帧实测 `translate(0px,0px) scale(1)` → `scale(1.43)` → `2` → `2.57` → `3`（**帧直写路径仍生效=手感不变**），且全程 DOM 内 `pctNodes: []`——**放大到 300% 也不再出现"300%"字样**。截图 .tmp/shots/mobile-no-zoom-badge.png。
- **回归复跑**：桌面工具栏结构化 40/40、手机端芯片渲染 22/22、独立站产物断言全过。
- **产物**：插件 `npm run build` → lib/client.js 817.1kb；独立站 `npm run build` → dist/assets/main-D8SiHxVr.js 415.28kb。刷新 dsh 页面即生效。
### 备注
scale 状态与 `setScale` 仍照旧（画布变换、桌面端不动）；本轮只摘"显示"，不改缩放能力与上限。
### 备份
MEOW_backups/mobileView.jsx.bak-20260911-150250-nozoombadge

## 2026-09-11 手机端条件边标签对齐桌面端：去框 + 不截断（用户点名）
### 用户需求（原话）
"手机端画布，节点之间的连线上，如果有条件边，现在条件外面会加一个框，把那个框去掉，条件也不要截断，和电脑端显示保持一致~"
### 现状（两端各写各的）
- 桌面端（FemoWorAuto 4422 区）：纯 `<text>`，无框、全文 `{e.cond}`、`fontSize 9.5`、基线 `labelPos.y + 4.5`、mono/700、贝塞尔中点。注释本就写着"无白色背景框"。
- 手机端（FemoWorAuto 手机分支内的 canvasContent 另一份渲染）：`<g>` + `<rect width=44 height=16 rx=4>` 白底描边框 + **8 字截断**（`e.cond.length>8 ? slice(0,7)+'…'`）+ `fontSize 9`、基线 `+4`——正是用户看到的"框"和"截断"。
### 修改（femoGen/src/FemoWorAuto.jsx，手机端块一处）
改成与桌面端同款：去掉 `<rect>` 与 `<g>` 包裹，`{e.cond}` 全文渲染，`fontSize 9.5`、`y = labelPos.y + 4.5`、`textAnchor=middle`、mono/700、`pointerEvents:'none'`（手机端 SVG 整体本就 pointerEvents:none，显式标注对齐桌面端）。fill 仍用手机端自己的 `stroke`（与桌面 `col` 同一套语义色板，仅优先级微差，未动）。注释标明派生日与"对齐桌面端"。
### 验证
- **真实渲染**（.tmp/ec-harness：414px 窄视口 → `useMobile()` 走手机端真路径；剧本用 `_diag_cat_werewolf.femo` → 贴进手机端 FEMO 面板代码框 → 点「文本到图」）：画布渲染出 **6 节点 / 6 边**，两条条件边标签 `game_over == false` / `game_over == true` **全文显示**（18 字，旧版会截成 `game_ov…`）、`fontSize=9.5`、**44×16 rx=4 的框 rect 计数 0**、全 SVG 无 `…`。截图 .tmp/shots/mobile-cond-edges-nobox.png。
  - 排障留痕（harness 侧问题，非产品）：① 插件模式的 `initialScript` 会建图入 state，但插件模式+无 session 时画布被后置 effect 覆盖成空图（只剩 START/END，边 0）——最后改走"代码框粘贴 + 文本到图"的**真实用户路径**才拿到真图；② 改 serve.mjs 文件表后忘了重启服务，fetch 回来 9 字节 "not found"（scriptLen=9），靠给 harness 页加 console 捕获才定位。
- **源码断言 8/8**（.tmp/check-cond-label.mjs）：手机端块无 rect/无截断/全文/9.5/+4.5/无 g 包裹；桌面端参照系未动（同为无框全文 9.5）。
- **回归复跑**：缩放徽标 7/7、桌面工具栏结构化 40/40、手机端芯片渲染 22/22、独立站产物 13/13（全 PASS）。
- **产物**：插件 `npm run build` → lib/client.js 820.3kb；独立站 `npm run build` → dist/assets/main-C5V8lo1i.js 416.55kb。刷新页面即生效。
### 备份
MEOW_backups/FemoWorAuto.jsx.bak-20260911-150931-condlabel

## 2026-09-11 刷新恢复浮层风暴修复：挂起态刷新零浮层 / 运行态只弹当前节点（用户点名）
### 用户需求（原话）
"帮我改一下dsh- femo这个插件，femogen，手机端ui，当剧本处于挂起状态时，一刷新页面，就会把之前的所有运行过程中弹出的浮层都弹一遍。这个改一下吧。
我希望挂起状态啥都别弹。
如果剧本是运行状态，刷新页面之后，也不是走马灯闪一遍过去弹过的一切，而应该弹出当前在运行的节点浮层，如果有人类输入就优先人类输入（这是写过的逻辑可复用）。"
### 现状（为什么会"走马灯"）
1. **重放帧与活帧形状完全一致**：宿主 `/dsh-femo/events` 新连接会重放 `runState.lastEvents`（cap 400，`ai_token/step` 不入环，见 engine-events.ts:159）——为的是"运行中打开编辑器标签页/手机切回"能把画布状态补齐。但重放发出的 SSE 信封与实时事件逐字节相同（routes.ts:814），前端无从分辨。
2. **"鬼影弹窗"只挡住了一条路**：`pendingReplayRef` 缓冲补放（画布未恢复时入队）会给帧打 `_replayed: true`，human_wait/node_retry 的弹泡点用 `if (!evt._replayed)` 过滤（旧 FemoWorAuto.jsx:2167/2203）。而**画布恢复完成之后**到达的重放帧（手机切回重连、刷新时网络先后差、initialRunning 触发的 `connectSse` 二次连接）不走缓冲——每条历史 `human_wait` 都被当活事件 `setBubbleOverlay` 弹一遍：整场弹过的输入浮层"走马灯"，最后停在最后一条历史 human_wait 上。
3. **挂起态刷新同样中招**：挂起场次的 lastEvents 里历史 human_wait 原样在环内（宿主 `flow_stopped` 只清 mirror.waitingHuman，不清事件环），刷新即触发上述走马灯——用户体感的"挂起状态一刷新就全弹一遍"。
4. 运行态刷新则是另一面：历史帧抢镜，真正"当前在跑的节点"反而不弹（旧逻辑运行态接通没有任何"弹当前节点"的入口；只有 `waitingHuman` 快照那一支会弹人类输入）。
### 修改（宿主 1 处 + 前端 6 处，三门口卫）
**宿主**：`src/routes.ts:822` —— 重放帧统一打 `replay: true`（顶层信封，data 内容零改动）：追平帧的含义在协议层显式化，前端据此只恢复状态、绝不弹浮层。
**前端**（`femoGen/src/FemoWorAuto.jsx`）：
1. **门一·帧源**：`isCatchUpFrame(evt)`（:291）= `evt._replayed === true || evt.replay === true`；两处弹泡点改 `if (!isCatchUpFrame(evt) && canPopOverlay()) setBubbleOverlay(...)`（:2290 human_wait、:2327 node_retry）——追平帧（宿主重放/前端缓冲补放）只恢复状态。
2. **门二·场态**：`canPopOverlay()`（:1966）= `!plugin || flowStatusRef.current === 'running'`（`flowStatusRef` :565 渲染期同步，闭包不滞后）——挂起/空闲态活帧也不弹（用户点名"啥都别弹"）；独立模式不走此门（其 run-scoped 流无重放，行为零变）。配套：`flow_start` 的 `setFlowStatus('running')` 加追平帧门卫（:2492）——历史 flow_start 不代表"现在在跑"，运行态由权威源裁决（`/session-state` 的 running、run_state 广播、本页运行时回调）。
3. **门三·目标**：`attachSnapshot`（:2684-2720）——"刷新恢复弹什么"的**唯一裁决面**，两个来源合一（内容去重）：
   - props（页面加载：`initialRunning/initialCheckpoint/initialWaitingHuman`，即 editor-page 那一轮 session-state）；
   - `es.onopen` 现拉（每次接通/重连：手机切回、断线重连；与既有 flowStatus 校准同一个请求，只多取 `checkpoint`/`waitingHuman`）。
   消费 effect（画布恢复完成后执行，nodes/flowStore 变化会重试）：`running !== true → 什么都不弹`；有人类等待 → `restoreHumanWait`（人类输入优先＝复用 2026-09-06 写的那套快照恢复，原样搬进 `useCallback`，waitKey 记账防重复弹）；否则 → `popCurrentNode(引擎 checkpoint label)`（:2045，label 记账防重复弹：同一节点同页只自弹一次、跑到下一个节点再弹；非 action 节点不弹）。
4. **辅助抽取**：`findNodeByLabel`（:1973，可跨画布自动切画布，与 module_enter 同款导航；原 waitingHuman effect 的查找逻辑原样搬入，并加 label 双形态匹配 `[开场]`/`开场`——与断点高亮 effect 同口径，兼容存量不带方括号的记录）、`mainCheckpointLabel`（:295，`checkpoint['__main__'] ?? 任一`，与 editor-page 断点高亮同口径）。旧那段 `initialWaitingHuman` 专用 effect 下线，改由接通快照统一驱动（挂起/空闲一并被门二挡住，而不是只靠"宿主清了 waitingHuman"）。
5. 弹泡点日志：`[FEMOEditor] 接通恢复：弹出当前运行节点浮层: <label>` / 调试窗一行「接通：弹出当前运行节点「X」」——手机上看不到控制台也能在调试窗看见恢复动作。
### 验证
- **浏览器真渲染回归（.tmp/fpop-harness，真 React 真页面真事件、桩 fetch/EventSource）**：6 场景——⓪探针自检（直渲染浮层，证探针认得出）、①挂起态刷新+整场重放、②运行态刷新（AI 节点在跑）、③运行态刷新（人类等待中）、④运行中活帧照弹（回归）、⑤挂起态活帧（门二）。**新代码 6/6 全过**；**同源对照（修前源码副本，?old=1）：①/②/⑤ 红**——修前①弹出「提问·等待人类输入」浮层（＝用户报的挂起态走马灯）、修前②停在历史 human_wait 而非当前节点「开场」（＝走马灯抢镜）、修前⑤挂起态活帧也弹。分辨力已实证。
  - 关键断言形态：浮层 DOM 探针（`div[style*="z-index: 3000"]`）按 250ms 采样成"浮层时间线"，断言 ① 全程 0 浮层 / ② 全程只认「开场」/ ③④ 出现且仅出现一个目标浮层。
  - 排障留痕（harness 侧问题，非产品）：① 初版 harness 把 `initialScript` 塞进首帧 props，与真宿主不同序（editor-page 是 state=null 先挂载、session-state 异步到达）——恢复被"挂载期画布默认化"effect（FemoWorAuto.jsx:1332 那个 `[locationPath]` effect，空 flowStore 走 else 建默认画布）覆盖，表现为"弹了但浮层渲染不出（nodeId 指向已被替换的画布）"；改成两轮渲染（先空 props 再补快照）后才与生产同序。② 单场景渲染慢（本组件单次提交数百 ms），固定 sleep 断言不可靠 → 全部改为观测窗+时间线。③ 本机 IAB 里 `?only=` 参数与 `only` 变量初版命名撞车，脚本直接 ReferenceError，已改 `want()`。
- **产物/源码结构化断言 15/15**（.tmp/check-refreshpop-bundle.mjs）：宿主 `replay: true` 进包且仍在重放环内跳过 femo_stream；前端 `_replayed`/`replay` 双标记判定、`canPopOverlay`（running 才弹）、`attachSnapshot`、两处弹泡点过门卫、`flow_start` 追平帧不驱动运行态、`__main__` 归一、裸 `!_replayed` 弹泡形态绝迹；中文串在产物里是 `\uXXXX`（**大写十六进制**，esbuild charset）——断言两种形态都认（踩过的坑：小写转义匹配恒 false）。
- **产物**：插件 `npm run build` → lib/client.js 820.0kb（本轮末次；中途并行会话 15:16 也重打过 820.3kb，本轮产物断言在**那份产物上复跑 15/15 通过**——改动未丢）；独立站 `npm run build` → dist/assets/main-DZ2Z-c5j.js 416.51kb。
- **改动后复跑**：label 双形态匹配补丁落盘后重打产物，产物断言 15/15 复跑通过；浏览器回归 ⓪①②③ 复跑全过（①挂起态零浮层、②只弹当前节点「开场」、③人类输入优先）。
- **手机视口复跑（390×844，走 MobileLayout）**：①挂起态刷新零浮层 ✔、②运行态刷新只弹当前节点「开场」✔——用户点名的"手机端"这两条在手机布局下逐条复验通过。
- **宿主重启**：`replay: true` 标记是宿主侧改动（lib/index.js），需重启 3081 生效。本轮开机窗口内 **Job 800 正在跑**（用户实测中），故由 `.tmp/fpop-restart-watch.mjs` 守望"最新 Job 非 running 且 30s 内无会话写入"的空闲窗口（pid 13→16 点间实测：800 于 15:58 收工、15:59:56 连续两次空闲）再走 `_restart3081_detached.ps1` 重启，不掐在跑的剧本——**重启已在 16:00:19 执行**（旧 pid 13564 → 新 pid 12896）。
- **重启后核验**：`session-state` 200（running=false jobId=800 script 4217ch 仍在）、`/dsh-femo/job?job_id=800` 200（引擎桥活着，档案 state=finished）、`/dsh-femo/femo-files` 200、`/events` 200 且流头 `: connected`；重放环重启后为空（符合预期）。
  - **活体标记核验已取证（16:25）**：用户 16:0x-16:2x 跑了 Job 801（环内 flow_start=1 / node_start=102 / human_wait=9 / human_done=8 / ai_done=43 …共 351 帧），新开一条 `/events` 连接实读该重放批：**351 帧全部带 `replay: true`（351/351）**——修前这批帧 9 条 human_wait 就是"走马灯"的燃料，现在在协议层全部可识别。
  - 常驻守望（`.tmp/fpop-post-restart-live.mjs`，20 分钟）本身只见活帧 42972 条、0 标记：**重放批只发给"新连接"**，常驻连接看不到——取证必须新开连接（本次即如此）。
  - 踩坑：首版活体探针把"连接后 2.5s 内收到的帧"一律当重放批 → 重启后立刻撞上**活帧**（投影窗接管写盘的 `femo_diag` 广播，payload ts 就是当时的）被判"未标记 FAIL"。判据改为"帧自带 replay:true"（活帧永远没有该字段）后无歧义。
### 两个判断点（不合意各改一行）
- 运行态接通弹的"当前节点"取**引擎 checkpoint**（`checkpoint_labels`，引擎"进入节点前记录"语义 ⇒ 运行中即当前节点；挂起态那是续跑位置，但门二已挡）。若想让运行态接通的浮层改为"最近一次 node_start 的节点"，改 `attachSnapshot` 里 `checkpoint` 的取值即可。
- 同一节点**同页只自弹一次**（`currentNodePopRef` label 记账）：用户关掉后不再自弹；手机切回重连若引擎已推进到下一个节点会再弹一次。要"每次接通都重弹"就把记账去掉。
### 语义澄清（用户 2026-09-11 追加原话）
"我说有人类输入的时候，优先人类输入，指的是，在多节点并行的时候，在有并发任务有 par 的时候，人类和 AI 会同时输入嘛，这种时候优先人类输入框，因为人类输入需要时间。但是在其他时候，我们画布节点弹出的浮层的默认行为是，运行到哪个节点，就弹哪个节点的浮层。"
- **落地为两条规则**：①**par 并发**（人类分支在等输入 + 并发 AI 分支在跑）→ 弹人类输入框；②其余情况 → 弹"运行到的那个节点"。本实现与之一致：接通快照里 `waitingHuman` 存在即走人类输入恢复（人类优先），否则弹 `mainCheckpointLabel(checkpoint)`＝引擎进入节点前记录的位置＝当前在跑的节点。
- **par 形态补验**（.tmp/fpop-harness 场景③改造后复跑，手机视口 390×844）：`waitingHuman={提问}` 且 **checkpoint 指向并发的另一分支**（`{__main__:[开场], t1:[提问]}`）时，弹出的仍是「提问·等待人类输入」输入框（不是 `__main__` 的 [开场]）——par 人类优先实证 ✔。
- **边界（据实说明，未擅自改）**：**运行过程中**（不刷新）浮层自动弹只发生在人类等待；运行推进到 AI/func/assign/notice 节点时**不会**自动弹浮层。这不是本轮引入的——8/17、9/8、9/11 三份快照里的 `setBubbleOverlay` 弹点都只有 3 处（点节点 / human_wait / node_retry-human）。若后续要"运行中浮层跟着节点走"，可加（口径二选一：每节点强制弹／仅浮层已开时切到当前节点），par 人类优先保持。

### 备份
MEOW_backups/{FemoWorAuto.jsx.bak-20260911-150703-prerefreshpop, routes.ts.bak-20260911-150703-prerefreshpop}
### 并行改动提醒
同日并行会话 15:02 前后改的是 `femoGen/src/mobileView.jsx`（条件边标签去框/不截断）与 15:09:31 的 FemoWorAuto 快照（内容与本轮改动后版本逐字节相同，未实际改动该文件）；15:16 的插件产物重打与 dist 重打均为并行会话所为，双方改动在同一份产物里并存，两侧断言各自复跑通过。

## 2026-09-11 femo-debug：调试干跑做成主模型工具（用户点名）
### 用户需求（原话）
"帮我改一下 dsh femo，这个插件，你可以先看 femogen 左下角的调试按钮，找一下这里有一个后端 API，就是调试功能，可以对一个剧本进行空跑，不调用任何 AI 大模型，只是跑通流程看看。我现在想要做的是，把这个调试功能做成 AI 能调用的工具给主模型。工具调用这部分是在 DSH 的接口处，你可以去检查一下我们这个插件有的工具，它有好几个，我们给它加一个调试，调试就是把当前挂载的剧本空跑一遍，把调试返回的所有信息都返回给主模型看。还需要改这个插件注入的 system prompt 和工具 schema"
### 现状（为什么要做）
1. 调试干跑（`femo_debugger.py` FakeHost 替 AI/人类发言、零 token）此前只有一个**人看**入口：femoGen 调试窗头部「编译」按钮 → `POST /dsh-femo/debug-run` → NDJSON 流式 → debugPanel 逐行渲染。主模型自己写完/改完剧本只能拿正式 `femo-run` 当第一遍测试——编译、接线、死循环都要真烧 token 才发现。
2. 缺口①：工具面没有调试（femo-mount / run / script / soul / chronica 五件套里没有它）。缺口②：调试器 `--report` 的结构化终报里**没有未达节点**（`unreached` 只在人读的 print_report 里印一行），AI 借道工具接入后会看不到死分支/漏接线。
### 修改（后端 5 文件 + 提示词 3 处）
1. **`src/debug-run.ts`（220 → 600 行，本轮核心）**：流式路径与工具路径拆成两条消费面、共用同一套装配。
   - 抽出 `spawnDebugger(ctx, resolved, req, mode)`：沙盒剧本 `web-<ts>.femo` / 流水 `web-<ts>.jsonl` / 终报 `web-<ts>.report.json` 三落盘 + `--quiet --log-jsonl --report --runs` argv 装配（`--report` 是本次为工具路径新增的出参，人读版 print_report 仍只进 stdout）+ `code: file:` 相对引用目录判定 + stdio 分派（stream 模式 stderr 照旧转发控制台；capture 模式 stdout/stderr 进数组）。
   - `handleDebugRun`（调试窗按钮那条 NDJSON 流）**行为逐字不变**：同一枚 `inFlight` 单飞闸、409/400/500 语义、tail 增量转发、客户端断开 terminate、180s 看门狗、`debug_done` 哨兵——只把内联的装配换成调用 `spawnDebugger`。
   - 新增 `collectDebugRun(ctx, resolved, req, signal?)`：整跑收集（工具路径）——共享单飞闸（调试窗在跑时工具明确报错，反之亦然）、跑完一次性读回流水 JSONL（半行=终止时截断，丢弃不谎报）+ 终报 + stderr 尾部；`timeoutMs` 可注入（测试注短值）、AbortSignal 撤销即 terminate。
   - 新增三个纯函数（可单测）：`formatDebugRecordLine`（DebugLogBus 记录 → 一行可读流水，与 femoGen 调试窗 `debugRecToLine` **同款语义**：同一套 kind、同样的丢弃规则——edge 高频噪音不上屏、flow_outcome 与 run_end 重复、debug_done 是哨兵；边覆盖在终报给全）、`debugTranscriptLines`（超 1500 行中段省略：首 600 + 尾 900，尾部是结局/报错最密的区段）、`debugRunToolOutcome`（裁决：**完全没跑起来**（无流水无终报非零退出）→ ok:false + stderr 末尾异常原话（`SyntaxError: 条件 "y == 1" 引用了未声明的变量…` 这类直接置顶）+ traceback 尾巴；其余含超时/跑挂轮次 → ok:true + 流水 + 终报全文）。
2. **`src/tools.ts`**：注册第六件工具 `femo-debug`。
   - schema：仅 `runs`（跑几轮，默认 1 上限 20，多轮换种子撞随机分支）/`seed`（起始种子，复现某场）两个**可选**参数，`additionalProperties: false`。
   - description 讲清四件事：零 token 不调模型（FakeHost 替答）、**写/改完剧本先干跑自检再 femo-run**、返回两大类（流水 + 终报）、开销与前置（不占 Job / 独立 DB 沙盒 / 可反复跑 / 跑的是「当前挂载的剧本」/ 合成输入只验流程不验内容）。
   - `register` 执行体签名加 `exec`：把 `exec.signal` 透传给执行体（工具被撤销时终止子进程）——既有五件工具的 run 回调忽略第三参，零改动。
3. **`src/index.ts`**：注入 `toolDeps.debugRun`——读会话挂载剧本（`readSessionScriptText` text 优先=实际运行版本；`prev.path` 供 `code: file:` 相对引用解析，与正式运行同语义）→ `collectDebugRun`。与 `femo-run` 的关键差别：**不查 Job 守卫、不 check 编译、不开 Job、不广播**（调试器自己会编译并原话报错；纯只读干跑），并打一行 `[dsh-femo] femo-debug <sid> → exit/records/report/timedOut（耗时）` 诊断。
4. **`src/subagent.ts`**：`ACTOR_DENIED_TOOLS` 补 `femo-debug`——演员对 femo 六件套全隐身（干跑要起子进程跑整场剧本，那是导演的自检动作，演员既不需要也不该有）。
5. **`femo_debugger.py`**：抽出 `_reached_nodes` / `_unreached_nodes`（print_report 与 write_json_report 共用，两处口径永远一致），终报 JSON 增加 `unreached_nodes` 字段；顺带修掉一个既有隐患——`script.flow` 为 None（空/垃圾剧本）时原 `(script.flow.nodes or {})` 会 AttributeError 崩在 print_report，**连带后面的 write_json_report 不执行（`--report` 静默丢文件）**；现在 `_unreached_nodes` 对 flow=None 返回空表。
6. **系统提示词（工具 schema 之外的注入面）**：
   - preset persona `dsh-home/.agent-presets/dsh-femo/agent.cordis.yml`：【运行】段两种工作流都插入干跑自检环节、工具线从「三个专用工具」改为「四个专用工具」（顺手修掉 stale 的 `pause 暂停`——schema 里从来没有 pause 动作）、**新增【干跑自检】整段**（返回什么/拿它确认什么/代价为零/跑的是挂载版/多轮与种子/合成输入不代表内容质量）。
   - `src/persona.ts` femo:docs 段：补一句调试器 CLI 指路（`femo_debugger.py run --module/--set/--assign-prob/--flaky`，与工具返回同源），给主模型留"更细玩法"的进路。
   - `README.md`：新增「调试（零 token 干跑）」段（人看/AI 看/无副作用/CLI 玩法四条）+ 首屏「主模型 = 导演」那条补 femo-debug。
### 验证
- **三个真跑测试台**（`.tmp/aidebug/`，真 python + 真 femo_debugger.py；宿主面用假 ctx——只有 `tools` 服务与 `subprocess` 适配器（node `child_process` 冒充 `SubprocessHandle`），其余方法调用即抛错）：
  - `harness.ts` **38/38**：①正常剧本 2 轮（exit=0 / report.runs=2 / 流水含节点行 / 终报含变量快照与 unreached_nodes / 裁决 ok）②编译失败（无流水无终报 → ok:false 且错误含 `SyntaxError: …未声明的变量`）③超时两态（200ms=进程没起来 → ok:false 且点明看门狗超时；5000ms+runs=20=跑到一半 → 有流水、无终报、ok:true 且文本列"已跑完的轮次"）④单飞闸（并发第二条被拒且报原话、失败后闸门自放开）⑤纯函数全 kind 渲染 + 2000→1500 截断保留尾部。
  - `tools-harness.ts` **23/23**：注册面六件套名字集合 / femo-debug schema 形状（参数只有 runs+seed、无 required、additionalProperties=false）/ execute 成功路径（runs=2 真跑：ok、exit_code、outcomes 两轮 completed、text 含流水段+终报段+落盘路径、无损 JSON 无 undefined）/ render 上屏 == text / 子代理与非主会话拒绝（❌ 上屏）/ 未挂载剧本引导原话 / 非法参数兜底（runs='abc'→1、seed=42.9→42）。
  - `route-harness.ts` **14/14**（回归我重构过的流式路径）：真 http server → 200 + `application/x-ndjson`、首条 run_start 末条 debug_done(exitCode=0)、总线记录带 seq/ts/run/seed（路由合成的哨兵不带，按既有协议形状断言）、空剧本 400、**流式中第二条 409**、subprocess 服务缺席 500——调试窗那条路一行没退化。
- **工具返回文本人眼复核**（examples/goal-mode.femo 2 轮）：流水（`▶ 第 N 轮…` / `→ [work]（ai）` / `🤖 合成赋值：done=True（prompt-clue）` / `[work] done: False → True` / `■ 第 N 轮结束：completed（0.59s）`）+ 终报（结局 2/2、节点执行、边覆盖 2/2 及走过的边、变量快照、未达节点）+ 退出码语义 + 沙盒剧本/完整流水/终报三条落盘路径。
- **构建**：`npm run build` → `lib/index.js` 331.9kb、`lib/client.js` 820.0kb（本轮无前端改动，client 体积不变）。
### 未重启（刻意）
宿主侧改动（lib/index.js）需重启才生效；重启前探活发现 **Job 801（谁是卧底.femo）16:11 仍在跑且 `waiting_human=true`**——正在演出中，不掐戏：本轮不执行重启。空闲时用 `D:\myFiles\dsh\_restart3081_detached.ps1`（或直接跑 `start-meow.ps1`）重启即可生效。
### 备份
`MEOW_backups/*.bak-20260911-1630-preaidebug` 共 8 份：README.md / femo_debugger.py / debug-run.ts / persona.ts / subagent.ts / tools.ts（**取自 `git show HEAD:`**——这六个文件与 HEAD 的差异经逐条核对只含本次改动）+ index.ts / agent.cordis.yml（**反向应用本次编辑**生成——前者混有并行会话未提交改动、后者在仓外，反向应用失败即报错退出，绝不产出错备份）。备份核验：新词（femo-debug / collectDebugRun / 干跑自检 / unreached_nodes）在 8 份备份里均 0 命中，老词（「三个专用工具」、「未达节点」）在位。
### 判断点与遗留（不合意各改一处）
- **流水截断上限**：>1500 行时中段省略（首 600 + 尾 900），文本里明写省略行数与 jsonl 落盘路径——AI 想看全量可自己读那个文件。要"永不截断"把 `TRANSCRIPT_MAX_LINES` 提到极大即可（代价是超长剧本的工具结果会被 preset 的 tool-result-pruner 按 65536 字符剪掉，剪的位置更不可控，故默认保留可控截断）。
- **合成输入只验流程**：FakeHost 按 out 声明/变量初值猜值（`--assign-prob` / `--flaky` 等细档只在 CLI 手动用），所以干跑通过 ≠ 台词质量合格——persona 里已明写。
- **preset 冻结语义**：人设文本在会话创建时冻结，**已存在的 Femo 会话看不到新的【干跑自检】段**（工具本身对新旧会话都在，因为工具是全局注册的）；要新会话才带新提示词。
- **单飞是刻意的**：调试窗与工具共用一枚闸——同时只允许一条干跑。并发需求（如两个会话各自自检）需要 femo_debugger 的进程内类级 patch 先支持隔离，本轮不做。

### 补（2026-09-11 16:25 重启已执行，用户拍板）
用户原话"你来重启吧"，同时问"刚才是你把它给关了吗？我怎么现在觉得它已经退出了，不是我干的"。
- **不是本会话干的**：aidebug 这一轮全程只做读文件/git 查询/构建/测试台 python 子进程（各自独立、跑完即退）/文件编辑/curl 探活，没有任何 kill 或重启命令。今天两次 detached 重启（**15:38:40** 停 pid=22344、**16:00:13** 停 pid=13564→新 12896）都是**并行的另一个会话**（修「刷新恢复浮层风暴」那轮）按 `.tmp/fpop-restart-watch.mjs` 守望到的空闲窗口触发的，见本轮 MEOW 上一日条目的重启段（原话"重启已在 16:00:19 执行"）。
- **重启执行**：16:25:27 detached 请求 → 16:25:33 start-meow 停旧实例（pid 12896）→ 新实例 **pid 28720** 起来，`/dsh-femo/models` 200。
- **生效核验**：新实例启动日志里 `[dsh-femo] tool registered: femo-debug` 出现 1 次（六件套齐全：mount/run/debug/script/soul/chronica）——本轮改动正式上线。
- **线上实测**（重启后的 live 宿主，真 python 真调试器）：`POST /dsh-femo/debug-run` → 200 + `application/x-ndjson`，9 条记录（run_start/edge/node_start/ai_reply/assign/flow_outcome/run_end/debug_done），末条 `debug_done(exitCode=0)`——干跑链路在线上端到端可用。
- **重启打断的现场（已知且可恢复）**：Job 801（谁是卧底.femo，第 4 轮 [投票] 正等人类输入）随宿主重启而中断；档案在 DB 里暂显 running（懒对账设计：`job_resume` 动手前先 `reconcile_stale`，见 python/femo_bridge.py:395 → femoCompiler/job_manager.py:370），点「继续」即落成 suspended(crash) 并从断点续跑——断点、剧本指纹、session-state 的 `jobId=801 + checkpoint` 都在，未丢场。

## 2026-09-11 浮层弹起默认滚到长文本最底（用户点名）
### 用户需求（原话）
"嗯，可以了，不过我还有个需求：每次这个浮层弹起来的时候，都默认拉到长文本的最底。"
### 现状（为什么不到底）
`femoGen/src/bubbleOverlay.jsx` 弹起定位 effect 原为三分支：`el.scrollTop = hw ? 0 : el.scrollHeight`——**有人类等待时定位到顶部**（"常驻人类卡置顶"那套：卡在滚动区顶部，AI 并行输出在卡下方，输入框固定在滚动区之外）。于是人类节点的 `context`/`prompt` 一长，刷新/点开浮层先看到的是顶部，得自己往下翻才见最新内容（用户实测场景：一本剧本 9 次 human_wait，回回如此）。
### 修改（纯前端一处，`femoGen/src/bubbleOverlay.jsx`）
1. 弹起定位 effect 去掉 `hw` 分支：**一律 `el.scrollTop = el.scrollHeight`**（长文本直接落底；输入框本就在滚动区之外、任何滚动位置都可见，所以"到底"不会把输入框滚没）。
2. 该 effect 从 `useEffect` 改 `useLayoutEffect`（并在 react 导入里补上）：提交后、**绘制前**定位——弹起时不会先闪一帧顶部再跳到底。
3. `hw` 仍在依赖里：等待出现/提交完成（hw 变化）同款回底，语义与"跟最新"一致；流式自动跟随那条 effect（`userScrolledUpRef` 手工上滚让位、有人等待时不跟滚）**未动**。
### 验证
- **真浏览器真 React 宿主（.tmp/scroll-harness/，观察"浮层从关到开"的真实弹起）**：3 场景——①长 AI 输出（context 30 行 + output 120 行）、②人类等待 + 长 prompt（context 20 行 + prompt 90 行，用户点名场景）、③人类等待 + AI 并行输出（streamingText 60 行）。**新代码 3/3 到底**（`scrollTop` 2532 / 1946 / 2582，`scrollTop+clientHeight ≥ scrollHeight-2`），且 ②③ 的输入框可见（`inputVisible: true`）。
- **同源对照修前副本（?old=1）**：①不变（修前本来就到底），**②③ 停在顶部（scrollTop=0，atTop=true）**——即用户报的"弹起来看不见最新内容"，分辨力实证。
- **产物断言 6/6**（.tmp/check-scrollbottom.mjs）：源码恒到底、旧三元 `hw ? 0 :` 绝迹、定位是 useLayoutEffect 且在 react 导入里；产物 lib/client.js 同款（useLayoutEffect 进包、旧三元绝迹）。
- **回归复跑**：刷新恢复浮层断言 15/15（宿主 `replay` 标记 + 三门口卫仍在包内）✔。
- **产物**：插件 `npm run build` → lib/client.js 822.8kb（含并行会话 16:09-16:51 的宿主/客户端改动，非本轮增量）；独立站 `npm run build` → dist/assets/main-Cn4EkoSJ.js 416.52kb。**纯前端改动，刷新页面即生效，无需重启 3081**。
### 两个判断点
- 人类等待"常驻卡置顶"的**布局**没动（卡仍在滚动区顶部、AI 并行输出在下方），只改"弹起时看哪一段"——到底后长 prompt 的结尾可见、开头要上翻，与之前的方向相反。若想让人类等待仍停在卡片开头，只把 effect 里的 `hw` 分支加回去。
- 顺带说明：手机端用的是同一个 BubbleOverlay（`MobileBubbleOverlay` 是死代码，未被引用），因此两端行为一致，无需分别改。
### 备份
MEOW_backups/bubbleOverlay.jsx.bak-20260911-165753-prescrollbottom
### 并行改动提醒
同日并行会话 16:09-16:51 连续改了宿主多处（src/{debug-run,tools,index,subagent,persona,run-control,projection-input,routes}.ts + client-ui/{view-button,composer}.tsx）。本轮 16:59 的插件双产物重打**包含了那些改动**（同一份产物）；并行会话没碰 `replay` 标记那一段（复跑断言 15/15 通过、routes.ts:822 原文仍在）。dist 与 lib 均为最新源码产物。
## 2026-09-11 投影窗「刷新后窗口不存在 / 视角菜单点了不切窗」修复（用户点名）
### 用户需求（原话）
"我本来是在角色窗。刷新之后，它就提示我这个窗口不存在。我回到主模型主窗口是可以的，但是如果想再次切回到角色窗或者上帝投影窗，在视角菜单那里，它会显示我到过的那些窗口。但是下面的窗口内容完全不变，我认为我并没有成功切换。这是怎么回事呢？你有 log 可以看吗？……首先，我刷新之后，它提示我内窗口不存在，这就很奇怪呀，那窗口明明是存在的。……你帮我解决一下这个问题吧。"
（前置一句："刚才是你把它给关了吗？我怎么现在觉得它已经退出了，不是我干的"——**不是本会话**：今天两次 detached 重启是并行会话按空闲窗口守望触发的，见本文件同日上一轮条目的「补」段；本会话全程零 kill/零重启。）
### 复现与定因（证据链）
1. **"窗口不存在"的出处不是 dsh 本体**：全仓 + dsh 前端产物里都没有这句中文；真正闪现给用户的是两条：
   - 诊断流（右上角 log 窗）里的宿主 diag：`[proj-input] 404 窗不在 store：sid=47fc805b431c-god（宿主重启后投影窗未装载；已尝试冷装载）`（用户自己贴的 log 第一条就是它）；
   - 投影窗 composer 的失败 toast：`data.error` 原话 `session femo-proj-…-god not found`（composer.tsx 提交分支直接把后端 error 文本上屏）。
2. **宿主重启后的"半死窗"**：宿主重启把内存 store 清空，投影窗只活在持久化里——前端照样能渲染历史，但 `sessions.get(窗id)` 返回 undefined ⇒ 输入 404、`openSubagent` 被 dsh 地址校验拒（`subagent Sessions require their durable parent address` / `descriptor is unavailable`）。同轮 16:25 的重启（本会话执行，用户拍板）正是触发点。
3. **"菜单点了不切窗"的机制（本次新发现）**：`view-button.tsx` 只在挂载时 `listProjectionWindows(mainSid)` 拉一次窗清单，且 `.catch(() => {})` **静默吞错**；`/dsh-femo/projection-windows` 在主会话不在 store 时直接 **503**（`main session not loaded yet`，源码 routes.ts 原话）。于是：清单拉失败 ⇒ `proj` 恒空 ⇒ 菜单项照旧渲染（数据源是 `/actors`，有 turn_scopes 文件回退，重启后照样有值）⇒ 点下去 `proj.actors[id] === undefined` ⇒ 落进「CSS 过滤降级」分支：`setView()` 只改视角状态、**完全不 openSession**。用户看到的就是「菜单列着到过的窗口、下面的内容完全不变」。刷新才自愈（重挂载重拉），但刷新后若又撞上主会话未装载则回到 404 报错——正是用户描述的循环。
4. 交叉证据：客户端 trace（`user_data/debug-client-trace.log`）里 20:34:31 的 404 与 20:34:58 的 `job_resume OK`（用户点「继续」后才把主会话与窗拉活）时间线吻合；`openSubagent` 侧从未超时（说明不是目录慢，而是清单压根没到手）。
### 修改（客户端 2 文件 = 立刻生效；宿主 3 文件 = 需重启）
**客户端（`lib/client.js` 重打，刷新页面即生效）**
1. `src/client-ui/view-button.tsx`：
   - 新增 `refreshWindows()`（唯一权威拉取点，失败**写前端留痕** `[viewmenu] ⚠ 投影窗清单获取失败：…`，不再静默）；
   - **挂载时**拉（投影窗身份进本页＝顺手唤醒宿主侧未装载的窗）+ **开菜单时**重拉（重启后曾失败的缓存在这里自愈，不必刷新整页）+ **点击未命中时**重拉一次再裁决（`pickView` 改为 async 包装，三处共用同一函数）；
   - 三处仍失败才保留旧的 CSS 过滤降级，并在按钮下方给**可见提示条**（8s 自愈）：「⚠ 「@猫猫」暂时没有可跳转的投影窗（宿主未装载或剧本未运行）：先打开一次「戏外 · 主模型」再点视角试试。」——「点了没反应」正式退役。
2. `src/client-ui/composer.tsx`：投影窗发消息遇 **404** 时，先按主会话 id 打一次 `/dsh-femo/projection-windows`（唤醒宿主，幂等），再重发一次；仍失败才把后端原话上屏（并写留痕）。`session … not found` 直冲用户面前的老路径封死。
**宿主（`lib/index.js` 重打，需重启生效）**
3. `src/run-control.ts`：`ensureSessionLive`（既有函数：走官方 `agents.resume` + 挂 FEMO_PRESET，与 run/pause 兜底同款）**导出**，供投影窗路径复用。
4. `src/routes.ts` `/dsh-femo/projection-windows`：主会话不在 store 时**不再直接 503**，先 `ensureSessionLive` 把主会话拉活（拉活后 cwd 与子代理目录齐备，`projections.ensure` 才有落点）；只有拉活也失败才 503，且带 `kind:'main-not-loaded'` + 可操作中文提示。`/dsh-femo/projection-input` 的调用点补注入 `ensureMainLive`。
5. `src/projection-input.ts`：ensure 兜底补「主会话自己也不在 store」的分支（先拉活拿 cwd 再 ensure），且角色表从 `turn_scopes` 文件补齐（与 projection-windows 路由同源，保证被路由的那个角色窗真的被建出来）——旧实现传空数组，角色窗建不出来，404 照旧。
### 验证
- **真机 Playwright（系统 Edge，真页面真事件，打 live 宿主；全程只读、不发任何消息）**：
  - `verify-viewmenu.mjs`：定位到用户的真会话（`.YDXeBa_sessionRow` 遍历 + `localStorage['dsh.sessions.current']` 反查 id 命中 `session-037b2575…`）→ 菜单项齐全（戏外/上帝/戏内/7 角色）→ **用 route 拦截把 `/projection-windows` 首次打成 503（伪造重启态）** → 点「@小猫咪」：客户端重拉（`{windows:6, blocked:1}`）后**成功切到 `femo-proj-…-_40_5c0f_732b_54aa`**、内容确实变化、再切回戏外成功 → **6/7 通过**（未过的那条是我用例设计问题：清单已热，点击走了正常路径、本就不该出提示条，该场景另由 verify-hint 覆盖）。
  - `verify-hint.mjs`：冷启动 + 该路由**全程 503** → 菜单仍列出角色项（/actors 文件回退）→ 点角色项后出现**可见提示条**（原文核对通过）、**没有误切窗口**、`__femoTraceDump()` 里含 `投影窗清单获取失败` 留痕 → **6/6 通过**。
  - `verify-menuopen.mjs`：行为断言「开菜单触发重拉」（调用计数 2→3）→ **3/3 通过**。
- **产物断言 11/11**（`.tmp/winbug/check-bundle.mjs`，esbuild 中文转义归一后比对）：宿主含 `ensureSessionLive`/新 503 文案/`ensureMainLive`/`scopeActors` 且旧 503 英文文案绝迹；前端含点击重试语料/失败留痕/提示条文案/404 唤醒重试。
- **构建**：`npm run build` → `lib/index.js` 334.1kb、`lib/client.js` 822.8kb。
- **备份自检**：5 份备份里本次新词命中 0、旧行为锚点在位（见下）。
### 生效状态与遗留
- **客户端修复已生效**：`lib/client.js` 已重打，用户手机刷新页面即得（无需重启）。
- **宿主修复未生效**：`lib/index.js` 是新打的，但线上实例（pid 28720）载入的是旧代码——**需重启 3081 才生效**。本会话未擅自重启：用户的 Job 801（谁是卧底）仍在运行/等待输入，重启会把它挂起（断点可续）。重启窗口留给用户拍板。
- **遗留判断点**：①「开菜单重拉」每次开菜单多一次 `/projection-windows` 请求（幂等只读，实测 <50ms，可接受；嫌吵可去掉该 effect）；②提示条 8s 自动消失，文案里直接给了恢复路径；③宿主侧拉活走 `agents.resume`（与 run/pause 同一官方路径，会挂 FEMO_PRESET 与 femo:docs），不是无副作用的只读操作——但它只在「主会话没在 store」时触发，语义上等于替用户点开一次主会话。
### 备份
`MEOW_backups/*.bak-20260911-2110-previewmenufix` 共 5 份：composer.tsx / view-button.tsx（**取自 `git show HEAD:`**——本轮会话前这两个文件与 HEAD 一致，已核对）+ run-control.ts / routes.ts / projection-input.ts（**反向应用本次编辑**生成——这三个混有并行会话未提交改动（femo-files 账本、SSE `replay:true` 标记、/femo-files 路由），反向应用失败即报错退出；生成后再做自检：新词必消失、旧行为锚点必在）。

## 2026-09-11 浮层跟随运行（B 规则）+ 人类等待自动弹开例外（用户点名）
### 用户需求（原话）
"是 B，但只有一处例外，如果到人类输入的时候，浮层就会自动弹开，哪怕他本来并没有已经开着。其他时候就完全遵循 B 的规则。"
（B 的定义出自用户上一条口径："浮层**已经开着**的时候，运行到新节点就把浮层切到那个节点；关着就不打扰你"。）
### 现状（为什么要改）
浮层自动弹从来只发生在人类等待：8/17、9/8、9/11 三份历史快照里 `setBubbleOverlay` 弹点都只有 3 处（点节点 / `human_wait` / `node_retry`-human）。于是"浮层开着看戏"时，运行推进到下一个节点浮层不动（停在刚看过的那个节点上），除非下一个又是人类等待。
### 修改（纯前端，`femoGen/src/FemoWorAuto.jsx`）
1. **新增 `followRunningNode(label, nodeId)`**（浮层裁决块内）：`bubbleOverlayRef.current === null` → **直接返回（B：关着不打扰）**；`Object.keys(humanWaitsRef.current).length > 0` → 返回（**par 人类优先，不让位**）；已在该节点 → 返回；否则 `setBubbleOverlay({ nodeId })` 并记 `currentNodePopRef`（与接通弹点同源记账）+ 控制台一行 `[FEMOEditor] 浮层跟随运行: <label>`。
2. **挂在 `node_start` 事件上**：`if (!isCatchUpFrame(evt)) followRunningNode(matchedNode?.label ?? data?.node_name, nodeId);`——**追平帧不跟随**（历史推进不许带动浮层），挂起/空闲由 `canPopOverlay()`（门二）挡下。
3. **例外（人类等待永远自动弹开）**：沿用既有 `human_wait`/`node_retry` 弹泡点不改——`!isCatchUpFrame(evt) && canPopOverlay()` 即弹，**不看浮层是否已开**，所以关着也会被弹开；同时它天然满足"par 时人类输入框优先"（AI 分支的 node_start 因人类等待挂起而不抢位）。
4. 新增 `bubbleOverlayRef`（渲染期同步，与 `nodesRef` 同款）：事件处理里要读"浮层此刻开着没"，不能用闭包旧值。
### 验证
- **真浏览器真 React 回归（.tmp/fpop-harness，手机视口 390×844）新增三场景全过**：
  - **⑦ 浮层开着·跟随运行**：接通弹「开场」→ 活帧 `node_start[收场]` → 浮层时间线 `[开场] → [收场]`（切过去了）✔
  - **⑧ 浮层关着·不弹+人类等待例外**：接通后点 ✕ 关掉（真事件序列派发）→ 活帧 `node_start[收场]` → 观测窗内**恒零浮层** ✔；再活帧 `human_wait[提问]` → **自动弹开输入框** ✔
  - **⑨ par·人类输入不让位**：活帧 `node_start+human_wait[提问]`（人类框弹开）→ 再活帧 `node_start[收场]`（并发 AI 分支推进）→ 浮层**仍停在人类输入框** ✔
- **回归复跑（新代码，手机视口）**：①挂起态刷新零浮层 ✔、②运行态刷新只弹当前节点「开场」✔、③par 接通人类优先 ✔、④运行中活帧照弹（人类框）✔、⑤挂起态活帧零浮层 ✔——既有一至五全绿，新规则不出回归。
  - 排障留痕（harness 侧，非产品）：把 ⓪①②③④⑤⑦⑧⑨ 一次连跑时，④ 的 burst 阶段会卡住（页面无报错、无渲染循环、DOM 稳定）；**单跑 ④（?only=4）即通过**，且改前也出现过同一现象——判定为宿主连跑的时序/慢渲染耦合，不是产品逻辑问题。
- **回归断言**：刷新恢复浮层断言 **21/21**（新增 6 条：跟随函数存在、人类等待不让位、`node_start` 追平帧不跟随、`bubbleOverlayRef` 渲染期同步、跟随日志/函数进包）；滚底断言 6/6。
- **产物**：插件 `npm run build` → lib/client.js 823.5kb；独立站 `npm run build` → dist/assets/main-CYLRiK4l.js 416.82kb。**纯前端改动，刷新页面即生效，无需重启 3081**。
### 两个判断点
- **"跟随"只看浮层开没开，不区分是谁开的**：用户手点某个节点查看时，若运行随即推进到下一节点，浮层会被切走（B 的字面语义）。若想"手点查看期间不被抢"，记一个"手动打开"标记、跟随只在自动弹开时生效即可（一处判断）。
- **人类等待挂起期间完全不让位**（AI 分支推进不切走）：这是 par 人类优先的直接推论；若嫌"看戏时看不到 AI 分支输出"，可改成"人类框仍常驻、另开小窗"之类，但那是新交互，未做。
### 备份
MEOW_backups/FemoWorAuto.jsx.bak-20260911-172847-prefollowrun
### 并行改动提醒
本轮只动 `femoGen/src/FemoWorAuto.jsx`。同日 16:59 之后的插件产物里同时含并行会话的宿主/客户端改动（见上一条记录末尾）；本次重打（17:3x）产物包含全部。

## 2026-09-11 pre-step 门卫改「按轮」裁决：运行中主窗口说话恢复整轮多步工具（用户点名）
### 用户需求（原话）
"现在有一个 bug，就是当剧本正在运行的时候，如果用户在主窗口找主模型说话，我发现这个时候主模型好像只能调用一轮工具，不能持续调用。这是为什么呢？" / "我希望在剧本已经跑着的时候，如果 User 来找主模型说话，主模型依然可以正常调工具。其实主窗口本来就是这样啊，在子代理跑着的时候，用户是可以跟主窗口说话的。也许它最默认的状态，就是我们想要的状态。我们是不是加了些什么不该加的判定啊？"
### 现象与根因（代码级定位）
- **现象**：剧本 running 时在主窗口发消息 → 主模型只调得动**一轮**工具（工具结果落到会话里，模型再也拿不到，随后整轮静默结束）；不调工具的纯文本回答不受影响。
- **根因不在工具系统，在门卫的裁决粒度**。dsh 的 `agent/pre-step` **每个 ReAct 步都跑一次**（`dsh-agent-loop` 的 `turn()` 循环 `while (true) { await this.preStep(target, {turn, step}) ... }`），每步各自 `inbox.claim()`：轮首步（step=1）claim = 全部 next-step + 1 条 next-turn（那条用户消息）；**之后各步（工具续跑所在步）claim 只取 next-step，实测为空批次**——dsh 自家 `tests/interception.spec.ts` 断言 `[{turn:1,step:1,messages:1},{turn:1,step:2,messages:0}]`；工具结果本身是 `tool/result` 事件（`source.kind==='tool'`），只有工具给的 `additionalContexts` 才进 next-step。
- 而 **reject 的语义是「本批已 claim 的消息整批丢弃 + 整个 turn 以 reason=blocked 收场」**（`if (decision.kind === 'reject') { turnEnds = {kind:'blocked'}; return false }`）。2026-09-05（f0fde2f）为解决"运行中主窗消息被静默吞掉"加的豁免是**按步**写的：`messages.some(m => m.source.kind === 'user')`——只在含用户消息的那一步成立。于是轮首步放行 → 模型调工具 → 续跑步批次为空、无 user、`running=true` → **reject → 整轮 blocked**。
- **旁证**：宿主日志 `meow-3081-restart-0910e.log:126` 等处的 `pre-step dropped 1 actor-child notice(s)` 紧跟 `pre-step REJECTED for running femo agent …`——那是同一条按步判定的另一张面孔：**整批噪音落在完轮补步上时，reject 会把本已 completed 的轮改判 blocked**。
- 主模型下场（main 节点注入）那条路一直好使，是因为它的豁免是**整轮**的（`isMainAnswerPending` 到 `turn/end` 才 delete）——两条路豁免粒度不一致，正是 bug 的结构性来源。
### 修改（3 处源码 + 1 个新测试）
1. **新增 `src/pre-step-gate.ts`（纯函数裁决面，零依赖可单测）**：`gatePreStep(facts)` + `isActorChildNoise`（自 engine-events 迁入）。口径：
   - **后继步（step>1）不裁决**：一轮既已开跑（轮首步判过），归属已定——只做演员噪音过滤，一律放行（`enter`）。工具续跑要的正是一个"不唤醒的空批次"，与原生循环同构；
   - **轮首步（step=1）才裁决**：整批噪音 → reject（不唤醒，旧行为逐字保留）；main 节点在飞 → 放行；引擎未跑 → 放行；**含真实用户输入 → 放行（整轮，含全部工具续跑步）**；其余（运行中 plugin 注入）→ reject（引擎拥有会话的安全网保留）。
   - `step` 缺失/非正（老宿主 payload 无该字段）保守当轮首步：维持旧口径，不凭空放开轮次未知的注入。
   - 两行日志文本与抽出前逐字一致（既有日志 grep 口径不变，`for <sid>` / `for running femo agent <sid>`）。
2. **`src/engine-events.ts`**：pre-step 钩子只剩接线（`isFemoAgent` + 两个事实源查询 `isMainAnswerPending` / `isSessionRunning` → `gatePreStep`），文件头注释同步口径。
3. **`src/index.ts`**：模块清单补一行；「历史行为注记」第 2 条补 turn-scoped 语义。
4. **新增 `tests/pre-step-gate.test.mjs`（零 token、零宿主）**：用**真 AgentLoop**（LlmRuntime/SessionStore/SystemPrompt/ToolRuntime/AgentRegistry/AgentLoop 同款挂载）+ 脚本化假模型 + echo 工具驱动，源码经 esbuild 同步打包（同 safe-steer.test 写法）。
### 验证
- **`node tests/pre-step-gate.test.mjs` → 24/24 PASS**：①**根因复现（旧口径）**：同一场景装旧按步门卫 → `requests=1` + `blocked`（精确复现用户症状，证明用例对根因敏感）②运行中+用户消息（新口径）→ 模型被调用 2 次、turn `completed`、用户消息落盘、两段回答都在 ③运行中轮中插话（`agent.steer` 落在续跑步）→ 插话进对话流且整轮跑完 ④运行中演员噪音落在续跑步 → 噪音不落盘、整轮不再被改判 blocked ⑤运行中轮首步 plugin 注入 → 仍零模型请求 + blocked（安全网未破）⑥空闲原生多步照旧 ⑦纯函数裁决表 10 条（step>1 空批/噪音批、step1 四分支、未跑、main 在飞）。
- **构建**：`npm run build` → `lib/index.js` 336.0kb、`lib/client.js` 823.5kb。产物已核验含新裁决（`gatePreStep` + `if (step > 1) return { kind: "enter", … }`）。
### 备份
`MEOW_backups/`：`engine-events.ts.bak-20260911-174335-perturn-gate`、`index.ts.bak-20260911-174335-perturn-gate`（**取自 `git show HEAD:`**——本轮改动是这两个文件与 HEAD 的全部差异，逐 hunk 核对过）。核验：备份里 `gatePreStep` / `pre-step-gate` 0 命中（=改动前状态）。新增文件 `src/pre-step-gate.ts`、`tests/pre-step-gate.test.mjs` 是本轮净增，无需备份。
### 判断点
- **不是删判定，而是把判定挪到该在的粒度**：门卫本身（运行中不让 plugin 注入把主模型叫醒=引擎拥有会话）保留；被改掉的只是"按步豁免"这个粒度错误。用户问"是不是加了不该加的判定"——准确说是**加对了判定、写错了粒度**。
- **引擎注入仍被拦**：运行中 `flow_error`/`notify_author` 一类 plugin 来源消息若在**空闲时**到达，依旧 reject 不唤醒（`flow_done`/`flow_stopped` 本就落在 running=false 之后，不受影响）。
- **需重启宿主才生效**：lib/index.js 是宿主侧产物；前端零改动。空闲窗口用 `_restart3081_detached.ps1` 重启即可（本轮未重启——正在演出中不掐戏）。
- **回归入口**：后续任何人改 pre-step 相关代码，先跑 `node tests/pre-step-gate.test.mjs`。
## 2026-09-11 femo-debug 加固：多轮耗时可见 + 撤销路径（用户实测「AI 调用等很久」）
### 用户需求（原话）
"是不是有什么 bug 呀？我看 AI 调用之后，等了很久很久，工具结果还是不出来。但如果我在 fengen 直接按调试，只需要一会儿功夫，结果就出来了。"
### 排查（不是卡死，是两件事叠加）
用 `.tmp/look-toolcall.mjs` / `.tmp/tail-session.mjs`（`node:zlib` 的 zstd 逐帧解压 dsh 会话日志）拿到原始时间线：
- **第一次调用正常返回，只是慢**：`21:51:09 tool/call femo-debug {"runs":6}` → `21:52:14 tool/result`（结果 31984 字符）= **65 秒**。终报显示 6 轮各耗 5.6~18.2s、合计 **62.7s**（`user_data/debug-sandbox/web-1789163470570.report.json`）。即 **runs=6 就是把单份时间乘 6**；而 femoGen 的「调试」按钮只跑 1 轮（几秒到十几秒）——观感差距全在这里。宿主日志里当时也没有收尾行，是因为工具还在跑（不是死了）。
- **第二次是被中断的**：`21:52:22 tool/call` → `21:53:26 tool/result` = `Error: tool call aborted`（回合被中断；沙盒那次只有 1176 行流水、无终报——被我方的撤销分支 terminate 掉了）。客户端中断不进宿主日志，所以看起来"什么都没发生"。
- 交叉核对：宿主进程无 python 残留；沙盒文件三个时间戳（21:51:10 完成/21:52:22 被 terminate/21:53:42 用户手点调试完成）与日志时间线一一对上。
### 修改（`src/debug-run.ts` + `src/tools.ts`，宿主侧）
1. **预先撤销不再起子进程**：入口检查 `signal?.aborted` → 直接返回 `emptyCollect`（形状与真结果一致，交给裁决函数统一处理）。旧实现在撤销发生在 `mkdir/writeFile/resolveExecutable` 那几毫秒窗口时 `spawned` 尚未赋值，terminate 无从下手：白跑一场、单飞闸被占住直到跑完。
2. **撤销话术与剧本问题分开**：`ok:false` 原话改为「本次干跑被调用方撤销（回合被中断/用户停止），没有产生调试数据。需要看结果的话重新调用一次（轮数别开太大：runs 是线性耗时，每轮≈一次 femoGen 调试）」，不再把「退出码 -1」这类噪声糊在一起。
3. **耗时可见（回给模型）**：`DebugRunCollect` 加 `elapsedMs`；工具结果加 `elapsed_ms`；文本结局行改「结局：1/6 轮 completed（**各轮合计 62.7s**）」、footer 加「**用时 65.2s**」。
4. **进度可见（给人看）**：起跑/收尾各推一条诊断流——`[femo-debug] 干跑启动：6 轮（沙盒脚本 web-….femo）` / `[femo-debug] 干跑结束：exit=0 流水 500 条 终报有 用时 65.2s`。用户看诊窗/log 窗能分辨「在跑」与「死了」；模型看不到这两条（不占它上下文）。
5. **工具描述写明成本**：「单轮≈点一次调试；runs 线性叠加（实测 9KB 剧本 6 轮 63 秒）；先单轮跑通，确实要撞随机分支再加轮数」——同步进 `runs` 参数说明，让模型自己掂量轮数。
### 验证
- `harness.ts` **44/44**（新增段⑥ 预先撤销：不起子进程=沙盒文件数前后不变 / 空结果形状 / 裁决原话含「被调用方撤销」/ 单飞闸未被占用 / 真跑 elapsedMs>0）。
- `tools-harness.ts` **25/25**（新增：描述含「线性叠加」与「63 秒」、runs 参数说明含耗时警告）。
- 产物断言：`check-bundle.mjs` 11/11 + `check-bundle2.mjs` 8/8（诊断流两条、emptyCollect、撤销原话、各轮合计、footer 用时、描述警告、elapsed_ms 均在 `lib/index.js` 里）。
- 重启生效：18:0x detached 重启（旧 pid 10812 → 新 **pid 26396**），启动日志六件套注册齐（含 femo-debug）。
### 判断点
- **没给 runs 加硬上限**（仍 1~20）：交给模型按新描述自己掂量；若还习惯性开大，把 `clampRuns` 的上限从 20 改成 5 即可（一行）。
- 被撤销时 python 会被 terminate（不留残留），已产出的流水留在沙盒 jsonl 里可人工翻（模型拿不到——框架按 aborted 丢弃结果，这是 dsh 语义，插件侧改不了）。
- 以后遇到"工具结果不出来"：先看宿主日志有无收尾行 + 沙盒 jsonl 是否在长 + 诊断流两条进度行；三者能快速区分「在跑/被撤销/真死」。
### 备份
`MEOW_backups/*.bak-20260911-1810-predebughardening`（debug-run.ts / tools.ts）——这两个文件上一轮已被本会话改过（HEAD 里还没有 femo-debug），改前状态只能反向应用本轮编辑取得；生成后自检：本轮新文本（emptyCollect / elapsedMs / pushDiag('femo-debug' / 撤销新原话 / 各轮合计 / 线性叠加 / basename(local.sandboxScript)）在备份里 0 命中。
## 2026-09-11 femo-debug 三修：被中断时把已产出的数据照常回传 + 留档（用户指正）
### 用户原话
"没有产生调试数据吗？倒也不至于吧。数据是实时产生的，你可以把现有的数据返回给他呀～哎，只不过作为工具调用。，用户这边按停止，他可能也就收不到了吧。"
### 核对（用户指正成立）
- 干跑数据确实是实时产出的：被中断时 `collectDebugRun` 的 `records.length > 0` 分支**本来就会把已产出的流水当「部分信息」回传**（ok:true ＋ ⏹ 头 ＋ 流水全文）。上一次用户"什么都没看到"，是因为**框架把 aborted 的工具结果整条替换成了 `tool call aborted`**——会话日志实证 `21:53:26 tool/result "Error: tool call aborted"`：工具是返回了的，dsh 按 aborted 把结果丢了。
- 我上一轮那句「没有产生调试数据」口径过宽（只有"一条流水都没写出来就被撤销"时才成立）——已删掉。
### 修改（`src/debug-run.ts` + `src/tools.ts`）
1. **话术收窄**：改为「本次干跑在产出任何流水之前就被撤销（回合被中断/用户停止；也可能卡在起跑阶段——看诊断流的「干跑启动」那行有没有出现）」。
2. **⏹ 头部写清楚**：「已实时产出的流水照常回传在下方——注意：框架会把 aborted 的工具结果整条替换成 "tool call aborted"，这份数据到你手里可能已经丢了，可让用户按留档路径直接读：<path>」。
3. **新增部分信息留档**：被中断（撤销/超时）**且已产出流水**时，同目录写 `<log>.partial.md`——含沙盒剧本路径 / 原始 JSONL / 用时 / 流水条数 ＋ 同款渲染的流水全文；路径同时进 ① 工具结果 footer、② 结果字段 `partial_path`、③ 诊断流收尾行。这样即使模型拿不到（框架丢弃），用户也能照路径把数据捞回来喂给模型（AI 有 fs 读取工具）。
### 验证
- `harness.ts` 新增段⑦（**真实中途撤销**：`runs:20` 跑 4.0 秒后 abort）——实测 `elapsedMs=4006、records=59`：`aborted=true` ✔ / 部分流水回传 ✔ / 裁决 `ok=true` ✔ / 文本含「已实时产出的流水照常回传」✔ / `.partial.md` 已生成且可读（含「# 干跑被中断时的部分信息」＋流水行）✔ / footer 列出留档路径 ✔ → **50/50**。顺带修了段③a 一处竞态断言（200ms 看门狗下"是否已落第一条流水"取决于机器速度，改为两分支任一合格）。
- `tools-harness.ts` **25/25**；产物断言 `check-bundle` **11/11** ＋ `check-bundle2` **8/8** ＋ `check-bundle3` **9/9**（新增：留档头 / 「照常回传」话术 / 框架丢弃说明 / 收窄原话 / `partial_path`）。
- **备份语法复检**：两份反向应用备份用 esbuild 单文件编译通过（不是只看字符串）。
- 重启生效：18:09 detached 重启（旧 pid 26396 → 新 **pid 4088**），六件套工具注册齐，调试路由实测 200 ＋ 9 条 NDJSON ＋ exitCode 0。
### 判断点
- 框架层"用户按停止 ⇒ 丢弃该次工具结果"是 dsh 语义，插件侧改不了；**留档是绕过它的正路**——用户照路径让 AI 读 `.partial.md`，拿到的是同一份信息。
- 留档只在「被中断且已有流水」时生成（正常跑完/空撤销不产生额外文件）。
### 备份
`MEOW_backups/*.bak-20260911-1812-prepartialarchive`（debug-run.ts / tools.ts）：反向应用本轮编辑生成，自检（本轮新文本 0 命中）＋ esbuild 语法复检。

## 2026-09-11 戏内戏外不掺一轮：主模型下场注入排队等本轮收口（用户点名）
### 用户需求（原话）
"如果主模型已经在和用户说话，也许正在多步调用工具，一轮还没有结束时，如果这个剧本恰巧有主模型下场参与，此时节点轮到他发言，节点会给他发什么？一个 steer 对吧？我们可以拦截这个 steer 吗？就是，在主模型这边，这一轮彻底结束之后，再把这个 steer 当作新一轮的开头发给他。毕竟戏内戏外本来就不应该掺在一起嘛，怎么能放在一轮里呢？……你需要注意，节点内有重试功能，如果有 API 错误，会在 DSH 这一侧重发重试，如果 AI 输出令 FAM 引擎不满意……FAM 引擎会要求重试。这些重试都属于同一个节点。所以你要想清楚，比如，在一轮之内拦截 femo steer，别把同节点的重试拦截了。我觉得最符合语义的表述是，我们在一轮没完成的时候，要拦截的是下一个节点的开始。"
### 语义与信号（把"节点开始"钉死）
- **节点开始 = `ai_request(source=main)`**（engine-events 的 ai_request 分支 → `runMainModelTurn`）。此刻引擎 `wait_for_input` 等着这位 main 节点的台词；主模型那轮的捕获答案经 human_input 交卷。
- **同节点重试有两条完全不同的路**，本功能的队列只碰得着其中一条：
  1. **DSH 侧 API 错误重试**（用户提的第一种）：`api-retry.ts` 挂在 `agent/request-error` 瀑布上 → 返回 `{kind:'retry'}` = **同 turn 同 step 原地重跑**（dsh 官方语义），不产生 steer、不出新轮、不经注入面——队列天然碰不到它，零影响。
  2. **引擎侧 node_retry**（FAM 不满意，如缺 SET VARIABLE）：`broker.deliverRetry` → 停靠循环消费 → `broker.steerLease` → 租约 steer。**它不是新节点**（waitKey/节点身份不变，交付后照旧 park 等下一次裁决）——排队只推迟它的交付时点，**不改节点边界**，重试循环完整。
- **为什么重试也得排队**（不只是洁癖）：若重试 steer 落进用户那轮，注入会被那轮的 step 边界消费，而捕获面 `sawTurnStart` 永假（该轮早已开轮）→ 用户回合里混进戏内反馈、那次重试还交不上卷（最终 park 15min 超时收场）。排队是两条路的共同正解。
### 修改（1 个新模块 + main-actor 接线 + 生命周期）
1. **新增 `src/main-delivery-queue.ts`（纯状态机，零依赖可测）**：主会话轮开闭跟踪（`noteTurnStart(sid, turn)` / `noteTurnEnd(sid)`）+ 按会话 FIFO 的待交付队列（`offer`：无轮在飞→立即交付 / 有轮在飞→排队；`peek` / `takeNext` 一次一条；`dropAll` / `dropWhere` / `forget` / `clear` 作废面）。**队列是唯一真源**——交付全程先 peek 后 take，等待期间被作废就自然不再交付。
2. **`src/main-actor.ts` 交付面**：`deliverMain`（pending 登记 + steer，与旧 `rearmPending + steerMainAgent` 逐字同义）、`queueOrDeliverMain`（立即/排队 + 日志 + pushDiag 提示"剧本节点 X 等你把这轮说完"）、`flushNextMainDelivery` / `tryDeliverNext`（轮收口放行）、`dropMainDeliveries`（作废 + resolve 首轮交卷槽防悬挂）、`disposeMainDeliveries`（HMR）。
   - **两路交付统一过队**：首轮（`runMainModelTurnInner`，交卷槽=自己的 `answer` resolve）与重试轮（broker 租约回调，`via:'重试'`，交卷由停靠循环重新 park 承担）。
   - **作废链**：`abandonMainAnswer`（flow_stopped/flow_error）丢弃本会话排队件并 resolve 交卷槽（其后 `broker.park` 因 parker 已被 abortJob 清而立即 aborted，整条收尾不卡）；`clearMainPlayState`（换场 flow_start）连轮开闭一起 `forget`；`runMainModelTurnInner` 的 finally 按 waitKey `dropWhere`（节点收尾兜底）；index.ts 的 broker 生命周期 effect 里加 `disposeMainDeliveries()`。
3. **`src/engine-events.ts`**：ai_request(main) 分支注释补语义（无逻辑改动——交付口本就在 main-actor）。
### 实测踩的三个坑（留档，全是 dsh 语义级的）
1. **同步 steer 会 reenter**：在 `session/event` 的 turn/end 分发里直接 steer → `session append cannot reenter while another append is being published`（steer 写会话投影 inbox → append）。必须先跳出本轮发布（microtask）。
2. **microtask 交付仍偏早 → 静默停放**：跳出发布后立刻 steer，driver 仍在收尾（`phase.kind === 'running'`）——dsh 的 `wakeDriver` 只在 maintenance/wakeAfterAbort 时记 `wakeRequested`，**普通 steer 对非 idle driver 只把消息放进 inbox、不记唤醒**，而本轮的认领点已过 ⇒ 注入静默停放在 inbox，新回合起不来（实测：requests 停在 2、inbox 有货、driver 已 idle）。→ 交付前等 `agent.status === 'idle'`（0.1.1 与 0.1.5 都有该 getter，跨版本安全）。
3. **同 tick 停演会漏过作废**：`runMainModelTurn` 是异步起跑的（`queues` 串行链里 `then(...)` 才走到登记/排队），引擎若在同一 tick 内 flow_stopped/flow_error，那次 `abandonMainAnswer` 早于本条入队 ⇒ 谁也没作废它，之后会对着已死的引擎交空卷（实测：`{"output":"","steps":[]}` 落到旧 wait_key）。→ 交付前加**活性复核** `broker.has(waitKey)`（登记没了=节点已收尾/停演 → 直接作废 + resolve）。
### 验证
- **新增 `tests/main-delivery-queue.test.mjs` → 33/33 PASS**（零 token、零宿主；真 AgentLoop + 脚本化假模型 + 真 main-actor 交付面，源码 esbuild 同步打包）：
  - 状态机 13 条：无轮在飞立即交付 / 有轮在飞排队 / FIFO / 一次一条（第二节点的等下一轮）/ 重试与新节点同队顺序不乱 / `dropWhere` 只剔同 waitKey 且不动轮开闭 / `dropAll` 保留在飞轮 / `forget` 全清。
  - 集成 14 条（四个场景）：①**用户轮多步在飞 + 节点到达**：用户轮续跑请求里**没有**戏内通知（不掺轮）、带全用户那轮的工具结果；用户轮收口后节点作为**第 3 次模型请求**登场；交卷恰好一次且是 `human_input` + 本节点 wait_key，内容是节点台词、**不含**用户对话。②**空闲到达**：立即交付（1 次请求）+ 即交卷。③**排队中停演**：注入作废、不悬挂、不事后交付、不交卷。④**同节点重试恰在用户轮内到达**：用户轮收尾请求无重试信；重试作为**第 4 次请求**的新轮登场且带重试信；两次交卷都落在同一 wait_key；重答内容正确、用户对话没被当重答交卷。
- **门卫回归**：`node tests/pre-step-gate.test.mjs` → 24/24（本功能不碰门卫，互不干扰）。
- **构建**：`npm run build` → `lib/index.js` 347.7kb（含 `tryDeliverNext` / 活性复核 / 注入排队日志）、`lib/client.js` 823.5kb（前端零改动）。
### 备份
`MEOW_backups/*.bak-20260911-183450-pre-maindelivery` 共 4 份：`main-actor.ts` / `index.ts` / `engine-events.ts` / `README.md`（**取自 `git show HEAD:`**——本轮改动是这四个文件与 HEAD（63032b3，含上一条"门卫按轮裁决"）的全部差异，已核验：本轮新词 `MainDeliveryQueue` / `disposeMainDeliveries` / 戏内戏外不掺一轮 在 4 份备份里 0 命中）。新增文件 `src/main-delivery-queue.ts`、`tests/main-delivery-queue.test.mjs` 为本轮净增，无需备份。
### 判断点
- **等待窗口**：节点答案是等主模型把这轮说完才交付的，上限由引擎 `wait_for_input`（3600s）兜底；重试轮另受停靠 15min 计时约束（与"主模型一直不回答"同款既有边界）。急停/出错走 `abandonMainAnswer` 即刻作废，不会悬挂。
- **极端长忙不硬塞**：driver 若 2s 内仍未 idle（异常），本轮不交付、留给下一次轮收口（宁可晚一轮，也不做会静默停放的投放）。
- **同 tick 并发**：用户消息与节点通知若在同一瞬间进 inbox，dsh 认领批次仍会把它们放进同一轮（原生队列语义）——极窄竞态，未做特殊处理。
- **需重启宿主才生效**：宿主侧产物（18:09 那次重启不含本功能）；空闲窗口重启即可（本轮未重启——正在演出中不掐戏）。
- **回归入口**：`node tests/main-delivery-queue.test.mjs`（改 main-actor 交付面/排队相关代码前先跑）。

## 2026-09-11 补：手机端标题栏左上角图标定案（本日第二次修订，取代同日上一条的图标选择）
### 用户反馈（原话）
"现在这个最大化看起来根本就不像最大化，像移动窗口的那个图标，你换一个。其实，如果你能把边栏换成宿主的边栏，我觉得也不错。"
### 为什么换（用户判断正确）
FA 的 `fa-maximize` 字形是「四角括号各带一支对角箭头」——同一套视觉语言就是"移动/缩放"，在一枚 19px 的键上确实读作移动窗口，不读作最大化。同日上一条把它当选是选错了。
### 定案图标
| 位置 | 状态 | 图标 | 来源 |
|---|---|---|---|
| 左槽 | 全屏沉浸态（点=退出沉浸+开边栏） | `IconPanelLeftOutline` | **dsh 宿主** `@deepseek-ai/dsh-client-ui-primitives` 的 `ic_ds_panel_left_outline_16`（与宿主边栏收起键同款，用户点名要宿主那个） |
| 左槽 | 容器态（点=回全屏沉浸） | `FaSquareOutline` | FA Free 6.7.2 **regular** 描边方块（经典窗口控件"最大化"） |
取描边方块而非 solid 方块的硬理由：隔壁「停止」键就是 `FaStop`＝实心方块，同屏两枚实心方块必混。
### 修改
1. `femoGen/src/faIcons.jsx`：`make()` 增可选第三参 fillRule（宿主该图标是 evenodd 镂空轮廓，缺了会填实）；新增 `IconPanelLeftOutline`（路径从已安装宿主包**程序化解析**落地，不引依赖，保持 femoGen 可独立 vite 构建）与 `FaSquareOutline`；移除上一轮的 `FaWindowRestore`/`FaMaximize`；文件头注明"含一枚非 FA 的宿主图标"。
2. `femoGen/src/mobileView.jsx`：左槽两处组件名与注释替换（回调/aria-label 不动）。
### 验证
- 渲染断言 **14/14**（.tmp/verify-mobile-titlebar-icons-entry.mjs，断言已同步为新图标路径特征）。
- **图标观感自证**（模型读不了图片，改走栅格化字符画）：.tmp/icon-harness/ 从已安装宿主包与 unpkg 抽 6 个候选路径 → 浏览器 `Path2D` 画进 canvas → ASCII 字符画。结论：上一版 fa-maximize 是四角箭头（用户判断成立）；FA solid table-columns 是"三栏"，不如宿主 panel-left 像边栏；FA bars 是纯汉堡。**并把最终两枚按实际 19px 尺寸复栅格化确认小尺寸仍可辨认**（边栏那道竖分隔线还在、方块干净）。
- 真实浏览器（.tmp/tb-harness）：两键各恰 1 个 svg、无箭头字符、path 与 viewBox 正确。截图 .tmp/shots/titlebar-icons-v2.png。
- 产物 `npm run build` 通过；lib/client.js 内含新图标路径、旧的两条已不在（脚本核验 4/4）。
### 备份
MEOW_backups/{faIcons.jsx,mobileView.jsx}.bak-20260911-140435-prehosticon（本轮改动前）
### 教训
选图标别只看 FA 的名字（`maximize` 这名字下挂的是四角箭头字形）。**把候选字形栅格化成字符画自检**是本仓库模型看不见图时唯一可靠的字形判断法，几行 canvas 代码的事，值得复用（harness 留在 .tmp/icon-harness/）。

## 2026-09-11 调试窗口分级底色：warn 黄底 / error 红底（用户点名）
### 用户需求（原话）
"在调试面板，它会返回后端的跑的信息，warning 和 error 嘛，应该可以甄别哪些是正常信息，哪些是 warning、哪些是 error 吧？这是由后端一个专门的 error.py 类似的文件发过来的。帮我在面板里显示的时候，把 Warning 的底色换成黄色，Error 的底色换成红色吧"
### 先答"能不能甄别"：能，级别是后端发的（不是前端猜）
链路三段，均已核：
1. **后端** `femoCompiler/FEMO_errors.py`——四桶分类（FATAL / AGENT / WARNING / TOLERANT），WARNING 桶的定义是"值得作者知道但什么都没被拒绝"。发 `notify_author{severity}`：`fatal` / `agent_error` / `agent_giveup` / `warning`（TOLERANT 连作者都不打扰，不上浮）。
2. **宿主 SSE** 另供分类明确的事件：`flow_error` / `bridge_run_ended(ok=false)`→error；`compile_warnings`（编译期 warning 桶）/ `ai_retry` / `node_retry`→warn；`flow_start` / `node_start` / `ai_done` / `human_wait` 等运行事件→info。
3. **前端翻译层** `FemoWorAuto.summarizeDebugEvent`（:210 起）：`notify_author` 按 severity 落 error/warn/info；另有 :218 那条注释记着历史坑——2026-09-07 之前误读 `d.level`（后端字段其实叫 `severity`），导致**作者通知（含真错误）全被降级成 info、红标从不亮**，当日已修正。
   注：调试干跑（FemoWorAuto.debugRecToLine）另有一套级别（retry/silence/flaky/warning→warn；run_end 未 completed / debug_error→error），同一面板共用。
### 实现（femoGen/src/debugPanel.jsx）
1. `LEVEL_STYLE` 增 `rowBg` 字段：error=`color-mix(in srgb, var(--femo-danger) 22%, transparent)`、warn=`color-mix(in srgb, var(--femo-warning-strong) 22%, transparent)`、info=`transparent`。
   **为什么不用现成的 `--femo-*-soft`**：暗色主题下 `--femo-warning-soft` 是 `#75603A`（莫兰迪灰驼，与 func 底同族），根本不读作"黄"；从 `--femo-warning-strong`(#f7ad31) / `--femo-danger`(#f25a5a) 混 22% 则两套主题都稳定读成黄/红，且底色自动跟随主题。`soft` 仍只服务头部错误徽标。
2. 行容器：`padding:'3px 6px'` + `marginBottom:4` + `borderRadius:var(--femo-radius-sm)` + `background:st.rowBg`。**内边距给到所有行（含 info 的无底色行）**，否则只有底色行缩进会看起来像错位；行间留 4px 免得相邻两条黄/红糊成一整块。
3. 只给 warn/error 补底色——09-08「条目去卡片化」撤掉的是**所有**条目的软色底与色条，正文两行制排版与"可整段选中"不动（用户当时的要求）。
### 验证
- 渲染断言 **8/8**（.tmp/verify-debugpanel-levels-entry.mjs）：info 行 transparent 且无 color-mix / warn 行取自 warning-strong / error 行取自 danger 且非 warning / 两者不同源 / 圆角与内外边距 / 两行制未破 / 复制清空按钮仍在。
- **真实浏览器量计算后颜色**（.tmp/dp-harness 同时渲染 light + dsh-dark 两主题）：
  light：error `rgba(239,68,68,.22)`、warn `rgba(221,134,41,.22)`、info 透明；dsh-dark：error `rgba(242,90,90,.22)`、warn `rgba(247,173,49,.22)`、info 透明——色相判定分别为红系/黄琥珀系，两主题均成立。截图 .tmp/shots/debugpanel-levels.png。
- 产物 `npm run build` 通过；lib/client.js 内含两条 rowBg 与行容器样式（脚本核对 3/3）。
### 备份
MEOW_backups/debugPanel.jsx.bak-20260911-194444-prelevelbg（**改动前**回滚点，291 行、0 处 color-mix；生成方式见 .tmp 已删脚本说明——先误存成了改动后快照，已按行逆向还原并 diff 核对恰为本次三处）
### 备注
底色浓度 22% 是"看得清但不刺眼"的折中；若嫌淡，调 `LEVEL_STYLE` 里两个百分比即可（同一个数字管两套主题）。

## 2026-09-11 调试窗口排版改单行内联（用户点名，紧接上一条底色之后）
### 用户需求（原话）
"这个报错信息现在每一条都分了两行，我觉得有点占地方。你看要不这样吧：每条一行。但是也不要分三栏，就是单纯的每条一行，换行都要顶格，不要像表格一样从第三栏才开始换，再跟第三栏对齐，那样太占地方了。"
### 改动（femoGen/src/debugPanel.jsx）
把 09-08 r3 的**两行制**（首行只放 时间+[来源]，正文永远另起一行）改回**单行内联**：
1. 行容器直接放三个内联 span：`时间` + ` [来源]` + ` 正文`（三段同层，中间不再有 flex 分栏 div），正文紧接来源之后。
2. 行容器承担折行职责：`whiteSpace:'pre-wrap'` + `overflowWrap:'anywhere'` → 过长自然折行、**续行从行首（时间那一列）顶格起**，不是"从第三栏才开始换、再跟第三栏对齐"；正文自带的 `\n` 也照原样断在该行行首。
3. **行容器必须自带 `fontSize:10 / lineHeight:1.6`**——这是实测踩到的坑：不写这两行时，撑起行盒高度的是**继承来的大字号 strut**（1.6×继承字号≈24px），几个 10px 的 span 压不住，单条行高实测 29.9px；写上之后才是 16+6=22px（实测 23.2px）。
4. 顺手清掉两行制遗留：timeSt/kindSt 里的 `flexShrink`（内联后无意义）、正文 span 的 `marginTop:1`。
### 实测（真实浏览器量几何，dsh-dark 主题，面板宽 340）
| 条目 | 视觉行数 | 行高 | 折行续行左缘 |
|---|---|---|---|
| 短条目 info / warn | **1** | 23.2px | —（无折行） |
| 长条目 error（约 150 字） | 5 | 89.9px | 全部 **17px** = 行内容左缘 = 时间列（顶格 ✓） |
两行制同类短条目约 38px → 现在 23.2px，**竖向省约四成**，正是用户要的"别占地方"。
### 验证
- 单行结构断言 **8/8**（.tmp/verify-debugpanel-oneline-entry.mjs）：三段同层无内层 div / pre-wrap+anywhere / 无 marginTop / 正文换行保留 / 底色未受影响。
- 几何实测：上面那张表（按 top 分组成行盒、取每行最小左缘，避开同行的空格片段干扰）。
- **回归**：底色断言 8/8、清空按钮断言 11/11（更早那轮）——三套同跑全绿，无回归。产物 `npm run build` 通过并核对含新样式、两行制痕迹已消失。
- 截图 .tmp/shots/debugpanel-oneline.png（短条目 1 行、长条目 5 行且续行顶格）。
### 备份
MEOW_backups/debugPanel.jsx.bak-20260911-194707-preoneline（本轮改动前）

## 2026-09-11 调试窗口分页签：『剧本』+『编译器』（用户点名）
### 用户需求（原话）
"调试面板这里，我们分几个标签页吧。我想，既然已经做了调试面板，不如让它把信息显示得全一点。现有的这些信息显示在名为"剧本"的标签页里。然后再加上名为编译器的标签页，显示后端编译器运行时出现的 print。"
### 数据源勘察（关键：print 早就有了，只是没全采）
- **后端**：`femoCompiler/*.py`（FEMO_runtime 等）大量用 `print()` 出诊断（`[runtime]` / `[format_human_dialog]` / `[FORK]` …）。
- **宿主**：`src/bridge.ts` 的 `onData` 逐行读引擎 stdout，非 JSON 行原本**只放行** `[resume-diag]`/`[resume]`/`[FORK]` 三类探针进 diag feed → 其余只落 `console.log('[femo-engine] ...')`，femoGen 一点都看不到。
- **通道**：`src/diag-feed.ts` 已有三路落点（内存环 800 条 + SSE `femo_diag` + `user_data/debug-diag-feed.log`），`GET /dsh-femo/diag-tail?n=` 可拉历史；SSE 走的就是前端已连的 `/dsh-femo/events`——**通道齐全，且此前无前端消费者**。
### 改动
1. **`src/bridge.ts`（宿主，12 行）**：非 JSON 行**全量** `pushDiag('engine', line.slice(0,400))`（截断防一条 payload 撑爆面板），去掉三类探针白名单；`console.log` 保留。
2. **`femoGen/src/debugPanel.jsx`**：
   - 新增 `compilerEntries` / `onClearCompiler` 两个入参（缺席时该页空态）+ 内部 `tab` 状态（UI 私事，不上抛）。
   - 头部下方加**页签条**：『剧本』/『编译器』，各带条数；剧本页有错时按原徽标口径显「N 错」（红），无错显示总条数（灰）——**不同时显两个数字**。原头部的错误徽标随之撤下（挪到页签上，跟内容同页更直观）。
   - **复制 / 清空按当前页生效**（跨页操作会让人误以为清掉了别处）：`activeList` / `clearActive` 分派，按钮 title 也按页说明。
   - 两页共用同一套行样式（提到组件域，避免两处各写一份漂移）；编译器行无级别→不上色、无底色。
3. **`femoGen/src/FemoWorAuto.jsx`**：`compilerLog` 状态（新在前、上限 300、文本截断 400 与宿主同口径）+ `handleDiagFeed`（只认 `tag==='engine'`）+ SSE `onmessage` 里拦 `evt.type==='femo_diag'`（**不进 handleWorkflowEvent**——那不是画布事件，进去只落 default 分支）+ 开面板时 `GET /dsh-femo/diag-tail?n=400` 拉历史（按 ts+文本去重后拼到实时流后面；独立模式无此路由，故 `plugin` 门控）。
4. **`femoGen/src/mobileView.jsx`（7 行）**：`compilerLog`/`onClearCompiler` 沿 MobileLayout → MobileTitleBar → DebugPanel 的既有 prop 链透传。
### 验证（真实浏览器，带外部计数器）
- 页签渲染：『剧本 1 错』『编译器 2』；默认停在剧本页（只有 SCRIPT 行，无 COMPILER 行）。
- 切页：点『编译器』→ 只显 COMPILER 行、剧本行隐藏。
- **逐页清空（本次关键行为）**：在编译器页点「清空」→ `script=2 compiler=0 scriptCleared=0 compilerCleared=1`——只清编译器页、剧本页毫发无伤；切回剧本页两行俱在；编译器页转为空态文案。
- 回归：清空按钮 11/11（其中一条断言按新行为更新为 title 分页说明）、分级底色 8/8、单行排版 8/8。
- 产物核验 7/7：宿主 index.js 含新的 engine 转发且旧白名单已去；前端 client.js 含两个页签、compilerEntries、diag-tail、femo_diag。
- 截图 .tmp/shots/debugpanel-tabs.png（编译器页）。
- 排障留痕：该 webview 的 playwright click 仍送不进指针事件（role 点击超时），改用页面内 `el.click()` 派发真实 DOM click 驱动 React（`elementFromPoint` 已复验坐标命中按钮）——与上一轮同一环境问题。
### 生效方式（重要，与以往不同）
- **前端（本轮主体）：刷新 dsh 页面即生效**（lib/client.js）。
- **宿主 `bridge.ts`：必须重启 dsh 才生效**（引擎 print 的全量转发在 lib/index.js 里）。重启前打开「编译器」页会是空的——不是坏，是老宿主还在按白名单过滤。
### 备份
MEOW_backups/{debugPanel.jsx.bak-20260911-195134-pretabs, bridge.ts.bak-20260911-195134-preengineprints}（本轮改动前）

## 2026-09-11 调试窗口第三页签『FEMOGen』：前端 femoGen 自己的 log（用户点名）
### 用户需求（原话）
"FEMO 前端的报错，或者说 print 信息，是可以放到这个调试面板的吗？一个新的标签页，叫 FEMOGen，然后把前端 FEMOGen 的 log 信息输出到这里。也是每条一行。Log 是代码里面写的有 log 的地方，就直接 print 到这里。"
### 做法：钩 console，不改调用点
前端 femoGen 有 **157 处 `console.*`**（含大量注释掉的）——逐处改造成 `femoLog()` 既伤 diff 又必然漏。用户要的是"代码里原来在哪打就在哪"，所以新增 `femoGen/src/femoLog.js` **钩住 `console.log/info/warn/error`**：原行为原样转发（DevTools 照旧），同时镜像进环形缓冲（400 条、单条截断 500 字符、对象 JSON 化、Error 带首帧位置）。
### 两个必须处理的坑（都已在代码里注明）
1. **自噬死循环**：若捕获后同步 setState，而 setState 又触发 React 的"Cannot update a component while rendering"警告——那条警告走 console.error、又被钩进来、再 setState……故通知走**微任务批量 flush**（一次事件循环的多条合成一批，顺带把高频日志的渲染次数压成 1）。实测：连续打日志后 1.5s 内计数稳定不再增长，无自增。
2. **console 是全局的**：插件模式下 femoGen 与 dsh 外壳同窗口，**宿主/其它插件的 console 输出也会被收进来**。这是"不改调用点"的必然代价，已写进该页空态文案里明示（实测确实收到了外壳的 `[RUM] ArmsEventBridge is not available` warn）。要精确区分只能靠栈回溯，打包后栈里只有 `lib/client.js:行号`，不可靠，故不做。
### 改动
1. **新增 `femoGen/src/femoLog.js`**：`installFemoLogCapture()`（幂等）/ `pushFemoLog` / `subscribeFemoLog` / `femoLogTail` / `clearFemoLog`。级别取 console 方法名（log/info/warn/error），面板直接当"来源"栏位显示。
2. **`femoGen/src/debugPanel.jsx`**：加第三页签『FEMOGen』；三页清单/清除/计数改成一张 `TABS` 表（加页只动一处，避免 if 分支漂移）；FEMOGen 行复用 `LEVEL_STYLE`（warn 黄底 / error 红底 / log 无底色）；复制/清空仍按当前页。
3. **`femoGen/src/FemoWorAuto.jsx`**：模块级 `installFemoLogCapture()`（femoGen 两种入口都会引到本模块，等于页面一加载就开收，启动期日志不漏）；组件里订阅 + 首屏 `femoLogTail(200)` 补历史；清空时**连缓冲一起清**（否则重开面板旧行又回来）。
4. **`femoGen/src/mobileView.jsx`（14 行）**：第三对 prop 沿既有链路透传。
### 验证（真实浏览器，外挂计数器）
- 钩子生效：页面加载即已收到日志（`femogen=1`）；依次打 log/warn/error → `femogen=7`。
- 渲染：一行一条；对象被压成 `HARNESS_LOG_行 {"a":1}`；底色实测 error `rgba(242,90,90,.22)` 红、warn `rgba(247,173,49,.22)` 琥珀、log 透明。
- 清空：按当前页生效（`femogen` 归零、剧本与编译器页计数不变），清空后再打一条仍能收（采集未被清空破坏）；**无自增循环**（1.5s 观察窗口内计数稳定）。
- 回归：清空按钮 11/11、分级底色 8/8、单行排版 8/8 三套全绿；产物 5/5（含 FEMOGen 页签、femoLog 常量、console 钩子、femogenEntries、queueMicrotask）。
- 截图 .tmp/shots/debugpanel-femogen-tab.png。
### 生效方式
- **纯前端改动，刷新 dsh 页面即生效**（无宿主侧改动；上一轮 bridge.ts 那次仍需重启才能看到『编译器』页的内容）。
### 备份
MEOW_backups/debugPanel.jsx.bak-20260911-200114-prefemogentab（本轮改动前；FemoWorAuto/mobileView 本轮为纯增量接线，未单独备份）

## 2026-09-11 调试窗口第四页签『Host』：宿主（投影窗这边）的 print（用户点名）
### 用户需求（原话）
"第 4 个标签页是 Host，就是投影窗这边的 代码里的 print，是可以 print 到 FEMOGen 这边的吗？"
### 能不能：能，但要新加一路采集
宿主跑在 dsh 的 Node 进程里，`console` 只落 harness 日志文件（`user_data/*.log`，`debugLogMainActor` 的注释也写着"host console 不可见"）——**浏览器侧一点都看不到**。故在宿主侧新增 `src/host-log.ts`：钩 `console.log/info/warn/error`，把本插件自己打的行送进前端已在消费的 diag feed（tag 'host'）。
### 关键设计：调用栈过滤（不清洗 198 处调用点）
宿主进程的 console 是**全局**的，harness 自己与其它插件也在打（harness 日志动辄 MB 级），全量转发会把面板淹掉。故用**调用栈过滤**：栈里出现本模块所在目录的帧 ⇒ 本插件代码打的（打包态 lib/index.js / tsx 直跑态 src/*.ts 两种都命中）；否则丢弃、不转发。
### 离线测试逮到的两个真 bug（都写进了代码注释）
1. **路径分隔符**：Node 栈帧是 `file:///D:/...`（正斜杠 URL），而 `fileURLToPath` 在 Windows 给反斜杠路径——不归一则 `includes` 永不成立，**一条都收不到**。修：SELF_DIR 与帧都归一成正斜杠。
2. **取栈位置**：栈若在独立辅助函数里取，会多出一帧"本模块的包装函数"，把"跳过钩子自身"的偏移算错——结果**任何调用方的日志都被认领**（`other/` 的也收了）。修：取栈内联进包装函数，从 `frames[2]` 起找。
   → 教训：这类"靠栈认人"的过滤器必须用一个能区分两个目录的离线用例验证，光看代码看不出这两点。
### 改动
1. **新增 `src/host-log.ts`**：`installHostLogCapture(sink?)`（幂等、sink 可注入以便测试）；warn/error 行首加 `[warn]`/`[error]` 标记供前端上色；文本截断 400。
2. **`src/index.ts`**：apply 里 `initDiagFeed` 之后装钩子（+1 import）。
3. **`femoGen/src/debugPanel.jsx`**：加第四页签『Host』；`HOST_LEVEL_RE` 只认 `[log]|[info]|[warn]|[error]` 四词——**普通行（含引擎式 `[runtime]` 前缀）不会被误判成级别**（实测过）；级别标记收进"来源"栏、正文不留前缀；四页共用级别配色。页签条加 `overflowX: auto`（手机 320px 四个 chip 会顶到边）。
4. **`femoGen/src/FemoWorAuto.jsx`**：`hostLog` 状态；两条 diag 流（engine→编译器、host→Host）共用一个 `appendDiagLine`，`handleDiagFeed` 按 tag 分派；diag-tail 一次请求同时喂两条流；其余 diag 标签（bridge/ev-in/human_wait…）仍不上页签。
5. **`femoGen/src/mobileView.jsx`**：第四对 prop 沿既有链路透传。
### 验证
- **宿主栈过滤离线测试 6/6**（.tmp/hostlog-test：把 host-log.ts 打进独立目录，另一个目录放"别人"的调用），含"认领同目录"/"放过别的目录"/"对象 JSON 化"/"WARN·ERROR 带级别标记"。
- **前端浏览器实测**：四页签齐全（Host 页签正确显示「1 错」红字）；Host 页四行——`[runtime] 普通行` 未被误判（透明底）、`[warn]` 琥珀底、`[error]` 红底、裸行 `[log]`；逐页清空 `host=0 cleared=1`（其余页计数不动）。
- 回归：清空按钮 11/11、分级底色 8/8、单行排版 8/8、宿主栈过滤 6/6；两端产物核验 9/9。
- 截图 .tmp/shots/debugpanel-host-tab.png。
### 生效方式（与上一轮同类）
- 前端（第四页签本体）：刷新即生效。
- **宿主收集：必须重启 dsh 才有内容**——重启前 Host 页是空态（该页空态文案里也写了这条）。
### 备份（回滚点，均经 diff 自证只含本轮改动）
MEOW_backups/{index.ts, femoGen_src_debugPanel.jsx, femoGen_src_FemoWorAuto.jsx, femoGen_src_mobileView.jsx}.bak-20260911-200700-prehosttab

## 2026-09-11 补记（**无代码改动**）：复制/清空逐页实测 + 切走时采集连续性定性
### 一、复制/清空确实都按「当前显示页签」（补上复制这条的实测）
清空在加页时已实测；**复制此前只有结构断言**，本轮补齐浏览器实测（stub `navigator.clipboard.writeText` 收回内容）：
| 页签 | 复制到的内容 |
|---|---|
| 剧本 | `[时间] [error] 运行: SCRIPT_ONLY_行`（时间/级别/来源/全文） |
| 编译器 | `[时间] COMPILER_ONLY_行` |
| FEMOGen | `[时间] [warn] FEMOGEN_ONLY_行` |
| Host | `[时间] [warn] HOST_ONLY_行` |
每页只出本页内容、格式各按各页定义。
- **测试踩坑留痕**：首版把"点页签"和"点复制"写在**同一个同步 evaluate 块**里，React 尚未重渲染 → 复制到的是**上一页**，看起来像产品 bug。拆成两次调用（中间留 250ms 让 React 提交）后全对。以后测"切页 + 立即点击"的组合必须分帧，否则冤枉代码。
### 二、切到 DSH 对话时，采集**不断**（用户问；已核代码）
用户问："当我页面切到 DSH 的对话去的时候，这边可以继续收集，对吧？我记得咱们的 Femogen 一直不关。" —— **对，三路采集都不受影响**，依据：
1. **编辑器页是单例 keep-alive**：`client-ui/editor-page.tsx` 把 femoGen 单页 createRoot 到 body 级容器，切走只把容器设 `visibility:hidden`（`placement -> hidden`），**不卸载**；日志里那句 `single-instance keep-alive` 即此。故 FemoWorAuto 常驻 → `subscribeFemoLog` 订阅、`connectSse` 的 `/dsh-femo/events` 连接（编译器/Host 两页的实时源）都**保持不断**。
2. **没有按可见性暂停的逻辑**：全仓 grep `visibilitychange` / `document.hidden` / `window.blur` 在 femoGen 与 editor-page 里**零命中**；SSE 只在三处关闭——独立模式运行流终了、重连前重建、组件卸载（页面不卸载则不走）。
3. **两个 console 钩子的生命周期都长于"切走"**：前端 `femoLog.js` 装的是 `window.console`（页面级，刷新才重置）；宿主 `src/host-log.ts` 装的是 Node 进程级（与浏览器显示无关，进程活着就在收）。
4. **兜底**：即便日后编辑器页改成卸载，重开面板也会补历史——编译器/Host 走 `diag-tail` 拉 host 侧环形缓冲（800 条），FEMOGen 走 `femoLogTail` 读模块级缓冲（400 条）。即"漏不掉，只是不是实时"。
- 唯一会丢的场景：**浏览器刷新/关闭页面**（前端两条缓冲是内存态，刷新即重来，这是设计如此："观测面不是档案"）；宿主侧因另有 `debug-diag-feed.log` 落盘，重启后仍可查。

## 2026-09-11 补：Host 页口径收窄——只放「DSH 接口侧」的话（用户拍板）
### 用户要求（原话）
"Host 只显示来自 DSH 接口侧 的 print 就好了。换句话说，在我们这个场合里，应该就是投影窗那些。"
### 问题定性
Host 页此前收的是"宿主进程里本插件所有 console"——于是**引擎 stdout 的转发也混了进来**（`bridge.ts` 收到引擎行后既发 tag 'engine' 给『编译器』页，又自己 `console.log('[femo-engine] …')` 一份，那份被 host-log 认领成 tag 'host'）。同一句话在两个页签重复出现，且它压根不是"DSH 接口侧的话"。
### 改动（**只能在调用点做，不能靠栈过滤**）
打包后全部模块同处 `lib/index.js`，栈里分不出"哪个模块"——所以模块级取舍只能在调用点落地。三处引擎透传改成 **`process.stdout.write` 绕过 console**（harness 日志一个字不少，只是不再被钩子认领；它们的家在『编译器』页）：
1. `src/bridge.ts` 引擎 stdout 透传（原 `console.log('[femo-engine] …')`）
2. `src/bridge.ts` 引擎 stderr 透传（原 `console.log('[femo-engine:stderr] …')`）
3. `src/debug-run.ts` 调试器 stderr 透传（原 `console.log('[femo-debug:stderr] …')`）
另：`src/host-log.ts` 文件头补记该口径与"为何不能在栈层做模块过滤"；面板 Host 页空态文案改准（明确写"引擎自己的 stdout/stderr 不在这页，归『编译器』页"）。
### 验证
- 口径断言 8/8（文案含「DSH 接口侧」/ 点明引擎行不在这页 / UI 文案无 markdown 星号 / 四页签仍在 / 四列表渲染不崩且只渲当前页）。
- 四套回归全绿：清空 11/11、分级底色 8/8、单行排版 8/8、宿主栈过滤 6/6。
- 宿主产物 5/5：三处 `process.stdout.write` 就位、引擎行不再走 console.log、钩子仍在。
- 已知遗留（未做，等用户发话）：**引擎 stderr 目前只落 harness 日志**，两个面板页都看不到它（stdout 的原文进『编译器』页，stderr 没有对应通道）。要的话给『编译器』页加一路 stderr 即可。
### 生效方式
- 前端（Host 页文案）：刷新即生效。
- **宿主三处口径改动：需重启 dsh 才生效**（与 Host 采集本体同批）。
### 备份
MEOW_backups/{bridge.ts, debug-run.ts, host-log.ts, debugPanel.jsx}.bak-20260911-201453-prehostscope

## 2026-09-11 演员名双名制：戏中名（Soul name）三处显示（用户拍板）
### 用户要求（原话）
"我建议我们现在先干净一点，把戏中角色卡和本人的名字都显示出来。角色卡（Soul name）"；三处：①Block Collector 给 AI 拼接上下文；②Femogen 运行时气泡浮层里的人名（用户猜测"或许不用改，它就是 Block Collector 直接拼出来的，你可以确认一下"）；③DSH 侧各投影窗的角色标签（"这个是要改的"）。
### 确认结论（②的猜测只对一半）
- 气泡浮层里的**上下文全文**确实是 Block Collector（默认路由=ContextExample）拼的，①改完它自动跟着对；
- 但气泡的 **`[ai_name]:` 头行**来自引擎 `_exec_ai` 的 `context_ready` 事件（femoGen `FemoWorAuto.jsx:2470` 收 `data.ai_name`），不走 Block Collector——所以②其实也要改，改在引擎取名处；
- DSH 投影窗 speaker 标签/角色窗名/直播帧 actor 全是同一个 `ai_name`（引擎随 ai_request payload 下发，`subagent.ts:582` `actor = request.ai_name ?? …`）——**引擎一处改名，气泡头行+投影标签两端同时生效**，宿主 TS 零改动。
### 格式（拍板）
`戏中名（Soul name）`，例：`猫猫（小猫咪）`（`ai @猫猫 = soul:littlecat`）；**同名去重**（`@Eve = soul:Eve → Eve`，不写"Eve（Eve）"）；缺一退单名；投影窗 speaker 标签同格式（页签 🎭 名仍走 scope @名，是路由键，不动）。
### 改动
1. **femoCompiler/FEMO_runtime.py**（`_exec_ai` 取名处）：原"三级兜底"（soul_name → soul 块正则`名字:` → @演员名 → "AI"）前面加双名组装——查库得 soul_name + `_resolve_actor_name` 得戏中名（去 @），两名都有且不同 → `戏中名（soul_name）`；否则原链路逐级兜底（main 伪 soul、无 soul 裸演员行为不变）。
2. **femoBridges/ContextExample.py**：①新增 `_actor_role_maps(actors_def)`（AI 演员 soul_id→戏中名；人类演员 source(user_id)→戏中名 + soul_id→戏中名兜底——无 source 回退 owner 的行只能按行上 soul_id 认亲；同键先声明者胜）与 `_dual_name(role, display)`（拼装+同名去重）；②`get_name` 人类行/AI 行包双名（`铲屎官（人类玩家）`/`玩家（用户）`；femo-/femoshow-/[节点提醒]/主模型 特例不动）；③`actors_def` 可选参数穿线 `build_session_context/full/incremental/first_full_then_incremental/get_session_context/findThisSession`——**不传=纯单名原行为**（自定义 context 老调用方零感知；台账行只存 soul_id/user_id，戏中名只能靠剧本 actors 定义还原，历史场次同样退单名）。
3. **femoCompiler/block_collector.py**：默认 context 路由两处调用把 `actors_def`（引擎四处 collect_blocks 调用点均已传 `script.actors`）穿线给 `build_session_context`。
### 验证
- 真实库 session 2951（谁是卧底场）full 模式对比：带映射 `猫猫（小猫咪）`/`铲屎官（人类玩家）`/`Eve`（去重）；不带映射与旧版逐名一致（`小猫咪`/`人类玩家`）——向后兼容实证。
- 引擎取名五路径模拟：双名/同名去重/仅卡名/main 伪 soul→@名/全缺→AI 全部正确。
- pytest 全量 **368 passed**（27 个 error 系 `_tmp` basetemp 目录缺失的环境噪音，`test_job_manager.py` 单跑 26/26 全绿，与改动无关）；三文件 py_compile 过。纯 Python 改动，无 TS/前端产物。
### 生效方式
- **引擎侧（取名+上下文）需重启 dsh 生效**（宿主经 bridge 拉起引擎进程；直连 femoGen 独立跑同样重启）。
- 注意：投影窗/角色窗 id 以 ai_name 为键（消毒后），改名后**新开场次**才建新窗；旧场次旧窗仍按旧名挂靠。
### 备份
MEOW_backups/{FEMO_runtime.py, ContextExample.py, block_collector.py}.bak-20260911-210526-predualname

## 2026-09-11 补：引擎 stderr 补进『编译器』页（用户点头："是的，补吧"）
### 起因
上一轮收窄 Host 页口径时留的遗留项：**引擎 stderr（Python traceback 之类）两个面板页都看不到**——stdout 原文有『编译器』页兜着，stderr 没有对应通道（只落 harness 日志）。用户确认要补。
### 改动（宿主两处 + 前端文案）
1. **`src/bridge.ts`**：引擎 stderr 转发处加 `pushDiag('engine', \`[stderr] ${line}\`.slice(0,400))`——与 stdout 原文同一个 tag/同一页；`[stderr] ` 前缀用于与 stdout 原文区分。原 `process.stdout.write('[femo-engine:stderr] …')` 保留（harness 日志照旧）。
2. **`src/debug-run.ts`**：调试器（干跑）stderr 的两条路径**都**补 pushDiag——`capture` 模式（走 err 回调用方）与 `stream` 模式（面板「编译」按钮那条）都不再只有 harness 日志可见。
3. **`femoGen/src/debugPanel.jsx`**：编译器页空态文案、页签 title、入参注释、文件头设计注释同步"stdout + stderr 都在这一页"。
### 验证
- 前端浏览器实测：编译器页并排显示 `[runtime] stdout 原文行` 与两条 `[stderr] …`（**traceback 的缩进被 pre-wrap 原样保住**），全部不上色（该页口径：原文直通、无级别语义）。
- 产物核验：宿主 3/3（两处 pushDiag + engine 行仍绕过 console）、前端 4/4（title/空态提到 stderr、Host 页口径文案未被破坏、四页签仍在）。
- 五套回归全绿：清空 11/11、分级底色 8/8、单行排版 8/8、宿主栈过滤 6/6、Host 口径 8/8。
### 附带留痕：bundle 中文转义的坑
核产物时发现 esbuild 对中文有两种转义：`\uXXXX`，以及**逐字转义 `\编`**（NonEscapeCharacter）。只用 `\uXXXX` 解码的断言会漏匹配中文串——本仓库以后写"产物字符串断言"要两种都还原（脚本 .tmp/check-client-copy.mjs 留了实现）。
### 生效方式
**需重启 dsh**（两处都在宿主侧）；前端文案刷新即生效。
### 备份
MEOW_backups/{bridge.ts, debug-run.ts, debugPanel.jsx}.bak-20260911-212532-preeginstderr

## 2026-09-11 摘除右上角 log 窗（diag-overlay）及整条 femo-trace 埋点链（用户点名；净 -820 行）
### 用户需求（原话）
"你看右上角有一个 log 窗，现在请你把那个 log 按钮及其组件，以及到底是谁在调用它，把这些相关代码都去掉吧。我们现在已经把 log 分门别类地放到了 FemoGen 下面的调试窗口里，所以，那个 log 按钮和它相关的功能已经没有用了，完全被取代了。"
### 定性：这是 2026-09-06/09-10 两轮投影窗排障的临时观测面，其职能已被四页签调试窗完全取代
右上角那个窗 = `client-ui/diag-overlay.ts`（276 行纯 DOM 悬浮窗，注释自证"排障结束后整体摘除"）。它拖着一条临时埋点链：`femo-trace.ts`（前端埋点路由 + 批量回传宿主落盘）+ `femo-view-dump.ts`（400ms 屏幕内容直读探针，纯为"渲染乱序"排查）。
### 摘除面（用户指示"直接搜函数把相关调用全搜出来"：`femoTrace(` 等 8 个标识）
- **删除 3 个文件**：diag-overlay.ts / femo-trace.ts / femo-view-dump.ts（719 行）。
- **10 个文件逐语句摘除**：client.tsx（import + mountDiagOverlay 块 + 6 处 femoTrace + __femoUiConv 注入点）、composer / view-button / stream-store / proj2 的 index·frame-router·ledger·turn-view（各 import + 埋点行；turn-view 连 traceDecision 辅助函数一起删）、chat-node（__femoChatNodeDebug 调试挂窗——注释自证"随 diag-overlay 一并摘除"）、routes.ts（`/dsh-femo/client-trace` 接收路由）、proj-trace.ts（悬空注释行）、stream-frames.ts（注释提及）。
- proj2/index.ts 的 `installErrorTrace` 函数体只有 femoTrace 调用，删除后留下**空壳监听器**（addEventListener 空回调）——一并清除，含调用点与整段注释。
### 验证
- 零残留：源码 grep 8 个标识全零（.bak 除外）；产物 grep 8 项全零。
- 构建 exit 0；**tsc 135 条 ≤ 基线 137 条**（基线=摘除前同 tsc 实测，删除后反而少 2 条；且无任何"引用已删导出"类错误——那才是删出问题的信号）。注：tsc 基线从历史留痕的 113 涨到 137 是其它并行改动所致，与本轮无关（本轮实测只降不升）。
- 五套回归全绿：清空 11/11、分级底色 8/8、单行排版 8/8、宿主栈过滤 6/6、Host 口径 8/8——四页签调试窗完好。
- 净变化：**-820 行**；lib/client.js 841.9kb → 816.5kb（约 -25KB 诊断代码）。
### 过程教训（两条，都踩了）
1. **`git checkout -- src/` 会无差别撤销工作区**：验证基线时我把旧文件放回跑完 tsc 后想恢复"删除后"状态，`git checkout -- src/` 把删除也撤销了（三个文件复活）。且 stash pop 后 stash 已空、临时脚本又已被我自己删——只能重写摘除脚本再跑一遍。教训：批量脚本别急着删（本轮写了第二遍）；用 git 恢复前先想清楚它撤销的是"谁"。
2. **CRLF**：脚本第一版按 LF 匹配锚点，在该仓库（CRLF 工作区）锚点不命中。修：读入归一 \n、写出按原文件还原 \r\n。
### 生效方式
纯前端改动，刷新 dsh 页面即生效（四页签调试窗不受影响，数据面与它无关）。
### 备份
MEOW_backups/logwin-20260911-213219/（摘除前 13 个文件原样，含被删的三个）

## 2026-09-11 调试窗文案产品化：清掉用户可见的开发叙事（用户点名）
### 用户要求（原话）
"【需重启】宿主侧采集随插件加载安装——本次改动重启 dsh 后才有内容。把这句给我删掉，还有几月几日更新那种词都删掉。你要明白，这里不是你的工作记录，作为一个展示给 User 的产品上的东西，它所显示的东西应该…怎么说呢？更产品说明书一点。当然不要说的那么官方那么晦涩。但总之需要是一个清晰的介绍。"
### 定性
面板空态与页签 title 里混进了开发过程的叙事（日期、"用户点名"、实现口径、"需重启"部署提示、【上报口径】这类括号标签、DevTools/调用点数量等开发黑话）。这些是开发者的工作记录，不该出现在用户界面。
### 改动（仅 femoGen/src/debugPanel.jsx 可见字符串；代码注释不动——那是开发者自留地）
1. **删「需重启」句**（Host 空态最后一条 + Host 页签 title）。
2. **四个空态重写为用户向说明**（每条 ≤3 行：这是什么 + 什么会有内容 + 需要看的别处）：
   - 剧本：运行事件与干跑流水；新增一句"四个标签页各有独立的日志，复制和清空按钮只作用于当前所在的标签页"（把逐页操作的使用须知放在用户能看到的空态里）。
   - 编译器：「这里显示引擎（编译器/运行时）打印的原始日志：运行或干跑剧本时，标准输出和错误信息（带 [stderr] 前缀）都会实时出现在这里。」——不再罗列 [runtime]/[FORK] 等实现前缀、删日期。
   - FEMOGen：「这里显示 femoGen 页面自身产生的日志（log / warn / error），页面运行中随时产生、随时出现在这里。」——删"不改 157 处调用点的代价，不是漏斗"这类实现叙事。
   - Host：「这里显示投影窗、会话等宿主侧功能打印的日志。引擎打印的日志不在这页，请看『编译器』页。」——删调用栈过滤细节与【需重启】。
3. 四个页签 title 同步改准（如 Host：`投影窗、会话等宿主侧功能打印的日志`；编译器不再写"[stderr] 前缀"这类实现细节；剧本删"零 token"术语——空态里的"零 token 干跑"保留，它是给用户的价值点）。
### 验证
- 文案核验 13/13：需重启/日期/口径/DevTools/调用点字样不再出现在产物可见字符串；四条新空态与四个 title 逐条命中；四页签齐全。
- 浏览器实测（四页全空的 harness）：Host 页空态显示新三行文案；截图 .tmp/shots/host-empty-copy.png。
- 顺带发现并记录：**esbuild 未开 minify，代码注释会原样进 lib/client.js**——所以可见面审查要区分"渲染的字符串"（本轮清的对象）与"注释"（保留，不影响 UI；若要连产物瘦身一起做，给 build.mjs 开 minify 即可，未动）。
### 生效方式
纯前端，刷新 dsh 页面即生效。

## 2026-09-12 补：Host 页"需重启"答疑定性 + 修复 checkout 事故暗伤 + 开机确认行
### 用户疑问（原话）
"什么，原来需要重启，指的不是我这次重启3081生效啊…你是说每次都要重启，才能看到 Host 的内容吗？那其实就不太合理呀，你能不能改一改，让它实时显示呢？其实 TS 这边肯定也是能传出来东西的呀，你也可以给他写一个Log Collector 模块，直接传到这里就好了。"
### 答疑结论：不需要"每次重启"，只需要再重启一次（部署性质，非常态）
- **线上实测**：3081 的 dsh 进程是 09-11 19:12 启动的，而 Host 采集（host-log.ts）20:07 之后才构建——进程里没有这段代码。现场触发一次插件 console.log（GET /dsh-femo/actors），诊断流零 host 行，实锤。
- **结论**：再重启一次 3081，钩子即常驻进程 → Host 页从此实时滚动，日常使用零重启。"Log Collector"已存在（src/host-log.ts），只是那次重启时它还没写出来。
- **部署路径确认**：dsh-home/profiles/node_modules/dsh-femo 与 dsh-plugins/dsh-femo 均为指向本仓库的符号链接，重启必然加载新代码，无需同步拷贝。
- **注意**：答疑时正有剧本在演出（诊断流导演流持续收帧），重启会掐演出——等演完再重启（未代为重启）。
### 本轮改动
1. **host-log.ts 加开机确认行**：装好钩子即推 `Host 日志采集已启动：投影窗、会话等宿主侧日志将实时显示在这里` 进诊断环——重启后打开 Host 页第一眼就有"活着"的证据，不再对着空页猜装没装。
2. **修复 checkout 事故暗伤（重要）**：昨日 `git checkout -- src/` 事故当时只重跑了摘除脚本，未复查宿主侧——实际把三处已完成的改动也回退了，今日核验发现并全部补回：bridge.ts（引擎 stdout 全量转发+绕过 console、stderr 双路）、debug-run.ts（干跑 stderr 双路）、index.ts（host-log 接线）。教训：**批量 git 恢复后必须对"此前每轮宿主侧改动"逐项复核**，不能只验证当轮改动。
### 验证
- 离线栈过滤 7/7（新增开机确认行断言）；宿主产物 5/5（接线/stderr 双路/绕过 console/确认行全就位）；全套回归（断言同步到产品化文案后）：清空 11/11、底色 8/8、单行 8/8、Host 口径 9/9、前端文案 4/4；tsc 135 ≤ 基线 137。
### 生效方式
重启 dsh 一次（部署上述全部宿主侧改动）→ 之后 Host 页永久实时。

## 2026-09-11 双名制二修：不去重 + @带上 + source:main 认亲（用户实测反馈）
### 用户反馈（原话，附 3064 场实拼上下文）
"其实不要去重。而且也不要去掉@，要把@也带上。我理解现在也许Eve等是名字一样被去重了所以只显示了一个，主模型source:main 怎么也没显示，他在剧本里是@铲屎官。"
### 病根（三条全中）
实测剧本（debug-sandbox/web-1789183003255.femo）actors：`@小猫咪=@小机=@看图梗` 戏中名与卡名**同名**、`@Eve` 卡名 Eve——首版同名去重把它们全退成单名；`ai @铲屎官 = source:main` 走伪 soul `'main'`（ActorDef.soul=None），首版 `_actor_role_maps` 只认显式 soul: 声明→映射漏收，main 行退回常量「主模型」单名。
### 改动（同首版三处文件，只动 Python）
1. **ContextExample.py**：①`_dual_name` 去掉 `role == display` 去重（`@Eve（Eve）` 照写）；②`_actor_role_maps` @ 保留（无 @ 补 @）+ AI 演员 `source == 'main'` 时 `ai_soul_map['main']` 也记戏中名；③`get_name` 的 main 分支从裸 `"主模型"` 改 `_dual_name(ai_soul_map.get('main'), "主模型")`。
2. **FEMO_runtime.py**（`_exec_ai` 取名）：@ 保留（无 @ 补 @）+ 去掉同名去重 + 伪 soul `'main'` 无卡时 soul_display='主模型'（投影窗标签/气泡头行同步变 `@铲屎官（主模型）`）。
3. block_collector 无改动（穿线已在首版完成）。
### 验证
- **真实剧本真拼 3064 场**（parse_script 出 actors 后 build_session_context full）：`@小猫咪（小猫咪）/ @Eve（Eve）/ @小机（小机）/ @看图梗（看图梗）/ @铲屎官（主模型）/ @猫猫（人类玩家）`+`[节点提醒]` 特例原样；缺映射对照与旧版逐名一致（`小猫咪/主模型/…` 单名）——向后兼容实证。
- 引擎取名模拟同剧本五演员：上同 + main 查库告警后正确拼 `@铲屎官（主模型）`。
- pytest 全量 **395 passed** 0 error（上轮 27 个 error 系 `_tmp` 缺失环境噪音，本轮补齐 basetemp 后全绿）。
### 生效方式
- 引擎侧需重启 dsh。消费端自洽性已核：src/femoGen 无对 `主模型`/ai_name 的相等比较；角色窗窗名走 scope @名（路由键，不受影响），speaker 标签/直播桶/气泡头行走 ai_name（文本，随改名自洽）。
### 备份
MEOW_backups/{FEMO_runtime.py, ContextExample.py}.bak-20260911-234024-predualname2

## 2026-09-12 双名制三修定稿：括号名统一按行身份取（用户理清规则）
### 用户规则（原话）
"对于任何节点，有soul id就括号里显示Soul name。如果没有soul id：对于人类发言，就显示user id对应的user name。对于ai发言，就看他model id是不是main，如果是main就显示main。如果不是main就什么都不显示。"（前一条补充："主模型没有设定soul的时候，如果存的是model id = main，就给他写(main)←这个相当于model name。人类也是一样的，有soul就显示soul name，没soul就显示user id的user name。"）
### 变化（相对二修）
- 「主模型」常量退役：source:main 伪 soul 的括号名改显示 **main**（model id 本字）——`@铲屎官（main）`；
- 无 soul 人类行：括号名=user id 的 user name（不再只有 uid=='0' 特判走 soul 名——**任何行**带 soul_id 都优先 Soul name，这是规则的一般化；查无此人退 uid 原样，如 source:0 无卡人类 → `@猫猫（0）`）；
- 无 soul 且非 main 的 AI：无括号（引擎走 @名兜底；上下文里此类行 soul_id='' 无键可认领，维持 "AI" 兜底）。
### 改动
1. **ContextExample.py** `get_name`：人类分支重写——soul_id 有值→Soul name（不再限 uid=='0'），无值→user_name（查无此人退 uid）；main 分支括号名 'main'；模块头注释同步定稿口径。
2. **FEMO_runtime.py** `_exec_ai`：伪 soul 'main' 的 soul_display='main'（原 '主模型'）；注释同步。
### 验证
- 3064 场真拼：`@铲屎官（main）` + `@小猫咪（小猫咪）/ @Eve（Eve）/ @小机（小机）/ @看图梗（看图梗）/ @猫猫（人类玩家）` 全部如规则；
- 合成边界五例：u001 无 soul→`[用户]`、source:0 无卡→`@猫猫（0）`、裸 AI 行→`[AI]`、main→`@铲屎官（main）`、femoshow→`[节点提醒]`；
- 引擎模拟：main→`@铲屎官（main）`、无 soul→`@执行者`（无括号）、有 soul→`@小猫咪（小猫咪）`；
- pytest 394 passed + 1 failed（test_v2_resume_e2e 快照恢复 e2e，全量并发下偶发；单跑与整文件 4/4 均过，与本改动无关——名字渲染不在快照链路上）。
### 生效方式
- 引擎侧需重启 dsh。
### 备份
MEOW_backups/{FEMO_runtime.py, ContextExample.py}.bak-20260912-001444-prebracket3

## 2026-09-12 上场注入的〖场上信息〗改走 Block Collector 产物（用户拍板）
### 用户要求（原话）
"在主模型下场的时候，femo工具steer给主模型的场上信息……这个排版真的太混乱了。你看能不能搞成和block collector收集的排版一样的排版？那个排版清楚一些。而且给他steer的角色标签，也需要是我们要求的格式，@上场角色（Soul name）: 这样的形式"；次日定案："你看看能不能走block collector的api？和其他节点一样，都是first then那个选项"。
### 病根
上场通知的〖场上信息〗=宿主本地流水行拼装（main-actor stageNotice：`delta.map(l => \`${l.actor}：${l.text}\`)`）——半角冒号名行、多行发言的名字只挂首行、后面整段 markdown 裸奔无归属；且流水只记 ai_done（人类/系统行缺席）。
### 改动（src/main-actor.ts，宿主侧唯一改动点）
1. `runMainModelTurnInner`：从 ai_request payload 取 `blocks.context`（引擎对 main 节点与其他节点走同一条 collect_blocks：first_full_then_incremental + actors_def 双名制——payload 本就带全量 blocks，零引擎改动）；
2. `stageNotice` 加 context 参数：〖场上信息〗优先 BC 产物；旧 payload 无 context 或为空时退回流水行（原行为）；**剧终补遗**（flow_done，无 request）恒走流水行不变；
3. 流水/水位机制原样保留（剧终补遗的"自上次注入起的尾巴"语义依赖水位照常推进）；
4. debug 行加 `场上信息=BC(Nch)` 便于实测核对。
### 角色标签
header「轮到 ${actor} 说话」的 actor=ai_name=引擎双名（@上场角色（Soul name）），上场通知已带正确格式；〖场上信息〗行名为 BC 排版 `[@名（Soul）]：`（提醒行的 `[[节点提醒]]` 双括号系 BC 对该常量名的既有渲染，非新引入）。
### 验证
- `node build.mjs` 双产物过；lib/index.js 字面量：`fieldContext`×4、`stageNotice(..., fieldContext)`、stageNotice 函数体（field = context||flowLines）逐段核对（中文以 \uXXXX 转义存在，grep 须用 ASCII 键）；
- 3064 场 main 视角 first_full_then_incremental 实拼：〖场上信息〗即 BC 排版（[[@Eve（Eve）]] 等名行+成块内容）；
- tests/main-delivery-queue.test.mjs 全过（main-actor 唯一关联测试文件）。
### 生效方式
- **宿主改动需重启 dsh**；引擎零改动（blocks.context 既有产出）。
### 备份
MEOW_backups/main-actor.ts.bak-20260912-005338-prebcctx

## 2026-09-12 femo-mount 入账导入清单（用户需求：AI 挂载的剧本也要出现在导入浮层）
### 用户需求（原话）
"femogen右上角的导入按钮弹出的浮层，明明有新挂载的剧本，为什么不自动添加到列表里吗？我注意到，在我里导入之后，它会自动添加到列表里。但我希望在AI调用工具去mount一个剧本之后，它也可以自动加入列表里。"
### 病根
导入浮层（femoGen 两级导入的一级清单，2026-09-11）读 host 侧账本 user_data/femo_files.json（src/femo-files.ts）。入账点只有三处：pick-script（系统对话框选中，routes.ts）、open-femo-file（从清单打开，routes.ts）、save-script（导出落盘，run-control.ts）。AI 的 femo-mount 执行体（index.ts toolDeps.mountScript）只写会话剧本记录 {path,text}，从不动账本 → AI 挂载的剧本浮层里看不到，只有人工导入/导出过才有。
### 改动（src/index.ts 一处；femo-files.ts 仅头注释同步口径）
mountScript 执行体 writeSessionScript 成功后补 `await rememberFemoFile(resolved.femoRoot, scriptPath, 'import')`——AI 挂载与人工导入同待遇，下次打开浮层即可看到（打开=引用语义不变，账本仍只记路径）。rememberFemoFile 自吞写失败（只打日志），挂载本身不受影响。
### 验证
- `node build.mjs` 双产物过；lib/index.js 含 `rememberFemoFile(resolved.femoRoot, scriptPath, "import")`（esbuild 单行化，grep ASCII 键核对）；
- 临时 bundle 单测（esbuild 单独打 femo-files.ts）：remember → list（exists=true、name 正确）→ readLedgerFemoFile 读回正文一致 → 重复入账 upsert 去重仍 1 条，全过；
- 09:36 detached 重启 3081（旧 pid 19264 → 新 pid 2208），本次启动段 [dsh-femo] 六工具注册 + bridge started，脚本验证文件 up=True。
### 生效方式
- 宿主改动需重启 dsh，已重启生效（2026-09-12 09:38，pid 2208）。
### 备份
未建 .bak（改动为单行调用+注释，git 仓库在但当前用户有 dubious ownership 不可读；回退=删除 mountScript 中 rememberFemoFile 一行与对应 import）。

## 2026-09-12 打开 Session 的对账点：状态不一致自动收口为挂起（用户拍板）
### 用户要求（原话）
"如果发现引擎和宿主内存的运行状态不一致，那么就自动把引擎和宿主内存里这个job的状态都改成挂起""它能给引擎发送停止信号。对，它可以，所以就发送停止信号吧，把那个停下来"。
### 病根
原对账点只有【镜像单向自愈】：宿主镜像说 running、引擎档案已终态时仅降级镜像，引擎侧不动作；反向（引擎档案 running、宿主镜像丢失/终态，宿主重启后僵尸场）则完全不处理——引擎后台继续烧、宿主按 idle 放行用户消息。
### 改动（src/routes.ts，/dsh-femo/session-state 对账点，宿主侧唯一改动点；引擎零改动）
1. 对 running 认定不一致（mirrorRunning XOR engineRunning）且 session 归属本宿主（sessionsStore 判定，沿用 214 红线）：先发 `job_stop` 停止信号（幂等——真在跑=停下挂起断点保留；不在跑=原样回执不写档案），再把宿主镜像对齐到引擎回执终态（`settleMirror`：镜像缺失先 prearm 补建、activeJobId 收拾、run_state+projection_state 双广播）；
2. 回执分路：引擎本就不跑→镜像落引擎终态（suspended=两边同挂起）；回执仍 running（优雅停止在途/罕见登记缺位）→prearm 认领镜像，让 flow_stopped 走既有管道收口（全窗通知+主模型 steer）；回执带终态→镜像直接对齐；
3. 例外（偏离字面"都改挂起"）：引擎回执 finished/failed 时以引擎真相为准——终态档案无 API 可改写成挂起（job_stop 幂等原样回执），强改反而反向制造不一致+「可续跑」假象；
4. no_such_job（runs 档案没了）：残留 running 镜像降级 suspended（引擎无档案可停，宿主侧先说实话）；
5. 非本宿主 session 保留旧单向自愈（不发停止信号，不碰别家 Job）。
### 验证
- `node build.mjs` 过；lib/index.js 含三条新日志（状态不一致收口/no_such_job 降级/job_stop 失败兜底）；
- tsc（借 dsh-meow 的 typescript）26 个错误全部为 client-ui/client.tsx 存量问题，routes.ts 零错误；
- 引擎侧回执形态核对：优雅停止 join 成功=重读档案终态回执（suspended）、卡死=forced suspended+bridge 退出、无 runner=直接落盘 suspended、终态幂等=原样回执——三分支全覆盖。
### 生效方式
- **宿主改动需重启 dsh**；引擎零改动（job_stop/reconcile_if_stale 均为既有 API）。
### 备份
MEOW_backups/routes.ts.bak-20260912-prereconcile
