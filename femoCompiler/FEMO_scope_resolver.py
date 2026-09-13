"""
FEMO_scope_resolver.py — Scope 解析模块
===================================
将 FEMO 语法中的 scope 表达式转换为纯数字的 user_scope 和 soul_scope 列表。

输入：FEMO 的 scope 列表，如 [@hostgod, @wolfbob, {alive_players}]
输出：(user_scope: List[int], soul_scope: List[int])
  - 正数 → soul_id（存入 soul_scope）
  - 负数 → user_id（取绝对值存入 user_scope）
  
!!!不不不，已经改了，再也不要纯数字了！我们用字符串，保留字符串！
"""

from typing import List, Tuple, Any, Optional, Dict


def resolve_scope(
    scope_str: str,
    actors: Dict[str, Any],
    var_manager,
) -> Tuple[List[str], List[str]]:
    """
    解析 scope 字符串，支持新语法：
      [@God, @Diana, @someactor_var] + somevar_list
    返回 (user_scope, soul_scope)，所有 ID 均为字符串。
    """
    # ── 0. 保留字段：all（大小写不敏感）= 全可见（所有 actors）──
    if scope_str.strip().lower() == 'all':
        user_scope, soul_scope = [], []
        for name, actor in actors.items():
            if hasattr(actor, 'type') and actor.type.value == 'ai':
                sid = getattr(actor, 'soul', None)
                if sid is not None:
                    soul_scope.append(str(sid))
                elif str(getattr(actor, 'source', None) or '').strip() == 'main':
                    # source:main 裸演员：伪 soul "main" 作为可见性键（参考 human
                    # 用 source 当身份的处理，但主模型不是 user——落 soul_scope）
                    soul_scope.append('main')
            elif hasattr(actor, 'type') and actor.type.value == 'human':
                source = getattr(actor, 'source', None)
                if source is not None:
                    user_scope.append(str(source))
                sid = getattr(actor, 'soul', None)
                if sid is not None:
                    soul_scope.append(str(sid))
        return sorted(set(user_scope)), sorted(set(soul_scope))

    # ── 1. 按 + 号分段（注意保护方括号内的内容）────
    parts = _split_scope_by_plus(scope_str)

    # ── 2. 展开每一段 ──
    actor_names = []
    for part in parts:
        part = part.strip()
        if part.startswith('['):
            # 去掉方括号，按逗号切分
            inner = part[1:-1]
            items = [x.strip() for x in inner.split(',') if x.strip()]
        else:
            # 视为变量名，从 var_manager 取值（应为列表）
            var_name = part
            val = var_manager.get(var_name)
            if isinstance(val, list):
                items = [str(x) for x in val]
            elif isinstance(val, str) and val.startswith('@'):
                items = [val]
            else:
                raise ValueError(f"scope 中的变量 '{var_name}' 不是列表或 actor 引用：{val}")
        # 对 items 中的每一项再解析（可能是变量引用）
        for item in items:
            resolved = _resolve_single_actor(item, actors, var_manager)
            actor_names.append(resolved)

    # ── 3. 根据 actor 类型分类为 user_scope / soul_scope ──
    user_scope = []
    soul_scope = []
    for name in actor_names:
        actor = actors.get(name)
        if not actor:
            raise ValueError(f"scope 中的 actor '{name}' 未在 actors 中声明")
        # AI actor
        if hasattr(actor, 'type') and actor.type.value == 'ai':
            soul_id = getattr(actor, 'soul', None)
            if soul_id is not None:
                soul_scope.append(str(soul_id))
            elif str(getattr(actor, 'source', None) or '').strip() == 'main':
                # source:main 裸演员：伪 soul "main" 作为可见性键
                soul_scope.append('main')
        # Human actor
        elif hasattr(actor, 'type') and actor.type.value == 'human':
            source = getattr(actor, 'source', None)
            if source is not None:
                user_scope.append(str(source))
            soul_id = getattr(actor, 'soul', None)
            if soul_id is not None:
                soul_scope.append(str(soul_id))

    user_scope = sorted(set(user_scope))
    soul_scope = sorted(set(soul_scope))
    return user_scope, soul_scope


def _split_scope_by_plus(scope_str: str) -> List[str]:
    """按 + 分割，但跳过方括号内的内容"""
    parts = []
    bracket_depth = 0
    current = []
    for ch in scope_str:
        if ch == '[':
            bracket_depth += 1
            current.append(ch)
        elif ch == ']':
            bracket_depth -= 1
            current.append(ch)
        elif ch == '+' and bracket_depth == 0:
            parts.append(''.join(current).strip())
            current = []
        else:
            current.append(ch)
    if current:
        parts.append(''.join(current).strip())
    return parts


def _resolve_single_actor(item: str, actors: Dict[str, Any], var_manager) -> str:
    """将 scope 中的一个 token 解析为确定的 @actor 名字"""
    item = item.strip()
    # 如果已经是 @xxx 且存在于 actors 中，直接返回
    if item in actors:
        return item
    # 如果是 @xxx 但不在 actors 中，从变量中取值
    if item.startswith('@'):
        val = var_manager.get(item)
        if val and isinstance(val, str) and val.startswith('@'):
            # 递归解析变量链（最多 10 层）
            for _ in range(10):
                if val in actors:
                    return val
                new_val = var_manager.get(val)
                if new_val and isinstance(new_val, str) and new_val.startswith('@'):
                    val = new_val
                else:
                    break
            if val in actors:
                return val
        raise ValueError(f"无法解析 scope 中的动态 actor：{item}")
    # 纯数字字符串等，不应该出现在这里
    raise ValueError(f"scope 中出现非法 token：{item}")

def scope_to_db_format(
    user_scope: List[int],
    soul_scope: List[int],
) -> Tuple[List[int], List[int]]:
    """
    确保 scope 都是正数且去重（已经由 resolve_scope 完成）。
    这里提供一个明确的接口，方便后续扩展（如添加默认 owner 等）。
    """
    return (sorted(set(user_scope)), sorted(set(soul_scope)))


def parse_scope_field(scope_str: str) -> List[str]:
    """解析数据库中存储的 scope 字段（JSON 数组字符串），返回字符串列表"""
    import json
    try:
        return json.loads(scope_str) if scope_str else []
    except (json.JSONDecodeError, TypeError):
        return []


def ids_match_scope(scope_list: List[str], target_ids: List[str]) -> bool:
    """
    检查 target_ids 中是否有任意一个 id 出现在 scope_list 中。
    """
    if not scope_list or not target_ids:
        return False
    scope_set = set(str(x) for x in scope_list)
    target_set = set(str(x) for x in target_ids)
    return bool(scope_set & target_set)


def scope_str_to_actor_list(scope_str: str, actors: Dict[str, Any], var_manager) -> List[str]:
    """
    将 scope 字符串解析为演员名列表（用于前端展示）。
    例如 "[@God, @Diana] + my_list" -> ['@God', '@Diana', '@Ellis', '@Cat']
    """
    # ── 0. 保留字段：all（大小写不敏感）= 全可见（所有 actors）──
    if scope_str.strip().lower() == 'all':
        return sorted(actors.keys())

    parts = _split_scope_by_plus(scope_str)
    actor_names = []
    for part in parts:
        part = part.strip()
        if part.startswith('['):
            inner = part[1:-1]
            items = [x.strip() for x in inner.split(',') if x.strip()]
        else:
            var_name = part
            val = var_manager.get(var_name)
            if isinstance(val, list):
                items = [str(x) for x in val]
            elif isinstance(val, str) and val.startswith('@'):
                items = [val]
            else:
                items = []
        for item in items:
            resolved = _resolve_single_actor(item, actors, var_manager)
            actor_names.append(resolved)
    return sorted(set(actor_names))
