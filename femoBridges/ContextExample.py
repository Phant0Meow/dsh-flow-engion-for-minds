"""
bridges/ContextExample.py — 默认上下文提取实现
===============================================
从数据库提取当前 session 的对话上下文，排除当前 prompt。
代码原则：所有代码不许写try静默兜底不报错，有错必须报错。

上下文拼接三种模式（2026-09-11 增量上下文立项）：
  full                        — 本条之前所有可见内容（原有行为）
  incremental                 — 本演员上次发言→本次发言之间的可见内容；
                                查库定起点（react_steps 按 soul_id 取 MAX(turn_id)），
                                无既往发言=「之间」为开场到现在=等价全量
  first_full_then_incremental — 首轮全量、之后增量（查库语义下与 incremental
                                同体；独立成 def 作为 harness 侧稳定接口名）
路由入口 build_session_context(session, actor_info, mode)。
harness 接口决定 mode（DSH 宿主后端钉 first_full_then_incremental），
剧本无感；直连模式等不钉的调用方吃默认 full。
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from femoCompiler.db_utils import _get_conn
from femoCompiler.FEMO_scope_resolver import parse_scope_field, ids_match_scope
from typing import List, Optional, Dict, Any

# ── 上下文可见性开关（2026-08-29 转写分离配套）────────────────────────
# 拼接上下文时各类内容的可见性：self=发言者本人（行 soul_id == 提问者），
# other=同房间其他角色。改这里的 0/1 即全局生效，无需动拼装逻辑。
# 配套：react_steps 按 step 分行存储（cot/tool_call/tool_result 各归各位），
# 上游节点的思考不再混在 response 里泄漏给下游。
VISIBILITY = {
    "self":  {"cot": 1, "response": 1, "tool": 1},
    "other": {"cot": 0, "response": 1, "tool": 0},
}

# ── 拼接模式常量（harness 接口按此钉 runner._context_mode）──────────────
MODE_FULL = 'full'
MODE_INCREMENTAL = 'incremental'
MODE_FIRST_FULL_THEN_INCREMENTAL = 'first_full_then_incremental'
_KNOWN_MODES = (MODE_FULL, MODE_INCREMENTAL, MODE_FIRST_FULL_THEN_INCREMENTAL)


# ── 演员双名制显示（2026-09-11 拍板，2026-09-12 三修定稿）────────────────
# 上下文里每个发言行显示「@戏中名（括号名）」：戏中名=@演员名（@ 保留，
# 不去重——@Eve（Eve）照写）。括号名按发言行身份取（2026-09-12 拍板）：
#   行带 soul_id          → Soul name（角色卡 soul_name）
#   无 soul_id 的人类发言 → user id 对应的 user name（查无此人退 uid 原样）
#   无 soul_id 的 AI 发言 → model id，仅 source:main（伪 soul 'main'）显示
#                           'main'；其余无 soul AI 行无法认领，维持 "AI" 兜底
# 台账行只存 soul_id/user_id，戏中名必须由调用方把剧本 actors 定义穿线进来；
# 缺席（旧调用方/自定义 context）=空映射，渲染退回单名（原行为）。
def _actor_role_maps(actors_def) -> tuple:
    """从剧本 actors 定义提取「戏中名」映射（@ 保留）。

    返回 (ai_soul_map, human_user_map, human_soul_map)：
      ai_soul_map     soul_id → @戏中名（AI 演员，行按 soul_id 认领）；
                      source:main 裸演员额外记 'main' 键（伪 soul，行上
                      soul_id='main'）；
      human_user_map  source(user_id) → @戏中名（人类演员，行按 user_id 认领）；
      human_soul_map  soul_id → @戏中名（人类演员兜底——无 source 回退 owner 的
                      行 user_id 是真实 uid，与戏中名对不上号，只能按行上的
                      soul_id 认亲，如 `human @玩家 = soul:human` 的玩家行）。
    同键多演员取先声明者。"""
    ai_soul, human_user, human_soul = {}, {}, {}
    if not actors_def:
        return ai_soul, human_user, human_soul
    for actor_name, adef in actors_def.items():
        role = str(actor_name).strip()
        if not role:
            continue
        if not role.startswith('@'):
            role = f'@{role}'
        atype = getattr(adef, 'type', None)
        atype = getattr(atype, 'value', atype)
        soul = getattr(adef, 'soul', None)
        source = getattr(adef, 'source', None)
        if atype == 'ai':
            if soul is not None:
                ai_soul.setdefault(str(soul), role)
            if str(source or '').strip() == 'main':
                ai_soul.setdefault('main', role)
        elif atype == 'human':
            if source is not None:
                human_user.setdefault(str(source), role)
            if soul is not None:
                human_soul.setdefault(str(soul), role)
    return ai_soul, human_user, human_soul


def _dual_name(role: str, display: str) -> str:
    """双名拼装：`@戏中名（Soul name）`；缺一退单名（不去重，2026-09-11
    二次拍板——同名双写 @Eve（Eve）正是用户要的结构统一）。"""
    display = str(display or '').strip()
    role = str(role or '').strip()
    if role and display:
        return f"{role}（{display}）"
    return display or role


def _get_records_visible_to(
    user_ids: List[str] = None,
    soul_ids: List[str] = None,
    session_id: int = None,
    include_ai: bool = True,
    max_turns: int = 20,
    offset: int = 0,
    after_turn: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """获取指定 user 或 soul 可见的对话记录（仅当前 session）。

    after_turn：只取 turn_id > after_turn 的行（增量窗口；None=不过滤）。
    """
    user_ids = user_ids or []
    soul_ids = soul_ids or []
    conn = _get_conn()
    results = []

    query = """
        SELECT session_id, turn_id, oratio_idx, user_prompt AS content,
               timestamp, user_id, soul_id, user_scope, soul_scope,
               'human' AS source
        FROM dialog
    """
    conditions = []
    params = []

    if session_id is not None:
        conditions.append("session_id = ?")
        params.append(session_id)

    if conditions:
        query += " WHERE " + " AND ".join(conditions)
    query += " ORDER BY session_id, turn_id, oratio_idx DESC"

    cursor = conn.execute(query, params)
    for row in cursor:
        user_scope = parse_scope_field(row["user_scope"] or "[]")
        soul_scope = parse_scope_field(row["soul_scope"] or "[]")
        # 无 user 无 soul（裸 actor）：不过滤——本 session 全部记录可见
        # （无角色设定 = 无隔离；有 user/soul 时行为不变）。
        no_filter = not user_ids and not soul_ids
        match_user = user_ids and ids_match_scope(user_scope, user_ids)
        match_soul = soul_ids and ids_match_scope(soul_scope, soul_ids)
        print(f"[ctx-dbg] dialog turn={row['turn_id']} src={row['source']} "
              f"u_scope={user_scope} s_scope={soul_scope} "
              f"ask_u={user_ids} ask_s={soul_ids} no_filter={no_filter} "
              f"match_user={match_user} match_soul={match_soul}")
        if no_filter or match_user or match_soul:
            results.append(dict(row))

    if include_ai:
        query2 = """
            SELECT session_id, turn_id, step_idx, response AS content,
                   timestamp, soul_id, user_scope, soul_scope,
                   cot, tool_call, tool_result,
                   'ai' AS source
            FROM react_steps
        """
        if conditions:
            query2 += " WHERE " + " AND ".join(conditions)
        query2 += " ORDER BY session_id, turn_id, step_idx DESC"

        cursor2 = conn.execute(query2, params)
        for row in cursor2:
            user_scope = parse_scope_field(row["user_scope"] or "[]")
            soul_scope = parse_scope_field(row["soul_scope"] or "[]")
            no_filter = not user_ids and not soul_ids
            match_user = user_ids and ids_match_scope(user_scope, user_ids)
            match_soul = soul_ids and ids_match_scope(soul_scope, soul_ids)
            print(f"[ctx-dbg] react turn={row['turn_id']} src={row['source']} "
                  f"u_scope={user_scope} s_scope={soul_scope} "
                  f"ask_u={user_ids} ask_s={soul_ids} no_filter={no_filter} "
                  f"match_user={match_user} match_soul={match_soul}")
            if no_filter or match_user or match_soul:
                results.append(dict(row))

    conn.close()

    # 增量窗口：只保留「上次发言」之后的行（dialog/react 同一 turn 域）
    if after_turn is not None:
        results = [r for r in results if (r.get("turn_id", 0) or 0) > after_turn]

    # 按时间戳或 turn_id + idx 降序排列（最近的在前）
    results.sort(key=lambda r: (
        r.get("turn_id", 0),
        r.get("oratio_idx", 0) if r.get("source") == "human" else r.get("step_idx", 0)
    ), reverse=True)
    # 去重（2026-08-28 加固）：键加入 soul_id + user_id——不同角色/不同行种类的
    # 同号行不再互吃（旧键曾把出题与甲思考的 react 行 (turn1,step0) 判为重复，
    # 静默吞掉甲思考，导致甲亮答上下文丢前文）。撞键时不再静默丢行：全部保留
    # 并高声告警——历史台账存在旧竞态写入的同键行，硬报错会炸老场次回放，故
    # 选择"全保留+告警"；新引擎 turn 号由 _alloc_turn 独占分配，正常不会再撞。
    seen = set()
    unique = []
    for r in results:
        key = (r["session_id"], r["turn_id"],
               r.get("oratio_idx", -1) if r["source"] == "human" else r.get("step_idx", -1),
               r["source"], str(r.get("soul_id") or ""), str(r.get("user_id") or ""))
        if key in seen:
            print(f"[ctx-dbg] ⚠️ 台账同键重复行（保留不丢）: key={key} "
                  f"content={str(r.get('content', ''))[:60]!r}")
        else:
            seen.add(key)
        unique.append(r)
    # 截断到 max_turns
    return unique


def _actor_scope_ids(actor_info: dict) -> tuple:
    """从 actor_info 提取 (user_ids, soul_ids) 提问者身份（原 findThisSession 内联逻辑）"""
    user_ids = []
    soul_ids = []
    info = actor_info or {}
    if "user" in info:
        user_ids.append(str(info["user"]))
    if "soul" in info:
        soul_ids.append(str(info["soul"]))
    return user_ids, soul_ids


def _last_speech_turn(session_id: int, soul_id: str) -> Optional[int]:
    """查库：该 soul 在本 session 的最后一次 AI 发言所在 turn（无发言→None）。

    增量模式的唯一起点事实源——不经参数、不查内存，谁拼增量谁查询。
    注意：裸演员 soul_id 落库为 ''，共享命名空间（另案处理）。"""
    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT MAX(turn_id) AS t FROM react_steps WHERE session_id = ? AND soul_id = ?",
            (session_id, str(soul_id or '')),
        ).fetchone()
        t = row["t"] if row else None
        return int(t) if t is not None else None
    finally:
        conn.close()


def _render_context(records: List[Dict[str, Any]], soul_ids: List[str],
                    actors_def: Optional[dict] = None) -> str:
    """把可见记录行渲染成上下文文本（原 get_session_context 后半段）。

    scope 过滤已由 _get_records_visible_to 完成；这里负责名字解析、react 行
    按 (turn_id, soul_id) 分组、VISIBILITY 拼装（cot/tool 剥离在此）、排序、
    [名字]：\n内容 拼接。名字走双名制「@戏中名（Soul name）」（不去重），
    actors_def 缺席时退回单名（原行为）。"""
    if not records:
        return ""

    # 排序主键（2026-08-29 换 turn 主序）：turn_id 在 _alloc_turn 后=节点因果
    # 序，par 慢分支的发言按自己节拍归位（910 实证），不再被墙钟完成时间打乱；
    # 节点内按 timestamp、idx 兜底（兼管 legacy 撞号行）。react 行按
    # (turn_id, soul_id) 分组、step_idx 升序拼轮，可见性由文件顶部 VISIBILITY
    # 控制：自己=cot/response/tool 全量，别人=只拼 response（tool 可开关）。
    # legacy 全量转写行（cot/tool 列为空）按 response 原样渲染，不做正则剥除。
    from femoCompiler.db_utils import get_soul_by_id, get_user_by_id
    import json
    name_cache = {}
    ai_soul_map, human_user_map, human_soul_map = _actor_role_maps(actors_def)

    def _parse_first_id(raw):
        """从可能是 JSON 数组的字段中提取第一个 ID 字符串"""
        if not raw:
            return ""
        if isinstance(raw, list):
            return str(raw[0]) if raw else ""
        if isinstance(raw, str):
            # 尝试 JSON 解析
            s = raw.strip()
            if s.startswith('[') and s.endswith(']'):
                try:
                    arr = json.loads(s)
                    if isinstance(arr, list) and arr:
                        return str(arr[0])
                except Exception:
                    pass
            return s
        return str(raw)

    def get_name(record):
        source = record.get("source")
        if source == "human":
            uid = _parse_first_id(record.get("user_id"))
            row_soul = _parse_first_id(record.get("soul_id", ""))
            # 戏中名：先按行 user_id 认领（source 落库行），再按行 soul_id 兜底
            # （无 source 回退 owner 的行）——人类演员自己的行两种键都可能带。
            role = (human_user_map.get(uid) if uid else None) \
                or (human_soul_map.get(row_soul) if row_soul else None)
            if not uid and not row_soul:
                return _dual_name(role, "用户")
            if uid and uid.startswith('femoshow-'):
                return "[节点提醒]"
            if uid and uid.startswith('femo-'):
                return None
            # 括号名（2026-09-12 拍板）：行带 soul_id → Soul name；无 soul_id
            # → user id 对应的 user name（查无此人退 uid 原样）
            if row_soul:
                if row_soul not in name_cache:
                    soul = get_soul_by_id(row_soul)
                    name_cache[row_soul] = soul.get("soul_name", row_soul) if soul else row_soul
                return _dual_name(role, name_cache[row_soul])
            if uid not in name_cache:
                user = get_user_by_id(uid)
                name_cache[uid] = user.get("user_name", uid) if user else uid
            return _dual_name(role, name_cache[uid])
        else:  # ai
            sid = _parse_first_id(record.get("soul_id"))
            if not sid:
                # 裸演员行（无 soul 无 source:main，落库 soul_id=''）：无键可认领，
                # 维持 "AI" 兜底
                return "AI"
            if sid == 'main':
                # source:main 裸天使伪 soul（无角色卡）：括号名=model id 'main'
                # （2026-09-12 拍板："如果是main就显示main"）；戏中名按 actors_def
                # 的 source:main 声明认领。投影窗 speaker 行走宿主 ai_name，不受此影响
                return _dual_name(ai_soul_map.get('main'), "main")
            if sid not in name_cache:
                soul = get_soul_by_id(sid)
                name_cache[sid] = soul.get("soul_name", sid) if soul else sid
            return _dual_name(ai_soul_map.get(sid), name_cache[sid])

    def _is_self(row):
        row_soul = str(row.get("soul_id") or "")
        return bool(soul_ids) and row_soul in {str(s) for s in soul_ids}

    # react 行按 (turn_id, soul_id) 分组成一个发言块；dialog 行（旁白/提醒/
    # 人类输入）保持逐行。blocks 元素=(turn_id, timestamp, idx, seq, name, content)。
    ai_groups = {}
    blocks = []
    seq = 0
    for r in records:
        name = get_name(r)
        if name is None:
            continue
        ts = r.get("timestamp", 0) or 0
        turn = r.get("turn_id", 0) or 0
        if r.get("source") == "ai":
            key = (turn, str(r.get("soul_id") or ""))
            g = ai_groups.setdefault(key, {"rows": [], "ts": ts, "name": name, "self": _is_self(r)})
            g["rows"].append(r)
            g["ts"] = min(g["ts"], ts)
        else:
            content = r.get("content", "")
            blocks.append((turn, ts, r.get("oratio_idx", 0) or 0, seq, name, content))
            seq += 1
    for key in sorted(ai_groups.keys()):
        g = ai_groups[key]
        vis = VISIBILITY.get("self" if g["self"] else "other", VISIBILITY["other"])
        rounds = []
        for row in sorted(g["rows"], key=lambda x: (x.get("step_idx", 0) or 0)):
            parts = []
            if vis.get("cot") and str(row.get("cot") or "").strip():
                parts.append(f"[思考] {str(row['cot']).strip()}")
            if vis.get("tool"):
                tool_result = str(row.get("tool_result") or "").strip()
                tool_call = str(row.get("tool_call") or "").strip()
                if tool_result:
                    parts.append(tool_result)
                elif tool_call:
                    parts.append(f"[工具调用] {tool_call}")
            # 注意：SELECT 里 response AS content——ai 行的发言在 content 键，
            # 读 response 键会永远拿到空（915 场实测：Eve 谜面整块消失）。
            resp_text = str(row.get("content") or row.get("response") or "").strip()
            if vis.get("response") and resp_text:
                parts.append(resp_text)
            if parts:
                rounds.append("\n".join(parts))
        if not rounds:
            continue
        # idx 取大数：同一 turn 内 react 块永远排在 prompt/show/人类输入之后
        blocks.append((key[0], g["ts"], 10 ** 9, seq, g["name"], "\n\n".join(rounds)))
        seq += 1
    blocks.sort(key=lambda b: (b[0], b[1], b[2], b[3]))
    lines = [f"[{name}]：\n{content}" for _, _, _, _, name, content in blocks]
    return "\n\n".join(lines)


# ═══ 三种拼接模式（只写拼接过程，工具全走上面的公共函数）════════════════

def full(session_id: int, actor_info: dict, actors_def: dict = None) -> str:
    """全量：本条之前所有可见内容（原有行为）。"""
    user_ids, soul_ids = _actor_scope_ids(actor_info)
    records = _get_records_visible_to(
        user_ids=user_ids if user_ids else None,
        soul_ids=soul_ids if soul_ids else None,
        session_id=session_id,
        include_ai=True,
        max_turns=999999,  # 足够大的数，取所有记录
    )
    print(f"[ctx-dbg] session={session_id} full 模式检索到 {len(records)} 条可见记录 "
          f"(ask_u={user_ids}, ask_s={soul_ids})")
    return _render_context(records, soul_ids, actors_def)


def incremental(session_id: int, actor_info: dict, actors_def: dict = None) -> str:
    """增量：本演员上次发言→本次发言之间的可见内容（AI 人类 showprompt）。

    起点查库定（react_steps 按 soul_id 取 MAX(turn_id)）；无既往发言时
    「之间」= 开场到现在 = 等价全量。AI 发言不带 cot/tool（VISIBILITY）。"""
    user_ids, soul_ids = _actor_scope_ids(actor_info)
    ask_soul = soul_ids[0] if soul_ids else ''
    last_turn = _last_speech_turn(session_id, ask_soul)
    if last_turn is None:
        print(f"[ctx-dbg] session={session_id} incremental 无既往发言（soul={ask_soul!r}）→ 等价全量")
        return full(session_id, actor_info, actors_def)
    records = _get_records_visible_to(
        user_ids=user_ids if user_ids else None,
        soul_ids=soul_ids if soul_ids else None,
        session_id=session_id,
        include_ai=True,
        max_turns=999999,
        after_turn=last_turn,
    )
    print(f"[ctx-dbg] session={session_id} incremental 增量窗口 turn>{last_turn}，"
          f"检索到 {len(records)} 条可见记录 (soul={ask_soul!r})")
    if not records:
        return ""
    return _render_context(records, soul_ids, actors_def)


def first_full_then_incremental(session_id: int, actor_info: dict,
                                actors_def: dict = None) -> str:
    """首轮全量、之后增量（DSH harness 接口钉死的模式）。

    查库语义下与 incremental 同体（无既往发言时 incremental 本身就退化为
    全量）；独立成 def 保持 harness 接口名稳定，将来语义分化只改这里。"""
    return incremental(session_id, actor_info, actors_def)


def build_session_context(session_id: int, actor_info: dict,
                          mode: str = MODE_FULL,
                          actors_def: dict = None) -> str:
    """上下文拼接路由入口：按 mode 分发到三种拼接方案。

    mode 由调用方（harness 接口/直连）传入；未知 mode 硬报错。
    actors_def 可选（剧本 actors 定义，双名制显示用）——block_collector
    默认路由传入；不传=单名渲染（原行为），自定义 context 老调用方零感知。"""
    if mode == MODE_FULL:
        return full(session_id, actor_info, actors_def)
    if mode == MODE_INCREMENTAL:
        return incremental(session_id, actor_info, actors_def)
    if mode == MODE_FIRST_FULL_THEN_INCREMENTAL:
        return first_full_then_incremental(session_id, actor_info, actors_def)
    raise ValueError(
        f"未知 context mode: {mode!r}（可用：{', '.join(_KNOWN_MODES)}）")


# ═══ 兼容薄壳（老调用方零感知）══════════════════════════════════════════

def get_session_context(
    session_id: int,
    user_ids: List[str] = None,
    soul_ids: List[str] = None,
    actors_def: dict = None,
) -> str:
    """获取当前 session 的完整对话上下文（兼容壳 = full 模式的 collect+render）"""
    records = _get_records_visible_to(
        user_ids=user_ids,
        soul_ids=soul_ids,
        session_id=session_id,
        include_ai=True,
        max_turns=999999,  # 足够大的数，取所有记录
    )
    print(f"[ctx-dbg] session={session_id} 检索到 {len(records)} 条可见记录 "
          f"(ask_u={user_ids}, ask_s={soul_ids})")
    return _render_context(records, soul_ids or [], actors_def)


def findThisSession(
    session: int,
    actor_info: dict,
    actors_def: dict = None,
) -> str:
    """默认 context 提取入口（兼容壳 = full 模式）"""
    context = build_session_context(session, actor_info, MODE_FULL, actors_def)
    return context
