#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
femo_debugger.py — Femo 调试模式（FakeHost 假宿主）
====================================================

零 token 干跑 .femo 剧本：AI / human / mind 节点全部由调试器替答。
引擎本体一行不改——SET VARIABLE 提取、out 白名单校验、evaluator 解析、
resolve/@func 调用、变量帧（fork/join/for/par）、模块进出栈、落库，
全部走引擎真实管线。只有「LLM 思考」和「人类打字」被替换成合成值；
因此它测的不只是剧本 bug，引擎 bug 也能暴露。

原理（FakeHost）：
  引擎宿主模式下，AI 节点（_invoke_ai_llm）发 ai_request 事件后
  wait_for_input(wait_key)；human 节点（_exec_human）发 human_wait 事件后
  wait_for_input(wait_key)。本模块伪装成宿主：监听事件 → ValueOracle
  合成合法赋值 → engine.human_input.provide_input(wait_key, ...) 秒回。
  femo_bridge.spawn_job_worker 就是这套协议的生产范本。

不落库的实现 = DB 沙盒（不是跳过）：
  context 收集（get_session_context）、save_dialog、init_database 全链路
  依赖 DB 文件；硬跳过 = patch 一串引擎函数 = 另写一条链路，违背
  「必须走引擎真实链路」的原则。因此把 FEMO_config._db_path 指到沙盒
  目录的一次性库：引擎照常落库（行为与生产一致），生产的 Chronica.wor
  一个字节不碰。沙盒目录只建不删（安全铁律：本文件零删除 API）；
  --keep-db 可指定保留位置查看台账，目录会随系统临时目录清理策略走。

用法：
  python femoToolcall/femo_debugger.py run femoExamples/goblin-mini.femo
  python femoToolcall/femo_debugger.py run a.femo --runs 3 --seed 42
  python femoToolcall/femo_debugger.py run a.femo --set player_choice=拒绝 --set @hero=@knight
  python femoToolcall/femo_debugger.py run a.femo --module BattleRound   # 模块单测
  python femoToolcall/femo_debugger.py run a.femo --module Outer.Inner   # 嵌套模块（点路径）
  python femoToolcall/femo_debugger.py run a.femo --assign-prob 0.7      # 概率赋值
  python femoToolcall/femo_debugger.py list a.femo / parse a.femo / coverage a.femo

  模块单测（--module）语义：
  - 合成 wrapper 主流程直接进被测模块（支持嵌套点路径），母链变量与全局
    变量照常可见；模块形参可用 --set 形参名=值 注入（引擎对未传实参的
    形参回退同名可见变量）。
  - 持续循环型模块（无 [OUT]/[BREAK]，或循环直到外部中断）跑满 max_steps
    即停：报告标「可能是无限循环」，退出码 0——非错误（2026-09-12 拍板）。
    无出口模块会被静态识别并在报告中注明。

实时调试日志（DebugLogBus，消费方接口）：
  跑动过程中每个节点的进出、每笔变量赋值（old→new）、每次合成发言的
  var→值→来源，都以结构化记录实时发出。两种消费方式：

  # ① 程序内订阅（测试代码 / 宿主 bridge / 任何 Python 消费方）
  from femo_debugger import DebugLogBus, load_script, run_once
  bus = DebugLogBus()
  bus.subscribe(lambda rec: print(rec['kind'], rec))   # 实时回调，按序送达
  result = run_once(load_script('a.femo'), seed=42, overrides={},
                    assign_prob=1.0, max_steps=200, quiet=True, bus=bus)
  bus.snapshot()        # 环形缓冲，事后取全部记录

  # ② CLI 落盘（每条记录 flush，可 tail -f，也可由前端 SSE 转发）
  python femo_debugger.py run a.femo --log-jsonl debug.jsonl
  python femo_debugger.py run a.femo --log-jsonl d.jsonl --log-kinds assign,node_start
  python femo_debugger.py run a.femo --log-console   # 紧凑实时控制台流水

  记录 schema：{seq, ts, run, seed, kind, ...kind 专属字段}；
  kind 全集与各字段见 DebugLogBus 类 docstring。

代码原则（项目铁律）：不许 try 静默吞错。对引擎内部状态的读取做显式
getattr 防御但失败必须响亮报告；FakeHost / 日志订阅者回调异常打印
traceback（回调炸不能带崩引擎，但绝不静默）。
"""

import argparse
import io
import json
import os
import random
import re
import sys
import threading
import time
import traceback
from collections import deque
from typing import Any, Dict, List, Optional, Tuple

# Windows GBK 控制台兼容（引擎 print 含 emoji/中文符号）——只在 CLI 入口做，
# 不在 import 时做：模块可能被测试/宿主进程导入，import 副作用会污染
# 调用方的 stdout（实测弄崩 pytest capture）。
def _force_utf8_stdio():
    for stream_attr in ('stdout', 'stderr'):
        s = getattr(sys, stream_attr, None)
        if s and hasattr(s, 'buffer'):
            try:
                setattr(sys, stream_attr, io.TextIOWrapper(
                    s.buffer, encoding='utf-8', errors='replace',
                    line_buffering=True))
            except Exception:
                pass


# ── 引擎导入路径：本脚本在 femoToolcall/ 下，插件根是其父目录 ──
_HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)


# ════════════════════════════════════════════════════════════
#  实时调试日志总线（DebugLogBus）
# ════════════════════════════════════════════════════════════

class DebugLogBus:
    """调试日志总线：跑动过程中的节点 / 变量 / 值实时结构化流水。

    采集点（全部在调试器侧，引擎零改动）与 kind 专属字段：
      run_start    {script, overrides}
      node_start   {node, node_type}      —— 引擎 node_start 事件
      edge         {src, tgt}             —— 引擎 _follow_next_edge
      assign       {node, var, old, new}  —— VarFacade.apply_intent（引擎真实落值）
      action_outs  {node, node_type, exprs} —— @assign 赋值表达式 / @func 写回目标
      func_result  {node, func_input, output} —— @func 调用入参与结果（引擎事件）
      ai_reply     {node, values}         —— FakeHost 合成 AI 赋值（var→{value,source}）
      human_input  {node, variables}      —— FakeHost 合成人类输入
      retry        {node, target, line, feedback}
      silence      {node, var}            —— --assign-prob 概率沉默
      flaky        {node, var}            —— --flaky 无效赋值
      warning      {msg}                  —— ValueOracle 猜值降级/兜底
      flow_outcome {outcome, error}
      run_end      {outcome, elapsed}

    公共字段：{seq, ts, run, seed}——run/seed 由 run_once 经 set_context
    注入，多轮共用一条总线时靠它区分轮次。

    消费方接口：
      bus = DebugLogBus()
      sub = bus.subscribe(fn)     # 实时回调（同步、按 seq 序）
      bus.unsubscribe(sub)
      bus.snapshot()              # 环形缓冲最近 history 条（默认 500）

    铁律：订阅者回调异常打印 traceback 并拦截（回调炸不能带崩引擎，
    但绝不静默）；其余订阅者不受影响。
    """

    def __init__(self, history: int = 500):
        self._lock = threading.Lock()
        self._seq = 0
        self._buf: deque = deque(maxlen=history)
        self._subs: Dict[int, Any] = {}
        self._sub_seq = 0
        self._ctx: Dict[str, Any] = {}

    def set_context(self, **ctx):
        """给后续记录附加运行上下文（run/seed 等）。"""
        self._ctx.update(ctx)

    def emit(self, kind: str, **fields) -> dict:
        with self._lock:
            self._seq += 1
            rec = {'seq': self._seq, 'ts': round(time.time(), 3),
                   **self._ctx, 'kind': kind, **fields}
            self._buf.append(rec)
            subs = list(self._subs.values())
        for fn in subs:
            try:
                fn(rec)
            except Exception:
                traceback.print_exc()
                print(f"[debug] ⚠️ 日志订阅者异常（kind={kind}），已拦截继续",
                      file=sys.stderr)
        return rec

    def subscribe(self, fn) -> int:
        with self._lock:
            self._sub_seq += 1
            self._subs[self._sub_seq] = fn
        return self._sub_seq

    def unsubscribe(self, sub_id: int):
        with self._lock:
            self._subs.pop(sub_id, None)

    def snapshot(self) -> List[dict]:
        return list(self._buf)


class JsonlLogSubscriber:
    """总线记录实时写 JSONL（每条 flush，可 tail -f / 供宿主 SSE 转发）。"""

    def __init__(self, bus: DebugLogBus, path: str, kinds=None):
        self._f = open(path, 'w', encoding='utf-8')
        self._kinds = set(kinds) if kinds else None
        self._sub = bus.subscribe(self)

    def __call__(self, rec: dict):
        if self._kinds and rec.get('kind') not in self._kinds:
            return
        self._f.write(json.dumps(rec, ensure_ascii=False, default=str) + '\n')
        self._f.flush()

    def close(self):
        self._f.close()


class ConsoleLogSubscriber:
    """总线记录的紧凑实时控制台渲染（不受 --quiet 影响——显式开启即想看）。"""

    def __init__(self, bus: DebugLogBus, kinds=None):
        self._kinds = set(kinds) if kinds else None
        self._sub = bus.subscribe(self)

    def __call__(self, rec: dict):
        if self._kinds and rec.get('kind') not in self._kinds:
            return
        head = f"[log #{rec.get('run', '?')}] {rec['kind']}"
        if rec.get('node'):
            head += f" @ {rec['node']}"
        body = {k: v for k, v in rec.items()
                if k not in ('seq', 'ts', 'run', 'seed', 'kind', 'node')}
        print(f"{head} {body if body else ''}")

    def close(self):
        pass


# ════════════════════════════════════════════════════════════
#  DB 沙盒
# ════════════════════════════════════════════════════════════

class DBSandbox:
    """把 FEMO_config._db_path 指到沙盒库；退出时恢复原路径（不删任何文件）。

    沙盒目录固定复用 cache/debug-sandbox/（相对插件根），每轮 run 用
    独立库文件名（run-<时间戳>.wor）。旧沙库滚动保留最近 3 天，超期自动
    清理（2026-09-12 由「只建不删」改制——只增不减的沙盒会无限长胖）。
    """

    @staticmethod
    def _sweep_old(sandbox_dir: str, keep_days: int = 3) -> int:
        """删除沙盒里 mtime 超过 keep_days 的旧文件，返回删除数。"""
        cutoff = time.time() - keep_days * 86400
        removed = 0
        try:
            for name in os.listdir(sandbox_dir):
                fp = os.path.join(sandbox_dir, name)
                try:
                    if os.path.isfile(fp) and os.path.getmtime(fp) < cutoff:
                        os.remove(fp)
                        removed += 1
                except OSError:
                    pass
        except OSError:
            pass
        return removed

    def __init__(self, verbose: bool = True, label: str = 'run'):
        self.verbose = verbose
        self.label = label
        self.db_path: Optional[str] = None
        self._saved: Optional[str] = None
        self._sandbox_dir = os.path.join(_HERE, 'cache', 'debug-sandbox')

    def path(self) -> str:
        return os.path.join(
            self._sandbox_dir, f'{self.label}-{int(time.time() * 1000)}.wor')

    def __enter__(self):
        from femoCompiler import FEMO_config
        self._saved = FEMO_config.get_db_path()
        os.makedirs(self._sandbox_dir, exist_ok=True)
        swept = self._sweep_old(self._sandbox_dir)
        if self.verbose and swept:
            print(f"[debug] 🧹 沙盒清理: 移除 {swept} 个超过 3 天的旧文件")
        self.db_path = self.path()
        FEMO_config.set_db_path(self.db_path)
        if self.verbose:
            print(f"[debug] 🔬 DB 沙盒: {self.db_path}")
        return self

    def __exit__(self, exc_type, exc, tb):
        from femoCompiler import FEMO_config
        if self._saved is not None:
            FEMO_config.set_db_path(self._saved)
        if self.verbose and self.db_path:
            print(f"[debug] 📦 沙盒库保留在: {self._sandbox_dir}（可随时手动删除整个目录）")
        return False


# ════════════════════════════════════════════════════════════
#  值合成：ValueOracle
# ═══════════════════════════════════════^^^^═════════════════

class ValueOracle:
    """为 out 变量按六层优先级合成值；随机全部经 rng（同种子可复现）。

    L1 --set 用户覆盖（v1|v2 序列轮换）
    L2 ASSIGN 型 out（"refuse_count += 1"）→ 语义已含在 out 文本，渲染层处理
    L3 dropdown choices（引擎 evaluator 求值后 rng 挑选）
    L4 prompt 线索（<<VAR = 示例>> 模板；@占位 → actor 名单挑真实演员）
    L5 vars 声明初值类型反推（bool 翻转 / 数字保持 / @actor 挑人）
    L6 兜底 "debug"（响亮记 warning）
    """

    def __init__(self, runner, rng: random.Random,
                 overrides: Dict[str, List[str]]):
        self.runner = runner            # None 占位，run_once 里回填
        self.rng = rng
        self.overrides = overrides
        self.seq_idx: Dict[str, int] = {}
        self.guess_warnings: List[str] = []
        self.bus: Optional[DebugLogBus] = None   # run_once 里回填

    def _warn(self, msg: str):
        """猜值降级/兜底告警：进终报 warnings，同时实时上总线。"""
        self.guess_warnings.append(msg)
        if self.bus is not None:
            self.bus.emit('warning', msg=msg)

    # ── out 声明遍历入口 ──
    def resolve_action_outs(self, ad, prompt_rendered: str,
                            facade) -> List[Tuple[Any, str]]:
        """返回 [(value, source)]，顺序与 ad.outs（过滤伪 out 后）一致。
        ASSIGN 型 value=None 占位（语义在 out 文本里，由 render 处理）。"""
        results = []
        for od in (ad.outs or []):
            if _is_field_noise(od):
                continue
            if _is_assign_out(od):
                results.append((None, 'assign-op'))
                continue
            results.append(self._resolve_value(od, prompt_rendered, facade))
        return results

    def _resolve_value(self, od, prompt_rendered: str,
                       facade) -> Tuple[Any, str]:
        var_name = od.var_name

        # L1 用户覆盖
        if var_name in self.overrides:
            seq = self.overrides[var_name]
            i = min(self.seq_idx.get(var_name, 0), len(seq) - 1)
            raw = seq[i]
            self.seq_idx[var_name] = i + 1
            return _coerce(raw), 'set-override'

        # L3 choices
        if getattr(od, 'choices', None):
            try:
                expr = od.choices.strip()
                if expr.startswith('{') and expr.endswith('}'):
                    expr = expr[1:-1].strip()
                val = self.runner.evaluator.evaluate(expr, facade, strict=False)
                if isinstance(val, (list, tuple)) and val:
                    return _coerce(self.rng.choice(list(val))), 'choices'
                return _coerce(val), 'choices'
            except Exception as e:
                self._warn(
                    f"choices 求值失败（{var_name}: {od.choices!r}: {e}），降级下层")

        # L4 prompt 线索
        clue = _prompt_clue(prompt_rendered, var_name)
        if clue is not None:
            op, text = clue
            hit = _clue_to_value(op, text, self._pick_actor, facade,
                                 self._warn)
            if hit is not None:
                return hit

        # L5 声明初值类型
        init = self._declared_initial(var_name, facade)
        if init is not None:
            hit = _from_initial(init, self._pick_actor)
            if hit is not None:
                return hit

        # L6 兜底
        self._warn(
            f"变量 '{var_name}' 无值线索（无 --set/choices/prompt 模板/初值），"
            f"用兜底值 \"debug\"——分支走向可能不反映真实行为")
        return "debug", 'fallback'

    # ── 存活名单快照（合成票只投活人）──
    _ALIVE_KEY_RE = re.compile(r'alive|存活|players|roster', re.IGNORECASE)

    def _alive_snapshot(self, facade) -> set:
        """从变量世界里找「存活玩家列表」变量的快照（找不到返回空集）。

        识别口径：变量名含 alive/存活/players/roster（如 $alive、存活名单），
        值里至少有一个 '@名'。多命中时取最长的那个（最可能是真正的存活表）。
        """
        best: List[str] = []
        try:
            view = facade.visible_view() if hasattr(facade, 'visible_view') else {}
            for name, v in (view or {}).items():
                if not self._ALIVE_KEY_RE.search(str(name)):
                    continue
                if isinstance(v, dict):
                    items = list(v.keys())
                elif isinstance(v, (list, tuple, set)):
                    items = list(v)
                else:
                    continue
                names = [x for x in items if isinstance(x, str) and x.startswith('@')]
                if len(names) > len(best):
                    best = names
        except Exception as e:
            self._warn(f"读取存活名单失败: {e}")
        return set(best)

    # ── actor 挑选（@占位 → 真实演员）──
    def _pick_actor(self, placeholder: str, facade) -> Optional[str]:
        candidates: List[str] = []
        try:
            for aname in (self.runner.script.actors or {}):
                candidates.append(aname if aname.startswith('@') else f'@{aname}')
        except Exception as e:
            self._warn(f"读取 actors 定义失败: {e}")
        try:
            view = facade.visible_view() if hasattr(facade, 'visible_view') else {}
            for _n, v in (view or {}).items():
                if isinstance(v, list):
                    candidates.extend(
                        x for x in v if isinstance(x, str) and x.startswith('@'))
                elif isinstance(v, dict):
                    candidates.extend(
                        k for k in v.keys() if isinstance(k, str) and k.startswith('@'))
        except Exception as e:
            self._warn(f"读取变量世界 actor 名单失败: {e}")
        # 存活名单优先（2026-09-12）：剧本里若有「存活玩家列表」变量（$alive/存活名单
        # /players 等），合成票只从**存活者**里挑——否则会投给已淘汰的人（干跑实测：
        # 某 3 人出局的局，第 4 轮合成票还在投第 2 轮就出局的人），票一散就永远平票、
        # 每轮进 PK，死循环跑不完（谁是卧底 8 人局干跑 180s 超时就是这么来的）。
        alive = self._alive_snapshot(facade)
        if alive:
            filtered = [c for c in candidates if c in alive]
            if filtered:
                candidates = filtered
        seen, uniq = set(), []
        for c in candidates:
            if c not in seen:
                seen.add(c)
                uniq.append(c)
        if not uniq:
            return None
        if placeholder in uniq:
            return placeholder
        return self.rng.choice(uniq)

    # ── L5 声明初值查询 ──
    def _declared_initial(self, var_name: str, facade) -> Optional[Any]:
        try:
            table = self.runner.world.table
            # def_chain 是 property（返回 tuple，不能加括号调用）
            decl = table.lookup(var_name, facade.def_chain)
            if decl is not None:
                return decl.initial
        except Exception as e:
            self._warn(f"查声明初值失败（{var_name}）: {e}")
        return None


# ── 模块级纯函数（供 FakeHost 复用）──────────────────────────

_ASSIGN_OUT_RE = re.compile(r'^[@$\w\u4e00-\u9fff\[\]]+\s*[+\-]?=')

# 引擎 parser 的 out: 续行收集会误吞同缩进二级字段（_FIELD_KEYWORDS 缺
# max_retries: 等，2026-09-08 调试器实测发现）——伪 out 的 var_name 形如
# 'max_retries: 2'。调试器侧过滤（引擎修复后无副作用）。
_ENGINE_FIELD_NOISE = re.compile(
    r'^(max_retries|max_tries|timeout|fallback|resolve|memory|context|'
    r'scope|prompt|showprompt|interrupt)\s*:')

def _is_assign_out(od) -> bool:
    return bool(_ASSIGN_OUT_RE.match(od.var_name or ''))

def _is_field_noise(od) -> bool:
    """伪 out 识别：引擎 out 解析误吞的二级字段行。"""
    return bool(_ENGINE_FIELD_NOISE.match(od.var_name or ''))


def _coerce(raw: Any) -> Any:
    s = str(raw).strip()
    if s.lower() == 'true':
        return True
    if s.lower() == 'false':
        return False
    if re.match(r'^-?\d+$', s):
        return int(s)
    if re.match(r'^-?\d+\.\d+$', s):
        return float(s)
    # dict / list 字面量（--set damage_report={"@knight": 25}）
    if s.startswith(('{', '[')):
        import ast
        try:
            return ast.literal_eval(s)
        except (ValueError, SyntaxError):
            return s
    return s


_CLUE_RE = re.compile(
    r'(?:<<|《|〈|《《)\s*([@$\w\u4e00-\u9fff\[\]]+)\s*'
    r'([+\-]?=)\s*(.+?)\s*(?:>>|》|〉|》》)')

def _prompt_clue(prompt: str, var_name: str) -> Optional[Tuple[str, str]]:
    for m in _CLUE_RE.finditer(prompt or ''):
        if m.group(1) == var_name:
            return m.group(2), m.group(3)
    return None


def _clue_to_value(op, text, pick_actor, facade,
                   warn) -> Optional[Tuple[Any, str]]:
    text = text.strip()
    if text.startswith('@'):
        actor = pick_actor(text, facade)
        if actor is not None:
            return actor, 'prompt-clue'
        warn(f"prompt 线索 {text!r} 找不到可用 actor，降级下层")
        return None
    if text.lower() in ('true', 'false'):
        return (text.lower() == 'true'), 'prompt-clue'
    if re.match(r'^-?\d+$', text):
        return int(text), 'prompt-clue'
    if re.match(r'^-?\d+\.\d+$', text):
        return float(text), 'prompt-clue'
    if len(text) >= 2 and text[0] == text[-1] and text[0] in ('"', "'", '“', '”'):
        return text[1:-1], 'prompt-clue'
    if text.startswith(('add(', 'remove(')):
        return None
    if re.match(r'^[\w\u4e00-\u9fff]+$', text):
        return text, 'prompt-clue'
    return None


def _from_initial(init: Any, pick_actor) -> Optional[Tuple[Any, str]]:
    if isinstance(init, bool):
        return (not init), 'declared-type'   # 翻转，让流程有机会离开默认分支
    if isinstance(init, (int, float)):
        return init, 'declared-type'
    if isinstance(init, str):
        if init.startswith('@'):
            actor = pick_actor(init, None)
            if actor is not None:
                return actor, 'declared-type'
        if init:
            return init, 'declared-type'
    return None


# ════════════════════════════════════════════════════════════
#  覆盖率追踪
# ════════════════════════════════════════════════════════════

class CoverageTracker:
    def __init__(self, bus: Optional[DebugLogBus] = None):
        self.node_visits: Dict[str, int] = {}
        self.node_order: List[str] = []
        self.edges_taken: set = set()
        self.var_snapshots: List[dict] = []
        self.bus = bus   # 实时日志总线（可选）

    def _emit(self, kind: str, **fields):
        if self.bus is not None:
            self.bus.emit(kind, **fields)

    def on_node(self, node_id: str, node_type: str):
        self.node_visits[node_id] = self.node_visits.get(node_id, 0) + 1
        tag = {'human': 'h', 'ai': 'a', 'mind': 'm'}.get(node_type, node_type[:1] if node_type else '?')
        self.node_order.append(f"{node_id}({tag})")
        self._emit('node_start', node=node_id, node_type=node_type)

    def on_edge(self, src: str, tgt: str):
        self.edges_taken.add(f"{src}->{tgt}")
        self._emit('edge', src=src, tgt=tgt)

    def on_assignment(self, node: str, var: str, old, new):
        self.var_snapshots.append(
            {'node': node, 'var': var, 'old': _safe_repr(old), 'new': _safe_repr(new)})
        self._emit('assign', node=node, var=var,
                   old=_safe_repr(old), new=_safe_repr(new))

    def cross_run_merge(self, other: 'CoverageTracker'):
        for k, v in other.node_visits.items():
            self.node_visits[k] = self.node_visits.get(k, 0) + v
        self.edges_taken |= other.edges_taken
        self.var_snapshots.extend(other.var_snapshots)
        self.node_order.extend(other.node_order)


def _safe_repr(v) -> str:
    try:
        r = repr(v)
        return r if len(r) <= 120 else r[:117] + '...'
    except Exception:
        return '<unrepr>'


# ═══════════════交付物═══════════════════════════════════════
#  FakeHost：替 AI / human 发言
# ════════════════════════════════════════════════════════════

class FakeHost:
    """监听引擎事件，替 AI / human 节点提供合成输入。

    事件契约（与 FEMO_runtime._emit_event / FEMO_errors 源码一致）：
      ai_request {wait_key, node_name, ai_name, blocks, actor_info, source,...}
      human_wait {wait_key, node_name, prompt, scope, out_vars, ...}
      node_retry {node_name, wait_key, ai_name, feedback, attempt, target}
      node_start {node_name, node_type, prompt?, scope}
    回传：runner.engine.human_input.provide_input(wait_key, payload)
    """

    def __init__(self, runner, oracle: ValueOracle, tracker: CoverageTracker,
                 assign_prob: float, quiet: bool, rng: random.Random,
                 flaky: float = 0.0, bus: Optional[DebugLogBus] = None):
        self.runner = runner            # None 占位，run_once 回填
        self.oracle = oracle
        self.tracker = tracker
        self.assign_prob = assign_prob
        self.flaky = flaky              # 概率输出无效赋值（测重试/fallback）
        self.quiet = quiet
        self.rng = rng                  # 概率赋值独立 rng
        self.bus = bus                  # 实时日志总线（可选）
        self._node_prompt: Dict[str, str] = {}      # node → 渲染后 prompt
        self._retry_values: Dict[str, dict] = {}    # wait_key → {values, idx}
        self.silences: List[str] = []
        self.flaky_fired: List[str] = []

    def log(self, msg: str):
        if not self.quiet:
            print(f"[fakehost] {msg}")

    def _emit(self, kind: str, **fields):
        if self.bus is not None:
            self.bus.emit(kind, **fields)

    # ── 事件分发 ──
    def on_event(self, event_type: str, data: dict):
        handler = getattr(self, f'_on_{event_type}', None)
        if handler is None:
            return
        try:
            handler(data or {})
        except Exception:
            # 回调炸不能带崩引擎；但绝不静默（项目铁律）
            traceback.print_exc()
            print(f"[fakehost] ⚠️ 事件处理异常（{event_type}），已拦截继续",
                  file=sys.stderr)

    # ── node_start：记 prompt（ai 节点带渲染后的 prompt 字段）──
    def _on_node_start(self, data: dict):
        node = data.get('node_name') or ''
        if not node:
            return
        ntype = data.get('node_type') or ''
        self.tracker.on_node(node, ntype)
        if data.get('prompt') is not None:
            self._node_prompt[node] = data.get('prompt') or ''
        # @assign/@func 节点：把 out 声明（赋值表达式/写回目标）上总线——
        # 引擎对这两类节点只 print 不发事件，调试窗要显示它们的"输出"全靠这条。
        if ntype in ('assign', 'func'):
            ad = self._action_def_for(node)
            outs = getattr(ad, 'outs', None) if ad is not None else None
            exprs = [_display_name(od) for od in (outs or [])
                     if not _is_field_noise(od)]
            if exprs:
                self._emit('action_outs', node=node, node_type=ntype,
                           exprs=exprs)

    # ── func_result：@func 调用结果（引擎自带事件：入参 kwargs + 写回后
    #    的 out 值 / 无 out 时为返回值 repr——此前无人消费，这里接上）──
    def _on_func_result(self, data: dict):
        self._emit('func_result',
                   node=data.get('node_name') or '',
                   func_input=data.get('input') or {},
                   output=data.get('output'))

    # ── ai_request：合成回复 ──
    def _on_ai_request(self, data: dict):
        wait_key = data.get('wait_key') or ''
        node = data.get('node_name') or ''
        if not wait_key:
            print(f"[fakehost] ⚠️ ai_request 缺 wait_key（node={node}）", file=sys.stderr)
            return
        blocks = data.get('blocks') or {}
        prompt = blocks.get('prompt') or self._node_prompt.get(node, '')
        ad = self._action_def_for(node)
        lines: List[str] = []
        if ad is not None:
            facade = _current_facade(node)
            outs_real = [od for od in (ad.outs or []) if not _is_field_noise(od)]
            pairs = self.oracle.resolve_action_outs(ad, prompt, facade)
            values_map: Dict[str, dict] = {}
            for (od, (value, source)) in zip(outs_real, pairs):
                if source != 'assign-op' and self.rng.random() >= self.assign_prob:
                    self.silences.append(f"{node}:{_display_name(od)}")
                    self.log(f"🎲 {node} 概率沉默（不赋值 {_display_name(od)}）")
                    self._emit('silence', node=node, var=_display_name(od))
                    continue
                # flaky：概率输出无效赋值（未声明变量）→ assign_error
                # → node_retry → 换值重发（完整测试重试链路）
                if self.flaky and self.rng.random() < self.flaky:
                    self.flaky_fired.append(f"{node}:{_display_name(od)}")
                    self.log(f"💥 {node} flaky 无效赋值（触发重试链路）")
                    self._emit('flaky', node=node, var=_display_name(od))
                    lines.append(
                        "SET VARIABLE: <<__flaky_undefined_var = 1>>")
                    continue
                line = self._render_assignment(od, value)
                if line:
                    lines.append(line)
                    values_map[_display_name(od)] = {
                        'value': _safe_repr(value), 'source': source}
            self._emit('ai_reply', node=node, values=values_map)
            self._prepare_retry_values(ad, node, wait_key, prompt, facade)
        reply = "[debug-sim]（FakeHost 模拟回复，未调用 LLM）"
        if lines:
            reply += "\n" + "\n".join(lines)
        self.log(f"🤖 ai_request node={node} outs={len(lines)}条")
        self.runner.engine.human_input.provide_input(wait_key, {
            'output': reply, 'steps': [], 'model_id': 'fake-host'})

    # ── human_wait：合成输入 ──
    def _on_human_wait(self, data: dict):
        wait_key = data.get('wait_key') or ''
        node = data.get('node_name') or ''
        if not wait_key:
            print(f"[fakehost] ⚠️ human_wait 缺 wait_key（node={node}）", file=sys.stderr)
            return
        ad = self._action_def_for(node)
        variables: Dict[str, str] = {}
        if ad is not None:
            facade = _current_facade(node)
            prompt = data.get('prompt') or ''
            outs_real = [od for od in (ad.outs or []) if not _is_field_noise(od)]
            pairs = self.oracle.resolve_action_outs(ad, prompt, facade)
            for (od, (value, source)) in zip(outs_real, pairs):
                if source == 'assign-op':
                    continue
                if self.rng.random() >= self.assign_prob:
                    self.silences.append(f"{node}:{_display_name(od)}")
                    self.log(f"🎲 {node} 概率沉默（human 不赋值）")
                    self._emit('silence', node=node, var=_display_name(od))
                    continue
                if self.flaky and self.rng.random() < self.flaky:
                    self.flaky_fired.append(f"{node}:{_display_name(od)}")
                    self.log(f"💥 {node} flaky 无效赋值（触发重试链路）")
                    self._emit('flaky', node=node, var=_display_name(od))
                    continue
                variables[_display_name(od)] = _to_input_str(value)
            self._prepare_retry_values(ad, node, wait_key, prompt, facade)
        self.log(f"👤 human_wait node={node} vars={list(variables)}")
        self._emit('human_input', node=node, variables=dict(variables))
        self.runner.engine.human_input.provide_input(wait_key, {
            'chat_text': "[debug-sim]（FakeHost 模拟人类输入）",
            'variables': variables})

    # ── node_retry：换值重发（引擎 emit_request=False，等同一 wait_key）──
    def _on_node_retry(self, data: dict):
        wait_key = data.get('wait_key') or ''
        node = data.get('node_name') or ''
        feedback = str(data.get('feedback') or '')
        target = data.get('target') or 'ai'
        backup = self._retry_values.get(wait_key)
        if backup is None:
            self.log(f"⚠️ {node} node_retry 无备用值，不重发（{feedback[:60]}）")
            return
        idx = backup['idx']
        if idx >= len(backup['values']):
            self.log(f"⚠️ {node} 备用值用尽，不重发（{feedback[:60]}）")
            return
        line = backup['values'][idx]
        backup['idx'] = idx + 1
        self.log(f"🔁 {node} 重试换值 #{idx + 1}（{feedback[:50]}）")
        self._emit('retry', node=node, target=target, line=line,
                   feedback=feedback[:120])
        if target == 'human':
            variables = {}
            m = re.match(
                r'SET\s+VARIABLE:\s*<<\s*([@\w\u4e00-\u9fff\[\].]+)\s*=\s*(.+?)\s*>>',
                line)
            if m:
                variables[m.group(1)] = m.group(2)
            self.runner.engine.human_input.provide_input(wait_key, {
                'chat_text': f"[debug-sim] 重试 #{idx + 1}",
                'variables': variables})
        else:
            self.runner.engine.human_input.provide_input(wait_key, {
                'output': f"[debug-sim] 重试 #{idx + 1}\n{line}",
                'steps': [], 'model_id': 'fake-host'})

    # ── 备用值（resolve 拒绝时轮换）──
    def _prepare_retry_values(self, ad, node: str, wait_key: str,
                              prompt: str, facade):
        if ad is None or not wait_key:
            return
        lines: List[str] = []
        for od in (ad.outs or []):
            if _is_field_noise(od) or _is_assign_out(od):
                continue
            for alt in self._alternative_values(od, prompt, facade)[:2]:
                lines.append(
                    f"SET VARIABLE: <<{od.var_name} = {_to_input_str(alt)}>>")
        if lines:
            self._retry_values[wait_key] = {'values': lines, 'idx': 0}

    def _alternative_values(self, od, prompt: str, facade) -> List[Any]:
        alts: List[Any] = []
        if getattr(od, 'choices', None):
            try:
                expr = od.choices.strip()
                if expr.startswith('{') and expr.endswith('}'):
                    expr = expr[1:-1].strip()
                val = self.oracle.runner.evaluator.evaluate(expr, facade, strict=False)
                if isinstance(val, (list, tuple)):
                    alts.extend(val)
            except Exception:
                pass
        init = self.oracle._declared_initial(od.var_name, facade)
        if isinstance(init, bool):
            alts.extend([True, False])
        elif isinstance(init, (int, float)):
            alts.extend([init, type(init)(init + 1)])
        elif isinstance(init, str) and init.startswith('@'):
            actor = self.oracle._pick_actor(init, facade)
            if actor:
                alts.append(actor)
        if not alts:
            alts = ["debug", "debug-2"]
        return alts

    # ── node → action 定义（主查节点绑定，兜底同名；含模块内节点）──
    def _action_def_for(self, node_name: str):
        runner = self.runner
        # 1) 剧本级 flow 节点绑定
        node_obj = (runner.script.flow.nodes or {}).get(node_name)
        if node_obj is not None and getattr(node_obj, 'action_name', None):
            ad = (runner.script.actions or {}).get(node_obj.action_name)
            if ad is not None:
                return ad
        # 2) 同名兜底（常见剧本节点名==action 名）
        ad = (runner.script.actions or {}).get(node_name)
        if ad is not None:
            return ad
        # 3) 模块内节点：当前模块帧栈顶的 actions
        try:
            from femoCompiler.FEMO_runtime import current_task_ctx
            ctx = current_task_ctx()
            if ctx is not None and getattr(ctx, 'module_frames', None):
                top = ctx.module_frames[-1].name
                mod = runner._resolve_module_def(top)
                ad = (mod.actions or {}).get(node_name)
                if ad is not None:
                    return ad
                node_obj = (mod.flow.nodes or {}).get(node_name)
                if node_obj is not None and getattr(node_obj, 'action_name', None):
                    return (mod.actions or {}).get(node_obj.action_name)
        except Exception:
            pass
        return None

    # ── 渲染 ──
    def _render_assignment(self, od, value) -> Optional[str]:
        if _is_assign_out(od):
            return f"SET VARIABLE: <<{od.var_name}>>"
        dk = getattr(od, 'dynamic_key', None)
        if dk:
            # 动态字典键 out（damage_report.@hero）：引擎 AI 通道的
            # _parse_single_assignment 正则（VAR_NAME_RE）不含点号，dotted
            # lvalue 解析不了（引擎 bug #4，2026-09-08 调试器实测）；human
            # 通道走结构化 variables 无此问题。AI 侧改用引擎完全支持的
            # 整字典赋值：读当前值 + 写入合成键，仍走真实解析管线。
            try:
                facade = _current_facade('')
                key = self.runner.evaluator.evaluate(dk, facade, strict=False)
                cur = facade.get(od.var_name)
                if not isinstance(cur, dict):
                    cur = {}
                merged = dict(cur)
                merged[str(key)] = value
                dict_lit = '{' + ', '.join(
                    f'"{k}": {json.dumps(v, ensure_ascii=False)}'
                    for k, v in merged.items()) + '}'
                return f"SET VARIABLE: <<{od.var_name} = {dict_lit}>>"
            except Exception as e:
                print(f"[fakehost] ⚠️ 动态键 out 渲染失败（{od.var_name}.{dk}）: {e}",
                      file=sys.stderr)
                return None
        return f"SET VARIABLE: <<{od.var_name} = {_to_input_str(value)}>>"


def _display_name(od) -> str:
    dk = getattr(od, 'dynamic_key', None)
    return f"{od.var_name}.{dk}" if dk else od.var_name


def _to_input_str(value) -> str:
    if isinstance(value, bool):
        return 'true' if value else 'false'
    return str(value)


def _current_facade(node_hint: str = ''):
    from femoCompiler.FEMO_runtime import current_task_ctx
    ctx = current_task_ctx()
    if ctx is None:
        raise RuntimeError(
            f"FakeHost: 无 TaskContext（node={node_hint}，事件回调线程未绑"
            f"执行上下文）——引擎协议变更，请检查 FEMO_runtime.current_task_ctx")
    return ctx.facade


# ════════════════════════════════════════════════════════════
#  module 单测：合成 wrapper mainflow
# ════════════════════════════════════════════════════════════

def resolve_module_def(script, module_path: str):
    """按点路径逐段下钻解析模块定义——与引擎 FEMORunner._resolve_module_def
    同一口径（'Outer.Inner' → script.modules['Outer'].modules['Inner']）。
    容忍 '&' 前缀（用户习惯 &Mod 引用）。解析失败响亮 ValueError（列出
    顶层可用名）——调试器侧先拦住，别等引擎在跑动中途才炸。"""
    raw = (module_path or '').strip().lstrip('&')
    container = script.modules or {}
    mod = None
    for part in raw.split('.'):
        mod = container.get(part)
        if mod is None:
            raise ValueError(
                f"module '{module_path}' 未定义（解析失败于段 '{part}'）。"
                f"顶层可用: {sorted((script.modules or {}).keys()) or '（无）'}")
        container = getattr(mod, 'modules', None) or {}
    return mod


def wrap_module_test(script, module_path: str):
    """合成 mainflow：[START]→[MT_IN]→[MT_MOD:&Mod]→[MT_OUT]→[END]。

    [MT_MOD] 的 module_ref 走引擎真实 _run_module：模块 local vars/形参按
    module_initials 入帧（call_initials），母/姥姥模块变量与全局变量经
    ScopeTable 声明链（def_chain 由内到外）天然可见。$shared 变量照常
    全局一份。模块定义本身不动——被测的就是模块自己的 flow。

    支持嵌套模块点路径（'Outer.Inner'，2026-09-12）：引擎 _run_module 的
    顶层点路径 fallback 按完整路径解析并入帧——帧键与 ScopeTable owner
    同为点路径，module_initials/enter_module 天然一致。
    """
    from femoCompiler.FEMO_parser import FlowNode, FlowEdge, FlowGraph
    module_path = (module_path or '').strip().lstrip('&')
    resolve_module_def(script, module_path)   # 不存在即 ValueError，响亮
    script.debug_module = module_path   # run_start 记录带范围（前端/工具显示用）
    g = FlowGraph()
    g.add_node(FlowNode(id='[START]', type='start', label='START'))
    g.add_node(FlowNode(id='[MT_IN]', type='start', label='MT_IN'))
    g.add_node(FlowNode(id='[MT_MOD]', type='action', label=module_path,
                        module_ref=module_path))
    g.add_node(FlowNode(id='[MT_OUT]', type='end', label='MT_OUT'))
    g.add_node(FlowNode(id='[END]', type='end', label='END'))
    g.add_edge('[START]', '[MT_IN]')
    g.add_edge('[MT_IN]', '[MT_MOD]')
    g.add_edge('[MT_MOD]', '[MT_OUT]')
    g.add_edge('[MT_OUT]', '[END]')
    script.flow = g
    return script


# ════════════════════════════════════════════════════════════
#  编译与运行
#════════════════════════════════════════════════════════════

def load_script(femo_path: str, base_dir: Optional[str] = None):
    """编译剧本（沙库内进行，soul/user 查询落沙库）。

    base_dir：覆盖 code: 相对引用的解析目录（默认=剧本所在目录）。
    调试路由用：剧本文本暂存沙盒，引用按原剧本目录解析——与正式
    运行同语义（否则 file:"xxx.py" 落在别处必 404）。
    返回 (script, base_dir) 已并入 script——引擎 FEMORunner 的 base_dir
    参数必须用它（code: 相对路径按它解析），Script 对象本身不带该信息。"""
    from femoCompiler.FEMO_parser import parse_script
    with open(femo_path, 'r', encoding='utf-8-sig') as f:
        text = f.read()
    base_dir = base_dir or os.path.dirname(os.path.abspath(femo_path))
    script = parse_script(text, base_dir=base_dir)
    script.debug_base_dir = base_dir
    return script


def run_once(script, seed: int, overrides: Dict[str, List[str]],
             assign_prob: float, max_steps: int, quiet: bool,
             flaky: float = 0.0, run_index: Optional[int] = None,
             bus: Optional[DebugLogBus] = None) -> dict:
    """单轮调试跑（沙库内）。返回报告数据。

    bus：传入外部 DebugLogBus 即可实时订阅本轮全部结构化日志
    （节点/边/变量赋值/合成发言/告警）；不传则自建一条（随结果返回）。
    """
    from femoCompiler.FEMO_runtime import FEMORunner

    bus = bus or DebugLogBus()
    bus.set_context(run=run_index, seed=seed)
    rng = random.Random(seed)
    flaky_rng = random.Random(seed ^ 0x5EED)
    tracker = CoverageTracker(bus=bus)
    oracle = ValueOracle(None, rng, overrides)
    oracle.bus = bus
    fake = FakeHost(None, oracle, tracker, assign_prob, quiet, flaky_rng,
                    flaky=flaky, bus=bus)
    flow_result = {'outcome': 'exception', 'error': None}
    t0 = time.time()
    bus.emit('run_start', script=script.meta.get('name', ''),
             overrides={k: list(v) for k, v in (overrides or {}).items()},
             module=getattr(script, 'debug_module', None))

    def event_cb(event_type: str, data: dict):
        fake.on_event(event_type, data)
        if event_type == 'flow_done':
            flow_result['outcome'] = 'completed'
            bus.emit('flow_outcome', outcome='completed', error=None)
        elif event_type == 'flow_paused':
            flow_result['outcome'] = 'paused'
            bus.emit('flow_outcome', outcome='paused', error=None)
        elif event_type == 'flow_error':
            flow_result['outcome'] = 'error'
            flow_result['error'] = str((data or {}).get('error', ''))
            bus.emit('flow_outcome', outcome='error',
                     error=flow_result['error'][:200])

    runner = FEMORunner(
        script,
        base_dir=getattr(script, 'debug_base_dir', os.getcwd()),
        verbose=False,
        event_callback=event_cb,
    )
    runner._human_input_event = threading.Event()
    runner._host_ai_backend = True
    oracle.runner = runner
    fake.runner = runner

    # ── --set 跑前直接注入变量世界（root task '__script__' 帧）──
    # 语义：定向设定初始状态，让条件边按指定方向走（比 L1 覆盖更早、更可控）。
    # 值解析：@actor → 引擎 actors 表真实演员名；数字/布尔/字符串直接入帧。
    if overrides:
        root_env = runner.world.envs.get('t0')
        if root_env is None:
            raise RuntimeError(
                "--set 注入失败：world.envs['t0'] 不存在（引擎装配变更？）")
        for k, seq in overrides.items():
            i = min(rng.randrange(len(seq)) if len(seq) > 1 else 0, len(seq) - 1)
            raw = seq[i]
            val = _coerce(raw)
            if isinstance(val, str) and val.startswith('@'):
                # @actor：验证存在性（响亮报错，不静默）
                aname = val
                if aname not in (runner.script.actors or {}):
                    raise ValueError(
                        f"--set {k}={raw}: actor '{aname}' 不在剧本 actors 中。"
                        f"可用: {sorted(runner.script.actors.keys())}")
            root_env.frames['__script__'][k] = val
        print(f"[debug] 💉 --set 已注入: "
              f"{ {k: root_env.frames['__script__'].get(k) for k in overrides} }")

    _patch_tracking(runner, tracker, flow_result, max_steps)

    try:
        # 不传 max_steps：引擎 run_async 的 global_meta 只在 max_steps is None
        # 分支绑定，显式传参会 UnboundLocalError（引擎 bug，2026-09-08 调试器
        # 首跑卖修——bridge 生产路径不传参故未触发）。步数预算由上面的
        # _patch_tracking 补丁承担。
        runner.run()
    except Exception as e:
        if flow_result['outcome'] == 'exception':
            flow_result['error'] = f"{type(e).__name__}: {e}"
        if not quiet:
            traceback.print_exc()
    finally:
        try:
            import asyncio
            asyncio.run(runner.engine.shutdown())
        except Exception:
            pass

    elapsed = round(time.time() - t0, 2)
    bus.emit('run_end', outcome=flow_result['outcome'],
             error=flow_result.get('error'), elapsed=elapsed)
    return {
        'outcome': flow_result['outcome'],
        'error': flow_result.get('error'),
        'seed': seed,
        'elapsed': elapsed,
        'tracker': tracker,
        'oracle': oracle,
        'fake': fake,
        'bus': bus,
    }


# 类级 patch 的运行上下文：VarFacade.apply_intent 是类级方法，只能包装一次
# （每轮重装会层层嵌套）；但 tracker / 当前节点归属必须按「当前轮」解析。
# 早期实现用闭包捕获，第 2 轮起 _patch_tracking 早退，赋值记录泄漏进第 1 轮
# tracker、节点名停在上一轮末节点（2026-09-08 实测）。改为模块级
# threading.local，每轮 run_once 重挂当前 tracker，patch 内动态读取。
_RUN_CTX = threading.local()


def _patch_tracking(runner, tracker: CoverageTracker, flow_result: dict,
                    max_steps: int):
    """侦听点（全部包装实例方法，不改引擎文件）：
    - _execute_node_content：步数预算（死循环保险）
    - _follow_next_edge：边覆盖
    - VarFacade.apply_intent（类级，仅装一次）：变量赋值 diff，归属读 _RUN_CTX
    """
    step_count = [0]
    budget = [max_steps]

    orig_exec = runner._execute_node_content

    async def patched_exec(node, flow, extra_actions, *_args, **_kwargs):
        step_count[0] += 1
        if budget[0] and step_count[0] > budget[0]:
            flow_result['outcome'] = 'max_steps'
            raise RuntimeError(
                f"[debug] 步数预算耗尽（{budget[0]} 步）仍未停——可能是无限循环"
                f"/持续循环型设计，已中止（max_steps 不算错误，退出码 0）")
        return await orig_exec(node, flow, extra_actions, *_args, **_kwargs)

    runner._execute_node_content = patched_exec

    orig_edge = runner._follow_next_edge

    def patched_edge(node_id, flow):
        tgt = orig_edge(node_id, flow)
        if tgt is not None:
            tracker.on_edge(node_id, tgt)
        return tgt

    runner._follow_next_edge = patched_edge

    # 类级 patch apply_intent：记录 old→new（当前节点由每轮的
    # _emit_event 包装刷新进 _RUN_CTX——见 _RUN_CTX 注释）
    from femoCompiler.vars.env import VarFacade
    _RUN_CTX.tracker = tracker
    _RUN_CTX.node = '?'
    if not getattr(VarFacade, '_debug_patched', False):
        orig_apply = VarFacade.apply_intent

        def patched_apply(self_facade, name, intent):
            old = _safe_get(self_facade, name)
            ret = orig_apply(self_facade, name, intent)
            new = _safe_get(self_facade, name)
            t = getattr(_RUN_CTX, 'tracker', None)
            if t is not None:
                t.on_assignment(getattr(_RUN_CTX, 'node', '?'), name, old, new)
            return ret

        VarFacade.apply_intent = patched_apply
        VarFacade._debug_patched = True

    orig_emit = runner._emit_event

    def patched_emit(event_type, data=None):
        if event_type == 'node_start':
            _RUN_CTX.node = (data or {}).get('node_name') or '?'
        return orig_emit(event_type, data)

    runner._emit_event = patched_emit


def _safe_get(facade, name: str):
    try:
        return facade.get(name)
    except Exception:
        return '<unset>'


# ════════════════════════════════════════════════════════════
#  报告
#════════════════════════════════════════════════════════════

# 结构节点（非作者编写的流程节点）：未达判定不报它们。
_STRUCTURAL_NODES = {'[START]', '[END]', '[IN]', '[OUT]', '[BREAK]',
                     '[MT_IN]', '[MT_MOD]', '[MT_OUT]'}


def _reached_nodes(merged) -> set:
    """节点可达集：从边覆盖推导（空节点/模块节点不发 node_start 事件）。"""
    reached = set(merged.node_visits)
    for e in merged.edges_taken:
        src, _, tgt = e.partition('->')
        reached.add(src)
        reached.add(tgt)
    return reached


def _module_flow(script, module_mode: Optional[str]):
    """module 模式的判定用 flow：被测模块自己的 flow；整剧本模式 mainflow。
    （module 模式下 script.flow 已被 wrapper 换成合成主流程，不能用它做
    覆盖判定的分母/分子。）"""
    if not module_mode:
        return getattr(script, 'flow', None)
    mod = resolve_module_def(script, module_mode)
    return getattr(mod, 'flow', None)


def _module_has_out(script, module_mode: Optional[str]) -> Optional[bool]:
    """被测模块 flow 是否有 [OUT]/[BREAK] 出口（None=非 module 模式或无 flow）。
    无出口 = 持续循环型设计——max_steps 结局属预期（静态检测，回答
    「无限循环型模块能不能提前识别」：能识别的是这种无出口形态；带出口但
    条件永不满足的动态死循环只能靠步数预算在跑动中暴露）。"""
    if not module_mode:
        return None
    flow = _module_flow(script, module_mode)
    if flow is None:
        return None
    nodes = set((flow.nodes or {}).keys())
    return '[OUT]' in nodes or '[BREAK]' in nodes


def _unreached_nodes(merged, script,
                     module_mode: Optional[str] = None) -> List[str]:
    """本场（多轮合并后）一次都没走到的作者节点——死分支/漏接线的证据。

    2026-09-11 抽出：原先只在 print_report 里算（人看得见），JSON 终报
    （AI/工具消费方）看不到；femo-debug 工具要把「全部信息」回给主模型，
    未达节点必须进结构化终报。print_report 与 write_json_report 共用本函数，
    两处口径永远一致。

    2026-09-12 修正 module 模式口径：原实现固定看 script.flow——但 module
    模式下它已被 wrapper 换成合成主流程（全是结构节点），模块自己的死分支
    永远报不出来；现按被测模块自己的 flow 算。

    flow 为 None（解析没得到流程，如空/垃圾剧本）时返回空表：直接摸
    flow.nodes 会 AttributeError——那会在 print_report 里炸掉，连带后面的
    write_json_report 也不执行（-report 静默丢文件）。"""
    flow = _module_flow(script, module_mode)
    if flow is None:
        return []
    reached = _reached_nodes(merged)
    return [n for n in (flow.nodes or {})
            if n not in reached and n not in _STRUCTURAL_NODES
            and not n.startswith('__')]


_OUTCOME_LABELS = {
    # max_steps = 跑满步数预算仍未停。持续循环型模块（如群聊回 [IN]）这是
    # 预期结局；真死循环也在这暴露。按 2026-09-12 拍板：不算错误，退出码 0。
    'max_steps': 'max_steps（跑满步数预算仍未停——可能是无限循环，非错误）',
}


def _outcome_label(outcome: str) -> str:
    return _OUTCOME_LABELS.get(outcome, outcome)


def print_report(runs: List[dict], script, module_mode: Optional[str]):
    merged = runs[0]['tracker']
    for r in runs[1:]:
        merged.cross_run_merge(r['tracker'])
    outcomes = [r['outcome'] for r in runs]
    ok = sum(1 for o in outcomes if o == 'completed')
    loops = sum(1 for o in outcomes if o == 'max_steps')
    # 边覆盖率分母：module 模式看被测模块自己的 flow；整剧本看 mainflow
    total_edges = 0
    mflow = _module_flow(script, module_mode)
    if mflow is not None:
        total_edges = len(mflow.edges)
    print()
    print('═' * 62)
    title = f"Femo Debug — {script.meta.get('name', '')}"
    if module_mode:
        title += f" — module: {module_mode}"
    print(title)
    print('═' * 62)
    result = f"结果: {ok}/{len(runs)} 轮 completed"
    if loops:
        result += (f"（{loops} 轮 max_steps：跑满步数预算未停——可能是无限循环"
                   f"/持续循环型设计，非错误）")
    print(f"{result}   耗时: {sum(r['elapsed'] for r in runs):.1f}s   "
          f"种子: {[r['seed'] for r in runs]}")
    for r in runs:
        line = f"  seed={r['seed']}: {_outcome_label(r['outcome'])}"
        if r.get('error'):
            line += f" — {str(r['error'])[:110]}"
        print(line)
    print(f"节点执行: {' → '.join(merged.node_order[:36])}"
          + (' …' if len(merged.node_order) > 36 else ''))
    cov = len(merged.edges_taken)
    pct = (cov / total_edges * 100) if total_edges else 0
    print(f"边覆盖: {cov}/{total_edges} ({pct:.0f}%)")
    if merged.var_snapshots:
        print("变量快照(diff):")
        for s in merged.var_snapshots[:12]:
            print(f"  {s['node']:<16} {s['var']}: {s['old']} → {s['new']}")
        if len(merged.var_snapshots) > 12:
            print(f"  … 共 {len(merged.var_snapshots)} 条")
    warn = []
    for r in runs:
        warn.extend(r['oracle'].guess_warnings)
        warn.extend(f"概率沉默: {s}" for s in r['fake'].silences)
        warn.extend(f"flaky 无效赋值: {s}" for s in r['fake'].flaky_fired)
    if warn:
        print(f"提示 ⚠ {len(warn)} 条:")
        for w in dict.fromkeys(warn):
            print(f"  • {w}")
    unreached = _unreached_nodes(merged, script, module_mode)
    if unreached:
        print(f"未达节点: {unreached}")
    if module_mode and _module_has_out(script, module_mode) is False:
        print("ℹ 该模块 flow 没有 [OUT]/[BREAK] 出口——持续循环型设计，"
              "干跑跑满步数预算（max_steps）即停，属预期非错误")
    print('═' * 62)


def write_json_report(path: str, runs: List[dict], script,
                      module_mode: Optional[str]):
    merged = runs[0]['tracker']
    for r in runs[1:]:
        merged.cross_run_merge(r['tracker'])
    # 边覆盖率分母：module 模式看被测模块自己的 flow；整剧本看 mainflow
    total_edges = 0
    mflow = _module_flow(script, module_mode)
    if mflow is not None:
        total_edges = len(mflow.edges)
    data = {
        'script': script.meta.get('name', ''),
        'module_mode': module_mode,
        'runs': [{'seed': r['seed'], 'outcome': r['outcome'],
                  'error': r.get('error'), 'elapsed': r['elapsed']}
                 for r in runs],
        'node_visits': merged.node_visits,
        'node_order': merged.node_order,
        'edges_taken': sorted(merged.edges_taken),
        'total_edges': total_edges,
        'var_snapshots': merged.var_snapshots,
        'guess_warnings': sorted(set(
            w for r in runs for w in r['oracle'].guess_warnings)),
        'silences': [s for r in runs for s in r['fake'].silences],
        'flaky_fired': [s for r in runs for s in r['fake'].flaky_fired],
        # 未达节点（2026-09-11 起进终报）：结构化消费方（femo-debug 工具）
        # 也能看到死分支——与 print_report 共用 _unreached_nodes，口径一致。
        # 2026-09-12 module 模式按被测模块自己的 flow 算。
        'unreached_nodes': _unreached_nodes(merged, script, module_mode),
        # module 模式静态检测：被测模块 flow 无 [OUT]/[BREAK] = 持续循环型
        # 设计，max_steps 结局属预期（None=非 module 模式或模块无 flow）。
        'module_has_out': _module_has_out(script, module_mode),
    }
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2, default=str)
    print(f"[debug] 📄 JSON 报告: {os.path.abspath(path)}")


# ════════════════════════════════════════════════════════════
#  CLI
#════════════════════════════════════════════════════════════

def parse_set_args(set_args: List[str]) -> Dict[str, List[str]]:
    """--set k=v / k=v1|v2 → {k: [v1, v2]}。支持 @actor、数字、布尔。"""
    overrides: Dict[str, List[str]] = {}
    for s in set_args or []:
        if '=' not in s:
            raise ValueError(f"--set 格式应为 k=v 或 k=v1|v2，收到: {s!r}")
        k, v = s.split('=', 1)
        k = k.strip()
        if not k:
            raise ValueError(f"--set 键为空: {s!r}")
        seq = [x.strip() for x in v.split('|')] if '|' in v else [v.strip()]
        overrides[k] = seq
    return overrides


def cmd_run(args):
    overrides = parse_set_args(args.set)
    runs: List[dict] = []
    base_seed = (args.seed if args.seed is not None
                 else random.randrange(1, 10 ** 6))
    # 一条总线贯穿所有轮（记录带 run/seed 区分轮次）；订阅者按 CLI 装配
    bus = DebugLogBus()
    kinds = None
    if getattr(args, 'log_kinds', None):
        kinds = [k.strip() for k in args.log_kinds.split(',') if k.strip()]
    log_subs = []
    try:
        if getattr(args, 'log_jsonl', None):
            log_subs.append(JsonlLogSubscriber(bus, args.log_jsonl, kinds))
            print(f"[debug] 📡 实时日志 → {os.path.abspath(args.log_jsonl)}"
                  + (f"（kind 过滤: {kinds}）" if kinds else ""))
        if getattr(args, 'log_console', False):
            log_subs.append(ConsoleLogSubscriber(bus, kinds))
        with DBSandbox(verbose=not args.quiet):
            for i in range(args.runs):
                seed = base_seed + i
                script = load_script(args.script, base_dir=args.base_dir)   # 每轮重新编译（干净世界）
                if args.module:
                    wrap_module_test(script, args.module)
                runs.append(run_once(script, seed, overrides,
                                     args.assign_prob, args.max_steps,
                                     args.quiet, flaky=args.flaky,
                                     run_index=i + 1, bus=bus))
                if not args.quiet:
                    print(f"[debug] run {i + 1}/{args.runs} 完成（seed={seed}, "
                          f"{runs[-1]['outcome']}）")
    finally:
        for s in log_subs:
            s.close()
    script_ref = load_script(args.script, base_dir=args.base_dir)
    if args.module:
        wrap_module_test(script_ref, args.module)
    print_report(runs, script_ref, args.module)
    if args.report:
        write_json_report(args.report, runs, script_ref, args.module)
    return cli_exit_code(runs)


def cli_exit_code(runs: List[dict]) -> int:
    """CLI 退出码三档。completed 与 max_steps（跑满步数预算未停——可能是
    无限循环/持续循环型设计）都算「可接受结局」：max_steps 不再当失败
    （2026-09-12 拍板：持续循环型模块单测跑满预算即停是预期，退出码 0；
    真死循环在报告里响亮标注，不靠退出码表达）。error/exception/paused
    照旧：全好 0、部分好 2、全坏 1。"""
    good = sum(1 for r in runs if r['outcome'] in ('completed', 'max_steps'))
    return 0 if good == len(runs) else (2 if good else 1)


def cmd_parse(args):
    with DBSandbox(verbose=False):
        script = load_script(args.script)
    print(f"✅ 编译通过: {script.meta.get('name', '')}")
    print(f"   actions: {sorted(script.actions.keys())}")
    print(f"   modules: {sorted(script.modules.keys())}")
    print(f"   actors:  {sorted(script.actors.keys())}")
    print(f"   vars:    {sorted(script.vars.keys())}")
    ws = getattr(script, 'warnings', None) or []
    if ws:
        print(f"   编译警告 {len(ws)} 条:")
        for w in ws:
            print(f"     ⚠ {w}")
    return 0


def cmd_list(args):
    with DBSandbox(verbose=False):
        script = load_script(args.script)
    print(f"剧本: {script.meta.get('name', '')}")
    mods = script.modules or {}
    print(f"  modules: {sorted(mods) or '（无）'}")
    for mname, mdef in mods.items():
        params = ', '.join(mdef.params or []) or '（无参）'
        locals_ = ', '.join((mdef.locals or {}).keys()) or '（无）'
        subs = ', '.join((mdef.modules or {}).keys()) or '（无）'
        print(f"    &{mname}({params})  vars: {locals_}  子模块: {subs}")
    print(f"  actions: {sorted(script.actions.keys()) or '（无）'}")
    return 0


def cmd_coverage(args):
    return cmd_run(args)


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog='femo_debugger',
        description='Femo 调试模式：零 token 干跑剧本（FakeHost 替 AI/人类发言）')
    sub = ap.add_subparsers(dest='cmd', required=True)

    p_run = sub.add_parser('run', help='干跑剧本（可 --module 单测模块）')
    _add_common_args(p_run)
    p_run.add_argument('--runs', type=int, default=1, help='多轮跑（每轮换种子）')
    p_run.set_defaults(func=cmd_run)

    p_cov = sub.add_parser('coverage', help='多轮换种子跑，汇总分支覆盖率')
    _add_common_args(p_cov)
    p_cov.add_argument('--runs', type=int, default=10)
    p_cov.set_defaults(func=cmd_coverage)

    p_parse = sub.add_parser('parse', help='仅编译检查（不跑流程）')
    p_parse.add_argument('script', help='.femo 剧本路径')
    p_parse.set_defaults(func=cmd_parse)

    p_list = sub.add_parser('list', help='列出剧本的 module / action 清单')
    p_list.add_argument('script', help='.femo 剧本路径')
    p_list.set_defaults(func=cmd_list)

    args = ap.parse_args(argv)
    return args.func(args)


def _add_common_args(p):
    p.add_argument('script', help='.femo 剧本路径')
    p.add_argument('--seed', type=int, default=None, help='随机种子（可复现）')
    p.add_argument('--set', action='append', default=[],
                   help='定向注入变量值 k=v / k=v1|v2（可多次；@actor 可用）')
    p.add_argument('--module', default=None,
                   help='单独测试某 module（[IN]→[OUT]，母链变量可见；嵌套模块'
                        '用点路径如 Outer.Inner。持续循环型模块跑满 max_steps '
                        '即停，报告标「可能是无限循环」，退出码 0 非错误）')
    p.add_argument('--base-dir', default=None,
                   help='覆盖 code: 相对引用（file:"xxx.py"）的解析目录；'
                        '缺省=剧本所在目录')
    p.add_argument('--assign-prob', type=float, default=1.0,
                   help='赋值概率 0~1（默认 1.0 总是赋值；<1 概率沉默，'
                        '模拟 out 是权限不是义务——不赋值走引擎重试/fallback）')
    p.add_argument('--flaky', type=float, default=0.0,
                   help='概率输出无效赋值 0~1（默认 0；>0 时按概率输出未声明'
                        '变量赋值，触发 assign_error→node_retry 换值重发链路）')
    p.add_argument('--max-steps', type=int, default=200, help='步数预算（死循环保险）')
    p.add_argument('--report', default=None, help='JSON 报告输出路径')
    p.add_argument('--quiet', action='store_true', help='抑制引擎 print 日志')
    p.add_argument('--log-jsonl', default=None,
                   help='实时调试日志 JSONL 输出路径（每条落盘即 flush，'
                        '可 tail -f，或由宿主/前端转发）')
    p.add_argument('--log-kinds', default=None,
                   help='逗号分隔的 kind 过滤（配合 --log-jsonl/--log-console），'
                        '如: assign,node_start,retry')
    p.add_argument('--log-console', action='store_true',
                   help='实时在控制台打印结构化日志流水（不受 --quiet 影响）')


if __name__ == '__main__':
    _force_utf8_stdio()
    sys.exit(main())
