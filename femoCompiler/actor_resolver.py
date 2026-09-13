"""
actor_resolver.py — Actor 类型解析独立模块
===========================================
提供两个纯函数：
  - resolve_actor_var(vm, actors, actor_ref) -> str 或抛异常
  - resolve_actor_attr(vm, actors, actor_ref, attr_name) -> Any 或抛异常
"""

from typing import Any, Dict

# 保留属性列表
_RESERVED_ATTRS = {'type', 'soul', 'source', 'tools', 'name'}


def resolve_actor_var(vm, actors: Dict[str, Any], actor_ref: str) -> str:
    """
    解析 Actor 类型变量，返回最终的演员实体名（带 @）。
    例如 @speaker -> @Diana。
    只支持简单的一级变量（赋值时一定是实体名），最多追 10 层链。
    """
    if not actor_ref.startswith('@'):
        raise ValueError(f"resolve_actor_var 需要一个以 @ 开头的引用，收到: {actor_ref!r}")

    current = actor_ref
    for depth in range(10):
        if current in actors:
            print(f"[actor_resolver] 解析 actor 变量 {actor_ref!r} -> {current!r} (第{depth}层)")
            return current

        # 上下文感知取值（优先局部作用域）
        if vm.has(current):
            val = vm.get(current)
            if isinstance(val, str) and val.startswith('@'):
                print(f"[actor_resolver] 变量 {current!r} 的值为 {val!r}，继续追踪")
                current = val
                continue
            else:
                raise ValueError(
                    f"Actor 变量 {current!r} 的值不是合法的演员引用，而是 {val!r}"
                )
        else:
            raise ValueError(f"未声明的 Actor 引用: {current!r}")

    raise ValueError(f"Actor 变量追踪超过 10 层，可能存在循环引用: {actor_ref!r}")


def resolve_actor_attr(vm, actors: Dict[str, Any], actor_ref: str, attr_name: str) -> Any:
    """
    双向解析 @actor.attr 或 attr.@actor，返回属性值。
    - 如果 actor_ref 是变量，先解析为实体名。
    - 如果 attr_name 是保留属性，直接从 actors 定义获取。
    - 否则，当作字典名，以实体名为键从 vars 中取值。
    """
    # 1. 解析出真正的演员实体
    if actor_ref not in actors:
        print(f"[actor_resolver] 属性访问遇到变量 {actor_ref!r}，尝试解析")
        actor_ref = resolve_actor_var(vm, actors, actor_ref)
        print(f"[actor_resolver] 解析后实体: {actor_ref!r}")

    # 2. 保留属性
    if attr_name in _RESERVED_ATTRS:
        actor_def = actors[actor_ref]
        if attr_name == 'type':
            return actor_def.type.value
        elif attr_name == 'soul':
            return str(getattr(actor_def, 'soul', ''))
        elif attr_name == 'source':
            return str(getattr(actor_def, 'source', ''))
        elif attr_name == 'tools':
            return getattr(actor_def, 'tools', [])
        elif attr_name == 'name':
            return actor_def.name

    # 3. 动态字典访问
    container = vm.get(attr_name) if vm.has(attr_name) else None
    if not isinstance(container, dict):
        raise ValueError(
            f"属性 '{attr_name}' 不是字典，无法通过 .{actor_ref} 访问"
        )
    if actor_ref not in container:
        raise ValueError(
            f"字典 '{attr_name}' 中不存在键 {actor_ref}"
        )
    value = container[actor_ref]
    print(f"[actor_resolver] 字典访问: {attr_name}[{actor_ref!r}] = {value!r}")
    return value