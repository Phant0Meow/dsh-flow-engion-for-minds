import random


def _as_name(v):
    """把 @actor 引用归一化为名字字符串（个别通道会把 @actor 解析成 dict）。"""
    if isinstance(v, dict):
        v = v.get('name', '') or ''
    return str(v).strip() if v is not None else ''


def check_role(target_name, roles_dict):
    """预言家查验：返回 {"seer_check_result": "狼人"/"好人"}。"""
    target_name = _as_name(target_name)
    for actor_ref, role in (roles_dict or {}).items():
        if actor_ref == target_name:
            return {"seer_check_result": "狼人" if role == "狼人" else "好人"}
    return {"seer_check_result": "未知"}



def get_speaker_order_from_start(candidates, start):
    """
    从start开始，返回candidates的循环发言顺序。
    candidates: list 上警玩家
    start: str 起始玩家名
    返回list
    """
    if not candidates:
        return []
    if start not in candidates:
        start = candidates[0]
    idx = candidates.index(start)
    return candidates[idx:] + candidates[:idx]

def get_sheriff_voter_order(alive, candidates):
    """
    返回未上警的存活玩家列表（警下投票者）。
    alive: list 所有存活玩家
    candidates: list 上警玩家
    返回list
    """
    return [p for p in alive if p not in candidates]

def process_election_votes(votes, candidates, alive):
    """
    统计警长竞选投票。
    只有警下存活玩家的投票有效，且只能投给警上玩家。
    平票则无人当选。
    """
    from collections import Counter

    candidates = list(candidates or [])
    alive = list(alive or [])
    candidate_set = set(candidates)
    voter_set = set(alive) - candidate_set

    valid_votes = {
        _as_name(v): _as_name(t)
        for v, t in (votes or {}).items()
        if _as_name(v) in voter_set
        and _as_name(t) in candidate_set
    }

    if not valid_votes:
        return ""

    counter = Counter(valid_votes.values())
    max_votes = max(counter.values())
    winners = [p for p, c in counter.items() if c == max_votes]

    if len(winners) == 1:
        return winners[0]

    return ""



def resolve_night(kill_target, save, poison_target, alive_players, has_antidote, has_poison, wolves):
    """夜晚结算：
    - 刀：目标必须在场；女巫用解药（且有药、目标在场）则救下，否则死亡。
    - 毒：规则每晚最多一瓶——解药生效当晚毒药作废；毒目标必须在场才生效。
    - 用药实际生效才扣瓶。
    - 同步维护 wolves / wolf_room：死掉的狼剔出夜间名单（防幽灵之刀）。
    返回 dead_tonight / alive / wolves / wolf_room / witch_has_antidote / witch_has_poison。"""
    kill_target = _as_name(kill_target)
    poison_target = _as_name(poison_target)
    alive_players = list(alive_players or [])
    wolves = list(wolves or [])
    dead = []
    poison_used = False

    saved = bool(save) and bool(has_antidote) and bool(kill_target) \
        and kill_target in alive_players
    if kill_target and kill_target in alive_players and not saved:
        dead.append(kill_target)

    if (poison_target and poison_target != "none" and has_poison
            and not saved and poison_target in alive_players):
        dead.append(poison_target)
        poison_used = True

    dead = list(dict.fromkeys(dead))  # 刀毒同一人不重复报
    new_alive = [a for a in alive_players if a not in dead]
    new_wolves = [w for w in wolves if w not in dead]

    return {
        "dead_tonight": dead,
        "alive": new_alive,
        "wolves": new_wolves,
        "wolf_room": ["@小灵"] + new_wolves,
        "witch_has_antidote": (False if saved else has_antidote),
        "witch_has_poison": (False if poison_used else has_poison),
    }


def build_witch_prompt(has_antidote, has_poison, kill_target, alive_players, witch_name):
    """按药瓶实况生成女巫夜晚行动提示词：有什么药才引导输出对应的 SET VARIABLE，
    没药就明说并禁止输出对应赋值，避免"永远在引导用药"的误导。
    返回 {"witch_prompt_text": ...}。"""
    witch_name = _as_name(witch_name) or "女巫"
    alive_names = [_as_name(a) for a in (alive_players or []) if _as_name(a)]
    kill_target = _as_name(kill_target)
    if kill_target and kill_target not in alive_names:
        kill_target = ""
    alive_str = "、".join(alive_names)
    lines = [f"现在是夜晚行动时间。你是{witch_name}，你的身份是女巫。"]

    if not has_antidote and not has_poison:
        lines.append(
            "你的解药和毒药都已经用完了，今晚无药可用。"
            "请直接简短说明你已无药可用，严禁输出任何 SET VARIABLE 赋值语句。"
        )
        return {"witch_prompt_text": "\n".join(lines)}

    if has_antidote:
        if kill_target:
            lines.append(
                f"今晚 {kill_target} 被袭击了。你手里还有一瓶解药："
                "如果要救他，请输出：SET VARIABLE:<< SAVE = true >>；"
                "如果决定不救，就不要输出 SAVE 赋值。"
            )
        else:
            lines.append("今晚没有人被袭击，解药今晚用不上。不要输出 SAVE 赋值。")
    else:
        lines.append(
            "你的解药已经用完，今晚救不了任何被袭击的玩家。"
            "严禁输出 SET VARIABLE:<< SAVE = ... >>。"
        )

    if has_poison:
        lines.append(
            f"你手里还有一瓶毒药，可以毒杀一名存活玩家（当前存活：{alive_str}）。"
            "如果要使用毒药，请输出：SET VARIABLE:<< @POISON = @目标名字 >>；"
            "如果决定不用，就不要输出 @POISON 赋值。"
        )
    else:
        lines.append("你的毒药已经用完，今晚无法毒人。严禁输出 SET VARIABLE:<< @POISON = ... >>。")

    if has_antidote and has_poison:
        lines.append(
            "注意：女巫一晚只能使用一瓶药，上面两个 SET VARIABLE 最多只能输出其中一个，也可以都不输出。"
        )

    return {"witch_prompt_text": "\n".join(lines)}


def get_order(from_, sheriff, alive):
    """根据警长决定的方向，生成白天发言顺序。"""

    alive = [_as_name(p) for p in alive]
    sheriff = _as_name(sheriff)
    from_ = _as_name(from_)

    if not alive:
        return []

    # 没有警长，直接按照存活名单顺序发言
    if not sheriff or sheriff not in alive:
        return alive

    sheriff_index = alive.index(sheriff)

    # 从警长左边开始
    if from_ == "左":
        return [
            alive[(sheriff_index + i) % len(alive)]
            for i in range(1, len(alive) + 1)
        ]

    # 从警长右边开始
    if from_ == "右":
        return [
            alive[(sheriff_index - i) % len(alive)]
            for i in range(1, len(alive) + 1)
        ]

    # 如果 AI 没有正确输出“左/右”，给一个稳定的兜底
    return [
        alive[(sheriff_index + i) % len(alive)]
        for i in range(1, len(alive) + 1)
    ]


def announce_death(dead_tonight):
    """晨间播报文案。"""
    dead = [_as_name(d) for d in (dead_tonight or []) if _as_name(d)]
    if not dead:
        return {"announcement": "昨晚是平安夜，没有人死亡。"}
    return {"announcement": f"昨晚死亡：{'、'.join(dead)}。"}


def collect_vote(votes, voter_name, target):
    """把一票写进共享票箱（就地修改）。
    $vote_results 是全局一份的 shared 变量：par 并发分支各自写不同的键
    （dict 单键赋值 GIL 原子），互不覆盖；返回同一对象供 out 写回（幂等）。"""
    voter_name = _as_name(voter_name)
    target = _as_name(target)
    if voter_name:
        votes[voter_name] = target
    return votes


def process_votes_and_end(votes, alive_players, roles_dict, wolves, sheriff):
    """计票 -> 放逐 -> 判胜负（屠边制）。

    普通玩家投票权重为1，警长投票权重为2。
    只统计投给存活玩家的票；空串/场外名字视为弃票。
    平票=无人出局。
    不清空票箱：announce_vote 还要念票，次日由 DayPhase.init 清空。
    同步维护 wolves / wolf_room。
    """
    alive_players = list(alive_players or [])
    alive_set = {str(a) for a in alive_players}
    roles_dict = roles_dict or {}
    wolves = list(wolves or [])
    sheriff = _as_name(sheriff)

    clean = {}
    for voter, target in (votes or {}).items():
        voter = _as_name(voter)
        target = _as_name(target)

        if voter and target and voter in alive_set and target in alive_set:
            clean[voter] = target

    if not clean:
        eliminated_today = "无人"
    else:
        counts = {}

        for voter, target in clean.items():
            # 警长1.5票，其他玩家1票
            weight = 1.5 if voter == sheriff else 1
            counts[target] = counts.get(target, 0) + weight

        max_votes = max(counts.values())
        top = [name for name, v in counts.items() if v == max_votes]

        eliminated_today = top[0] if len(top) == 1 else "无人"

    if eliminated_today == "无人":
        new_alive = list(alive_players)
    else:
        new_alive = [a for a in alive_players if a != eliminated_today]

    new_wolves = [w for w in wolves if w in new_alive]

    alive_wolves = [a for a in new_alive if roles_dict.get(a) == "狼人"]
    alive_gods = [a for a in new_alive if roles_dict.get(a) in ("预言家", "女巫")]
    alive_villagers = [a for a in new_alive if roles_dict.get(a) == "村民"]

    if not alive_wolves:
        game_over, winner = True, "好人阵营"
    elif not alive_gods or not alive_villagers:
        game_over, winner = True, "狼人阵营"
    else:
        game_over, winner = False, ""

    return {
        "eliminated_today": eliminated_today,
        "alive": new_alive,
        "wolves": new_wolves,
        "wolf_room": ["@小灵"] + new_wolves,
        "game_over": game_over,
        "winner": winner,
    }


def assign_roles():
    """上帝 @小灵 是主持人不参与；6 名玩家全员盲抽（@人 也在池里）。
    wolf_room = 上帝 + 全体狼人（上帝坐镇夜间狼人房）。"""
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
        "wolf_room": ["@小灵"] + wolves,
        "@预言家": seer,
        "@女巫": witch,
        "@村民1": villager1,
        "@村民2": villager2,
    }
