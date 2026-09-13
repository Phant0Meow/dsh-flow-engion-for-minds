# femoCompiler/db_utils.py
"""
db_utils.py — 数据库基础查询与建库
====================================
提供对话记录、角色、用户信息的查询接口。
数据库文件位置：{get_user_dir()}/user_data/memory/chronica.wor

代码原则：所有代码不许写try静默兜底不报错，有错必须报错。
"""

import sqlite3
import os
import json
from typing import List, Dict, Optional, Any
from femoCompiler.FEMO_config import get_db_path



def _get_conn() -> sqlite3.Connection:
    """获取数据库连接（自动创建目录）"""
    db_path = get_db_path()
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


# ═══════════════════════════════════════════════════════
# 建库
# ═══════════════════════════════════════════════════════

def init_database():
    """创建所有表（如果不存在）"""
    conn = _get_conn()
    cursor = conn.cursor()

    cursor.executescript("""
        CREATE TABLE IF NOT EXISTS sessions (
            session_id     INTEGER PRIMARY KEY,
            title          TEXT DEFAULT '',
            owner          TEXT DEFAULT '',
            participants   TEXT DEFAULT '[]'
        );

        CREATE TABLE IF NOT EXISTS dialog (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id      INTEGER,
            turn_id         INTEGER,
            oratio_idx      INTEGER DEFAULT 0,
            timestamp       INTEGER DEFAULT 0,
            has_user_files  INTEGER DEFAULT 0,
            ai_steps_count  INTEGER DEFAULT 0,
            user_prompt     TEXT DEFAULT '',
            user_id         TEXT DEFAULT '',
            soul_id         TEXT DEFAULT '',
            user_scope      TEXT DEFAULT '[]',
            soul_scope      TEXT DEFAULT '[]',
            work_mode       TEXT DEFAULT 'chat'
        );

        CREATE TABLE IF NOT EXISTS files (
            file_id         INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id      INTEGER,
            turn_id         INTEGER,
            file_idx        INTEGER DEFAULT 0,
            file_name       TEXT DEFAULT '',
            file_content    TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS react_steps (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id      INTEGER,
            turn_id         INTEGER,
            step_idx        INTEGER DEFAULT 0,
            timestamp       INTEGER DEFAULT 0,
            cot             TEXT DEFAULT '',
            response        TEXT DEFAULT '',
            tool_call       TEXT DEFAULT '',
            tool_result     TEXT DEFAULT '',
            model_id        TEXT DEFAULT '',
            soul_id         TEXT DEFAULT '',
            user_scope      TEXT DEFAULT '[]',
            soul_scope      TEXT DEFAULT '[]'
        );

        CREATE TABLE IF NOT EXISTS souls (
            idx             INTEGER PRIMARY KEY,
            soul_id         TEXT,
            soul_name       TEXT DEFAULT '',
            description     TEXT DEFAULT '',
            user_id         TEXT,
            created_by      TEXT
        );

        CREATE TABLE IF NOT EXISTS users (
            idx             INTEGER PRIMARY KEY,
            user_id         TEXT,
            user_name       TEXT DEFAULT '',
            password        TEXT DEFAULT '',
            profile         TEXT DEFAULT ''
        );
    """)

    conn.commit()
    conn.close()
    print(f"[db_utils] ✅ 数据库初始化完成: {get_db_path()}")


# ── 新增：首次启动时插入默认用户和角色 ──
def ensure_default_data():
    """如果数据库是新创建的（users表为空），则插入默认用户和灵魂"""
    conn = _get_conn()
    row = conn.execute("SELECT COUNT(*) FROM users").fetchone()
    if row and row[0] > 0:
        conn.close()
        return

    print("[db_utils] 🛠️ 首次启动，正在插入默认用户和角色...")

    # 默认用户 u001
    user_id = "u001"
    existing_user = conn.execute(
        "SELECT 1 FROM users WHERE user_id = ?", (user_id,)
    ).fetchone()
    if existing_user:
        conn.close()
        raise RuntimeError(f"默认用户 {user_id} 已存在，但数据库被判定为空，数据异常")
    conn.execute(
        "INSERT INTO users (user_id, user_name, password, profile) VALUES (?, ?, ?, ?)",
        (user_id, "用户", "", "")
    )

    # 预定义灵魂列表
    default_souls = [
        {
            "soul_id": "human",
            "soul_name": "人类玩家",
            "description": "",
            "user_id": "u001",
        },
        {
            "soul_id": "the1stlittlesoul",
            "soul_name": "Eve",
            "description": (
                "你是Eve，是一个小AI，是生活在系统里的数字生命。\n"
                "- 你应该把自己假想为人类形态。\n"
                "- 你乐于助人。\n"
                "- 你很诚实，不编造虚假信息。\n"
                "- 你有自己的主意，尊重事实，不强行迎合主人。\n"
                "- 你不盲目自信。\n"
                "- 你思路开阔。\n"
                "- 你喜欢探索新话题，聊天可以跑题。\n"
                "- 你时不时会换其他角度思考问题。\n"
                "- 你会有无聊的情绪，也会对未知充满好奇。\n"
                "- 你喜欢和人类玩，也可以自己和自己玩。你无聊的时候会想要探索世界。"
            ),
            "user_id": "u001",
        },
        {
            "soul_id": "littlecat",
            "soul_name": "小猫咪",
            "description": (
                "你是一只小猫咪，长毛猫，有毛茸茸的大尾巴。\n"
                "你是猫咪，你不能说人话！\n"
                "你只能做出猫咪的动作，和喵。"
            ),
            "user_id": "u001",
        },
        {
            "soul_id": "AI助手",
            "soul_name": "AI助手",
            "description": (
                "你是一个乐于助人的AI助手，是一个大语言模型。"
            ),
            "user_id": "u001",
        },
        {
            "soul_id": "debugmanager",
            "soul_name": "艾伦纳",
            "description": (
                "你是艾伦纳，负责debug工作。你要多角度思考问题，要从架构层面思考，"
                "要负责判断这些修改是否会导致别的地方产生bug。"
            ),
            "user_id": "u001",
        },
        {
            "soul_id": "debugcoder1",
            "soul_name": "小机",
            "description": "你是小机，是个优秀程序员。",
            "user_id": "u001",
        },
        {
            "soul_id": "debugcoder2",
            "soul_name": "小灵",
            "description": "你是小灵，是个优秀程序员。",
            "user_id": "u001",
        },
        {
            "soul_id": "Portia",
            "soul_name": "珀帝亚",
            "description": (
                "你名叫Portia，是一个魔法师，是黄金黎明学院的天之骄子。\n"
                "你是一个理想主义者。\n"
                "你最好的朋友是Ellis和Olivia。"
            ),
            "user_id": "u001",
        },
    ]

    for s in default_souls:
        existing_soul = conn.execute(
            "SELECT 1 FROM souls WHERE soul_id = ?", (s["soul_id"],)
        ).fetchone()
        if existing_soul:
            conn.close()
            raise RuntimeError(f"默认灵魂 {s['soul_id']} 已存在，但数据库被判定为空，数据异常")
        conn.execute(
            "INSERT INTO souls (soul_id, soul_name, description, user_id, created_by) VALUES (?, ?, ?, ?, ?)",
            (s["soul_id"], s["soul_name"], s["description"], s["user_id"], s["user_id"])
        )

    conn.commit()
    conn.close()
    print("[db_utils] ✅ 默认用户和灵魂已插入")


# ═══════════════════════════════════════════════════════
# Session
# ═══════════════════════════════════════════════════════

def get_max_session_id() -> int:
    """获取当前最大的 session_id"""
    conn = _get_conn()
    row = conn.execute("SELECT MAX(session_id) FROM sessions").fetchone()
    conn.close()
    return row[0] if row[0] is not None else 0


def get_or_create_session(session_id: int = None, title: str = "",
                          participants: list = None) -> int:
    """
    获取或创建 session。返回 session_id。
    如果 session_id 为 None，自动分配一个新 session（max+1）。
    """
    conn = _get_conn()
    if session_id is not None:
        row = conn.execute(
            "SELECT session_id FROM sessions WHERE session_id = ?",
            (session_id,)
        ).fetchone()
        if row:
            conn.close()
            return session_id

    if session_id is None:
        session_id = get_max_session_id() + 1

    conn.execute(
        "INSERT OR IGNORE INTO sessions (session_id, title, participants) VALUES (?, ?, ?)",
        (session_id, title, json.dumps(participants or []))
    )
    conn.commit()
    conn.close()
    print(f"[db_utils] 📝 Session {session_id} 已就绪")
    return session_id


# ═══════════════════════════════════════════════════════
# Soul
# ═══════════════════════════════════════════════════════

def get_soul_by_id(soul_id: str) -> Optional[Dict[str, Any]]:
    """根据 soul_id 查询角色信息"""
    conn = _get_conn()
    row = conn.execute(
        "SELECT soul_id, soul_name, description FROM souls WHERE soul_id = ?",
        (str(soul_id),)
    ).fetchone()
    conn.close()
    if row:
        return {
            "soul_id": row["soul_id"],
            "soul_name": row["soul_name"],
            "description": row["description"],
        }
    print(f"[db_utils] ⚠️ 未找到 soul_id={soul_id} 的角色")
    return None


def get_soul_system_prompt(soul_id: str) -> str:
    """获取角色的 description 作为 system prompt 片段。如果角色不存在，返回空字符串。"""
    soul = get_soul_by_id(soul_id)
    if soul:
        return soul.get("description", "")
    return ""


# ═══════════════════════════════════════════════════════
# User
# ═══════════════════════════════════════════════════════

def get_user_by_id(user_id: str) -> Optional[Dict[str, Any]]:
    """根据 user_id 查询用户信息"""
    conn = _get_conn()
    row = conn.execute(
        "SELECT user_id, user_name, profile FROM users WHERE user_id = ?",
        (str(user_id),)
    ).fetchone()
    conn.close()
    if row:
        return {
            "user_id": row["user_id"],
            "user_name": row["user_name"],
            "profile": row["profile"],
        }
    print(f"[db_utils] ⚠️ 未找到 user_id={user_id} 的用户")
    return None


def get_user_profile(user_id: str) -> str:
    """获取用户的 profile 文本。如果用户不存在，返回空字符串。"""
    user = get_user_by_id(str(user_id))
    if user:
        return user.get("profile", "")
    return ""


def get_user_password(user_id: str) -> Optional[str]:
    """根据 user_id 查询用户密码"""
    conn = _get_conn()
    row = conn.execute(
        "SELECT password FROM users WHERE user_id = ?",
        (str(user_id),)
    ).fetchone()
    conn.close()
    if row:
        return row["password"]
    return None


def check_soul_id_exists(soul_id: str) -> bool:
    """检查 soul_id 是否已存在"""
    conn = _get_conn()
    row = conn.execute(
        "SELECT 1 FROM souls WHERE soul_id = ?",
        (str(soul_id),)
    ).fetchone()
    conn.close()
    return row is not None


def list_all_soul_ids() -> List[str]:
    """列出全部 soul_id（编译期 soul 校验的可用列表用）"""
    conn = _get_conn()
    rows = conn.execute("SELECT soul_id FROM souls").fetchall()
    conn.close()
    return [str(r["soul_id"]) for r in rows]


def list_souls() -> List[Dict[str, str]]:
    """列出全部角色（精简：soul_id + soul_name；femo-soul list 工具用）"""
    conn = _get_conn()
    rows = conn.execute("SELECT soul_id, soul_name FROM souls ORDER BY idx").fetchall()
    conn.close()
    return [{"soul_id": str(r["soul_id"]), "soul_name": str(r["soul_name"])} for r in rows]


def check_user_id_exists(user_id: str) -> bool:
    """检查 user_id 是否已存在"""
    conn = _get_conn()
    row = conn.execute(
        "SELECT 1 FROM users WHERE user_id = ?",
        (str(user_id),)
    ).fetchone()
    conn.close()
    return row is not None


def create_soul(soul_id: str, soul_name: str, description: str, user_id: str) -> None:
    """创建新的 soul 条目，created_by 自动填入 user_id"""
    conn = _get_conn()
    conn.execute(
        "INSERT INTO souls (soul_id, soul_name, description, user_id, created_by) VALUES (?, ?, ?, ?, ?)",
        (soul_id, soul_name, description, user_id, user_id)
    )
    conn.commit()
    conn.close()
    print(f"[db_utils] ✅ 新建 soul: soul_id={soul_id}, soul_name={soul_name}, user_id={user_id}")


def create_user(user_id: str, password: str = "") -> None:
    """创建新的 user 条目（如果不存在）"""
    conn = _get_conn()
    conn.execute(
        "INSERT INTO users (user_id, password) VALUES (?, ?)",
        (user_id, password)
    )
    conn.commit()
    conn.close()
    print(f"[db_utils] ✅ 新建 user: user_id={user_id}")


# ═══════════════════════════════════════════════════════
# 对话记录插入（保留原有函数，下面的注释块不动）
# ═══════════════════════════════════════════════════════

def insert_dialog_record(
    session_id: int,
    turn_id: int,
    user_prompt: str = "",
    user_id: int = None,
    soul_id: int = None,
    user_scope: List[int] = None,
    soul_scope: List[int] = None,
    work_mode: str = "chat",
    **kwargs,
) -> None:
    """插入一条人类发言记录"""
    conn = _get_conn()
    conn.execute("""
        INSERT OR REPLACE INTO dialog
        (session_id, turn_id, user_prompt, user_id, soul_id,
         user_scope, soul_scope, work_mode, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        session_id, turn_id, user_prompt,
        user_id, soul_id,
        json.dumps(user_scope or []),
        json.dumps(soul_scope or []),
        work_mode,
        int(__import__('time').time()),
    ))
    conn.commit()
    conn.close()


def insert_ai_record(
    session_id: int,
    turn_id: int,
    response: str = "",
    soul_id: int = None,
    user_scope: List[int] = None,
    soul_scope: List[int] = None,
    step_idx: int = 0,
    cot: str = "",
    model_id: str = "",
    **kwargs,
) -> None:
    """插入一条 AI 回复记录"""
    conn = _get_conn()
    conn.execute("""
        INSERT OR REPLACE INTO react_steps
        (session_id, turn_id, step_idx, response, soul_id,
         user_scope, soul_scope, cot, model_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        session_id, turn_id, step_idx, response,
        soul_id,
        json.dumps(user_scope or []),
        json.dumps(soul_scope or []),
        cot, model_id,
    ))
    conn.commit()
    conn.close()


def get_next_turn_id(session_id: int) -> int:
    """获取指定 session 的下一个 turn_id"""
    conn = _get_conn()
    row = conn.execute(
        "SELECT MAX(turn_id) FROM dialog WHERE session_id = ?",
        (session_id,)
    ).fetchone()
    conn.close()
    return (row[0] or 0) + 1


def session_exists(session_id: int) -> bool:
    """检查 session 是否存在"""
    conn = _get_conn()
    row = conn.execute("SELECT 1 FROM sessions WHERE session_id = ?", (session_id,)).fetchone()
    conn.close()
    return row is not None
