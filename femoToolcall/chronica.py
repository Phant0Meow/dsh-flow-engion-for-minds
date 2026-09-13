# -*- coding: utf-8 -*-
"""
chronica.py — 直查活体 Chronica.wor（femo 运行台账 SQLite）。与 femo-chat.mjs 同族的剧场应急工具。

设计理念（2026-08-26 用户口述）：prompt 是教 AI 怎么说话，不属于对话流；
showprompt 属于剧本正经旁白，属于正经对话流的一部分。
因此本工具把台账拆成两幕呈现：
  【对话流】= showprompt 旁白 + AI 发言 + 人类输入（按时间线交织）；
  【幕后指令】= 节点 prompt（附录，非对话流）。
判别依据（dialog.user_id JSON）：femoshow-* = 旁白；femo-* = 指令；其余 = 真人输入。

用法：
  python chronica.py                 # 最新场次的对话流 + 幕后指令附录
  python chronica.py 869             # 指定场次
  python chronica.py --list 5        # 最近 5 个场次一览（标题+调用数）
  python chronica.py 869 --scope     # 每行附带可见性信息（排查视野问题用）
  python chronica.py 869 --full      # 发言全文不截断（默认对话流行截 110 字、指令 90 字）

WAL 只读连接（mode=ro），与运行中的引擎互不干扰；
无需复制副本（复制法是旧文件沙箱时代的绕路，已废弃）。
2026-08-28 两处加固（用户拍板）：
  1. 路径要活的：库位置相对脚本自身解析（<脚本目录>/user_data/memory/Chronica.wor），
     不再写死盘符——整个插件目录搬家/改名照常工作；
  2. immutable 回退：引擎收尾清掉 wal/shm 边车后 mode=ro 会报
     "unable to open database file"（只读连接建不了 shm），此时降级
     immutable=1 快照读（引擎不在写库时安全；引擎运行中边车在场，
     第一分支即可连上，不受影响）。
  3. 同日再补一刀（实测踩坑）：immutable 降级原本只 try connect()，但 WAL 库
     是惰性打开——connect 成功、第一次查询才报错，降级分支永远接不住。
     现 _connect() 连上后先做一次探针读（sqlite_master 计数）再判定。
"""
import os, sqlite3, sys, json

_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 插件根（本脚本在 femoToolcall/ 下）
DB = os.path.join(_BASE, "user_data", "memory", "Chronica.wor")
_URI_BASE = "file:" + DB.replace(chr(92), "/")


def _connect():
    """只读连接；mode=ro 连不上（边车被清）时降级 immutable=1 快照读。

    注意：WAL 库是惰性打开——connect() 往往能成功，第一次真读才报
    "unable to open database file"（2026-08-28 实测报错点在 execute 处）。
    所以降级判定必须连上后先做一次探针读，只 try connect() 是接不住的。
    """
    con = None
    try:
        con = sqlite3.connect(f"{_URI_BASE}?mode=ro", uri=True, timeout=3)
        con.execute("SELECT count(*) FROM sqlite_master").fetchone()  # 探针：强制真读一次
        return con
    except sqlite3.OperationalError:
        if con is not None:
            try:
                con.close()
            except Exception:
                pass
    return sqlite3.connect(f"{_URI_BASE}?mode=ro&immutable=1", uri=True, timeout=3)


def _scopes(raw):
    if not raw:
        return ""
    try:
        arr = json.loads(raw)
        return ",".join(str(x) for x in arr) if isinstance(arr, list) else str(raw)
    except Exception:
        return str(raw)


def _classify(user_id_raw):
    """dialog.user_id 判别行性质：femoshow-*=旁白 / femo-*=指令 / 其余=真人输入。"""
    try:
        arr = json.loads(user_id_raw)
        first = str(arr[0]) if isinstance(arr, list) and arr else ""
    except Exception:
        first = str(user_id_raw)
    if first.startswith("femoshow"):
        return "narration"
    if first.startswith("femo"):
        return "directive"
    return "human"


def _clip(text, n):
    return str(text).replace("\n", " ")[:n]


def main():
    args = sys.argv[1:]
    show_scope = "--scope" in args
    args = [a for a in args if a != "--scope"]
    show_full = "--full" in args
    args = [a for a in args if a != "--full"]
    clip_line = 10**9 if show_full else 110   # 对话流行宽（--full=不截断）
    clip_dir = 10**9 if show_full else 90     # 幕后指令行宽

    conn = _connect()
    cur = conn.cursor()

    if "--list" in args:
        n = int(args[args.index("--list") + 1]) if len(args) > args.index("--list") + 1 else 8
        rows = cur.execute(
            "SELECT s.session_id, s.title, "
            "(SELECT COUNT(*) FROM react_steps r WHERE r.session_id = s.session_id), "
            "(SELECT COUNT(*) FROM dialog d WHERE d.session_id = s.session_id) "
            "FROM sessions s ORDER BY s.session_id DESC LIMIT ?", (n,)
        ).fetchall()
        print(f"最近 {len(rows)} 场：")
        for sid, title, ai_n, dia_n in reversed(rows):
            print(f"  [{sid}] 《{title}》 AI发言={ai_n} 台账行={dia_n}")
        return

    sid = int(args[0]) if args and args[0].isdigit() else cur.execute("SELECT MAX(session_id) FROM sessions").fetchone()[0]
    row = cur.execute("SELECT title FROM sessions WHERE session_id=?", (sid,)).fetchone()
    if row is None:
        print(f"场次 {sid} 不存在"); return
    tag = "（含 scope）" if show_scope else ""
    print(f"=== 场次 {sid}《{row[0]}》{tag} ===")

    # ── 收集两表事件，统一按时间排序 ──
    events = []  # (timestamp, kind, turn_id, text, user_scope, soul_scope)
    for ts, tid, uid, p, us, ss in cur.execute(
        "SELECT timestamp, turn_id, user_id, user_prompt, user_scope, soul_scope "
        "FROM dialog WHERE session_id=? ORDER BY id", (sid,)
    ):
        events.append((ts or 0, _classify(uid), tid, str(p), us, ss))
    for ts, tid, soul, resp, us, ss in cur.execute(
        "SELECT timestamp, turn_id, soul_id, response, user_scope, soul_scope "
        "FROM react_steps WHERE session_id=? ORDER BY id", (sid,)
    ):
        events.append((ts or 0, "ai", tid, f"{soul}: {resp}", us, ss))
    events.sort(key=lambda e: e[0])

    # ── 第一幕：对话流（旁白 / AI / 人类）──
    print("\n─── 对话流 ───")
    for ts, kind, tid, text, us, ss in events:
        if kind == "directive":
            continue
        who = {"narration": "旁白", "ai": "AI", "human": "人类"}[kind]
        line = f"  [{who}] {_clip(text, clip_line)}"
        if show_scope:
            line += f"\n        可见用户={_scopes(us)} 可见角色={_scopes(ss)}"
        print(line)

    # ── 第二幕：幕后指令（prompt，非对话流）──
    directives = [e for e in events if e[1] == "directive"]
    print(f"\n─── 幕后指令（prompt × {len(directives)}，不属对话流）───")
    for ts, kind, tid, text, us, ss in directives:
        line = f"  t{tid}: {_clip(text, clip_dir)}"
        if show_scope:
            line += f"\n        可见用户={_scopes(us)} 可见角色={_scopes(ss)}"
        print(line)
    conn.close()

if __name__ == "__main__":
    main()
