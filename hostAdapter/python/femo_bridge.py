#!/usr/bin/env python3
"""
femo_bridge.py — stdio NDJSON JSON-RPC bridge for the Femo compiler.

Runs the Femo engine (FEMO_parser + FEMO_runtime) as a headless subprocess and
speaks newline-delimited JSON over stdin/stdout:

  host -> bridge:  {"id": 1, "cmd": "job_start", "args": {...}}
  bridge -> host:  {"type": "response", "id": 1, "ok": true, "result": {...}}
                   {"type": "response", "id": 1, "ok": false, "error": "<code>", "detail": "<人话>"}
                   {"type": "event", "event": "<event_type>", "data": {...}}   # 事件信封带 job_id

Commands（Job 模型协议，运行状态链路重构 §7.2——每个命令必须给明确答复，
错误一律 {ok:false, error:<code>, detail:<人话>}，杜绝假成功 B5 死于结构）:
  job_start      Start one Job (active exclusivity in JobManager; compile_error
                 rejects before any Job file is created).
  job_resume     Resume a suspended Job (six gates adjudicated by JobManager;
                 resume_state comes from runs/<job_id>.json, not from host).
  job_pause      Pause a Job (idempotent; suspended persist happens on the
                 Runtime on_state_change callback, not here).
  actor_failed   Host executor ultimately failed (B5) — engine adjudicates:
                 notify author + suspend at node (断点保留，续跑=换新执行体重演).
                 Same mailbox validation as human_input; envelope
                 {'__actor_failed__':True, kind, detail}.
  human_input    Deliver human/AI input for a waiting node (per-Job mailbox,
                 no blind delivery).
  get_job_state  Read one Job's archive verbatim.
  list_jobs      List all Job archives (metadata rows, no vars_state).
  list_scripts   List .femo scripts under the user_data projects dir.
  check          Synchronous compile check (no state, no run).
  get_soul       One soul's record (persona 注入用；B4——宿主零直读 SQLite).
  list_souls / create_soul / ping / shutdown  (retained)
Retired: run / pause / resume / get_checkpoint (zero live consumers; host
switched in the same commit — no shims §八.6).

Protocol notes:
  - One JSON object per line, UTF-8. Every outbound line goes through a lock
    (event callbacks fire from LLM stream threads).
  - ai_request.blocks 料包键词汇契约见 femoCompiler/protocol.py BLOCK_KEYS
    （引擎拥有词汇表；拼装归执行后端——宿主拼装器为宿主模式正身）。
  - TranscriptStep 契约（AI 节点 human_input 回传 body.steps 逐项，生料）：
      {step:int, cot:str, reply:str, tool_calls:[{name,arguments}], tool_results:[str]}
      排版（[TOOL CALL #N] 模板）由引擎落档前套用——契约权威与归一化实现在
      femoCompiler/protocol.py，换 harness 只需照此契约回传。
  - 宿主握手面（harness 无关）：--host-manifest 提供清单（thinking 档位/
    默认用户——词汇事实，femoCompiler/host_manifest.py 消费，缺省回落内置）；
    job_start/job_resume/check 的 models 参数提供模型白名单
    （validate_actor_sources 编译期校验 source 用）；host_ref 是宿主塞的
    不透明标签（透传存档，引擎不懂；旧协议名 owner_tag 兼容读）。
    host_ai_backend（旧名 dsh_ai_backend 兼容）= AI 节点交宿主子代理执行。
  - FEMORunner is driven exactly like main.py's server mode: _human_input_event
    is set so human nodes wait on wait_key channels instead of stdin.
  - parse_script writes debug_normalized_output.femo into the CWD; the host
    should launch the bridge with a workdir it is allowed to pollute.
"""

import sys
import os
import json
import shutil
import threading
import argparse
import time
import traceback

# fork 循环回流每轮嵌套一层 asyncio 任务（见 FEMO_runtime._run_fork），
# 深层任务链的 Task.cancel() 是同步递归，默认 1000 栈深会在 stop 时
# RecursionError（maximum recursion depth exceeded）。提高递归限制兜底。
sys.setrecursionlimit(200_000)

# ── resolve the Femo project root ────────────────────────────────────────
def resolve_femo_root():
    root = os.environ.get("FEMO_ROOT", "")
    if root and os.path.isdir(root):
        return root
    return None

def ensure_default_data():
    """Insert Femo's default souls/users (idempotent) so ai_name resolution
    (get_soul_by_id) finds the built-in characters (Eve, littlecat, ...)."""
    try:
        from femoCompiler.db_utils import init_database, ensure_default_data as _seed
        init_database()
        _seed()
    except Exception as exc:
        sys.stderr.write(f"femo_bridge: ensure_default_data failed: {exc}\n")

def main():
    # Windows consoles default to GBK; Femo's own prints carry emoji and
    # would crash, and our JSON protocol carries UTF-8 Chinese text. Force
    # UTF-8 on all three streams before importing Femo.
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass

    parser = argparse.ArgumentParser(description="Femo stdio JSON-RPC bridge")
    parser.add_argument("--fe4m", default=None, help="Femo project root (default: $FEMO_ROOT)")
    parser.add_argument("--db", default=None,
                        help="Ledger DB override; default: user_dir/user_data/memory/Chronica.wor")
    parser.add_argument("--host-manifest", default=None,
                        help="宿主能力清单 JSON（thinking 档位/默认用户等 harness 词汇）；"
                             "缺省回读 $FEMO_HOST_MANIFEST，再缺省用引擎内置缺省")
    args = parser.parse_args()

    femo_root = args.fe4m or resolve_femo_root()
    if not femo_root:
        sys.stderr.write("femo_bridge: FEMO_ROOT/--fe4m must point at the Femo project\n")
        sys.exit(2)
    sys.path.insert(0, femo_root)
    if args.db:
        # 账本指向独立库（测试沙盒等用）；生产默认不受影响
        from femoCompiler.FEMO_config import set_db_path
        set_db_path(os.path.abspath(args.db))
    os.chdir(femo_root)  # keep parse_script's debug file out of the harness cwd

    from femoCompiler import host_manifest
    from femoCompiler.FEMO_parser import parse_script
    from femoCompiler.FEMO_runtime import FEMORunner
    from femoCompiler.job_manager import JobManager, JobError, JobBusyError, fingerprint_script

    def make_soul_checker():
        """构造 soul 存在性检查器：parse_script 编译期校验 actors 的 soul 用。
        携带 _soul_ids 可用列表，报错文案末尾附上（db_utils 无列表函数时省略）。"""
        from femoCompiler.db_utils import check_soul_id_exists, list_all_soul_ids

        def checker(sid: str) -> bool:
            return check_soul_id_exists(sid)

        checker._soul_ids = list_all_soul_ids()
        return checker

    out_lock = threading.Lock()

    def emit(obj):
        with out_lock:
            sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
            sys.stdout.flush()

    def send_response(req_id, ok, result=None, error=None, detail=None, extra=None):
        payload = {"type": "response", "id": req_id, "ok": ok}
        if ok:
            payload["result"] = result
        else:
            payload["error"] = error
            if detail:
                payload["detail"] = detail
            if extra:
                payload.update(extra)
        emit(payload)

    # ── 宿主能力清单（A2.1 解耦）────────────────────────────────────────
    # harness 的词汇与环境（thinking 档位/默认用户）由接口侧清单文件提供，
    # 启动时应用一次；缺失/损坏回落引擎内置缺省（standalone 自圆满），
    # 绝不因清单问题炸启动。
    manifest_path = args.host_manifest or os.environ.get("FEMO_HOST_MANIFEST", "")
    if manifest_path:
        manifest_data, manifest_err = host_manifest.load_manifest_file(manifest_path)
        if manifest_err is not None:
            print(f"[bridge] 宿主清单未应用：{manifest_err}（用引擎内置缺省词汇）")
        else:
            notes = host_manifest.apply_manifest(manifest_data)
            print("[bridge] 宿主清单已应用：" + ("；".join(notes) if notes else "（空清单，保持现状）"))
    else:
        print("[bridge] 未提供宿主清单（--host-manifest），引擎用内置缺省词汇")

    # ── Job 状态机（引擎侧唯一权威）────────────────────────────────────────
    jm = JobManager()
    # 【2026-09-07 214 事故改造】启动扫全目录的 reconcile() 退役——它按
    # "不在我内存里=主人死了"把所有 running 档案判 crash，判定依据是本进程
    # 的 _bound，而 runs/ 目录是多进程共享资源（测试 bridge/第二个宿主都会
    # 踩进来），会把活进程的 Job 误杀（214 实锤）。对账改为懒式：挂在
    # get_job_state(reconcile_if_stale=true)（femoGen 打开 session 的唯一询问点，
    # 宿主只对 session 归属本宿主时才带此参数）与 job_resume 动手前，
    # 单档案、_bound 主人检查先行——见 JobManager.reconcile_stale。

    # job_id → worker 线程（shutdown join 用：取消传播+on_state_change 落盘是
    # 异步的，join 到位再 exit——关机也诚实落 suspended，§7.2 shutdown 修正）
    workers = {}

    # ── per-job 事件包装与信封（§7.3）──────────────────────────────────────
    def make_event_callback(job_id):
        def cb(event_type, data):
            payload = {**(data if isinstance(data, dict) else {}), 'job_id': job_id}
            jm.observe_event(job_id, event_type, payload)      # 状态机旁挂（§7.5）
            emit({'type': 'event', 'event': event_type, 'data': payload})   # 信封带 job_id（A4 路由键）
        return cb

    def spawn_job_worker(job_id, script, base_dir, user_api_key, user_api_provider,
                         user_api_url, user_api_model, host_ai_backend=False,
                         resume_state=None):
        """构造 Runner 并起 worker 线程（§7.4，三面收口）：
        ①构造期异常（resume 裁决过了、FEMORunner.__init__ 里 restore_state 抛）
          → except → finalize('failed')；
        ②节点异常从 run_async 传播 → 同上；
        ③正常结束 → run_async 内 flow_done → observe_event → finalize('finished')，
          worker finally 兜底因 state 已非 running 而 no-op；
        ④取消/暂停 → on_state_change 回调先落 suspended，worker finally 兜底 no-op。
        Job 永不卡 running（除进程暴毙→对账 crash）。
        ⚠️ 实现决定（对清单 §7.4 伪代码的修订回写）：resume 分支的 mark_running
        在【构造前】调用——伪代码放构造后会让构造期异常停在 suspended
        （finalize 仅 running 生效，no-op 停尸）；构造前调用使 except/finally 的
        finalize(failed) 在 running 态生效，同样"不停僵尸 running"且收口统一。"""
        def worker():
            runner = None
            try:
                if resume_state:
                    # resume：裁决已过、构造即将开始——先确认 running（见上注）。
                    jm.mark_running(job_id)
                runner = FEMORunner(
                    script,
                    base_dir=base_dir,
                    verbose=False,
                    event_callback=make_event_callback(job_id),
                    user_api_key=user_api_key,
                    user_api_provider=user_api_provider,
                    user_api_url=user_api_url,
                    user_api_model=user_api_model,
                    resume_state=resume_state,
                    # Job 旁挂（§4.2 窄回调契约）：Runtime 不认识 Job，
                    # bridge 是翻译层——四个 lambda 全部在 worker 单线程 fire。
                    runtime_callbacks={
                        'on_flow_start':   lambda p: jm.mark_session(job_id, p.get('session_id')),
                        'on_checkpoint':   lambda p: jm.merge_checkpoint(job_id, p),
                        'on_state_change': lambda st, reason: jm.suspend(job_id, reason),
                        'on_run_end':      lambda fs: jm.finalize(job_id, 'finished'),
                    },
                    # wait_key 世代前缀（§5.6）：跨 Job 键永不重合的机制性免疫
                    run_tag=f'j{job_id}:',
                )
                if resume_state:
                    print(f"[bridge] resume state keys: {sorted(resume_state.keys())}")
                runner._human_input_event = threading.Event()
                runner._human_input_data = None
                if host_ai_backend:
                    # AI 节点走宿主子代理后端：_exec_ai 上行 ai_request 事件，
                    # 等待 host 回传（human_input 命令，wait_key 形如 j<N>:ai_*）。
                    runner._host_ai_backend = True
                    # DSH harness 接口钉死的上下文拼接模式：子代理窗口 durable
                    # 复用（同 Job 同角色同窗口），首轮喂全量、之后只喂增量——
                    # 这是 harness 的窗口记忆契约，剧本无感。其他 harness 接口
                    # 自行决定钉哪种模式；不钉（直连等）吃默认 full。
                    from femoBridges.ContextExample import MODE_FIRST_FULL_THEN_INCREMENTAL
                    runner._context_mode = MODE_FIRST_FULL_THEN_INCREMENTAL
                jm.attach(job_id, runner)
                runner.run()
                emit({'type': 'event', 'event': 'bridge_run_ended',
                      'data': {'ok': True, 'job_id': job_id}})
            except Exception as exc:
                traceback.print_exc(file=sys.stderr)
                # failed 路径照发 flow_error（§八.12：宿主清场全挂它）
                emit({'type': 'event', 'event': 'flow_error',
                      'data': {'error': str(exc), 'job_id': job_id}})
                emit({'type': 'event', 'event': 'bridge_run_ended',
                      'data': {'ok': False, 'job_id': job_id}})
                jm.finalize(job_id, 'failed', error=str(exc))   # 收口①②
            finally:
                if runner is not None:
                    try:
                        import asyncio
                        asyncio.run(runner.engine.shutdown())
                    except Exception:
                        pass                      # A2 修复后不再假死
                jm.detach(job_id)
                jm.finalize(job_id, 'failed')     # 收口③兜底：幂等，仅 running 态生效
        t = threading.Thread(target=worker, daemon=True)
        workers[job_id] = t
        t.start()

    # ── 同步编译（check / job_start / job_resume 共用一份）─────────────────
    def run_compile(femo_text, base_dir, models=None):
        """同步 parse：编译错误在此拒绝——job_start/job_resume 的编译失败连
        Job 文件都不产生（脏 Job 号零残留，§7.2）。base_dir 空串=未保存的
        合法语义（引擎对相对路径报错），不能用 femo_root 回退。
        models = 宿主注入的模型白名单（validate_actor_sources 编译期校验
        source 用；None 跳过校验）。
        编译成功时顺带取出 script.warnings（2026-09-07 warning 桶：编译不
        阻断的提示），随三个回执上浮宿主；warnings 取不到按空列表（旧
        Script 无此字段时防 AttributeError）。"""
        script = parse_script(
            femo_text,
            base_dir=base_dir if base_dir is not None else femo_root,
            soul_checker=make_soul_checker(),
            models=models,
        )
        return script, list(getattr(script, 'warnings', None) or [])

    # ── command dispatch ───────────────────────────────────────────────────
    def dispatch_inner(req_id, cmd, args_obj):
        if cmd == "ping":
            send_response(req_id, True, {"pong": True})
        elif cmd == "list_scripts":
            # Scan both the Femo project's bundled projects dir and the
            # user-data projects dir (get_user_dir may resolve elsewhere).
            from femoBridges.getDir.get_dir import get_user_dir
            candidates = []
            local_projects = os.path.join(femo_root, "user_data", "projects")
            if os.path.isdir(local_projects):
                candidates.append(local_projects)
            home_projects = os.path.join(get_user_dir(), "user_data", "projects")
            if os.path.isdir(home_projects) and home_projects not in candidates:
                candidates.append(home_projects)
            scripts = []
            for projects in candidates:
                for name in sorted(os.listdir(projects)):
                    sub = os.path.join(projects, name)
                    if os.path.isdir(sub):
                        for f in sorted(os.listdir(sub)):
                            if f.endswith(".femo"):
                                scripts.append(os.path.join(sub, f))
                    elif name.endswith(".femo"):
                        scripts.append(sub)
            send_response(req_id, True, {"scripts": scripts})
        elif cmd == "check":
            # 同步编译校验（femo-run 工具路径）：编译错误作为工具返回结果，
            # 带细节指导主模型改剧本；不启动运行、不产生状态。
            femo_text = args_obj.get("femo", "")
            if not femo_text.strip():
                send_response(req_id, False, error="femo is empty")
                return
            try:
                script, warnings = run_compile(femo_text, args_obj.get("base_dir"), args_obj.get("models"))
                # warnings 随回执上浮（2026-09-07 warning 桶）：编译放行的提示
                # 交宿主转告作者/主模型——编译没被阻断，但应当知情。
                send_response(req_id, True, {"ok": True, "actions": len(script.actions),
                                             "warnings": warnings})
            except Exception as exc:
                traceback.print_exc(file=sys.stderr)
                send_response(req_id, False, error=str(exc))
        elif cmd == "job_start":
            femo_text = args_obj.get("femo", "")
            if not femo_text.strip():
                send_response(req_id, False, error="femo is empty")
                return
            ensure_default_data()
            # 同步编译先行：编译失败的剧本连 Job 文件都不产生（脏 Job 号零残留）
            script, warnings = run_compile(femo_text, args_obj.get("base_dir"), args_obj.get("models"))
            rec = jm.create_job(
                fingerprint_script(femo_text),
                # host_ref 旧协议名 owner_tag 兼容（旧宿主不断）
                host_ref=str(args_obj.get("host_ref", args_obj.get("owner_tag", "")) or ""),
                script_name=str(args_obj.get("script_name", "") or ""),
                # 剧本快照（文本+地址）随档案落盘：femoGen 凭 job_id 即可取回
                # 当场跑的是哪一版（渲染/回放/续跑的数据源）。
                script_path=str(args_obj.get("script_path", "") or ""),
                script_text=femo_text,
            )
            spawn_job_worker(
                rec.job_id, script,
                # base_dir：有剧本地址=剧本目录；未保存=空串（引擎对相对路径报错）。
                args_obj.get("base_dir") if args_obj.get("base_dir") is not None else femo_root,
                args_obj.get("user_api_key"),
                args_obj.get("user_api_provider"),
                args_obj.get("user_api_url"),
                args_obj.get("user_api_model"),
                bool(args_obj.get("host_ai_backend", args_obj.get("dsh_ai_backend", False))),
                resume_state=None,
            )
            send_response(req_id, True, {"job_id": rec.job_id, "state": rec.state,
                                         "warnings": warnings})
        elif cmd == "job_resume":
            femo_text = args_obj.get("femo", "")
            job_id = args_obj.get("job_id")
            if not femo_text.strip():
                send_response(req_id, False, error="femo is empty")
                return
            if not isinstance(job_id, int):
                send_response(req_id, False, error="job_id is required")
                return
            # 摸到才对账（2026-09-07）：续跑动手前先把目标档案状态裁决诚实
            # ——僵死 running（上一代 bridge 暴毙残留）在此落成 crash，六关
            # 第②关才能放行。_bound 主人检查在 helper 内：自己正跑着的 Job
            # 不会被对账动，会在第②关以 already_running 原话拒绝。
            jm.reconcile_stale(job_id)
            ensure_default_data()
            # 同步编译先行（同 job_start）
            script, warnings = run_compile(femo_text, args_obj.get("base_dir"), args_obj.get("models"))
            # 六关裁决（JobManager.resume_job，JobError 带原话上浮宿主——B2/C2）
            rec = jm.resume_job(job_id, fingerprint_script(femo_text),
                                host_ref=str(args_obj.get("host_ref", args_obj.get("owner_tag", "")) or ""),
                                new_text=femo_text)
            # resume_state 由引擎档案提供（build_resume_state），宿主不再传——
            # 断点权威在 runs/<job_id>.json，指纹/场次/断点六关已裁决。
            resume_state = jm.build_resume_state(rec)
            spawn_job_worker(
                job_id, script,
                args_obj.get("base_dir") if args_obj.get("base_dir") is not None else femo_root,
                args_obj.get("user_api_key"),
                args_obj.get("user_api_provider"),
                args_obj.get("user_api_url"),
                args_obj.get("user_api_model"),
                bool(args_obj.get("host_ai_backend", args_obj.get("dsh_ai_backend", False))),
                resume_state=resume_state,
            )
            send_response(req_id, True, {"resumed": True, "job_id": job_id,
                                         "femo_session_id": rec.femo_session_id,
                                         "warnings": warnings})
        elif cmd == "job_pause":
            job_id = args_obj.get("job_id")
            if not isinstance(job_id, int):
                send_response(req_id, False, error="job_id is required")
                return
            out = jm.pause_job(job_id)
            # 幂等：suspended/finished/failed 照样 {paused:true, state:<现态>}，
            # 不假成功也不报错（B5 死于结构）
            # 【强停兜底（2026-09-07 214 事故）】stop() 的取消令牌已按
            # call_soon_threadsafe 送达——健康循环（含空转 park）秒级收场；
            # worker join 超时仍不退出=循环线程被同步调用卡死（asyncio 取消
            # 无法注入，Python 杀不了线程）。此时唯一诚实的强停是进程级：
            # 档案仍 running 就先落 suspended(user_pause)（checkpoint 每节点
            # 都写盘，进程死不丢断点），回执带 forced:true，再让 bridge 进程
            # 退出（宿主下次命令自动重拉新 bridge）。回执必须先于退出发出
            # （shutdown 命令同款时序）。join 上限 10s < 宿主 job_pause 发送
            # 超时 15s——慢收场不等价于失败，回执总能赶上。
            if out.get("paused") and out.get("state") == "running":
                t = workers.get(job_id)
                if t is not None:
                    t.join(timeout=10)
                    if t.is_alive():
                        st = jm.get_job_state(job_id)
                        if st.get("state") == "running":
                            jm.suspend(job_id, "user_pause")
                        send_response(req_id, True, {**out, "state": "suspended", "forced": True})
                        threading.Timer(0.2, os._exit, args=(1,)).start()
                        return
                    # 【干净收场回执纠偏（2026-09-10 暂停确认竞态）】out.state 是
                    # cancel 前快照（恒 running），而 join 期间 worker 已落终态、
                    # flow_paused 事件此刻早已广播——回执若仍说 running，前端会
                    # 在确认之后才起"等 8 秒确认"计时器（永远等不到）→ 黄条误报。
                    # 重读档案真实终态，并带 confirmed:true（本次暂停确实停掉了
                    # 运行中的 Job，非幂等无操作），前端据此当场确认不再等。
                    out = {**out, "state": jm.get_job_state(job_id).get("state", out.get("state")),
                           "confirmed": True}
            send_response(req_id, True, out)
        elif cmd == "human_input":
            wait_key = args_obj.get("wait_key", "")
            body = args_obj.get("body")
            job_id = args_obj.get("job_id")
            if not isinstance(job_id, int):
                send_response(req_id, False, error="job_id is required")
                return
            if not wait_key or body is None:
                send_response(req_id, False, error="wait_key and body are required")
                return
            # 不盲投（B6/孤儿信投递侧防线）：deliver_human_input 校验活跃+_bound
            out = jm.deliver_human_input(job_id, wait_key, body)
            send_response(req_id, True, out)
        elif cmd == "actor_failed":
            # 宿主执行体最终失败信号（B5）：子代理死亡/超时/API 预算耗尽——
            # 显式上报，引擎按「沉默收场」裁决（通知作者+节点按失败跳过），
            # 不再伪装空台词。投递校验与 human_input 同款（活跃+_bound，不盲投）；
            # 失败信封走同一 wait_key 信箱（{'__actor_failed__': True, kind, detail}）。
            job_id = args_obj.get("job_id")
            wait_key = str(args_obj.get("wait_key", "") or "")
            if not isinstance(job_id, int):
                send_response(req_id, False, error="job_id is required")
                return
            if not wait_key:
                send_response(req_id, False, error="wait_key is required")
                return
            out = jm.deliver_human_input(job_id, wait_key, {
                '__actor_failed__': True,
                'kind': str(args_obj.get("kind", "") or "executor_error"),
                'detail': str(args_obj.get("detail", "") or ""),
            })
            send_response(req_id, True, out)
        elif cmd == "get_job_state":
            job_id = args_obj.get("job_id")
            if not isinstance(job_id, int):
                send_response(req_id, False, error="job_id is required")
                return
            # 摸到才对账（2026-09-07）：仅宿主显式带 reconcile_if_stale 才动手
            # （femoGen 打开 session 的唯一询问点，宿主只在 session 归属本宿主时
            # 才带）——缺省纯读，测试/别的进程零副作用。
            if args_obj.get("reconcile_if_stale"):
                jm.reconcile_stale(job_id)
            state = jm.get_job_state(job_id)
            # 恒 ok（2026-09-10）：档案 error 是查询的答案（failed 场次的档案
            # 数据），不是查询失败——译成协议错误会把宿主 session-state 整条
            # 毒倒（画布恢复全灭）。宿主按字段自判（state 缺失=no_such_job）。
            send_response(req_id, True, state)
        elif cmd == "list_jobs":
            send_response(req_id, True, {"jobs": jm.list_jobs()})
        elif cmd == "get_soul":
            # 宿主查询单个角色（B4）：子代理 persona 注入用——宿主侧不再直读
            # SQLite，路径推导/表结构回归引擎内部。未知 soul → {'found': False,
            # 'description': ''}（宿主按「演员回落标准模式」降级，容错同旧语义）。
            soul_id = str(args_obj.get("soul_id", "") or "")
            if not soul_id:
                send_response(req_id, False, error="soul_id is required")
                return
            from femoCompiler.db_utils import get_soul_by_id as _get_soul_by_id
            soul = _get_soul_by_id(soul_id)
            if soul:
                send_response(req_id, True, {"found": True, **soul})
            else:
                send_response(req_id, True,
                              {"found": False, "soul_id": soul_id, "description": ""})
        elif cmd == "list_souls":
            # femo-soul list：返回全部角色（精简 id+名字，主模型写剧本选角用）。
            from femoCompiler.db_utils import list_souls as _list_souls
            send_response(req_id, True, {"souls": _list_souls()})
        elif cmd == "create_soul":
            # 插件模式 soul 创建：user_id/created_by 固定为默认用户 u001（前端不再输入）。
            from femoCompiler.db_utils import create_soul as _create_soul
            from femoCompiler.db_utils import check_soul_id_exists
            soul_id = str(args_obj.get("soul_id", "")).strip()
            soul_name = str(args_obj.get("soul_name", "")).strip()
            description = str(args_obj.get("description", ""))
            user_id = str(args_obj.get("user_id", "")).strip() or "u001"
            if not soul_id:
                send_response(req_id, False, error="soul_id is required")
                return
            if check_soul_id_exists(soul_id):
                send_response(req_id, False,
                              error=f'soul_id "{soul_id}" 已存在（角色库中已有同名角色，请换一个 soul_id）')
                return
            _create_soul(soul_id, soul_name, description, user_id)
            send_response(req_id, True, {"soul_id": soul_id})
        elif cmd == "shutdown":
            # 全场停止：对每个挂靠 Runner stop（取消链启动 → 取消路径
            # on_state_change 落 suspended——关机也诚实落挂起），然后 join 全部
            # worker（timeout=5）再回执+exit——旧实现 stop 后 0.2s os._exit，
            # 取消传播+落盘是异步的，可能没写盘就死（§7.2 shutdown 修正）。
            for job_id in list(jm._bound):
                runner = jm.runner_of(job_id)
                if runner is not None:
                    try:
                        runner.stop()
                    except Exception:
                        traceback.print_exc(file=sys.stderr)
            for t in list(workers.values()):
                t.join(timeout=5)
            send_response(req_id, True, {"bye": True})
            # small delay so the response flushes before exit
            threading.Timer(0.2, os._exit, args=(0,)).start()
        else:
            send_response(req_id, False, error=f"unknown command: {cmd}")

    def dispatch(req_id, cmd, args_obj):
        """命令-结果契约（B5 死于结构）：JobError/JobBusyError 统一捕获映射——
        每个命令必须给明确答复 {ok:false, error:<code>, detail:<人话>}。"""
        try:
            dispatch_inner(req_id, cmd, args_obj)
        except JobBusyError as exc:
            send_response(req_id, False, error=exc.code, detail=exc.detail,
                          extra={"active_job_id": exc.active_job_id,
                                 "active_host_ref": exc.active_host_ref})
        except JobError as exc:
            send_response(req_id, False, error=exc.code, detail=exc.detail)

    # ── stdin loop ─────────────────────────────────────────────────────────
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            emit({"type": "response", "id": None, "ok": False, "error": "invalid json"})
            continue
        req_id = req.get("id")
        cmd = req.get("cmd", "")
        args_obj = req.get("args") or {}
        try:
            dispatch(req_id, cmd, args_obj)
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            send_response(req_id, False, error=str(exc))

if __name__ == "__main__":
    main()
