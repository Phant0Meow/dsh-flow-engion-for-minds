# -*- coding: utf-8 -*-
"""谁是卧底：发牌、顺序、投票计票、胜负判定。

设计要点：
- 发牌（deal_cards）同狼人杀 assign_roles：全员盲抽，返回字典，FEMO 侧 out: 按 key 接。
- 判定（process_votes / next_round_stage / verdict）全在这里做，剧本里不写业务逻辑。
- 名字统一用 "@名" 形式（和 vars 里的 @actor 列表一致）。
- 2026-09-12 起支持**双卧底**：两个卧底各拿一个不同的相近词（都区别于平民词），
  场上因此有三张不同的牌在走——平民要靠"谁跟谁对不上"抓两个人。白板仍是 1 人。
"""

import random

# ---------------------------------------------------------------- 词库
# 每对 (平民词, 卧底词)。双卧底局里卧底词有两个：优先从本对取，再从不含平民词的
# 其它对里随机挑一个（三张牌互不相同，也不会出现"卧底词撞平民词"）。
DECK = [
    ("牛奶",   "豆浆"),
    ("牙膏",   "洗面奶"),
    ("可乐",   "雪碧"),
    ("电风扇", "空调"),
    ("拖鞋",   "凉鞋"),
    ("泡面",   "拌面"),
    ("日记",   "周记"),
    ("蜡烛",   "台灯"),
    ("口香糖", "薄荷糖"),
    ("睫毛膏", "眼线笔"),
    ("火锅",   "麻辣烫"),
    ("围巾",   "丝巾"),
    ("公交车", "地铁"),
    ("雨伞",   "阳伞"),
    ("枕头",   "抱枕"),
    ("手电筒", "探照灯"),
    ("电影院", "剧院"),
    ("橡皮擦", "修正带"),
    ("冰淇淋", "雪糕"),
    ("键盘",   "钢琴"),
]

BLANK_WORD = "？？？"


def _as_name(v):
    """把 @actor 引用归一化成名字字符串（个别通道会把 @actor 解析成 dict）。"""
    if isinstance(v, dict):
        v = v.get("name", "") or ""
    return str(v).strip() if v is not None else ""


def _pick_text(deck):
    if deck is None:
        deck = DECK
    try:
        pairs = list(deck)
    except TypeError:
        pairs = list(DECK)
    return random.choice(pairs or DECK)


def pick_undercover_count(n_players):
    """卧底人数随人数走（2026-09-13 猫猫拍板，取经典板子的经验值）。

    ≤7 人 → 1 名卧底；≥8 人 → 2 名卧底（且两人同词，见 deal_cards）；
    10 人以上仍封顶 2——人再多也不加，否则场上"怪词"太多，平民只能靠蒙。

    为什么 6 人给 1 个：偶数人 + 两个方向不同的卧底词时，票型很容易裂成
    2:2 反复平票（2026-09-12 场次实测一局连平四轮、无人出局）；
    卧底越多，平民的票越难集中，"可疑"就越不等于"是卧底"。
    """
    try:
        n = int(n_players)
    except (TypeError, ValueError):
        n = 0
    if n < 3:
        return 1
    return 1 if n <= 7 else 2


def _second_undercover_word(deck, civilian_word, first_word):
    """【已弃用 2026-09-13：双卧底改为同词】双卧底的第二个词：从不含平民词的其它对里挑。

    保留函数只为历史引用不炸；deal_cards 已不再调用它。留在这里当反面教材：
    它会让第二个卧底拿到一个与平民词毫不相干的词（实测「公交车」局抽到「凉鞋」），
    那人第一次发言就必然穿帮——等于把"卧底"变成"抓傻子"。
    """
    try:
        pairs = list(deck)
    except TypeError:
        pairs = list(DECK)
    if not pairs:
        pairs = list(DECK)
    pool = []
    for pair in pairs:
        words = [w for w in (list(pair) if isinstance(pair, (list, tuple)) else [pair]) if w]
        if civilian_word in words:
            continue
        pool.extend(w for w in words if w and w != first_word)
    if not pool:
        head = pairs[0] if isinstance(pairs[0], (list, tuple)) else [pairs[0]]
        pool = [w for w in head if w and w != first_word]
    return random.choice(pool or [first_word])


# ---------------------------------------------------------------- 发牌
def deal_cards(players, deck=None, n_undercover=None):
    """发牌：平民共用一个词 + n 个卧底（**同拿一个相近词**）+ 1 个白板（无词）。

    参数：
        players:      玩家名单（@actor 列表或名字列表）
        deck:         词库，缺省用模块内的 DECK
        n_undercover: 卧底人数；**缺省 None = 按人数自动定**
                      （pick_undercover_count：≤7 人 1 个、≥8 人 2 个）。
                      传具体数字可覆盖——老剧本显式传 2 时行为不变。
    返回字典（key 与剧本 out: 声明一一对应）：
        roles       {玩家名: "平民"/"卧底"/"白板"}
        words       {玩家名: 该玩家拿到的词}
        @卧底       卧底玩家名（多名卧底时取第一个；本局所有卧底同词）
        @白板       白板玩家名
        deck_word   [平民词, 卧底词1, 卧底词2, 人类可读词对说明]，供赛后复盘
    """
    names = [_as_name(p) for p in (players or []) if _as_name(p)]
    if len(names) < 3:
        raise ValueError("谁是卧底至少需要 3 名玩家，实际收到：%r" % (players,))
    if n_undercover is None:
        n_uc = pick_undercover_count(len(names))
    else:
        try:
            n_uc = max(1, int(n_undercover))
        except (TypeError, ValueError):
            n_uc = pick_undercover_count(len(names))
    if len(names) < n_uc + 2:
        n_uc = max(1, len(names) - 2)

    rnd = random.SystemRandom()
    shuffled = list(names)
    rnd.shuffle(shuffled)
    undercovers = shuffled[:n_uc]
    blank = shuffled[n_uc]

    civilian_word, undercover_word = _pick_text(deck)
    # 【2026-09-13 猫猫拍板：双卧底同词】旧实现给第二名卧底另抽一个"其它对"里的词
    # （实测抽到「凉鞋」配平民「公交车」）——那不是相近词，是另一个词：拿它的人
    # 第一次发言就必然穿帮，"抓卧底"直接退化成"抓傻子"。现在所有卧底共用对子里
    # 的同一个卧底词，卧底的伪装难度回到"描述的分寸"上。
    uc_words = [undercover_word] * max(1, n_uc)

    roles, words = {}, {}
    for i, n in enumerate(undercovers):
        roles[n] = "卧底"
        words[n] = uc_words[i]
    for n in names:
        if n in roles:
            continue
        if n == blank:
            roles[n] = "白板"
            words[n] = BLANK_WORD
        else:
            roles[n] = "平民"
            words[n] = civilian_word

    if n_uc >= 2:
        pairs_note = (f"平民「{civilian_word}」 / 卧底「{uc_words[0]}」"
                      f"（{n_uc} 名卧底同词）")
    else:
        pairs_note = f"平民「{civilian_word}」 / 卧底「{uc_words[0]}」"

    return {
        "roles": roles,
        "words": words,
        "@卧底": undercovers[0],
        "@白板": blank,
        "deck_word": [civilian_word] + uc_words + [pairs_note],
    }


def shuffle_order(players):
    """每轮打乱一次发言/投票顺序，让座位顺位不至于固定。

    key 必须逐字写成 "$alive"：引擎经 `_extract_var_name` 取 out 名时只处理
    带点路径里的 `@`（'vote_results.@voter'→'vote_results'），**不剥 `$`**，
    所以 `out: $alive` 期望的 key 就是 '$alive'（写回时由 facade 的
    `_decl_for` 剥 `$` 落到 shared 槽位）。
    """
    names = [_as_name(p) for p in (players or []) if _as_name(p)]
    random.shuffle(names)
    return {"$alive": names}


# ---------------------------------------------------------------- 渲染辅助
def names(players):
    """把玩家列表拼成「@A、@B、@C」这种好读的串，供 prompt 里的 {u.names($alive)} 用。"""
    items = [_as_name(p) for p in (players or []) if _as_name(p)]
    return "、".join(items) if items else "（无）"


def roster(roles):
    """把 roles 字典的键（玩家名）拼成名单串，供「场上 N 个人：…」这类播报用。"""
    if isinstance(roles, dict):
        keys = list(roles.keys())
    else:
        keys = list(roles or [])
    return names(keys)


def count_undercover(roles):
    """卧底人数（公告与终局文案用；单/双卧底自适应）。"""
    if isinstance(roles, dict):
        return sum(1 for r in roles.values() if r == "卧底")
    return 0


def card_texts(words):
    """每个玩家的「牌面文案」：看牌/陈述 prompt 里用 {words_text.@speaker} 取。

    【2026-09-13 猫猫拍板】白板以前只显示 BLANK_WORD（"？？？"），演员第一反应是
    "是不是渲染坏了"——它需要一句明确的"你手里没有词"，否则会像 2026-09-12 那局
    的弱模型一样胡说（@看图梗 拿着"凉鞋"老实描述反而被当成胡话）。
    平民/卧底仍是"你拿到的词是【X】"。返回 {"words_text": {...}}，key 与剧本 out 对齐。
    """
    src = words if isinstance(words, dict) else {}
    out = {}
    for name, word in src.items():
        w = "" if word is None else str(word)
        if w == BLANK_WORD or w.strip() == "":
            out[name] = ("你手里没有词——你是【白板】。没有牌面可描述，只能顺着别人的话"
                         "混过去；你的目标是不被投出去（活到终局就算白板赢）。")
        else:
            out[name] = f"你拿到的词是【{w}】。"
    return {"words_text": out}


def board_notice(roles):
    """开局公告的牌面段（人数、卧底数、白板有无都按**实际发牌**现算）。

    以前这段是剧本里写死的"6 人局：3 平民 + 2 卧底 + 1 白板"，板子一改（比如
    6 人局改回 1 卧底）公告就会说谎——而 in/out 对齐测试只查声明，查不出文案里的
    谎话，只能靠这里现算。返回纯文本，剧本 prompt 用 {u.board_notice(roles)} 内联。
    """
    roles = roles if isinstance(roles, dict) else {}
    all_names = list(roles.keys())
    n = len(all_names)
    n_uc = count_undercover(roles)
    has_blank = any(r == "白板" for r in roles.values())
    parts = [
        f"【谁是卧底 · {n} 人局】",
        f"场上 {n} 个人：{names(all_names)}。",
        "牌已经发到各自手里了——你只能看到自己的牌面，看不到自己是什么身份。",
    ]
    if n_uc >= 2:
        parts.append(f"这一局场上有 {n_uc} 名卧底：他们拿的是跟平民词相近的那个词（两名卧底同词）。")
    else:
        parts.append("这一局场上只有 1 名卧底：他拿的是跟平民词相近的词。")
    if has_blank:
        parts.append("另外还有一个白板，手里什么词都没有。")
    return "\n".join(parts)


# ---------------------------------------------------------------- 公告文案
def round_announcement(round_no, alive_players):
    """回合开始播报。"""
    alive_str = "、".join(_as_name(a) for a in (alive_players or []))
    return {"announce_text": f"—— 第 {round_no} 轮 · 陈述阶段 ——\n当前存活玩家：{alive_str}"}


# ---------------------------------------------------------------- 投票
def collect_vote(vote_results, voter_name, target):
    """把一票写进共享票箱（就地修改，返回同一对象供 out 写回）。"""
    vote_results = vote_results if isinstance(vote_results, dict) else {}
    voter = _as_name(voter_name)
    target = _as_name(target)
    if voter:
        vote_results[voter] = target
    return vote_results


def _clean_votes(vote_results, alive):
    """只留有效票：投票者与目标都得在存活名单里，且不能投自己。"""
    alive_set = set(alive)
    votes = {}
    for voter, target in (vote_results or {}).items():
        v, t = _as_name(voter), _as_name(target)
        if v in alive_set and t in alive_set and t != v:
            votes[v] = t
    return votes


def vote_box(vote_results, alive_players, candidates=None):
    """[@投票人→@被投人] 明细串（谁投了谁，供公告前台公开）。

    与计票同源口径（_clean_votes / pk_decide 的有效票判定），但**不吞信息**：
    自投、投给名单外/非候选人的票、没投的人，全部如实标出——
    - 没投或目标为空 → 「@A→？（弃权）」
    - 投给自己 → 「@A→@A（自投，废票）」
    - 候选名单给了（PK 重投）且目标不在名单里／投票人自己是候选人
      → 「@A→@B（无效票）」
    - 其余 → 「@A→@B」（有效票）

    有效票判定必须与计票函数逐字一致，否则公告的"明细"会和"计票"打起来。
    """
    alive = [_as_name(a) for a in (alive_players or [])]
    cands = [_as_name(c) for c in (candidates or []) if _as_name(c)]
    cand_set = set(cands)
    votes = vote_results if isinstance(vote_results, dict) else {}

    parts = []
    for voter in alive:
        raw = votes.get(voter)
        target = _as_name(raw) if raw is not None else ""
        if not target:
            parts.append(f"{voter}→？（弃权）")
            continue
        if target == voter:
            parts.append(f"{voter}→{target}（自投，废票）")
            continue
        if cand_set:
            if voter in cand_set or target not in cand_set:
                parts.append(f"{voter}→{target}（无效票）")
            else:
                parts.append(f"{voter}→{target}")
        else:
            if target not in alive:
                parts.append(f"{voter}→{target}（无效票）")
            else:
                parts.append(f"{voter}→{target}")
    return "投票明细：" + "、".join(parts)


def vote_recap(vote_results, all_players, candidates=None):
    """赛后复盘用的投票明细：按**全体参赛者**核票。

    与 vote_box 的唯一差别在名单口径——终局时若拿"最后存活名单"核票，
    早先被淘汰者投的票会被误标成无效票（_test_vote_box.py 第 4 例实测），
    复盘图的正是"谁当时投了谁"，必须算数。
    """
    names = [_as_name(p) for p in (all_players or []) if _as_name(p)]
    return vote_box(vote_results, names, candidates)


def _counts_note(counts, votes, alive):
    """计票明面文案：[@A 3 票、@B 1 票] + 弃权数。"""
    note = "计票：" + "、".join(f"{n} {c} 票" for n, c in
                             sorted(counts.items(), key=lambda kv: -kv[1]))
    abstain = len(alive) - len(votes)
    if abstain:
        note += f"（{abstain} 人弃权）"
    return note


def process_votes(vote_results, alive_players, roles, round_no):
    """第一轮计票 -> 定 PK 名单 / 淘汰 -> 判定。

    - 只统计存活玩家投给存活玩家、且不投自己的票，其余视为废票；
    - 得票唯一最高者出局；
    - **平票（≥2 人并列最高）→ 进入 PK 环节**：谁都不出局，
      pk_candidates 记下并列最高的几位，由 pk_decide 在重投后裁决。
    返回 dict（key 与剧本 out: 声明一一对应）。
    """
    alive = [_as_name(a) for a in (alive_players or [])]
    roles = roles or {}
    votes = _clean_votes(vote_results, alive)

    counts = {}
    for t in votes.values():
        counts[t] = counts.get(t, 0) + 1

    note = _counts_note(counts, votes, alive)
    is_pk = False
    pk_candidates = []
    eliminated = "无人"

    if not counts:
        # 【2026-09-13 兜底】整轮没人投出有效票（全员弃权／自投／投名单外的人）：
        # 旧文案"无人出局"会让这一轮原地打转——干跑实测第 5 轮起死循环，每轮真烧
        # token 却永远不收敛。改为随机送走一人：僵局只有这一种出口。
        if alive:
            eliminated = random.SystemRandom().choice(alive)
            reason = ("本轮没有人投出有效票——僵局不再空转，"
                      f"随机送走一人：{eliminated} 出局。")
        else:
            reason = "本轮没有人投出有效票，无人出局。"
    else:
        top = max(counts.values())
        top_names = [n for n, c in counts.items() if c == top]
        if len(top_names) > 1:
            # 平票 → PK：本轮无人离场，进入重投
            is_pk = True
            pk_candidates = top_names
            reason = ("、".join(top_names)
                      + f" 平票（各 {top} 票）——本轮无人离场，进入【平票 PK】，"
                      + "由 PK 重投决出谁出局。")
        else:
            eliminated = top_names[0]
            reason = f"{eliminated} 得票最多（{top} 票），被淘汰出局。"

    new_alive = [a for a in alive if a != eliminated]
    announce = (f"—— 第 {round_no} 轮 · 投票结果 ——\n"
                f"{vote_box(vote_results, alive)}\n"
                f"{note}\n{reason}")

    game_over, winner = _judge(new_alive, roles)
    return {
        "eliminated": eliminated,
        "$alive": new_alive,
        "is_pk": is_pk,
        "$pk_candidates": pk_candidates,
        "announce_text": announce,
        "game_over": game_over,
        "winner": winner,
    }


def pk_voters(pk_candidates, alive_players):
    """PK 重投的合法投票人 = 存活者 − 候选人（与 pk_decide 的 voters_ok 同口径）。

    剧本侧用它当循环体名单，公告文案也用它——这样"谁有资格投"只有一个出处，
    不会出现公告说"其余 3 位重投"、流程却把候选人也喊去投的分歧
    （2026-09-11 猫猫拍板：既然有 voters_ok，就直接在它上面循环）。
    """
    cands = {_as_name(c) for c in (pk_candidates or []) if _as_name(c)}
    return [a for a in (_as_name(x) for x in (alive_players or []))
            if a and a not in cands]


def pk_prompt(pk_candidates, alive_players, round_no):
    """PK 环节的公开播报（申辩与重投的提示词写在剧本节点里）。

    返回 {"announce_text": 播报, "$pk_voters": 合法投票人名单}——两个 key 都必须在
    剧本 `out:` 里逐字声明（引擎严格校验，多一个 key 就报「返回字典中的 key 未在
    out 中声明」）。剧本的 PK 重投循环直接遍历 $pk_voters，不再遍历全体存活者。
    """
    cands = [_as_name(c) for c in (pk_candidates or []) if _as_name(c)]
    voters = pk_voters(cands, alive_players)
    cand_str = "、".join(cands)
    announce = (
        f"—— 第 {round_no} 轮 · 平票 PK ——\n"
        f"平票的是：{cand_str}。本轮无人出局。\n"
        f"现在进入 PK 环节：{cand_str} 每人再说一句话为自己申辩；"
        f"然后由其余 {len(voters)} 位（{'、'.join(voters)}）在平票的人里重投，"
        f"得票多者出局；若再次平票，则由平票的几人中随机送走一人（僵局不再空转）。"
    )
    return {"announce_text": announce, "$pk_voters": voters}


def pk_decide(vote_results, pk_candidates, alive_players, roles, round_no):
    """PK 重投计票 -> 淘汰 -> 判定。

    有效票三条件：投票者**存活**、投票者不是 PK 选手、目标在 PK 名单里。
    （只判"不是 PK 选手"会把已出局的人也算成投票者——干跑流水里抓到过这个漏洞。）
    得票多者出局；再次平票、或一条有效票都没有（含"所有存活者都是候选人"这种
    结构性无票可投），一律**随机送走一人**（2026-09-13 平票兜底：僵局必须有出口）。
    """
    alive = [_as_name(a) for a in (alive_players or [])]
    cands = [_as_name(c) for c in (pk_candidates or []) if _as_name(c)]
    roles = roles or {}
    cand_set = set(cands)
    voters_ok = [a for a in alive if a not in cand_set]   # 存活且非 PK 选手

    votes = {}
    for voter, target in (vote_results or {}).items():
        v, t = _as_name(voter), _as_name(target)
        if v in voters_ok and t in cand_set:
            votes[v] = t

    counts = {}
    for t in votes.values():
        counts[t] = counts.get(t, 0) + 1

    note = ("PK 重投：" + ("、".join(f"{n} {c} 票" for n, c in
                                   sorted(counts.items(), key=lambda kv: -kv[1]))
                          if counts else "无人投出有效票"))
    eliminated = "无人"
    if counts:
        top = max(counts.values())
        top_names = [n for n, c in counts.items() if c == top]
        if len(top_names) > 1:
            # 【2026-09-13 平票兜底】旧规则"再次平票 = 本轮无人出局"会让
            # "票型天生 2:2"的局无限空转（2026-09-12 实测连平四轮、每轮都真烧
            # token，谁都出不去）。现在改为随机送走一人：僵局只有这一种出口。
            eliminated = random.SystemRandom().choice(top_names)
            reason = ("、".join(top_names)
                      + f" 再次平票（各 {top} 票）——僵局不再空转，"
                      + f"随机送走一人：{eliminated} 出局。")
        else:
            eliminated = top_names[0]
            reason = f"{eliminated} 在 PK 重投中得票最多（{top} 票），被淘汰出局。"
    else:
        # 【2026-09-13 兜底】PK 重投没有有效票，有两种成因：
        # ①全员弃权/自投；②**所有存活者都是 PK 候选人**（3 人局三人平票时必然发生，
        # 此时 $pk_voters 为空，谁都没资格投）——后者是结构性的，不兜底就永远出不去。
        if cands:
            eliminated = random.SystemRandom().choice(cands)
            reason = ("PK 重投无人投出有效票——僵局不再空转，"
                      f"随机送走一人：{eliminated} 出局。")
        else:
            reason = "PK 重投无人投出有效票，本轮无人出局。"

    new_alive = [a for a in alive if a != eliminated]
    announce = (f"—— 第 {round_no} 轮 · PK 结果 ——\n"
                f"{vote_box(vote_results, alive, cands)}\n"
                f"{note}\n{reason}")
    game_over, winner = _judge(new_alive, roles)

    return {
        "eliminated": eliminated,
        "$alive": new_alive,
        "$pk_candidates": [],
        "announce_text": announce,
        "game_over": game_over,
        "winner": winner,
    }


# ---------------------------------------------------------------- 胜负判定
def _judge(alive, roles):
    """胜负判定（process_votes / pk_decide / next_round_stage 共用）。

    结束条件（单/双卧底自适应，公式本身与人数无关）：
    - 卧底全被投出去 → 平民阵营胜；
    - 场上剩下的好人 ≤ 存活卧底数（卧底的票已经压过好人）→ 卧底阵营胜。
      白板算好人一边，且**只有当平民全没了**时才会作为"最后的好人"顶上去——
      所以"卧底 + 白板 + 1 平民"这类局面仍判卧底胜。
    """
    alive = [_as_name(a) for a in (alive or [])]
    roles = roles or {}
    alive_undercover = [a for a in alive if roles.get(a) == "卧底"]
    alive_good = [a for a in alive if roles.get(a) != "卧底"]

    if not alive_undercover:
        return True, "平民阵营"
    if len(alive_good) <= len(alive_undercover):
        return True, "卧底阵营"
    return False, ""


# ---------------------------------------------------------------- 胜负判定（对外入口）
def next_round_stage(alive_players, roles):
    """投票结算后判定游戏是否结束。返回 {"game_over": bool, "winner": str}。
    裁决口径见 _judge（与 process_votes / pk_decide 完全同源，避免两处漂移）。"""
    game_over, winner = _judge(alive_players, roles)
    return {"game_over": game_over, "winner": winner}


def _word_display(name, words):
    """终局文案里的词面：白板的 BLANK_WORD 显示成「（没有词）」。

    否则复盘时它和"占位符没渲染"长得一模一样（2026-09-12 我第一眼就怀疑是渲染故障）。
    """
    w = (words or {}).get(name)
    w = "" if w is None else str(w)
    return "（没有词）" if (w == BLANK_WORD or w.strip() == "") else w


def verdict(eliminated, roles, words, alive_players, winner, deck_word=None,
            vote_results=None, pk_vote_results=None):
    """终局判决文案。全部身份与词在这里揭晓（附最后一轮的投票明细）。

    投票资料（2026-09-11 加）：vote_results = 本轮常规投票票箱，
    pk_vote_results = PK 重投票箱（走没走 PK 由调用方决定传不传）——
    谁投了谁必须留痕，否则复盘时只剩"几票"没有"谁投的"。
    双卧底（2026-09-12）：deck_word 末位是词对说明串，文案收尾用它。
    """
    roles = roles or {}
    words = words or {}
    alive = [_as_name(a) for a in (alive_players or [])]
    elim = _as_name(eliminated)
    n_uc = count_undercover(roles)

    lines = ["—— 终局 ——"]
    if elim and elim != "无人":
        role = roles.get(elim, "？")
        lines.append(f"{elim} 被投出局，他的身份是【{role}】，词是「{_word_display(elim, words)}」。")
    else:
        lines.append("场上再无人被投出局。")

    lines.append(f"本局卧底 {n_uc} 人。所有人的身份与词：")
    # 先点卧底，再把其余人按原顺序列出——复盘时一眼看到重点
    order = ([n for n, r in roles.items() if r == "卧底"]
             + [n for n, r in roles.items() if r != "卧底"])
    for name in order:
        lines.append(f"　　{name}——{roles[name]}，词：{_word_display(name, words)}")
    # 投票明细不在这里重复打印：终局公告永远紧跟"投票结果/PK 结果"公告，
    # 那条已经用 vote_box 把明细摊开了（2026-09-11 拍板）。参数保留——要做
    # "赛后复盘单页"、或以后终局改由常规轮直接结束时，调 vote_recap 即可。
    _ = (vote_results, pk_vote_results)

    note = ""
    if isinstance(deck_word, (list, tuple)) and deck_word:
        tail = deck_word[-1]
        if isinstance(tail, str) and ("「" in tail or "平民" in tail):
            note = tail
        elif len(deck_word) >= 2:
            note = f"平民「{deck_word[0]}」 / 卧底「{deck_word[1]}」"
    if note:
        lines.append(f"（本局词对：{note}）")

    if winner == "平民阵营":
        lines.append("卧底已经被全部投出局 —— 平民阵营获胜！")
    elif winner == "卧底阵营":
        lines.append("卧底隐藏到了最后 —— 卧底阵营获胜！")
    else:
        lines.append("游戏结束。")

    # 【2026-09-13 白板胜负单列】猫猫问"白板赢了算什么"——本局定义：白板是独立
    # 目标，只要没被投出去、混到终局，白板自己就算赢；它不改变平民/卧底的胜负
    # 判定（_judge 里白板仍按"好人"计入人数，避免两处口径漂移）。
    for b in [n for n, r in roles.items() if r == "白板"]:
        if b in alive:
            lines.append(f"白板 {b} 混到了终局、没被投出去 —— 白板自己也算赢。")
        else:
            lines.append(f"白板 {b} 被投出局了 —— 白板这一局没混过去。")

    if alive:
        lines.append(f"最后的存活玩家：{'、'.join(alive)}")

    text = "\n".join(lines)
    return {"verdict_text": text, "announce_text": text}
