#femoCompiler/save_dialog.py
"""
SaveDialog.py — 对话存储模块
===============================
负责将人类发言和 AI 发言存入数据库，
自动处理 scope 注入、去重、turn 和 step_idx 管理。
"""

#from db_utils import insert_dialog_record, insert_ai_record
import threading
import queue
import json
import time

def _build_scope(action_scope, actor_info, meta_owner, raw_action_scope=None):
    """
    构建最终的 user_scope 和 soul_scope。
    自动注入发言者自己和 meta.owner，去重，删除 0。

    raw_action_scope: action 的原始 scope 字符串（未解析）。仅用于 scope: self
    保留字段判定（2026-08-31 猫猫拍板）：显式写了 self → 走下面同一条"注入发言
    者自己+meta.owner"路径。判定基于原始字符串、独立于 action_scope 是否为空——
    空 scope 的语义之后要改，self 的语义不能绑在"空"上面（self≠空，self=显式
    只给自己+owner）。不传（None）时行为与旧版完全一致。
    """
    if raw_action_scope is not None and str(raw_action_scope).strip().lower() == 'self':
        action_scope = ([], [])
    user_scope = [str(x) for x in action_scope[0]] if action_scope else []
    soul_scope = [str(x) for x in action_scope[1]] if action_scope else []

    # 注入发言者自己（字符串）
    if 'user' in actor_info:
        uid = str(actor_info['user'])
        if uid not in user_scope:
            user_scope.append(uid)
    if 'soul' in actor_info and actor_info['soul'] is not None:
        sid = str(actor_info['soul'])
        if sid not in soul_scope:
            soul_scope.append(sid)

    # 注入 meta.owner（保持字符串）
    for uid in (meta_owner or []):
        uid_str = str(uid)
        if uid_str not in user_scope:
            user_scope.append(uid_str)

    # 删除无效值（空字符串、'0' 等）
    user_scope = [x for x in user_scope if x and x != '0']
    soul_scope = [x for x in soul_scope if x and x != '0']

    # 去重排序
    user_scope = sorted(set(user_scope))
    soul_scope = sorted(set(soul_scope))

    return user_scope, soul_scope
    
    
def _do_insert_dialog(session_id, turn_id, oratio_idx, user_prompt, user_id, soul_id,
                      user_scope, soul_scope, work_mode="chat", **kwargs):
    from femoCompiler.db_utils import _get_conn
    conn = _get_conn()
    try:
        final_user_id_json = json.dumps(user_id) if isinstance(user_id, list) else (user_id or '[]')
        # 下行只为了调试打印，不要删除
        #print(f"[DEBUG _do_insert_dialog] final user_id={user_id!r}, json={json.dumps(user_id) if isinstance(user_id, list) else (user_id or '[]')}"),
        conn.execute("""
            INSERT INTO dialog
            (session_id, turn_id, oratio_idx, user_prompt, user_id, soul_id,
             user_scope, soul_scope, work_mode, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            session_id, turn_id, oratio_idx,
            user_prompt,
            json.dumps([str(x) for x in user_id]) if isinstance(user_id, list) else (str(user_id) if user_id else '[]'),
            soul_id or '',
            json.dumps([str(x) for x in (user_scope or [])]),
            json.dumps([str(x) for x in (soul_scope or [])]),
            work_mode,
            int(time.time()),
        ))
        conn.commit()
    finally:
        conn.close()

def _do_insert_ai(session_id, turn_id, step_idx, response, soul_id,
                  user_scope, soul_scope, model_id="", cot="", tool_call="", tool_result="", **kwargs):
    from femoCompiler.db_utils import _get_conn
    conn = _get_conn()
    try:
        conn.execute("""
            INSERT INTO react_steps
            (session_id, turn_id, step_idx, timestamp, response, soul_id,
             user_scope, soul_scope, cot, model_id, tool_call, tool_result)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            session_id, turn_id, step_idx,
            int(time.time()),
            response,
            soul_id or '',
            json.dumps([str(x) for x in (user_scope or [])]),
            json.dumps([str(x) for x in (soul_scope or [])]),
            cot, model_id,
            tool_call, tool_result,
        ))
        conn.commit()
    finally:
        conn.close()
        
        


def save_human_turn(session_id, turn_id, oratio_idx, user_input, actor_info, meta_owner,
                    action_scope=None, is_node_prompt=False, femo_id: str = '', prompt_type='prompt',
                    raw_action_scope=None):
    """
    将人类发言或节点 prompt 入队（后台线程写入数据库）
    """
    user_scope, soul_scope = _build_scope(action_scope, actor_info, meta_owner, raw_action_scope)
    # 构建 user_id 列表
    if is_node_prompt and femo_id:
        if prompt_type == 'showprompt':
            user_id_list = [f'femoshow-{femo_id}']
        else:
            user_id_list = [f'femo-{femo_id}']
        #print(f"[DEBUG save_human_turn] node mode, user_id_list={user_id_list}")
    else:
        raw_user = actor_info.get('user')
        user_id_list = [str(raw_user)] if raw_user else []
        #print(f"[DEBUG save_human_turn] normal mode, raw_user={raw_user!r}, user_id_list={user_id_list}")
    soul_id = str(actor_info['soul']) if actor_info.get('soul') and not is_node_prompt else ''


    event = save_queue.enqueue_human(
        session_id=session_id,
        turn_id=turn_id,
        oratio_idx=oratio_idx,
        user_prompt=user_input,
        user_id=user_id_list,
        soul_id=soul_id,
        user_scope=user_scope,
        soul_scope=soul_scope,
    )
    print(f"[SaveDialog] 💬 节点/人类发言已入队: session={session_id}, turn={turn_id}, oratio={oratio_idx}")
    return event


def save_ai_turn(session_id, turn_id, step_idx, response, actor_info, meta_owner,
                 model_id="", thinking="", action_scope=None, raw_action_scope=None):
    """
    将 AI 发言入队（后台线程写入数据库）
    """
    user_scope, soul_scope = _build_scope(action_scope, actor_info, meta_owner, raw_action_scope)
    soul_id = str(actor_info['soul']) if actor_info.get('soul') else ''

    event = save_queue.enqueue_ai(
        session_id=session_id,
        turn_id=turn_id,
        step_idx=step_idx,
        response=response,
        soul_id=soul_id,
        model_id=model_id,
        cot=thinking,
        user_scope=user_scope,
        soul_scope=soul_scope,
    )
    print(f"[SaveDialog] 🤖 AI 发言已入队: session={session_id}, turn={turn_id}, step={step_idx}")
    return event


def _do_insert_group(session_id, entries):
    """单事务多行写入（2026-08-29 合写）：entries 里全部行一次 commit——
    要么全有要么全无，消灭「有 show 没发言」的半行。异常 rollback 后 raise
    （不吞错）。entries 元素按 kind 区分：
      dialog_show  → dialog 表 showprompt 行（femoshow-*）
      human_input  → dialog 表 玩家输入行
      ai_step      → react_steps 表 一轮转写（cot/tool_call/tool_result 各归各位）
    """
    from femoCompiler.db_utils import _get_conn
    conn = _get_conn()
    try:
        for e in entries:
            kind = e['kind']
            ts = int(time.time())
            if kind == 'dialog_show':
                conn.execute("""INSERT INTO dialog
                    (session_id, turn_id, oratio_idx, user_prompt, user_id, soul_id,
                     user_scope, soul_scope, work_mode, timestamp)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (session_id, e['turn_id'], e['oratio_idx'], e['text'],
                     json.dumps([f"femoshow-{e['femo_id']}"]), '',
                     json.dumps([str(x) for x in (e['user_scope'] or [])]),
                     json.dumps([str(x) for x in (e['soul_scope'] or [])]),
                     'chat', ts))
            elif kind == 'human_input':
                conn.execute("""INSERT INTO dialog
                    (session_id, turn_id, oratio_idx, user_prompt, user_id, soul_id,
                     user_scope, soul_scope, work_mode, timestamp)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (session_id, e['turn_id'], e['oratio_idx'], e['text'],
                     json.dumps([str(e['user_id'])]) if e['user_id'] else '[]',
                     e['soul_id'] or '',
                     json.dumps([str(x) for x in (e['user_scope'] or [])]),
                     json.dumps([str(x) for x in (e['soul_scope'] or [])]),
                     'chat', ts))
            elif kind == 'ai_step':
                conn.execute("""INSERT INTO react_steps
                    (session_id, turn_id, step_idx, timestamp, response, soul_id,
                     user_scope, soul_scope, cot, model_id, tool_call, tool_result)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (session_id, e['turn_id'], e['step_idx'], ts, e['response'],
                     e['soul_id'] or '',
                     json.dumps([str(x) for x in (e['user_scope'] or [])]),
                     json.dumps([str(x) for x in (e['soul_scope'] or [])]),
                     e.get('cot', ''), e.get('model_id', ''),
                     e.get('tool_call', ''), e.get('tool_result', '')))
            else:
                raise ValueError(f"未知合写行类型: {kind}")
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def save_ai_finish(session_id, turn_id, showprompt, steps, actor_info, meta_owner,
                   action_scope=None, femo_id="unknown", model_id="", raw_action_scope=None):
    """AI 节点收尾合写（2026-08-29 转写分离配套）：showprompt 行 + 全部 react
    step 行同一事务落库——要不然都有，要不然都没有，消灭半行。

    showprompt: 渲染后的 showprompt 文本（None/空 = 无 showprompt 的节点）；
    steps: [{step, cot, reply, toolCall, toolResult}]（转写分离结构），
    空 steps 回退为单空 react 行（与旧行为对齐）。
    prompt 行不在本组——节点开始时已落（幕后指令，节点启动痕迹）。
    model_id: 模型标识（可空，落库 react_steps.model_id 列）。"""
    user_scope, soul_scope = _build_scope(action_scope, actor_info, meta_owner, raw_action_scope)
    soul_id = str(actor_info['soul']) if actor_info.get('soul') else ''
    entries = []
    if showprompt:
        entries.append({'kind': 'dialog_show', 'turn_id': turn_id, 'oratio_idx': 1,
                        'text': showprompt, 'femo_id': femo_id,
                        'user_scope': user_scope, 'soul_scope': soul_scope})
    if not steps:
        steps = [{'step': 0, 'cot': '', 'reply': '', 'toolCall': '', 'toolResult': ''}]
    for idx, s in enumerate(steps):
        if not isinstance(s, dict):
            s = {'reply': str(s)}
        entries.append({'kind': 'ai_step', 'turn_id': turn_id,
                        'step_idx': int(s.get('step', idx) or idx),
                        'response': str(s.get('reply', '') or ''),
                        'soul_id': soul_id, 'model_id': model_id,
                        'cot': str(s.get('cot', '') or ''),
                        'tool_call': str(s.get('toolCall', '') or ''),
                        'tool_result': str(s.get('toolResult', '') or ''),
                        'user_scope': user_scope, 'soul_scope': soul_scope})
    print(f"[SaveDialog] 🤖 AI 收尾合写已入队: session={session_id}, turn={turn_id}, rows={len(entries)}")
    return save_queue.enqueue_group(session_id=session_id, entries=entries)


def save_human_finish(session_id, turn_id, showprompt, user_input, input_oratio,
                      actor_info, meta_owner, action_scope=None, femo_id="unknown",
                      raw_action_scope=None):
    """human 节点收尾合写（2026-08-29）：showprompt 行（本轮新增——此前 human
    节点的 show 从未落库）+ 玩家输入行同一事务。输入为空（如超时放行）时只写
    show 行——即「超时留痕」的自然实现：台账上留得住"这个节点等过人"。"""
    user_scope, soul_scope = _build_scope(action_scope, actor_info, meta_owner, raw_action_scope)
    raw_user = actor_info.get('user')
    soul_id = str(actor_info['soul']) if actor_info.get('soul') else ''
    entries = []
    if showprompt:
        entries.append({'kind': 'dialog_show', 'turn_id': turn_id, 'oratio_idx': 1,
                        'text': showprompt, 'femo_id': femo_id,
                        'user_scope': user_scope, 'soul_scope': soul_scope})
    if user_input:
        entries.append({'kind': 'human_input', 'turn_id': turn_id,
                        'oratio_idx': input_oratio, 'text': user_input,
                        'user_id': str(raw_user) if raw_user else '', 'soul_id': soul_id,
                        'user_scope': user_scope, 'soul_scope': soul_scope})
    print(f"[SaveDialog] 💬 human 收尾合写已入队: session={session_id}, turn={turn_id}, rows={len(entries)}")
    if not entries:
        return None
    return save_queue.enqueue_group(session_id=session_id, entries=entries)


class SaveQueue:
    def __init__(self):
        self._queue = queue.Queue()
        self._running = True
        self._worker = threading.Thread(target=self._worker_loop, daemon=True)
        self._worker.start()

    def _worker_loop(self):
        """不死循环：工作线程崩溃后自动重启"""
        while self._running:
            try:
                self._run()
            except Exception as e:
                import traceback
                traceback.print_exc()
                #print(f"[SaveQueue] 工作线程异常退出，3 秒后重启: {e}")
                time.sleep(3)
        
    def _enqueue_with_event(self, typ, kwargs):
        """入队一个任务，返回一个 threading.Event，任务处理完成后会 set"""
        event = threading.Event()
        self._queue.put((typ, kwargs, event))
        return event

    def _run(self):
        print("[SaveQueue] 后台线程已启动")
        while True:
            try:
                item = self._queue.get(timeout=0.1)

                if item is None:
                    # 毒丸修复（2026-08-24）：哨兵必须 task_done 归账。否则
                    # Queue 的 unfinished 计数永远 ≥1，同进程第二轮 run 的
                    # wait_empty 卡死在 queue.join() → flow_done 永不发出
                    # → 宿主 running 永远 true（「时灵时不灵」+ 新会话被
                    # 「已有剧本在运行中」拒绝的共同根因）。
                    self._queue.task_done()
                    break
                if len(item) == 2:
                    typ, kwargs = item
                    event = threading.Event()

                else:
                    typ, kwargs, event = item

                try:
                    self._process_item((typ, kwargs))
                except Exception as e:
                    print(f"[SaveQueue] 处理失败: {e}")
                finally:
                    event.set()

                self._queue.task_done()
            except queue.Empty:
                if not self._running:
                    break
                continue
            except Exception as e:
                print(f"[SaveQueue] 运行错误: {e}")
                import traceback
                traceback.print_exc()

    def _process_item(self, item):
        """实际写入数据库，item 是 (type, kwargs)"""
        typ, kwargs = item
        try:
            if typ == 'human':
                _do_insert_dialog(**kwargs)
            elif typ == 'ai':
                _do_insert_ai(**kwargs)
            elif typ == 'group':
                _do_insert_group(**kwargs)
        except Exception as e:
            import traceback
            traceback.print_exc()
            print(f"[SaveQueue] ❌ 写入失败: {e}")

    def enqueue_human(self, **kwargs):
        event = self._enqueue_with_event('human', kwargs)
        #print(f"[SaveQueue] enqueue_human: 任务已入队, event={event}")
        return event

    def enqueue_ai(self, **kwargs):
        event = self._enqueue_with_event('ai', kwargs)
        #print(f"[SaveQueue] enqueue_ai: 任务已入队, event={event}")
        return event

    def enqueue_group(self, **kwargs):
        """合写入队（2026-08-29）：多行同一事务，event 在整组 commit 后 set"""
        return self._enqueue_with_event('group', kwargs)

    def wait_empty(self, timeout=None):
        """等待队列清空后停止后台线程。

        D2 修复（运行状态链路重构 §5.8）：原实现 `self._queue.join()` 无超时且
        timeout 参数被无视（只喂给了 _worker.join）——队列卡住时收尾挂死
        （取消路径必经此处，不修则"worker 秒退"承诺打折）。改为轮询
        unfinished_tasks（0.2s sleep，至 timeout 或清零）：正常清零路径返回
        语义不变（调用点未用返回值）；run_async 取消路径传的 10 从此真实生效
        （timeout=None 保持现语义等清零）。"""
        deadline = None if timeout is None else time.monotonic() + timeout
        while self._queue.unfinished_tasks > 0:
            if deadline is not None and time.monotonic() >= deadline:
                break
            time.sleep(0.2)
        self._running = False
        self._queue.put(None)  # 发送停止信号
        self._worker.join(timeout=timeout)
        #print("[SaveDialog] 所有数据已写入，后台线程已停止")

    def restart(self):
        """重新启动后台线程（用于连续运行多个任务）"""
        if not self._running:
            self._running = True
            self._worker = threading.Thread(target=self._worker_loop, daemon=True)
            self._worker.start()

save_queue = SaveQueue()
