"""
femoBridges/MemoryExample.py — Memory 检索实现
===============================================
跨 session 提取对话记忆，排除当前 session，基于 soul/user scope 过滤。
返回格式化文本供 model 作为记忆参考。
代码原则：所有代码不许写try静默兜底不报错，有错必须报错。
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from femoCompiler.db_utils import _get_conn
from femoCompiler.FEMO_scope_resolver import parse_scope_field, ids_match_scope
from typing import List, Optional, Dict, Any


def _get_memory_records(
    user_ids: List[str] = None,
    soul_ids: List[str] = None,
    exclude_session_id: int = None,
    limit: int = 30,
) -> List[Dict[str, Any]]:
    """获取跨 session 记忆记录，排除指定 session"""
    user_ids = user_ids or []
    soul_ids = soul_ids or []
    conn = _get_conn()
    results = []

    query_d = """
        SELECT session_id, turn_id, oratio_idx AS idx,
               timestamp, user_prompt AS content,
               user_id, soul_id, user_scope, soul_scope,
               'human' AS source
        FROM dialog
    """
    query_r = """
        SELECT session_id, turn_id, step_idx AS idx,
               timestamp, response AS content,
               '' AS user_id, soul_id, user_scope, soul_scope,
               'ai' AS source
        FROM react_steps
    """
    cond_d = []
    cond_r = []
    params_d = []
    params_r = []

    if exclude_session_id is not None:
        cond_d.append("session_id != ?")
        params_d.append(exclude_session_id)
        cond_r.append("session_id != ?")
        params_r.append(exclude_session_id)
        
    if cond_d:
        query_d += " WHERE " + " AND ".join(cond_d)
    if cond_r:
        query_r += " WHERE " + " AND ".join(cond_r)

    cursor_d = conn.execute(query_d + " ORDER BY timestamp DESC LIMIT ?", params_d + [limit * 2])
    for row in cursor_d:
        results.append(dict(row))

    cursor_r = conn.execute(query_r + " ORDER BY timestamp DESC LIMIT ?", params_r + [limit * 2])
    for row in cursor_r:
        results.append(dict(row))
    conn.close()

    results.sort(key=lambda r: r.get("timestamp", 0), reverse=True)

    filtered = []
    for r in results:
        user_scope = parse_scope_field(r.get("user_scope", "[]"))
        soul_scope = parse_scope_field(r.get("soul_scope", "[]"))
        if user_ids and ids_match_scope(user_scope, user_ids):
            filtered.append(r)
        elif soul_ids and ids_match_scope(soul_scope, soul_ids):
            filtered.append(r)
        elif not user_ids and not soul_ids:
            filtered.append(r)
    return filtered[:limit]


def _format_memory_records(records: List[Dict[str, Any]]) -> str:
    """将记忆记录列表格式化为文本（由远及近显示）"""
    if not records:
        return ""
    # records 按时间降序（最新在前），反转为升序（从旧到新）
    records = list(reversed(records))
    from femoCompiler.db_utils import get_soul_by_id, get_user_by_id
    import json
    name_cache = {}
    def get_name(record):
        source = record.get("source")
        if source == "human":
            user_id_field = record.get("user_id")
            if isinstance(user_id_field, str):
                try:
                    user_ids = json.loads(user_id_field)
                except Exception:
                    user_ids = [user_id_field]
            elif isinstance(user_id_field, list):
                user_ids = user_id_field
            else:
                user_ids = []
            if user_ids:
                uid = str(user_ids[0])
                if uid.startswith('femoshow-'):
                    return "[提醒]"
                if uid.startswith('femo-'):
                    return None
                if uid not in name_cache:
                    user = get_user_by_id(uid)
                    name_cache[uid] = user.get("user_name", uid) if user else uid
                return name_cache[uid]
            return "用户"
        else:
            soul_id = str(record.get("soul_id", ""))
            if soul_id not in name_cache:
                soul = get_soul_by_id(soul_id)
                name_cache[soul_id] = soul.get("soul_name", soul_id) if soul else soul_id
            return name_cache[soul_id]

    lines = []
    for r in records:
        name = get_name(r)
        if name is None:
            continue
        content = r.get("content", "")
        lines.append(f"[{name}]：\n{content}")
    return "\n\n".join(lines)


def retrieve_example(
    prompt: str = "",
    session_id: int = 0,
    turn_id: int = 0,
    actor_info: dict = None,
    memory_limit: int = 30,
    **kwargs,
) -> str:
    """Memory 检索入口"""
    actor_info = actor_info or {}
    print(f"[Memory] 🧠 检索跨 session 记忆 (limit={memory_limit})")
    print(f"[Memory]    actor_info = {actor_info}")

    user_ids = []
    soul_ids = []
    if "user" in actor_info:
        user_ids.append(str(actor_info["user"]))
    if "soul" in actor_info:
        soul_ids.append(str(actor_info["soul"]))

    records = _get_memory_records(
        user_ids=user_ids if user_ids else None,
        soul_ids=soul_ids if soul_ids else None,
        exclude_session_id=session_id,
        limit=memory_limit,
    )

    memory_text = _format_memory_records(records)
    print(f"[Memory] ✅ 检索完成，获得 {len(records)} 条记录")
    return memory_text
