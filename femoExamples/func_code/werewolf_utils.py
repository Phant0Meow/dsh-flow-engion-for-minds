import random

def check_role(target_name, roles_dict):
    # 如果传入的是字典（引擎把 @actor 解析成了结构化数据），提取 name
    if isinstance(target_name, dict):
        target_name = target_name.get('name', '')
    for actor_ref, role in roles_dict.items():
        if actor_ref == target_name:
            return {"seer_check_result": "狼人" if role == "狼人" else "好人"}
    return {"seer_check_result": "未知"}

def resolve_night(kill_target, save, poison_target, alive_players, has_antidote, has_poison):
    dead = []
    new_alive = list(alive_players)
    new_antidote = has_antidote
    new_poison = has_poison

    if kill_target:
        if save and has_antidote:
            new_antidote = False
        else:
            dead.append(kill_target)
            new_alive = [a for a in new_alive if a != kill_target]

    if poison_target and poison_target != "none" and has_poison:
        dead.append(poison_target)
        new_alive = [a for a in new_alive if a != poison_target]
        new_poison = False

    return {
        "dead_tonight": dead,
        "alive": new_alive,
        "witch_has_antidote": new_antidote,
        "witch_has_poison": new_poison
    }

def announce_death(dead_tonight):
    if not dead_tonight:
        return {"announcement": "昨晚是平安夜，没有人死亡。"}
    return {"announcement": f"昨晚死亡：{', '.join(dead_tonight)}"}

def init_speaker_order(alive_players):
    return {"speaker_order": list(alive_players)}

def next_in_order(order, current_idx):
    if current_idx is None:
        current_idx = -1
    next_idx = current_idx + 1
    if next_idx < len(order):
        return {
            "@speaker": order[next_idx],
            "speaker_idx": next_idx,
            "has_more": True
        }
    return {
        "@speaker": None,
        "speaker_idx": next_idx,
        "has_more": False
    }


def collect_vote(voter_name, target):
    # 直接返回投票目标字符串
    return target   # 返回 "1" 或 ""，不要包装成字典
    

def process_votes_and_end(votes, alive_players, roles_dict):
    """
    合并后的动作：计票 -> 淘汰 -> 检查游戏结束
    参数：
        votes: dict, 投票结果，键为投票者名，值为投票目标名（空串表示弃票）
        alive_players: list, 当前存活玩家列表
        roles_dict: dict, 玩家角色字典，键为玩家名，值为角色（如 "wolf"）
    返回：
        dict，包含：
            eliminated_today: 本轮被淘汰者（"无人" 表示无人出局）
            alive:           更新后的存活玩家列表
            game_over:       游戏是否结束（bool）
            winner:          获胜阵营（"好人阵营"/"狼人阵营"，未结束时为空字符串）
    """
    # 1. 计票
    if not votes:
        eliminated_today = "无人"
    else:
        counts = {}
        for voter, target in votes.items():
            if target:  # 忽略弃票
                counts[target] = counts.get(target, 0) + 1
        if not counts:
            eliminated_today = "无人"
        else:
            max_votes = max(counts.values())
            top_candidates = [name for name, v in counts.items() if v == max_votes]
            if len(top_candidates) > 1:
                eliminated_today = "无人"
            else:
                eliminated_today = top_candidates[0]

    # 2. 移除被淘汰者
    if not eliminated_today or eliminated_today == "无人":
        new_alive = list(alive_players)
    else:
        new_alive = [a for a in alive_players if a != eliminated_today]

    # 3. 判断游戏结束
    alive_wolves = [a for a in new_alive if roles_dict.get(a) == "狼人"]
    alive_gods = [a for a in new_alive if roles_dict.get(a) in ["预言家", "女巫"]]
    alive_villagers_only = [a for a in new_alive if roles_dict.get(a) == "村民"]

    if not alive_wolves:
        game_over = True
        winner = "好人阵营"
    elif alive_wolves and (not alive_gods or not alive_villagers_only):
        # 屠边：神全部阵亡 或 村民全部阵亡，狼人获胜
        game_over = True
        winner = "狼人阵营"
    else:
        game_over = False
        winner = ""

    return {
        "eliminated_today": eliminated_today,
        "alive": new_alive,
        "game_over": game_over,
        "winner": winner
    }

def assign_roles():
    # 上帝 @小灵 是主持人，不参与抽卡；6 名玩家全员盲抽（@人 也在池里，可能抽到任何身份）。
    players = ["@Eve", "@小猫咪", "@AI助手", "@Portia", "@人", "@小机"]
    role_pool = ["狼人", "狼人", "预言家", "女巫", "村民", "村民"]
    random.shuffle(role_pool)
    roles = dict(zip(players, role_pool))

    wolves = [p for p, r in roles.items() if r == "狼人"]
    seer = next(p for p, r in roles.items() if r == "预言家")
    witch = next(p for p, r in roles.items() if r == "女巫")
    villagers = [p for p, r in roles.items() if r == "村民"]
    villager1, villager2 = villagers[0], villagers[1]

    return {
        "roles": roles,
        "wolves": wolves,
        "@预言家": seer,
        "@女巫": witch,
        "@村民1": villager1,
        "@村民2": villager2
    }
