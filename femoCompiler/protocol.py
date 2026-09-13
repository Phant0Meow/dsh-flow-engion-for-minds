"""引擎对外协议——TranscriptStep 契约与归一化（引擎与宿主的握手面，单一权威）。

【TranscriptStep 契约（wire 形态）】
AI 节点一场演出的结构化转写。宿主代跑 LLM 时，随 human_input 回传的
body.steps 逐项必须长这样（直连模式未来的 agent loop 产出同构）：

    {
      "step":         <int>                                   # 第几轮（从 0 起）
      "cot":          <str>                                   # 该轮思考（全量，读取侧管可见性）
      "reply":        <str>                                   # 该轮台词（assistant 文本）
      "tool_calls":   [{"name": <str>, "arguments": <str>}, ...]  # 该轮工具命令
      "tool_results": [<str>, ...]                            # 该轮工具结果（与 tool_calls 按序配对）
    }

- 生料契约：tool_calls / tool_results 是结构化原文，不带任何展示排版。
  排版（[TOOL CALL #N] 模板）由引擎在落档前套用（format_tool_blocks）——
  全世界只有引擎这一份模板，任何 harness 存出的档案格式保证一致。
- 兼容：旧宿主 payload 的 toolCall / toolResult（成品字符串）原样透传；
  trajectory 整段兜底在 runtime 侧（FEMO_runtime._invoke_ai_llm）。

【档案形态（archive 形态）】
normalize_transcript_steps 的输出，即 save_dialog.save_ai_finish 消费的
[{step, cot, reply, toolCall, toolResult}]：toolCall = 命令 JSON 文本，
toolResult = 模板排版文本。档案键名维持历史形状（femoGen 回放 / chronica
读取侧依赖），不随 wire 契约更名。
"""

import json


def format_tool_blocks(calls, results):
    """把一轮的工具命令/结果排成档案文本（[TOOL CALL #N] 模板）。

    命令与结果按序配对：第 i 条命令对第 i 条结果；一方缺位即跳过对应段。
    纯函数——直连模式与宿主模式都经这里落档，保证档案格式唯一。"""
    n = max(len(calls), len(results))
    parts = []
    for i in range(n):
        c = calls[i] if i < len(calls) else None
        r = results[i] if i < len(results) else ''
        lines = [f'[TOOL CALL #{i + 1}]']
        if c:
            lines.append(f"{c.get('name', '')}({c.get('arguments', '')})")
        if r:
            lines.append(f'[TOOL CALL #{i + 1} RESULT]')
            lines.append(r)
        lines.append(f'[TOOL CALL #{i + 1} END]')
        parts.append('\n'.join(lines))
    return '\n\n'.join(parts)


def normalize_transcript_steps(steps):
    """宿主回传 steps → 档案形态（save_ai_finish 的 steps 参数形状）。

    - 新契约（tool_calls/tool_results 结构化生料）→ 套模板成档案形态；
    - 旧 payload（toolCall/toolResult 成品字符串）→ 原样透传；
    - 非法项（非 dict / 缺键）宽容降级，绝不 raise（转录是观测数据，
      格式问题不该炸演出）。"""
    if not isinstance(steps, list):
        return []
    out = []
    for s in steps:
        if not isinstance(s, dict):
            continue
        base = {
            'step': s.get('step', 0),
            'cot': str(s.get('cot', '') or ''),
            'reply': str(s.get('reply', '') or ''),
        }
        if 'tool_calls' in s or 'tool_results' in s:
            calls = s.get('tool_calls') or []
            results = s.get('tool_results') or []
            if not isinstance(calls, list):
                calls = []
            if not isinstance(results, list):
                results = []
            base['toolCall'] = (
                json.dumps(calls, ensure_ascii=False, separators=(',', ':')) if calls else ''
            )
            base['toolResult'] = format_tool_blocks(calls, results)
        else:
            base['toolCall'] = str(s.get('toolCall', '') or '')
            base['toolResult'] = str(s.get('toolResult', '') or '')
        out.append(base)
    return out


# ═══ ai_request.blocks 词汇契约（料包：键 = 料的语义，值 = 纯文本）═════════
#
# blocks 是引擎交给「执行后端」的原料包。键的词汇表归引擎所有（下面这份表即
# 权威）；拼装（键 → system/user 的分配、顺序、垫话）归执行后端——宿主后端
# 拼装器（接口侧 subagent.ts 的 buildSubagentPrompt）是宿主模式的正身；直连
# 模式拼装器（femoBridges/llmBridge，`from prompt_assembler import assemble`
# 恒 ImportError、inline 分支即实际生效实现）归引擎内部。两个拼装器各自服务
# 自己的后端，无需逐字同步——唯一共享契约 = 下面这份键词汇表。
#
# 特殊键说明：soul 在两种后端走不同注入路（宿主=子代理 persona；直连=system），
# 这是身份注入机制差异，不是契约漂移。
BLOCK_KEYS = {
    'basic_safety': '安全底线声明 → system 层',
    'basic_output': '输出风格/格式要求 → system 层',
    'soul': '演员 soul 卡描述（souls.description）。宿主模式不进 prompt——走子代理 persona；直连模式进 system',
    'user_info': '演员对应用户（human 身份）的资料 → system 层',
    'context': '场上可见发言流水（scope 视角过滤后）→ user 层前部',
    'prompt': '本节点指令 → user 层；有 memory 时 user 末尾再重复一次（提醒当前任务）',
    'memory': '该演员的记忆检索结果 → user 层中段（垫「[回忆]」提示）',
    '_actor_info': '引擎私有（dict 非文本，身份元数据）——随包透传，不得当文本拼',
}
# 契约外键：剧本可挂自定义 context 方法，其产出会以自定义键写入 blocks
# （block_collector 收集）。宿主拼装器当前不识别 → 忽略 + 告警（可见性），
# 即自定义 context 料仅在直连模式生效——这是已知边界，不是事故。


# ═══ 主模型下场的可见性判定（已知镜像清单）════════════════════════════════
# scope 语义（谁看得见谁的台词）归引擎所有。两处消费：
# - 子代理演员：引擎过滤（block_collector 收集 context 时按 scope 裁决）；
# - 主模型演员（source:main）：引擎逐行发 scope 名单，宿主镜像执行同一谓词
#   （接口侧 main-actor.ts isMainVisible：scope 未限定=全员可见，否则含任一
#   main 演员=可见；main 演员本人的台词不入账——天然在主窗历史里）。
# ⚠️ 引擎若扩展 scope 语义（新语法/新可见性规则），必须同步宿主镜像——
# 本节即同步清单。宿主的增量投递账本（水位/steer）是投递方记账，不属引擎语义。
