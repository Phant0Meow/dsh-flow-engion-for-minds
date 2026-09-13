# -*- coding: utf-8 -*-
"""哥布林讨伐队剧本的辅助 Python 模块（FEMO code 区示例）。

注意：@actor 类型变量传入 Python 时会被自动打包为状态字典，
例如 @knight -> {"type": "ai", "name": "@knight", "soul": 2, "hp": 100, ...}。
"""

import random


def sum_damage(damage_report=None, enemy_hp=0, **kwargs):
    """汇总各队员本回合造成的伤害，返回首领剩余血量（单值，直接赋给 out 的 enemy_hp）。"""
    total = 0
    for v in (damage_report or {}).values():
        try:
            total += int(v)
        except (TypeError, ValueError):
            continue
    return max(0, int(enemy_hp) - total)


def enemy_phase(hp=None, alive_party=None, battle_round=0, **kwargs):
    """哥布林首领反击：随机攻击一名存活队员，返回新的 hp 字典（单值，赋给 out 的 hp）。"""
    hp = hp or {}
    names = []
    for p in alive_party or []:
        names.append(p["name"] if isinstance(p, dict) else str(p))
    if not names:
        names = list(hp.keys())
    alive = [n for n in names if hp.get(n, 0) > 0]
    if not alive:
        return hp
    dmg = random.randint(5, 15) + int(battle_round or 0) * 2
    target = random.choice(alive)
    hp[target] = max(0, hp[target] - dmg)
    return hp


def retrieve_memory(prompt=None, session_id=None, actor_info=None, **kwargs):
    """记忆检索示例：返回一段给 AI 看的记忆文本。"""
    name = actor_info.get("name", "?") if actor_info else "?"
    return f"【记忆】{name} 隐约记得：上个月来酒馆讨伐哥布林的冒险者，是被抬着回来的。"


def get_context(session=None, actor_info=None, **kwargs):
    """上下文提取示例：返回当前会话上下文的文本。"""
    name = actor_info.get("name", "?") if actor_info else "?"
    return f"【上下文】当前 session={session}，说话者是 {name}。"
