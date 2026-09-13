"""
block_collector.py — Block 收集器
===================================
根据当前 Action、Meta、Actor 等信息，收集所有 prompt block，
返回一个标准的 blocks 字典，供外部框架的 prompt 组装器使用。

Block 清单：
  basic_safety  — 安全须知
  basic_output  — 输出质量要求
  soul          — 角色描述（system prompt 片段）
  user_info     — 用户信息
  memory        — 记忆检索结果
  context       — 对话历史上下文
  prompt    — 当前 Action 的 prompt（已变量替换）
"""

import os
from typing import Dict, Any, Optional, List, Tuple

from femoBridges.ContextExample import build_session_context, MODE_FULL


def _load_file_or_text(value: str, base_dir: str = "") -> str:
    """
    根据新规则加载内容：
    - file:"path" → 读取文件（绝对路径直接用；相对路径相对 base_dir=剧本目录；
      未保存态 base_dir 为空时相对路径报错）
    - "文本" 或 裸文本 → 字面量
    """
    if not value:
        return ""
    value = value.strip()

    # 检查是否是 file:"..." 格式
    if (
        (value.startswith('file:"') and value.endswith('"'))
        or (value.startswith('file：\u201c') and value.endswith('\u201d'))
        or (value.startswith('文件：\u201c') and value.endswith('\u201d'))
    ):
        filepath = value[6:-1]  # 去掉 file:" 和 结尾的 "
        if os.path.isabs(filepath):
            full_path = filepath
        elif base_dir:
            full_path = os.path.join(base_dir, filepath)
        else:
            print(f"[block_collector] ❌ 相对路径需要剧本文件地址: {filepath}")
            raise FileNotFoundError(
                f"相对路径 '{filepath}' 需要剧本文件地址（剧本未保存）。"
                f"请先「导出 .FEMO」保存剧本，或改用绝对路径。"
            )
        if not os.path.exists(full_path):
            print(f"[block_collector] ❌ 文件不存在: {full_path}")
            raise FileNotFoundError(f"文件不存在: {full_path}")
        try:
            with open(full_path, 'r', encoding='utf-8') as f:
                content = f.read()
            print(f"[block_collector] 📄 加载文件: {full_path} ({len(content)} 字符)")
            return content
        except Exception as e:
            print(f"[block_collector] ❌ 文件读取失败: {full_path}, 错误: {e}")
            raise
    # 否则是字面量：去掉可能包裹的普通引号（与 YAML 兼容）
    if (
        (value.startswith('"') and value.endswith('"'))
        or (value.startswith('\u201c') and value.endswith('\u201d'))
    ):
        return value[1:-1]
    return value



def _parse_method_ref(method_str: str) -> Tuple[Optional[str], Optional[str], dict]:
    """
    解析 'module.function' 或 'method_name' 格式的方法引用。
    返回 (module_name, function_name, kwargs)
    """
    if not method_str:
        return None, None, {}
    
    method_str = method_str.strip()
    
    # 格式：module.function
    if '.' in method_str:
        parts = method_str.split('.', 1)
        return parts[0], parts[1], {}
    
    # 格式：method_name（需要在已注册的方法表中查找）
    return None, method_str, {}


def collect_blocks(
    action,
    meta: dict,
    actors_def: dict,
    var_manager,
    code_modules: dict,
    memory_defs: dict = None,
    context_defs: dict = None,
    session_id: int = 1,
    turn_id: int = 0,
    actor_info: dict = None,
    runner=None,
    base_dir: str = ".",
    evaluator=None,
    context_mode: str = MODE_FULL,
) -> Dict[str, str]:
    """
    收集所有 prompt block，返回字典。

    参数：
        action: 当前 Action 定义对象
        meta: 剧本 meta 字典
        actors_def: 剧本 actors 字典
        var_manager: VarFacade 实例（R2 起：get/set 同名接口，VarManager 退役）
        evaluator: Evaluator 实例（R2 接线：prompt/showprompt 的 {var} 替换统一
                   走 evaluator.interpolate_prompt——修复旧 hasattr 恒 False 导致
                   blocks 侧 showprompt 从不替换变量的 bug）
        code_modules: 已加载的 Python 模块字典 {alias: module}
        registered_methods: 已注册的方法字典 {method_name: (module_alias, func_name)}
        session_id: 当前 session ID
        base_dir: 剧本文件所在目录
        context_mode: 默认上下文拼接模式（full/incremental/first_full_then_
                      incremental）。由调用方传入——DSH 宿主后端在 femo_bridge
                      钉 first_full_then_incremental，直连等老调用方吃默认 full。
                      只作用于默认 context 路径；剧本显式声明的自定义 context
                      方法优先级更高，不受此参数影响。

    返回：
        blocks 字典，包含 basic_safety, basic_output, soul, user_info,
                      memory, context, prompt
    """
    blocks = {}
    
    print(f"[DEBUG collect_blocks] actor_info = {actor_info!r}")

    # ── 1. basic_safety ──
    safety = meta.get('system_safety', '')
    blocks['basic_safety'] = _load_file_or_text(safety, base_dir)

    # ── 2. basic_output ──
    output_style = meta.get('output_style', '')
    blocks['basic_output'] = _load_file_or_text(output_style, base_dir)

    # ── 3. soul（角色描述） ──
    blocks['soul'] = ""
    #print(f"[DEBUG] actor_info 完整值: {actor_info}")
    #print(f"[DEBUG] 'soul' 是否在 actor_info 中: {'soul' in (actor_info or {})}")
    if actor_info and 'soul' in actor_info:
        try:
            from femoCompiler.db_utils import get_soul_system_prompt
            blocks['soul'] = get_soul_system_prompt(actor_info['soul'])
            #print(f"[block_collector] 🎭 加载 soul_id={actor_info['soul']} 的角色描述 ({len(blocks['soul'])} 字符)")
        except Exception as e:
            print(f"[block_collector] ⚠️ 加载 soul 失败: {e}")

    # ── 4. user_info（剧本 owner 信息） ──
    blocks['user_info'] = ""
    owners = meta.get('owner', [])
    if owners:
        if not isinstance(owners, list):
            owners = [owners]
        profiles = []
        try:
            from femoCompiler.db_utils import get_user_by_id
            for uid in owners:
                user = get_user_by_id(uid)
                if user:
                    print(f"[block_collector] 👤 用户: id={uid}, 名字={user.get('user_name', '')}, user_id={user.get('user_id', '')}")
                    parts = [f"用户名字: {user.get('user_name', '')}"]
                    profile = user.get('profile')
                    if profile:
                        parts.append(f"用户简介: {profile}")
                    profiles.append("\n".join(parts))
            if profiles:
                blocks['user_info'] = "\n\n".join(profiles)
        except ImportError:
            print("[block_collector] ⚠️ 无法导入 db_utils，跳过 user_info 加载")

    # ── 5. memory ──
    blocks['memory'] = ""
    memory_defs = memory_defs or {}
    memory_ref = getattr(action, 'memory', None)
    
    if memory_ref and memory_ref in memory_defs:
        method_def = memory_defs[memory_ref]
        print(f"[block_collector] 🧠 调用 memory: {memory_ref} → {method_def.module_alias}.{method_def.func_name}")
        _call_method_and_assign(
            method_def, code_modules, var_manager, blocks, 'memory',
            session_id, turn_id, actor_info, runner,
        )
    elif memory_ref:
        print(f"[block_collector] ⚠️ 未找到 memory 定义: '{memory_ref}'")
        # memory 没有默认实现，保持空
    else:
        if memory_defs:
            first_key = list(memory_defs.keys())[0]
            method_def = memory_defs[first_key]
            print(f"[block_collector] 🧠 未指定 memory，使用第一个: {first_key} → {method_def.module_alias}.{method_def.func_name}")
            _call_method_and_assign(
                method_def, code_modules, var_manager, blocks, 'memory',
                session_id, turn_id, actor_info, runner
            )
        # 没有定义 memory，保持空（memory 非必须）

    # ── 6. context ──
    blocks['context'] = ""
    context_defs = context_defs or {}
    context_ref = getattr(action, 'context', None)
    
    # 调试：看看到底传了什么进去
    #print(f"[DEBUG context] actor_info = {actor_info!r}")
    if actor_info:
        user_ids = [str(actor_info['user'])] if 'user' in actor_info else []
        soul_ids = [str(actor_info['soul'])] if 'soul' in actor_info else []
        #print(f"[DEBUG context] 即将查询 context: user_ids={user_ids}, soul_ids={soul_ids}")
    
    if context_ref and context_ref in context_defs:
        method_def = context_defs[context_ref]
        #print(f"[block_collector] 📖 调用 context: {context_ref} → {method_def.module_alias}.{method_def.func_name}")
        _call_method_and_assign(
            method_def, code_modules, var_manager, blocks, 'context',
            session_id, turn_id, actor_info, runner
        )
    elif context_ref:
        print(f"[block_collector] ⚠️ 未找到 context 定义: '{context_ref}'，走默认 context 路由: mode={context_mode}")
        # actors_def 穿线（2026-09-11 双名制）：上下文发言行显示「戏中名（Soul name）」
        blocks['context'] = build_session_context(session_id, actor_info or {}, context_mode, actors_def)
    elif context_defs:
        # 没有指定 context 但剧本定义过：用第一个定义的（原行为保留）
        first_key = list(context_defs.keys())[0]
        method_def = context_defs[first_key]
        #print(f"[block_collector] 📖 未指定 context，使用第一个: {first_key} → {method_def.module_alias}.{method_def.func_name}")
        _call_method_and_assign(
            method_def, code_modules, var_manager, blocks, 'context',
            session_id, turn_id, actor_info, runner,
        )
    else:
        # 默认：走上下文路由入口（full / incremental / first_full_then_incremental，
        # 由调用方经 context_mode 决定；缺省 full = 原默认行为）
        print(f"[block_collector] 📖 默认 context 路由: mode={context_mode}")
        # actors_def 穿线（2026-09-11 双名制）：上下文发言行显示「戏中名（Soul name）」
        blocks['context'] = build_session_context(session_id, actor_info or {}, context_mode, actors_def)

    # ── 7. prompt ──
    raw_prompt = action.prompt or ""
    # 完整替换走 Evaluator.interpolate_prompt（R2 接线：支持 @actor.attr 属性
    # 访问/动态键/in_mappings 已由调用方预替换）。evaluator 缺席时退化到
    # var_manager.get 的宽松分支（无 Evaluator 的防御路径）。
    if evaluator is not None and var_manager is not None:
        prompt_text = evaluator.interpolate_prompt(raw_prompt, var_manager)
    else:
        import re
        def replacer(m):
            var_path = m.group(1)
            try:
                val = var_manager.get(var_path)
                return str(val) if val is not None else m.group(0)
            except Exception:
                return m.group(0)
        prompt_text = re.sub(r'\{([^}]+)\}', replacer, raw_prompt)

    # 如果有 showprompt，拼接到 prompt 前面作为提醒
    # （R2 修复：旧 hasattr(var_manager,'_replace_prompt_vars') 恒 False——
    #   blocks 侧 showprompt 从不替换变量；现与 prompt 同走 Evaluator）
    showprompt_raw = getattr(action, 'showprompt', '') or ''
    if showprompt_raw:
        if evaluator is not None and var_manager is not None:
            showprompt_text = evaluator.interpolate_prompt(showprompt_raw, var_manager)
        else:
            showprompt_text = showprompt_raw
        prompt_text = f"[提醒]\n{showprompt_text}\n\n{prompt_text}"

    # 为 prompt 加上用户标签（与 context 中的格式一致）
    user_name = None
    if actor_info and 'user' in actor_info:
        uid = str(actor_info['user'])
        if uid.startswith('femo-'):
            user_name = '[节点提醒]'
        else:
            try:
                from femoCompiler.db_utils import get_user_by_id
                user = get_user_by_id(uid)
                if user:
                    user_name = user.get('user_name', uid)
            except:
                pass
    if not user_name:
        # 如果 actor_info 中没有 user 字段，说明 prompt 来自剧本，使用 [提醒]
        if not actor_info or 'user' not in actor_info:
            user_name = '[节点提醒]'
        elif meta.get('owner'):
            owner_id = meta['owner'][0] if isinstance(meta['owner'], list) else meta['owner']
            if isinstance(owner_id, str) and owner_id.startswith('femo-'):
                user_name = '[节点提醒]'
            else:
                try:
                    from femoCompiler.db_utils import get_user_by_id
                    user = get_user_by_id(str(owner_id))
                    if user:
                        user_name = user.get('user_name', str(owner_id))
                except:
                    pass
    if user_name:
        blocks['prompt'] = f"{user_name}：\n{prompt_text}"
    else:
        blocks['prompt'] = prompt_text
    
    # 记录 actor_info 供其他模块使用
    blocks['_actor_info'] = actor_info

    #print(f"[block_collector] 📦 Block 收集完成:")
    for key in ['basic_safety', 'basic_output', 'soul', 'user_info', 'memory', 'context', 'prompt']:
        val = blocks.get(key, '')
        #if val:
        #    print(f"\n--- {key} ---")
        #    print(val)

    return blocks



def _call_method_and_assign(
    method_def,
    code_modules: dict,
    var_manager,
    blocks: dict,
    block_key: str,
    session_id: int,
    turn_id: int,
    actor_info: dict,
    runner=None,
):
    """
    根据 MethodDef 调用用户 Python 函数，并将返回值和 out 写入 blocks。
    """
    # 获取模块和函数
    module = code_modules.get(method_def.module_alias)
    if not module:
        print(f"[block_collector] ⚠️ 模块 {method_def.module_alias} 未加载")
        return
    func = getattr(module, method_def.func_name, None)
    if not func:
        print(f"[block_collector] ⚠️ 函数 {method_def.func_name} 在模块 {method_def.module_alias} 中未找到")
        return

    # 构建参数
    kwargs = {}
    for param in method_def.in_params:
        if runner and hasattr(runner, '_resolve_special_param'):
            val = runner._resolve_special_param(param)
            if val is not None:
                if param == '@actor':
                    kwargs['actor_info'] = val
                else:
                    kwargs[param.lstrip('@')] = val
                continue
        # 普通变量
        if param.startswith('@'):
            if param == '@actor':
                kwargs['actor_info'] = actor_info
            else:
                kwargs[param[1:]] = actor_info
        elif param in ('session', 'session_id'):
            kwargs[param] = session_id
        elif param in ('turn', 'turn_id'):
            kwargs[param] = turn_id
        elif param == 'prompt':
            kwargs[param] = blocks.get('prompt', '')
        else:
            kwargs[param] = var_manager.get(param)


    # 调用
    result = func(**kwargs)

    # 处理 out 赋值
    if method_def.out_defs and result is not None:
        def _do_set(var_name, value):
            try:
                var_manager.set(var_name, value)
            except Exception as e:
                # 给出明确提示后，继续抛出错误终止流程
                print(f"[block_collector] ❌ 变量赋值失败：'{var_name}' 未声明。请在 vars: 中声明该变量。")
                raise

        if isinstance(result, tuple):
            for i, out_def in enumerate(method_def.out_defs):
                if i < len(result):
                    _do_set(out_def.var_name, result[i])
        elif isinstance(result, dict):
            for out_def in method_def.out_defs:
                if out_def.var_name in result:
                    _do_set(out_def.var_name, result[out_def.var_name])
        else:
            if method_def.out_defs:
                _do_set(method_def.out_defs[0].var_name, result)

    # 最后把结果放入对应 block
    if isinstance(result, str):
        blocks[block_key] = result
    else:
        blocks[block_key] = str(result) if result else ""
