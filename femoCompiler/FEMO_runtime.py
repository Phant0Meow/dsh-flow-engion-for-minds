#femoCompiler/FEMO_runtime.py
"""
FEMO Runtime - Scripting Host Engine 运行时 v5.0（变量系统接线版）
负责: 流程执行, AI/human/func/assign 调度, LLM 调用, 事件
v5.0（2026-09-05 R2 通电，清单 v2 §8.2）: 变量子系统切换到 vars/ 包
（TaskEnv/WorldStore/VarFacade/Evaluator）+ task_world 适配层（TaskContext/
assemble_world/fork_branches/join_sign_in）——VarManager/ExecutionContext
退役；求值四套散装通道收敛 Evaluator；fork 副本隔离/git 式合并/内建直通
生效。join 凑齐协调在 R3 接线（本版 join 网关维持直通现状）。
"""

import importlib.util
import sys
import os
import types
import json
import re
import time
import threading
import asyncio
from typing import Any, Dict, List, Optional, Tuple, Set
from .femoAsync import AsyncEngine, CancelledError
# （task_pause import 已随 C3 修复退役（§5.7）：TaskPauseManager/save_snapshot/
#  restore_snapshot 不再被 runtime 引用；文件移 mytrashbin 留痕。）
from femoBridges.getDir.get_dir import get_FEMOroot_dir
from femoCompiler.FEMO_CLIrenderer import CLIRenderer, emit_step, emit_context_ready, emit_memory_ready
from femoCompiler.actor_resolver import resolve_actor_var, resolve_actor_attr

# ============================================================
#  变量子系统（2026-09-05 R2 通电）
# ============================================================
# 语言层单一定义点：FEMOVariableError 从 vars.model re-export（旧本地类退役）
from femoCompiler.vars.model import FEMOVariableError
from femoCompiler.protocol import normalize_transcript_steps
from femoCompiler.vars.checkpoint import dump_state, restore_state
from femoCompiler.vars.evaluator import Evaluator
from femoCompiler.task_world import (
    TaskContext, ModuleFrame, task_ctx, current_task_ctx, set_task_ctx,
    TaskWorld, assemble_world, fork_branches, branch_main, join_sign_in,
    make_coordinator, GraphQuery, ChildSpec, seed_new_declarations,
)
# 同名沿用：既有读点 `ctx = _current_context.get()` 零改动（装的换 TaskContext）
from femoCompiler.task_world import _task_ctx as _current_context

from femoCompiler.FEMO_parser import (
    Script, ModuleDef, ActionDef, FlowGraph, FlowNode, FlowEdge,
    ExecutorType, OutType, ActorRef, DynamicActorRef, VarRef,
    ActorDef, OutDef, InMapping, MethodDef, _split_module_ref,
)
from femoCompiler.FEMO_errors import (
    ErrorCategory, FEMOActorExecutionError, FEMOConfigError, FEMOTransientError, classify_error,
    build_dispatcher, VERDICT_FATAL, VERDICT_RETRY, VERDICT_EXHAUSTED, VERDICT_TOLERANT,
    FEEDBACK_TARGET_AI, FEEDBACK_TARGET_HUMAN, NODE_SETTLED_EVENT,
)


class FEMOException(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(f"[{code}] {message}")

class FEMOConcurrencyError(FEMOException):
    def __init__(self, message: str):
        super().__init__("FEMO-101", message)


class FEMORunPaused(Exception):
    """直连模式 AI 失败挂起（C3 修复，施工清单 v3 §5.7）：节点门口断点已拍
    （_record_checkpoint），raise 后由 run_async 的 except 分支走
    on_state_change('suspended', 'node_pause')——替换旧 task_pause.pause()
    的 `await event.wait()` 无超时挂死协程（C3：永挂无人 set）。
    为什么是 suspended 不是 failed：提案 §六 C3 归宿表锚点"AI 失败走
    on_state_change(suspended)"，且保留直连模式续跑能力。
    fork/par 分支内 raise 时会被 branch_main 的 except Exception 收进
    _fork_errors → 转 FEMOVariableError → failed（既有分支错误上报链，
    诚实收场；主链直连 AI 失败=suspended）。"""


# 赋值通道统一变量名（三处共用：extract_ai_assignments / _parse_single_assignment /
# _exec_assign——清单拍板 8④；含 $ 前缀[shared] / @ 前缀[actor 变量] / $@ 双前缀 /
# 中文变量名；保留 [] 以兼容 dict 索引路径写）
VAR_NAME_RE = r'[@$]*[\w\u4e00-\u9fff\[\]]+'


# ============================================================
#  工具函数
# ============================================================

def extract_ai_assignments(text: str) -> List[Tuple[str, str]]:
    """
    从 AI 输出中提取 SET VARIABLE: <<VAR = expr>> 格式的主动赋值语句。
    支持中英文等价符号：
      SET VARIABLE: <<KILL = @Alice>>
      设定变量：《KILL = @Alice》
      SET VARIABLE: <<KILL += 1>>
      SET VARIABLE: <<KILL = add(@Alice)>>
      SET VARIABLE: <<$x = 1>>（shared 变量，拍板 8④）
    """
    pattern = (
        r'(?:SET\s+VARIABLE|设定变量|设置变量)'
        r'\s*[:：]\s*'
        r'(?:<<|《|〈|《《)'
        r'\s*(' + VAR_NAME_RE + r')\s*'   # 变量名（VAR_NAME_RE：$ / @ / 中文）
        r'([+\-]?=)\s*'                   # 操作符 = / += / -=
        r'(.+?)'                          # 表达式
        r'(?:>>|》|〉|》》)'
    )
    matches = re.findall(pattern, text)
    result = []
    for m in matches:
        var_name = m[0].strip()
        op = m[1].strip()
        value = m[2].strip()
        # 合并操作符和值，如 "= @Alice" 或 "+= 1"
        expr = f"{op} {value}"
        result.append((var_name, expr))
    return result


def text_assignments_to_dict(chat_text: str) -> dict:
    """从人类聊天文本中提取 SET VARIABLE: <<VAR = expr>> 赋值，转为结构化
    variables dict（与前端变量框上传的 dict 同一数据约定，供
    _try_apply_human_variables 统一应用）：
    - 普通赋值剥掉 '= ' 前缀（应用侧会统一补回）；
    - 增量赋值保留 '+= N' / '-= N' 原样。
    2026-09-01 新增：人类（含 @mind 分发与 CLI 模式）在聊天输入框里直接写
    赋值语句即可生效，与 AI 节点同一套提取器；前端结构化变量框仍然保留，
    两条通道并存，框值优先（显式 UI 输入覆盖文本解析结果）。"""
    out: dict = {}
    for var_name, expr in extract_ai_assignments(chat_text or ''):
        expr = expr.strip()
        if expr.startswith('+=') or expr.startswith('-='):
            out[var_name] = expr
        elif expr.startswith('='):
            out[var_name] = expr[1:].strip()
        else:
            out[var_name] = expr
    return out


def parse_assign_syntax(expr: str, var_name: str = ''):
    """
    只支持文档规定的语法：
      = value
      += N
      -= N
      = add(x)
      = remove(x)
    支持中文括号、引号。
    """
    if not isinstance(expr, str):
        raise FEMOVariableError(
            f"parse_assign_syntax 需要字符串，但收到了 {type(expr)}: {expr!r}"
        )
    expr = expr.strip()
    # 统一中文符号
    expr = expr.replace('（', '(').replace('）', ')').replace('“', '"').replace('”', '"')

    # 1. += N
    m = re.match(r'\+\=\s*(.+)$', expr)
    if m:
        val_str = m.group(1).strip()
        try:
            return ('increment', float(val_str))
        except ValueError:
            raise FEMOVariableError(f"+= 右侧需要数字，得到: {val_str!r}")

    # 2. -= N
    m = re.match(r'\-\=\s*(.+)$', expr)
    if m:
        val_str = m.group(1).strip()
        try:
            return ('increment', -float(val_str))
        except ValueError:
            raise FEMOVariableError(f"-= 右侧需要数字，得到: {val_str!r}")

    # 3. = add(...)
    m = re.match(r'=\s*add\((.+)\)$', expr)
    if m:
        return ('add', m.group(1).strip())

    # 4. = remove(...)
    m = re.match(r'=\s*remove\((.+)\)$', expr)
    if m:
        return ('remove', m.group(1).strip())

    # 5. = value
    m = re.match(r'=\s*(.+)$', expr)
    if m:
        value_str = m.group(1).strip()
        if value_str.lower() == 'true': return ('set', True)
        if value_str.lower() == 'false': return ('set', False)
        try:
            if '.' in value_str: return ('set', float(value_str))
            return ('set', int(value_str))
        except ValueError:
            pass
        # 去掉可能的外围引号
        if (value_str.startswith('"') and value_str.endswith('"')) or \
           (value_str.startswith("'") and value_str.endswith("'")):
            value_str = value_str[1:-1]
        return ('set', value_str)

    # 无法解析
    raise FEMOVariableError(
        f"无法解析赋值表达式: {expr!r}。"
        f"支持的格式: = value, += N, -= N, = add(x), = remove(x)"
    )

def call_python(bridge, path: str, kwargs: dict = None) -> Any:
    """共用的外接 Python 模块调用"""
    kwargs = kwargs or {}
    return bridge.call(path, **kwargs)
    
def _resolve_val(val, facade):
    """递归解析变量值，直到不是 @ 开头的变量引用（追链上限 10 层防环）。
    静态演员引用（@Alice 在 actors 表）经 facade.get 原样返回名字本身——
    out 变量存演员名语义不变；@变量 → 取当前值（可能再是 @引用 → 继续解）。"""
    for _ in range(10):
        if isinstance(val, str) and val.startswith('@') and facade.has(val):
            val = facade.get(val)
        else:
            return val
    return val


def process_ai_result(facade, triplets: list, out_defs: list,
                      retry_info: dict = None) -> dict:
    """
    解析 AI 返回的三元组，综合决定：赋值 / 重试 / 报错 / 忽略。
    """
    retry_info = retry_info or {}
    retries_left = retry_info.get('retries_left', 0)
    on_error = retry_info.get('on_error', 'abort')

    ai_values = {}
    for t in triplets:
        if len(t) == 3:
            var_name, value, _ = t
            ai_values[var_name] = value
        elif len(t) == 2:
            var_name, value = t
            ai_values[var_name] = value

    assigned = {}
    missing_required = []

    for out_def in out_defs:
        var_name = getattr(out_def, 'global_name', None) or getattr(out_def, 'var_name', '')
        required = getattr(out_def, 'required', True)
        default = getattr(out_def, 'default', None)

        if var_name in ai_values:
            intent = parse_assign_syntax(str(ai_values[var_name]), var_name)
            op, val = intent
            if op in ('set', 'add', 'remove'):
                # @ 开头的变量引用 → 解析为最终值/实体名
                val = _resolve_val(val, facade)
            intent = (op, val)
            facade.apply_intent(var_name, intent)
            assigned[var_name] = ai_values[var_name]
        else:
            if required:
                missing_required.append(var_name)
            else:
                if default is not None:
                    facade.apply_intent(var_name, ('set', default))
                    assigned[var_name] = default

    if missing_required:
        if retries_left > 0 and on_error in ('retry', None):
            return {'status': 'retry', 'assigned': assigned,
                    'missing_required': missing_required,
                    'error_msg': f"必须变量缺失: {missing_required}，剩余重试 {retries_left-1} 次"}
        elif on_error == 'fallback':
            for var_name in missing_required:
                default = None
                for od in out_defs:
                    od_name = getattr(od, 'global_name', None) or getattr(od, 'var_name', '')
                    if od_name == var_name:
                        default = getattr(od, 'default', None)
                        break
                if default is not None:
                    facade.apply_intent(var_name, ('set', default))
                    assigned[var_name] = default
            return {'status': 'ok', 'assigned': assigned,
                    'missing_required': [],
                    'error_msg': f"必须变量缺失已用默认值兜底: {missing_required}"}
        else:
            return {'status': 'error', 'assigned': assigned,
                    'missing_required': missing_required,
                    'error_msg': f"必须变量缺失且无重试机会: {missing_required}"}

    return {'status': 'ok', 'assigned': assigned,
            'missing_required': [], 'error_msg': None}


def format_human_dialog(chat_text: str, variables: dict) -> str:
    """
    将人类聊天文本和变量赋值拼接为存储格式。

    规则：
    - 输入以 += 或 -= 开头 → 拼 "varName += N"（标准化空格）
    - 否则 → 拼 "varName = raw"
    """
    lines = []
    if chat_text and chat_text.strip():
        lines.append(chat_text.strip())
    for var_name, var_value in (variables or {}).items():
        raw = str(var_value).strip()
        if not raw:
            continue
        if raw.startswith('+=') or raw.startswith('-='):
            op = raw[:2]
            val = raw[2:].strip()
            lines.append(f"SET VARIABLE : <<{var_name} {op} {val}>>")
        else:
            lines.append(f"SET VARIABLE : <<{var_name} = {raw}>>")
    result = '\n'.join(lines)
    print(f"[format_human_dialog] chat_text={chat_text!r}, variables={variables}, result={result!r}")
    return result


# ============================================================
#  PythonBridge — 动态加载 .py 并调用函数
# ============================================================
class PythonBridge:
    """加载外部 Python 文件，调用其中函数"""

    def __init__(self, base_dir: str = ""):
        # base_dir = 剧本文件所在目录（有剧本地址时由 host 传入）；
        # 空 = 剧本未保存（纯文本运行），此时相对路径一律报错。
        self.base_dir = base_dir
        self.modules: Dict[str, types.ModuleType] = {}

    def load(self, alias: str, filepath: str) -> types.ModuleType:
        """
        加载 .py 文件，注册为 alias。
        地址解析规则（todo #2）：
        - 绝对路径 → 直接使用（无脑支持）
        - 相对路径 → 相对剧本文件所在目录（base_dir）解析
        - base_dir 为空（剧本未保存）→ 相对路径报错
        func_code 默认位置已取消（不再回退查找）。
        """
        if os.path.isabs(filepath):
            full_path = filepath
        elif self.base_dir:
            full_path = os.path.join(self.base_dir, filepath)
        else:
            raise FileNotFoundError(
                f"Python Bridge: 相对路径 '{filepath}' 需要剧本文件地址（剧本未保存）。"
                f"请先「导出 .FEMO」保存剧本，或改用绝对路径。"
            )

        if not os.path.exists(full_path):
            raise FileNotFoundError(f"Python Bridge: 文件不存在 {full_path}")

        spec = importlib.util.spec_from_file_location(alias, full_path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        self.modules[alias] = mod
        return mod

    def call(self, dotted_name: str, *args, **kwargs) -> Any:
        """调用 module.function 形式的函数"""
        if '.' not in dotted_name:
            raise ValueError(f"Python Bridge: 无效调用格式 '{dotted_name}'，需要 'module.function'")
        alias, func_name = dotted_name.split('.', 1)
        if alias not in self.modules:
            raise KeyError(f"Python Bridge: 模块 '{alias}' 未加载")
        mod = self.modules[alias]
        func = getattr(mod, func_name, None)
        if func is None:
            raise AttributeError(f"Python Bridge: 模块 '{alias}' 中没有函数 '{func_name}'")
        return func(*args, **kwargs)

    def has(self, dotted_name: str) -> bool:
        """检查函数是否存在"""
        if '.' not in dotted_name:
            return False
        alias, func_name = dotted_name.split('.', 1)
        if alias not in self.modules:
            return False
        return hasattr(self.modules[alias], func_name)





# ============================================================
#  FEMORunner — 运行器 v4.0
# ============================================================
class FEMORunner:
    """执行解析后的 Script - 直接理解新格式 FlowGraph"""


    def __init__(self, script, base_dir: str = ".", verbose: bool = True, event_callback=None,
                 user_api_key: str = None, user_api_provider: str = None,
                 user_api_url: str = None, user_api_model: str = None,
                 resume_state: dict = None,
                 runtime_callbacks: dict = None, run_tag: str = ''):
        print("[runtime] FEMORunner.__init__ 开始")
        self.script = script
        # ── Job 旁挂（运行状态链路重构 §5.2，依赖倒置契约 §4.2）──
        # Runtime 不认识 Job：四个可选回调 on_flow_start/on_checkpoint/
        # on_state_change/on_run_end 由宿主（bridge）注入；run_tag=wait_key
        # 世代前缀（bridge 注入 f"j{job_id}:"）。两参全带缺省——CLI 裸跑/
        # 现有构造点不传 → _rc_call 全 no-op、前缀逐字节等于现状。
        self._rc = runtime_callbacks or {}
        self._run_tag = run_tag
        self.verbose = verbose
        self.user_api_key = user_api_key
        self.user_api_provider = user_api_provider
        self.user_api_url = user_api_url
        self.user_api_model = user_api_model
        # ── 变量世界装配（2026-09-05 R2 通电：VarManager 退役）──
        # ⚠️ assemble_world 在下方 code: 文件加载后调用（evaluator 需要
        # code_modules 做函数调用分支；内建 getter 用实时属性无需提前）
        self.base_dir = base_dir
        self.bridge = PythonBridge(base_dir)
        # 内建直通（拍板：session_id/turn_count 恒为 runner 实时值，剧本赋值报只读）
        self._builtins_getter = (
            lambda n: self._current_session_id if n == 'session_id' else self._current_turn_id)
        self._task_coros: Dict[str, asyncio.Task] = {}   # 两层 task 桥（清单 §1.2）
        self._coordinators: Dict[str, Any] = {}          # per join_id 协调器缓存（代次内置）
        self._cascade = None                             # run 级 JoinCascade 总线（嵌套 join 级联；_coordinator_for 惰性建）
        self._skip_frames: Set[str] = set()              # 循环帧集合（D5：push add/pop discard）
        self._current_prompt = ""
        self._current_actor_info = {}
        self._current_session_id = 0
        self._current_turn_id = 0
        # ── 事件回调（用于前后端通信） ──
        self._event_callback = event_callback  # callable(event_type, data_dict)
        # ── 异步引擎（替代原线程池/事件机制） ──
        self.engine = AsyncEngine()
        # 解析全局 delay 配置并传给引擎
        delay = script.meta.get('delay', 0)
        if isinstance(delay, str):
            try:
                delay = float(delay)
            except (ValueError, TypeError):
                delay = 0
        self.engine.llm_delay = delay

        # （task_pause/TaskPauseManager 已随 C3 修复退役（§5.7/§5.9）——直连
        # AI 失败改走 FEMORunPaused → suspended(node_pause)，不再有挂死协程。）
        # ── 错误三桶分发入口（2026-09-05 重构，施工清单 v4 §4①）：
        # ErrorDispatcher 只裁决与发信号；重试循环留在 runtime（裁决⑤）。
        self.errors = build_dispatcher(self)
        # ── 断点状态：位置 + per-task 变量世界整包，经 checkpoint 事件交宿主持久化 ──
        # 记录的是"位置"（task_id→node id）：续跑/改剧本后从该节点重放（分支直启）。
        self.checkpoints: Dict[str, str] = {}    # task_id → node_id（宿主可见性/续跑位置）
        self._positions: Dict[str, Dict[str, Any]] = {}   # task_id → {node_id, mod_stack, loop_frames}
        self._last_vars_dump: str = ""   # state 去重基线：没变化不随事件上行（事件体积）
        # 外部注入的恢复态（断点续跑）：{checkpoints, session_id, state=整包}。
        # session_id 优先级最高——续跑=回到同一个世界（同一场次房间）接着演。
        # ⚠️ 数据源单一性约束（接线约定 5）：恢复唯一数据源=state（R4 起字段
        # 名 state，载荷暂名 vars 的过渡期已随宿主更名结束）；checkpoints 是
        # 宿主可见性信号，恢复侧不消费它。
        self.resume_checkpoints: Dict[str, str] = dict((resume_state or {}).get('checkpoints') or {})
        self.resume_state: dict = resume_state or {}
        # ── 人类输入等待机制（FastAPI 模式） ──
        self._human_input_event = None
        self._human_input_data = None
        self._human_input_counter = 0   # 每次 human 节点等待时 +1，生成唯一 wait_key

        self._stopped = False               # 全局停止标志
        self._main_task: Optional[asyncio.Task] = None  # 主协程引用
        self._llm_stop_event: Optional[threading.Event] = None  # LLM 停止信号
        # 发言人状态机（编号已改由 _alloc_turn 独立分配，此状态机仅剩遗留读点）
        self.speaker = {"current": None, "last": None}
        self._oratio_idx = 0
        self._step_idx = 0
        # ── turn 号分配（2026-08-28 par 丢行根治）──
        # 旧实现由说话人状态机"推算"turn/step：par 并发分支交叉推进共享状态，
        # 会产生撞键行（如甲思考 react (turn1,step0) 撞出题的 (turn1,step0)），
        # 再被 get_session_context 去重静默吞掉——甲亮答上下文丢前文的根因。
        # 现在节点开工时在锁内领取严格递增的独立 turn 号（按领取顺序定号）。
        self._turn_lock = threading.Lock()
        self._turn_seq = None          # 本 run 已分配到的 turn 号；None=尚未首次取号
        self._turn_seq_sid = None      # 上次取号所属 session（换场时重新对齐起点）
        
        # ── Session 和 Turn 初始化 ──
        from femoCompiler.db_utils import init_database, get_max_session_id, get_or_create_session, get_next_turn_id, session_exists
        init_database()

        # ── 断点续跑：注入的场次身份优先级最高（宿主已校验剧本指纹未变）。
        # 场次不存在（台账被清）→ 拒绝失忆续跑：宁可 fresh_start，不演失忆剧。
        resume_sid = self.resume_state.get('session_id')
        resumed_session = False
        if resume_sid not in (None, '', 0):
            try:
                sid = int(resume_sid)
            except (TypeError, ValueError):
                raise ValueError(f"断点的 session_id 无效: {resume_sid!r}")
            if not session_exists(sid):
                raise ValueError(
                    f"断点指向的场次 {sid} 不存在（运行台账可能已被清空），拒绝失忆续跑；请 fresh_start 重新开演。")
            self._current_session_id = sid
            self._current_turn_id = get_next_turn_id(sid)
            resumed_session = True
            print(f"[runtime]🔁 断点续跑：复用场次 {sid}（turn {self._current_turn_id}），前情对话照常可见")

        session_meta = script.meta.get('session', None)
        if resumed_session:
            pass  # 场次已由断点注入决定，跳过 meta.session 判定
        elif session_meta is None or str(session_meta).strip().lower() == 'new':
            # 纯 new 或无声明：无脑新建
            self._current_session_id = get_max_session_id() + 1
            get_or_create_session(session_id=self._current_session_id, title=script.meta.get('name', ''))
            self._current_turn_id = 1
            print(f"[runtime]🆕 新建 session: {self._current_session_id}, turn: 1")
        else:
            session_meta_str = str(session_meta).strip()
            # 检查是否包含斜杠，格式: 数字/new
            if '/' in session_meta_str:
                parts = [p.strip() for p in session_meta_str.split('/', 1)]
                if len(parts) != 2 or parts[1].lower() != 'new':
                    print(f"[runtime]❌ meta.session 格式无效: {session_meta}，期望格式: 数字/new")
                    raise ValueError(f"meta.session 格式无效: {session_meta}")
                try:
                    declared_sid = int(parts[0])
                except (ValueError, TypeError):
                    print(f"[runtime]❌ meta.session 格式无效: {session_meta}，斜杠前必须为数字")
                    raise ValueError(f"meta.session 斜杠前必须为数字: {session_meta}")
                # 数字/new 逻辑
                if session_exists(declared_sid):
                    # 存在直接使用
                    self._current_session_id = declared_sid
                    self._current_turn_id = get_next_turn_id(declared_sid)
                    print(f"[runtime]📂 继续 session: {self._current_session_id}, turn: {self._current_turn_id}")
                else:
                    # 不存在，先计算新建后的 ID
                    new_id = get_max_session_id() + 1
                    if new_id == declared_sid:
                        # 恰好匹配，新建并写入
                        get_or_create_session(session_id=declared_sid, title=script.meta.get('name', ''))
                        self._current_session_id = declared_sid
                        self._current_turn_id = 1
                        print(f"[runtime]🆕 新建 session (恰好匹配): {self._current_session_id}, turn: 1")
                    else:
                        print(f"[runtime]⚠️ 声明的 session {declared_sid} 不存在，新建后 ID 为 {new_id}，不是 {declared_sid}。")
                        # 询问用户
                        try:
                            user_input = input(f"是否新建 session {new_id}？(y/N): ").strip().lower()
                        except (EOFError, KeyboardInterrupt):
                            user_input = ''
                        if user_input == 'y':
                            get_or_create_session(session_id=new_id, title=script.meta.get('name', ''))
                            self._current_session_id = new_id
                            self._current_turn_id = 1
                            print(f"[runtime]🆕 用户确认新建 session: {self._current_session_id}, turn: 1")
                        else:
                            print(f"[runtime]❌ 用户取消新建 session")
                            raise ValueError(f"Session {declared_sid} 不存在，用户拒绝新建")
            else:
                # 纯数字
                try:
                    declared_sid = int(session_meta_str)
                except (ValueError, TypeError):
                    print(f"[runtime]❌ meta.session 值无效: {session_meta}")
                    raise ValueError(f"meta.session 无效: {session_meta}")
                if not session_exists(declared_sid):
                    print(f"[runtime]❌ 声明的 session {declared_sid} 不存在。请使用 session = new 新建，或 session = {declared_sid}/new 自动匹配。")
                    raise ValueError(f"Session {declared_sid} 不存在")
                self._current_session_id = declared_sid
                self._current_turn_id = get_next_turn_id(declared_sid)
                print(f"[runtime]📂 继续 session: {self._current_session_id}, turn: {self._current_turn_id}")

        # 加载 code: 区域声明的 .py 文件
        for alias, filepath in script.code.items():
            # 处理 file: 前缀
            if filepath.startswith('file:"') and filepath.endswith('"'):
                filepath = filepath[6:-1]
            elif filepath.startswith("file:'") and filepath.endswith("'"):
                filepath = filepath[6:-1]
            self.bridge.load(alias, filepath)

        # ── 变量世界装配（R2 通电：替代 VarManager+literal_eval 二段求值；
        # session_id/turn_count 走内建直通不再写存储）──
        self.world: TaskWorld = assemble_world(
            script, builtins_getter=self._builtins_getter,
            code_modules=self.bridge.modules)
        self.evaluator = self.world.evaluator

        # ── 断点续跑：per-task 变量世界整包恢复（新格式，清单 D8）──
        # 恢复=原样重建（envs/world/forks/ledger/positions），随后 task_id
        # 序号取快照最大号+1 续分配防撞号。旧合并视图平铺格式已作废
        # （restore_state VERSION 响亮报错，按拍板 fresh 开演）。
        rs_state = self.resume_state.get('state')
        if isinstance(rs_state, dict) and rs_state:
            restored = restore_state(rs_state)
            _envs, _world, _forks, _ledger, _positions = restored
            # 引擎侧唯一数据源=state（接线约定 5）；以快照重建世界组件
            self.world.envs = _envs
            self.world.world = _world
            self.world.forks = _forks
            self.world.ledger = _ledger
            self.evaluator = self.world.evaluator
            # task_id 序号防撞号（清单 D8）：续分配从快照最大号+1 起——恢复后
            # fork/merge 还会分配新 task 号，不续号会与快照已有的 t1/t2… 撞号
            # （ledger/envs 登记互相覆盖，世界状态错乱）。
            seq_next = self.world.max_task_seq()
            self.world.idgen.restore_from(seq_next)
            self.resume_positions: Dict[str, Dict[str, Any]] = dict(_positions)
            print(f"[runtime]🔁 断点续跑：恢复 per-task 世界（{len(_envs)} env / "
                  f"{len(_positions)} 位置），task 序号续自 t{seq_next}")
            # 【2026-09-06 vars 增删容差（用户拍板）】整包恢复只认快照——新剧本
            # 新声明的变量不在恢复后的世界里，读到即"未声明"崩。按声明初值补种；
            # 快照有而新剧本已删的成为孤儿值（无人读则无害）。都打 ⚠️——能跑，
            # 但作者应当知情（⚠️ 补种值=声明初值，非断点时刻的中间态）。
            # 【2026-09-07 warning 桶】汇总发 WARNING（notify_author），作者在
            # 聊天窗/错误面板可见——原来只进 bridge 日志，作者蒙在鼓里。
            seeded, orphaned = seed_new_declarations(self.world, script)
            if seeded:
                names = ', '.join(seeded)
                print(f"[runtime] ⚠️ 断点续跑：新增变量 {names} 不在快照世界，已用声明初值补种")
                self.errors.warn(
                    f"断点续跑：新增变量 {names} 不在快照世界，已用声明初值补种"
                    "（补种值=声明初值，非断点时刻的中间态）")
            if orphaned:
                names = ', '.join(orphaned)
                print(f"[runtime] ⚠️ 断点续跑：变量 {names} 在新剧本已删除，快照残留值成为孤儿数据（无人读则无害）")
                self.errors.warn(
                    f"断点续跑：变量 {names} 在新剧本已删除，快照残留值成为孤儿数据（无人读则无害）")
        else:
            self.resume_positions = {}

        # 步数控制（保留）
        self.global_step = 0
        self.global_max_steps = 0
        
        # ── CLI 渲染器（若未提供外部事件回调且非 FastAPI 模式） ──
        if self._event_callback is None and self._human_input_event is None:
            cli_renderer = CLIRenderer(verbose=self.verbose)
            self._event_callback = cli_renderer.handle_event
            self._cli_renderer = cli_renderer   # 保存引用，供清屏命令使用
        else:
            self._cli_renderer = None

        if self.verbose:
            print("\n🔧 Python Bridge 已加载模块:")
            for alias in self.bridge.modules:
                funcs = [name for name, obj in vars(self.bridge.modules[alias]).items()
                         if callable(obj) and not name.startswith('_')]
                print(f"[runtime]{alias}: {funcs}")

    def _emit_event(self, event_type: str, data: dict = None):
        """向前端发送事件"""
        if data:
            def _sanitize(obj):
                if isinstance(obj, dict):
                    return {k: _sanitize(v) for k, v in obj.items()}
                elif isinstance(obj, list):
                    return [_sanitize(item) for item in obj]
                elif isinstance(obj, (str, int, float, bool, type(None))):
                    return obj
                else:
                    return str(obj)
            data = _sanitize(data)
        
        # 调试：打印所有发往前端的事件
        #print(f"[EMIT] {event_type}: {json.dumps(data, ensure_ascii=False, default=str) if data else '{}'}")
        
        if self._event_callback:
            self._event_callback(event_type, data or {})

    def _rc_call(self, name: str, *args) -> None:
        """窄回调安全调用（§4.2 依赖倒置契约）：回调是旁挂，环境故障不能带崩
        演出本体——try/except 打 log。旁挂失效最坏=Job 停在 running → 重启
        对账判 crash，不会伪 finished。未注入该回调（缺省 None）→ no-op。"""
        callback = self._rc.get(name)
        if callback is None:
            return
        try:
            callback(*args)
        except Exception as exc:  # noqa: BLE001 ——旁挂绝不反向炸演出
            print(f"[runtime]⚠️ runtime callback {name!r} failed: {exc}")

    def _record_checkpoint(self, ctx: TaskContext, node_id: str) -> None:
        """记录一个 task 当前执行到的节点位置与 per-task 变量世界整包
        （进入节点前调用）。

        存的是"位置"（task_id→node id，分支直启的恢复点）；节点不存在于
        新剧本时从头跑。[END]/[BREAK] 是终点/跳出点，永不作为续跑位置记录
        ——否则残留的 checkpoint 会让后续每次 run 都从终点"续跑"而整体跳过
        剧本。

        载荷 {checkpoints, session_id, state?}：checkpoints=task_id→node_id
        位置映射（宿主 canResume 判据，纯透传）；state=dump_state per-task
        世界整包（仅内容变化时携带去重省流量；R4 起字段名 state，与宿主
        宿主侧事件/开演两模块同刻更名——引擎与宿主同插件
        同次构建部署，无跨版本窗口）。
        ⚠️ 引擎恢复侧唯一数据源=state.positions（接线约定 5）。
        """
        if node_id in ('[END]', '[BREAK]'):
            return
        position_changed = self.checkpoints.get(ctx.task_id) != node_id
        # 本 task 的执行栈快照（直启时 restore_stack 用）；module_frames 含
        # 每层模块的母 flow 调用节点（caller_node_id）——直启跑完模块 flow 后
        # 逐层弹栈回母 flow 续传（恢复模型 §3.5 模块场景补全，_resume_module_unwind）。
        mod_stack, loop_frames = ctx.facade.export_stack()
        self._positions[ctx.task_id] = {
            'node_id': node_id,
            'mod_stack': list(mod_stack),
            'module_frames': [{'name': mf.name, 'caller_node_id': mf.caller_node_id}
                              for mf in ctx.module_frames],
            'loop_frames': list(loop_frames),
        }
        state = dump_state(
            envs=self.world.envs, world=self.world.world,
            forks=self.world.forks, ledger=self.world.ledger,
            positions=self._positions)
        state_dump = json.dumps(state, ensure_ascii=False, default=str, sort_keys=True)
        state_changed = state_dump != self._last_vars_dump
        if not position_changed and not state_changed:
            return
        if position_changed:
            self.checkpoints[ctx.task_id] = node_id
        self._last_vars_dump = state_dump
        # D1（前端断点高亮）：checkpoint_labels={task_id: 显示名}——per-task
        # 全量查表（各 task 位置可能在不同 flow，按 _positions 的 mod_stack
        # 逐个解析）；查表失败/网关缺省退化 node_id（0-e 兜底形态）。
        # 恢复侧仍消费 node_id，双字段并存不互扰。
        labels: Dict[str, str] = {}
        for tid, pos in self._positions.items():
            node_str = str(pos.get('node_id', ''))
            label = node_str
            try:
                flow_i, _extra_i = self._flow_for_stack(list(pos.get('mod_stack') or []))
            except Exception as exc:
                print(f"[runtime]⚠️ checkpoint_labels 查表失败（task {tid} 退化 node_id）: {exc}")
                flow_i = None
            if flow_i is not None:
                node_obj = flow_i.nodes.get(node_str)
                if node_obj is not None and getattr(node_obj, 'label', ''):
                    label = node_obj.label
            labels[tid] = label
        payload: Dict[str, Any] = {'checkpoints': dict(self.checkpoints),
                                   'checkpoint_labels': labels}
        if self._current_session_id:
            payload['session_id'] = self._current_session_id
        if state_changed:
            payload['state'] = state
        self._emit_event('checkpoint', payload)
        # Job 旁挂（§5.3）：断点归引擎落盘（JobManager.merge_checkpoint）——
        # 宿主不再持久化 resume 块（A3/C5 死于结构）。
        self._rc_call('on_checkpoint', payload)

    def _resume_start_for(self, task_id: str, fallback: str, flow) -> str:
        """续跑起点：该 task 上次记录的节点若仍在新剧本中则用之，否则从头。"""
        if not self.resume_checkpoints:
            return fallback
        resumed = self.resume_checkpoints.get(task_id)
        if resumed and resumed in flow.nodes:
            print(f"[resume] 分支 {task_id} 从节点 {resumed} 继续")
            return resumed
        if resumed:
            print(f"[resume] 分支 {task_id} 的记录节点 {resumed} 已不在新剧本，从头执行")
        return fallback

    def _resolve_module_def(self, mod_path: str):
        """沿模块完整路径（'Outer.Inner'）解析模块定义——嵌套模块 mod_path
        栈解析（清单 D4）：逐段下钻 script.modules。"""
        mod = None
        container = self.script.modules
        for part in mod_path.split('.'):
            mod = container.get(part)
            if mod is None:
                raise FEMOVariableError(
                    f"模块 '{mod_path}' 解析失败于段 '{part}'（未声明或路径错误）")
            container = mod.modules
        return mod

    def _chain_actions_for(self, mod_path: str) -> Optional[dict]:
        """模块 flow 的 extra_actions：词法链（mod_path 逐段 祖先→自身）
        actions 合并，自身覆盖同名（拍板 6 的 action 侧对齐——嵌套子模块
        flow 可引用母链模块的 action）。全局 script.actions 不在此合并：
        _execute_node_content 查不到 extra 时本就回退全局。"""
        merged: dict = {}
        container = self.script.modules
        for part in (mod_path or '').split('.'):
            mod = container.get(part)
            if mod is None:
                return None
            merged.update(mod.actions or {})
            container = mod.modules
        return merged or None

    def _flow_for_stack(self, mod_stack) -> Tuple[Any, Optional[dict]]:
        """直启/分支执行的目标 flow 与 extra_actions：模块栈顶决定
        （栈顶剧本级 → mainflow；否则对应模块 flow，extra_actions 同源）。"""
        if not mod_stack:
            return self.script.flow, None
        mod = self._resolve_module_def(mod_stack[-1])
        return mod.flow, self._chain_actions_for(mod_stack[-1])

    async def _resume_module_unwind(self, ctx: TaskContext) -> None:
        """直启恢复的模块调用链续传（恢复模型 §3.5 的模块场景补全，R4）。

        分支直启按栈顶 flow（模块 flow）跑：到 [OUT]/[BREAK] 时 _execute_path
        返回——**正常场景**母协程（fork gather 收场后）继续母 flow 的剩余执行
        流；**直启场景**母协程不存在（root 已随 fork 终止且不直启），若不续传，
        模块出口后 mainflow 的后续节点永远没人跑（flow_done 照发、剧本断头）。

        本方法逐层弹栈：exit_module 清模块帧（宪法 1.2）→ 按快照调用链
        （ModuleFrame.caller_node_id，_run_module push 时记录）定位母 flow 中
        的模块调用节点 → 从其出边继续 _execute_path；嵌套模块逐层回退，直到
        模块栈空（mainflow）或流程自然终止。已知边界（留档待议）：模块调用点
        在母 flow 的 for 循环体内时，restore_stack 重建的栈序（循环帧恒排在
        模块帧后）与运行期真实栈序（模块帧在循环帧内）不一致，exit_module
        的栈顶校验会 fail loud——不会静默错跑，该组合场景的恢复待单独处理。"""
        while ctx.module_frames:
            top = ctx.module_frames[-1]
            mod_path = top.name
            ctx.module_frames.pop()
            ctx.facade.exit_module()      # pop 帧 + 清模块 local（宪法 1.2）
            parent_stack = [mf.name for mf in ctx.module_frames]
            flow, extra = self._flow_for_stack(parent_stack)
            caller = top.caller_node_id or ''
            if flow is None or not caller or caller not in flow.nodes:
                print(f"[resume]⚠️ 模块 {mod_path} 的调用点 {caller!r} 不在新剧本"
                      f"母 flow 中，续跑止于模块出口")
                return
            nxt = self._follow_next_edge(caller, flow)
            if not nxt:
                return                    # 调用点后无出边：流程正常终止
            print(f"[resume]🔗 模块 {mod_path} 跑完，从调用点 {caller} 续传母 flow → {nxt}")
            await self._execute_path(flow, nxt, stop_at=None,
                                     extra_actions=extra, max_steps=0)

    def _parse_single_assignment(self, text: str) -> tuple:
        """
        解析单条赋值文本，返回 (变量名, 表达式)。
        支持格式：@KILL = @Ellis, KILL = @Alice, $x = 1, SCORE += 1, TASKS = add(@Alice)
        解析失败抛出 ValueError。
        """
        # 变量名支持 @/$ 前缀（VAR_NAME_RE，拍板 8④）
        m = re.match(r'^\s*(' + VAR_NAME_RE + r')\s*([+\-]?=)\s*(.+)$', text)
        if not m:
            raise ValueError(f"无法解析赋值语句: {text}")
        var_name = m.group(1).strip()
        op = m.group(2).strip()
        value = m.group(3).strip()
        expr = f"{op} {value}"
        return var_name, expr

    # ══════════════════════════════════════════════════
    #  边遍历辅助
    # ══════════════════════════════════════════════════

    def _follow_next_edge(self, node_id: str, flow) -> Optional[str]:
        """条件求值 + 找下一条边，返回目标节点 ID"""
        cond_edges = [e for e in flow.edges if e.source == node_id and e.condition]
        default_edges = [e for e in flow.edges if e.source == node_id and not e.condition]

        ctx = current_task_ctx()
        facade = ctx.facade if ctx is not None else None
        self.evaluator.clear_func_cache()   # 接线约定 4：每条边评估前清（副作用函数不跨节点缓存）
        for e in cond_edges:
            result = self.evaluator.evaluate_condition(e.condition, facade)
            print(f"[runtime]  🔍 此处有条件判断: 条件 = {e.condition}，结果 = {result}")
            if result:
                return e.target

        if default_edges:
            return default_edges[0].target

        # 【2026-09-07 warning 桶】流程在无出边处停止=按设计正常收尾的一种，
        # 不阻断（return None → 上层正常结束），但作者应当知情。
        print(f"[runtime]⚠️ 节点 {node_id} 没有任何符合条件的出边，流程将在此停止。")
        self.errors.warn(f"节点 {node_id} 没有任何符合条件的出边，流程将在此停止。")

        return None

    def _collect_loop_body(self, gateway_id: str, flow) -> Tuple[Set[str], Optional[str], Optional[str]]:
        """
        找出 for 循环体包含的节点，以及循环入口和出口。
        返回 (body_node_ids, body_entry_id, exit_node_id)
        """
        body = set()
        queue = []

        # 从 gateway 出发，所有非自环边的目标是候选入口
        for e in flow.edges:
            if e.source == gateway_id and e.target != gateway_id:
                queue.append(e.target)

        # BFS 收集 body 节点（不穿过 gateway）
        visited = set()
        while queue:
            nid = queue.pop(0)
            if nid in visited or nid == gateway_id:
                continue
            visited.add(nid)
            body.add(nid)

            for e in flow.edges:
                if e.source == nid and e.target != gateway_id and e.target not in visited:
                    queue.append(e.target)

        # body_entry: gateway 的第一条进入 body 的边
        body_entry = None
        for e in flow.edges:
            if e.source == gateway_id and e.target in body:
                body_entry = e.target
                break

        # exit_node: gateway 的边中，目标不在 body 里且不是 gateway 自身的
        exit_node = None
        for e in flow.edges:
            if e.source == gateway_id and e.target != gateway_id and e.target not in body:
                exit_node = e.target
                break

        return body, body_entry, exit_node




    def _check_cancel(self):
        """检查当前协程是否被取消"""
        self.engine.check_cancel()
        
    def stop(self):
        """全局立刻停止：取消主协程，中断 LLM 流式输出。
        v3（运行状态链路重构 §5.5）：
        - 幂等头：二次 stop / HMR dispose 不再双 flow_paused（灭 D6）；
        - _stopped 从零消费标志复活为真消费（A1 取消诚实化的判定依据：
          run_async 取消路径据它区分 user_pause / cancelled）；
        - 时序红线（v1 裁决）：**先 cancel 后 abort**——cancel 先置 _must_cancel，
          abort_all 唤醒的协程在恢复点直接吃 CancelledError 零推进；反过来
          （先 abort）唤醒与 cancel 之间存在同步推进窗口，协程可能拿着输入值
          继续跑赋值/落库（僵尸推进）。"""
        if self._stopped:
            return                          # ① 幂等头（D6）
        print("[runtime] 收到全局停止信号，正在停止所有任务...")
        self._stopped = True                # ② 真消费标志（A1 判定 + 幂等依据）

        # ③ 中断正在进行的 LLM 流式请求
        if self._llm_stop_event:
            self._llm_stop_event.set()

        # ④ 取消主协程 + 所有活动分支协程（先 cancel）。
        #    asyncio 的 cancel 不级联：fork 分支等子任务注册在
        #    engine._active_tasks，只取消 _main_task 会让分支继续跑
        #    （表现为"停止失败、狼人节点疯狂重复"）。
        #    【2026-09-07 214 事故根治】cancel 一律走 call_soon_threadsafe：
        #    stop() 从 bridge 的 stdin 派发线程调用（非循环线程），裸
        #    task.cancel() 内部经 loop.call_soon（非线程安全）调度唤醒、
        #    不写 self-pipe——循环恰 park 在 select 时取消令牌被静默丢失，
        #    循环从此永久空转，停止成了死信（214"停止已受理、引擎永不
        #    收场"的机制本体）。call_soon_threadsafe 自带 self-pipe 唤醒，
        #    回调在循环线程执行；深任务链 cancel 的同步递归发生在彼处
        #    （femo_bridge 已把 recursionlimit 提到 200k 兜底）。
        targets = [self._main_task]
        targets.extend(self._task_coros.values())   # 两层 task 桥双保险（值都在 engine._active_tasks）
        active = getattr(self.engine, '_active_tasks', None)
        if active:
            targets.extend(active)
        for task in targets:
            if task is not None and not task.done():
                try:
                    task.get_loop().call_soon_threadsafe(task.cancel)
                except RuntimeError:
                    # 循环已关闭（run 已收尾）：任务由循环退场收割，无需调度
                    pass
        print("[runtime] 主协程与全部活动分支协程已取消")

        # ⑤ 后 abort——唤醒 cancel 漏网的 executor 等待者（A2）：wait_for_input
        #    的 _aborted 恢复点让它们直接吃 CancelledError 零推进。
        try:
            self.engine.human_input.abort_all()
        except Exception as exc:
            print(f"[runtime]⚠️ human_input.abort_all failed: {exc}")

        # ⑥ 发送事件通知前端（首发照发：v4 停靠清场——宿主作废在飞 main 回答/
        #    掐断在飞子代理——全挂它上面，不发则宿主停靠托管挂满 15min）
        self._emit_event('flow_paused', {})
            
    async def _run_join(self, join_id: str, node, flow, extra_actions=None, max_steps=0) -> Optional[str]:
        """join 网关（R3 接线，清单 D3——主流程路径）。

        统一走 task_world.join_sign_in：到达即签到挂起；等待集沿 join 入边
        拓扑反溯（fork 网关对齐血统链收集孩子 / 嵌套 join 级联 / 串行直连
        到达即过）；凑齐 = LCA base + git 式三方合并（冲突保留 base + 警告，
        拍板 7）→ merge 出**新 task**（宪法 1.1）→ 本协程变身幸运者从出口
        继续；返回 None = 本 task 终止（迟到者/非触发者），调用方不得再跑
        出口。join(N) 的"凑 N 即跑、余者掐尾"语义首次生效（§1.4 实锤旧
        Runtime 里 join(数字) 从未生效）。"""
        return await join_sign_in(self, self.world, flow, join_id, node,
                                  extra_actions, max_steps)

    # ══════════════════════════════════════════════════
    #  join 协调器接线（R3，清单 D3）
    # ══════════════════════════════════════════════════

    def _coordinator_for(self, join_id: str, node, flow, tw: TaskWorld):
        """per join_id 协调器缓存（循环体里的 join 多轮复用靠协调器自带
        代次）。mode/sources 取自编译期产物：join_mode（parse_join 产出
        'all' 或数字字符串——数字串→int，根治旧 Runtime 数字掉 else 的死
        代码语义，拍板 2）；sources=直连入边的来源节点集（join 列表节点，
        事件显示与文档对照用）。GraphQuery 沿 join 入边在**当前 flow 图内**
        反溯（模块边界即停）；cascade 为 run 级共享总线（嵌套 join 级联）。"""
        coord = self._coordinators.get(join_id)
        if coord is None:
            meta = getattr(node, 'meta', None) or {}
            raw_mode = str(meta.get('join_mode', 'all')).strip()
            if raw_mode.lower() == 'all' or not raw_mode:
                mode = 'all'
            elif raw_mode.isdigit():
                mode = int(raw_mode)
            else:
                raise FEMOVariableError(
                    f"join 模式 '{raw_mode}' 不合法（join(all) 或 join(N)，N 为正整数）")
            # join 列表节点 = 直连入边的 source（parse_join 产出），去重保序
            sources = tuple(dict.fromkeys(
                e.source for e in flow.edges if e.target == join_id))
            if self._cascade is None:
                from femoCompiler.vars.join import JoinCascade
                self._cascade = JoinCascade()
            coord = make_coordinator(
                tw=tw, join_id=join_id, mode=mode, sources=sources,
                emit_event=self._emit_event,
                cancel_fn=self._cancel_branch_task,
                graph_query=GraphQuery(flow),
                skip_frames=self._skip_frames,
                cascade=self._cascade)
            self._coordinators[join_id] = coord
        return coord

    def _cancel_branch_task(self, task_id: str) -> None:
        """join(N) 凑齐时掐掉未到达分支的单链（cancel_fn 通道）。
        只 cancel 该 task 的协程（_task_coros 两层 task 桥），不影响其他
        分支/其他模块对同一 action 的调用（文档 §8.3 线程管理）。"""
        t = self._task_coros.get(task_id)
        if t is not None and not t.done():
            print(f"[JOIN]   join 掐断分支 task {task_id}（单链立即停）")
            t.cancel()

    # ══════════════════════════════════════════════════
    #  统一的图遍历执行器
    # ══════════════════════════════════════════════════

    async def _execute_flow(self, flow, start: str = None,
                            stop_at: Set[str] = None,
                            extra_actions: dict = None,
                            max_steps: int = 0) -> Optional[str]:
        """
        统一的 DFS 式图遍历执行器。
        - flow: FlowGraph 对象
        - start: 起始节点 ID
        - stop_at: 遇到这些节点就停下（不执行）
        - extra_actions: 额外的 action 字典（模块局部 action 优先查这里）
        - max_steps: 最大步数 (0=不限)
        返回: 停在哪个节点 ID
        """
        if not flow or not flow.nodes:
            return None

        stop_at = stop_at or set()
        
        # ★ 计算 start：优先参数 > flow.entry > [START] 节点 > 自动推断
        if start is None:
            start = getattr(flow, 'entry', None) or ''
        if not start:
            # 优先使用 [START] 节点（即使它有入边）
            if '[START]' in flow.nodes:
                start = '[START]'
            else:
                # 自动推断：不是任何边 target 的节点就是入口
                targets = {e.target for e in flow.edges}
                for nid in flow.nodes:
                    if nid not in targets:
                        start = nid
                        break
        if not start:
            raise FEMOVariableError(
                "无法确定流程入口节点。请检查 mainflow 中是否定义了起始节点，"
                "或是否所有节点都被其他节点指向（如成环且无 [START] 节点）。"
            )
        
        start = start or flow.entry
        if not start:
            return None

        # 续跑：本流程从上次记录的节点继续（节点须仍存在）；位置键=task_id
        # （分支直启恢复点，互不覆盖）。
        ctx = current_task_ctx()
        flow_key = ctx.task_id if ctx is not None else '__main__'
        start = self._resume_start_for(flow_key, start, flow)

        current = start
        step = 0

        # 入口 [START]：单边走第一条边；多出边 = 一次性 fork（与循环内
        # 语义一致，不静默丢线——之前只走第一条边会悄悄吞掉其余分支）。
        # fork 后主流程结束（_run_fork gather 等待所有分支完成；无限循环
        # 分支由 engine 跟踪，shutdown 时取消）。
        if current == '[START]':
            start_out = [e for e in flow.edges if e.source == current]
            if len(start_out) > 1:
                await self._run_fork(current, flow.nodes.get(current), flow,
                                     extra_actions or {}, max_steps)
                return None
            next_node = self._follow_next_edge(current, flow)
            if next_node:
                current = next_node
            else:
                return None

        prev_node = '[START]' if start != '[START]' else '外部'
        while current:
            # 到达停止点
            if current in stop_at:
                return current

            if max_steps > 0 and step >= max_steps:
                print(f"[runtime]⚠️ 达到最大步数 {max_steps}")
                return current

            step += 1
            node = flow.nodes.get(current)
            if not node:
                raise FEMOVariableError(f"节点未定义: {current}")

            # 节点位置检查点：进入节点前记录（续跑从此节点重放；键=task_id）
            ctx = current_task_ctx()
            if ctx is not None:
                self._record_checkpoint(ctx, current)

            # ── 获取节点类型 ──
            kind = node.type if node.type else 'empty'
            info = node.meta
            # ID 覆盖
            if current == '[END]':
                kind = 'end'
            elif current == '[BREAK]':
                kind = 'break'
            # 网关细化
            if kind == 'gateway':
                gw = node.meta.get('gw_kind', '')
                if gw in ('for', 'par', 'fork', 'join'):
                    kind = f'gateway_{gw}'
            # Delay 节点类型标记
            if node.type == 'delay' or node.meta.get('is_delay_node'):
                kind = 'delay'
            # 动作 / 模块覆盖（保持原有逻辑，但注意 module_call 优先级）
            if node.module_ref:
                kind = 'module_call'
            elif node.action_name:
                kind = 'action'

            emit_step(self, step, prev_node, current, kind)

            if kind == 'end':
                print("🏁 到达 [END]")
                return current
            if kind == 'break':
                print("⛔ 到达 [BREAK]")
                return current

            # ── FOR / PAR 网关 ──
            if kind in ('gateway_for', 'gateway_par'):
                prev_node = current
                current = await self._run_for_loop(current, node, info, flow,
                                                  extra_actions, max_steps)
                print(f"[runtime] 🔄 For/Par 返回后 current = {current}")
                continue

            # ── FORK 网关（可能由 par 展开） ──
            if kind == 'gateway_fork':
                prev_node = current
                current = await self._run_fork(current, node, flow,
                                               extra_actions, max_steps)
                continue

            # ── JOIN 网关 ──
            if kind == 'gateway_join':
                prev_node = current
                current = await self._run_join(current, node, flow, extra_actions=extra_actions, max_steps=max_steps)
                continue


            # ── 统一执行节点内容（适用于 action / module_call / start / router 等） ──
            await self._execute_node_content(node, flow, extra_actions, max_steps, node_id=current)

            # ── 走边进入下一个节点 ──
            out_edges = [e for e in flow.edges if e.source == current]
            print(f"[runtime] 📤 节点 {current} 的出边: {[(e.target, e.condition) for e in out_edges]}")
            if len(out_edges) > 1:
                # 多出边 = fork 并发语义（文档：不写 fork 直接 mermaid 多分支也并行）。
                # 无条件边必走、条件边评估为真才走，各分支并发执行。
                #
                # ⚠️ 已知现状（2026-09-03 拍板留痕，本次变量系统重构不解决）：
                # 多条线【直接指向同一节点】时（mermaid 直连汇聚、无 join 语法），
                # 各分支会【独立执行该节点及其后续整条链】——汇聚节点之后的节点
                # 每个分支各跑一遍，不是"合二为一"。正确的汇合语义是显式写
                # join(all)（接收端签到合并、merge 出新 task）。直连汇聚的隐式
                # join 语义待后续版本收敛；变量侧已按显式 join 的正确语义实现
                # （几线合一 → world.merge → 新 Task，源 task 生命周期终止）。
                print(f"[runtime] 🔀 节点 {current} 有多条出边（{len(out_edges)} 条），按 fork 并发执行")
                prev_node = current
                current = await self._run_fork(current, node, flow, extra_actions, max_steps)
                continue
            next_node = self._follow_next_edge(current, flow)
            if current == '[p]':  # 特别关注 [p] 节点
                print(f"[runtime]🔍 [p] 节点的下一节点: {next_node}")
            # 【2026-09-07 二次修复】死路（无出边/条件全不成立）= 按设计正常收尾
            # （_follow_next_edge 的 warning 桶注释原文："return None → 上层正常
            # 结束"）。此处原有一个 raise 与该设计自相矛盾——分支里的死路
            # （_execute_path）早已优雅允许，唯独主链死路整场报错，双 walker
            # 双语义。现统一：死路 → _follow_next_edge 已警告一次 → 本链优雅
            # 停止（其他分支不受影响；唯一主链死路=整场正常结束）。
            prev_node = current
            current = next_node

            # 协作式调度让出：assign 等快速节点不会自然挂起，不让出会
            # 饿死并行的其他 fork 分支（多地点常驻并行线场景）。
            await asyncio.sleep(0)

        # ... 循环结束
        # 【2026-09-07 二次修复】此处不再发"没有可用的出边"警告：
        # - 真实死路（节点无出边/条件全不成立）已由 _follow_next_edge 警告
        #   一次并优雅停止（warning 桶，见上）；
        # - fork/par/join 网关处母 walk 收尾是正常机制（续跑在子协程里：
        #   fork 纯收场等子任务、join 变身由幸运者接棒）——包装协程在此
        #   结束不是断链。此前在此处对网关收尾告警，一局误报 6 次（作者
        #   被吓退），且与真正的卡死（join 环上死等，完全无声）毫无关系，
        #   纯属误导，整段退役。
        return None


        
        
        
        
    async def _execute_node_content(self, node, flow, extra_actions: dict, max_steps: int = 0, node_id: str = ""):
        """执行节点的：绑定的动作 → 绑定的模块 → extra_actions 序列"""
        print(f"[runtime] >>> _execute_node_content: node_id={node_id}, type={getattr(node, 'type', '?')}, is_delay={node.meta.get('is_delay_node', False)}")



        # 记录当前节点 ID 到线程本地的上下文，避免多线程覆盖
        ctx = current_task_ctx()
        if ctx:
            ctx.current_node_id = node_id
        # 0. 处理节点 prompt（视作人类发言）
        if hasattr(node, 'prompt') and node.prompt:
            prompt_text = self.evaluator.interpolate_prompt(
                node.prompt, ctx.facade if ctx else None)
            if prompt_text:
                from .save_dialog import save_human_turn
                meta_owner = self.script.meta.get('owner', [])
                femo_id = self.script.meta.get('id', 'unknown')
                actor_info = {'user': f'femo-{femo_id}'}
                # 尝试获取节点绑定的 action 的 scope（2026-08-31 起空 scope=all、
                # self 由 _build_scope 判定，统一走 _raw_scope_for；节点无绑定
                # action 时保持空 → _build_scope 兜底注入 femo-id+owner）
                action_scope = ([], [])
                ad = None
                if node.action_name:
                    ad = extra_actions.get(node.action_name) if extra_actions else None
                    if not ad:
                        ad = self.script.actions.get(node.action_name)
                    if ad:
                        action_scope = self._raw_scope_for(ad)
                turn_id, oratio_idx = self._update_speaker('node')
                print(f"[DEBUG node_prompt] actor_info={actor_info}, meta_owner={meta_owner}, femo_id={self.script.meta.get('id', 'unknown')}")
                event = save_human_turn(
                    session_id=self._current_session_id,
                    turn_id=turn_id,
                    oratio_idx=oratio_idx,
                    user_input=prompt_text,
                    actor_info=actor_info,
                    meta_owner=meta_owner,
                    action_scope=action_scope,
                    is_node_prompt=True,
                    femo_id=self.script.meta.get('id', 'unknown'),
                    raw_action_scope=(ad.scope if ad and ad.scope else None),
                )
                if event:
                    event.wait()
                print(f"[runtime]📄 节点 prompt 已存入: turn={turn_id}, oratio={oratio_idx}")
        elif self.speaker["current"] == 'ai':
            # 节点无 prompt 但当前为 AI 状态，step_idx 递增（作为内部步骤）
            self._step_idx += 1

        # 1. 执行节点绑定的动作
        if node.action_name:
            ad = extra_actions.get(node.action_name) if extra_actions else None
            if not ad:
                ad = self.script.actions.get(node.action_name)
            if ad:
                print(f"[runtime]⚡ 节点动作: {node.action_name}")
                # 保存当前节点名，供 AI 暂停时使用
                self._current_node_id = node.node_id if hasattr(node, 'node_id') else ''
                await self._exec_action_def(ad)
            else:
                # 【2026-09-07 warning 桶】动作未定义=节点空过（不阻断流程），
                # 但剧情线大概率缺了一环——作者应当知情。
                print(f"[runtime]⚠️ 动作未定义: {node.action_name}")
                self.errors.warn(
                    f"动作未定义: {node.action_name}（节点 {node_id} 空过，流程继续）",
                    node_id=str(node_id))

        # 2. 执行节点绑定的模块
        if node.module_ref:
            print(f"[runtime]📦 节点模块: &{node.module_ref}, caller_node_id={node_id!r}")
            await self._run_module(node.module_ref, caller_node_id=node_id)


    # ══════════════════════════════════════════════════
    #  FOR 循环执行
    # ══════════════════════════════════════════════════

    async def _run_for_loop(self, gateway_id: str, node, info: dict,
                            flow, extra_actions: dict, max_steps: int) -> Optional[str]:
        """执行 for 循环（串行），返回循环后的下一个节点 ID。
        R2：循环变量写入循环帧（D5——生命周期=循环，join 收口 skip 豁免）；
        迭代器/条件求值走 Evaluator；range 兼容对齐 par（旧 for 缺此兼容导致
        for i in range(1,100) 空转——行为变化清单 §5）。"""
        var_name = info.get('var_name', '')
        iterable_expr = info.get('iterable', '')
        ctx = current_task_ctx()
        if ctx is None:
            raise FEMOVariableError("for 循环执行需要 TaskContext（协程未绑执行上下文）")
        facade = ctx.facade
        iterable = self.evaluator.evaluate_iterable(iterable_expr, facade)
        if isinstance(iterable, range):
            iterable = list(iterable)
        if not isinstance(iterable, (list, tuple)):
            # 【2026-09-07 warning 桶】迭代器不是列表=循环体零执行直接穿出
            # （不阻断），多半是变量没按列表声明/赋值——作者应当知情。
            print(f"[runtime]⚠️ 迭代器 '{iterable_expr}' 不是列表: {iterable}")
            self.errors.warn(
                f"for 迭代器 '{iterable_expr}' 不是列表（实际 {type(iterable).__name__}），"
                "循环体零执行直接穿出",
                node_id=str(gateway_id))
            iterable = []

        all_out_edges = [e for e in flow.edges if e.source == gateway_id]
        has_conditional = any(e.condition for e in all_out_edges)
        loop_entries = []
        exit_edge = None
        if has_conditional:
            for e in all_out_edges:
                if e.condition:
                    loop_entries.append(e)
                else:
                    if exit_edge is not None:
                        raise ValueError(
                            f"For 循环节点 {gateway_id} 存在多条出口边: {exit_edge.target} 和 {e.target}"
                        )
                    exit_edge = e
        else:
            # 无条件边：第一条循环体入口、（若有）第二条循环出口——解析器保证
            # 注册顺序（for 块体内链先、块后出口行后）
            if len(all_out_edges) > 2:
                raise ValueError(
                    f"For 循环节点 {gateway_id} 存在多条无条件出边 "
                    f"({[e.target for e in all_out_edges]})：至多一条循环体入口 + 一条出口。"
                )
            loop_entries.append(all_out_edges[0])
            if len(all_out_edges) == 2:
                exit_edge = all_out_edges[1]
        if not loop_entries:
            raise ValueError(
                f"For 循环节点 {gateway_id} 没有任何循环体入口边。"
                f"请检查 flow 中 for 循环的写法，确保循环体内部有节点。"
            )

        # 循环体内节点到其后继节点的边映射（不经过回边）
        edge_map = {}
        for e in flow.edges:
            if e.source != gateway_id:
                edge_map.setdefault(e.source, []).append(e)

        # 循环帧（D5）：push/收口 pop 放 finally（break/return/异常都平衡）；
        # _skip_frames 以引用同步给 join 协调器（拍板 1：循环帧豁免 merge）
        facade.push_loop_frame(gateway_id)
        self._skip_frames.add(gateway_id)
        if not len(iterable):
            # 【2026-09-06 探针】空迭代=循环体零执行直接穿出——恢复场景下
            # 迭代器变量若未被快照正确恢复，就会表现为"秒跑完"。
            print(f"[resume-diag] ⚠️ for '{iterable_expr}' 求值为空——循环体零执行直接穿出")
        try:
            for i, item in enumerate(iterable):
                if var_name:
                    facade.set_loop_var(gateway_id, var_name, item)
                    ctx.current_loop_var = var_name
                print(f"[runtime]🔄 For: {var_name} = {item} ({i+1}/{len(iterable)})")

                # 重新评估条件，找到匹配的入口边
                target_node = None
                for e in loop_entries:
                    if not e.condition or self.evaluator.evaluate_condition(e.condition, facade):
                        target_node = e.target
                        break
                if target_node is None:
                    print(f"[runtime]⏭️ For: 无匹配条件，跳过本轮")
                    continue

                current = target_node
                while current and current != gateway_id:
                    # 分层步数检查（模块帧栈顶逐层计数；无模块帧→全局步数）
                    if ctx.module_frames:
                        mf = ctx.module_frames[-1]
                        if mf.max_steps > 0 and mf.step >= mf.max_steps:
                            print(f"[runtime]⚠️ 模块 '{mf.name}' 达到最大步数 {mf.max_steps}")
                            break
                        mf.step += 1
                    else:
                        if self.global_max_steps > 0 and self.global_step >= self.global_max_steps:
                            print(f"[runtime]⚠️ 主流程达到最大步数 {self.global_max_steps}")
                            break
                        self.global_step += 1

                    node_obj = flow.nodes.get(current)
                    if node_obj:
                        await self._execute_node_content(node_obj, flow, extra_actions, 0, node_id=current)

                    # 找下一个节点：有回边立即结束本轮循环体
                    next_candidates = []
                    has_back_edge = False
                    for e in edge_map.get(current, []):
                        if e.target == gateway_id:
                            has_back_edge = True
                        else:
                            next_candidates.append(e)
                    if has_back_edge:
                        break
                    if not next_candidates:
                        break

                    next_target = None
                    for e in next_candidates:
                        if e.condition and self.evaluator.evaluate_condition(e.condition, facade):
                            next_target = e.target
                            break
                    if next_target is None:
                        next_target = next_candidates[0].target
                    current = next_target
        finally:
            facade.pop_loop_frame(gateway_id)
            self._skip_frames.discard(gateway_id)

        print(f"[runtime]🔄 For: 迭代完毕，退出")
        if exit_edge:
            print(f"[runtime]   For 返回出口节点: {exit_edge.target}")
            return exit_edge.target
        if loop_entries:
            # 无显式出口行：从入口顺藤摸瓜找到不在循环体内的下一个节点（原逻辑）
            visited = set()
            queue = [loop_entries[0].target]
            while queue:
                cur = queue.pop(0)
                if cur in visited:
                    continue
                visited.add(cur)
                if cur == gateway_id:
                    continue
                for e in flow.edges:
                    if e.source == cur and e.target != gateway_id:
                        queue.append(e.target)
            for e in flow.edges:
                if e.source in [le.target for le in loop_entries] and e.target != gateway_id:
                    has_back = any(be.source == e.target and be.target == gateway_id for be in flow.edges)
                    if not has_back:
                        print(f"[runtime]   For 返回顺藤摸瓜节点: {e.target}")
                        return e.target
        print(f"[runtime]   For 无出口，返回 None")
        return None

    async def _execute_path(self, flow, start: str,
                            stop_at: Set[str] = None,
                            extra_actions: dict = None,
                            max_steps: int = 0):
        current = start

        while current and current not in (stop_at or set()):
            ctx = current_task_ctx()   # 每轮重取（join 变身后指向新 task）
            # ── 分层步数检查（模块帧栈顶逐层计数；无模块帧→全局步数）──
            if ctx is not None and ctx.module_frames:
                mf = ctx.module_frames[-1]
                if mf.max_steps > 0 and mf.step >= mf.max_steps:
                    print(f"[runtime]⚠️ 模块 '{mf.name}' 达到最大步数 {mf.max_steps}")
                    break
                mf.step += 1
            else:
                if self.global_max_steps > 0 and self.global_step >= self.global_max_steps:
                    print(f"[runtime]⚠️ 主流程达到最大步数 {self.global_max_steps}")
                    break
                self.global_step += 1

            node = flow.nodes.get(current)
            if not node:
                # 【2026-09-06 探针】静默中断点：恢复位置/后继在新图中不存在时
                # 原来直接 break——路径无声蒸发，是"秒跑完"假象的高危源头。
                print(f"[resume-diag] ⚠️ 节点 {current!r} 不在当前 flow 中——路径中断（检查断点位置/连线是否失效）")
                break

            # 节点位置检查点：进入节点前记录（键=task_id，分支直启恢复点）
            if ctx is not None:
                self._record_checkpoint(ctx, current)

            # ── 获取节点类型 ──
            kind = node.type if node.type else 'empty'
            info = node.meta
            if current == '[END]':
                kind = 'end'
            elif current == '[BREAK]':
                kind = 'break'
            if kind == 'gateway':
                gw = node.meta.get('gw_kind', '')
                if gw in ('for', 'par', 'fork', 'join'):
                    kind = f'gateway_{gw}'
            # Delay 节点类型标记
            if node.type == 'delay' or node.meta.get('is_delay_node'):
                kind = 'delay'
            if node.module_ref:
                kind = 'module_call'
            elif node.action_name:
                kind = 'action'

            if kind == 'end' or kind == 'break':
                return

            if kind in ('gateway_for', 'gateway_par'):
                current = await self._run_for_loop(current, node, info, flow,
                                                  extra_actions, max_steps)
                continue

            if kind == 'gateway_fork':
                current = await self._run_fork(current, node, flow, extra_actions, max_steps)
                continue

            if kind == 'gateway_join':
                # R3 接线（清单 D3）：分支路径到达 join 不再"直接穿过"
                # （§1.4 实锤旧语义）——统一走 join_sign_in 签到等待；
                # 返回 None = 本 task 终止（迟到者/非触发者），退出本链。
                current = await join_sign_in(self, self.world, flow, current,
                                             node, extra_actions, max_steps)
                continue

            # 统一执行节点内容
            #print(f"[runtime]_execute_path 正在执行节点: {current}, 类型: {kind}, 动作: {getattr(node, 'action_name', '')}, 模块: {getattr(node, 'module_ref', '')}")
            await self._execute_node_content(node, flow, extra_actions, max_steps, node_id=current)

            current = self._follow_next_edge(current, flow)

            # 协作式调度让出：分支（fork/par）内快速节点循环时让出事件循环，
            # 避免独占并饿死其他并行分支（多地点常驻并行线场景）。
            await asyncio.sleep(0)


    # ══════════════════════════════════════════════════
    #  FORK 执行
    # ══════════════════════════════════════════════════

    async def _run_fork(self, gateway_id: str, node, flow,
                        extra_actions: dict, max_steps: int = 0) -> Optional[str]:
        """fork 执行器（par 合流，清单 D2 三步曲——委托 task_world.fork_branches）。
        母 task 终止（变量上已不存在），N 个子 task 值副本各跑各的；gather 纯
        收场等全死（**必须保留**：不 gather 则 run_async finally 的
        engine.shutdown() 会杀掉未完分支）；join 不接（fork/join 解耦——
        分支自己跑到 join 网关签到，R3 接协调器）。"""
        print(f"[FORK] ========== 进入 fork 网关 {gateway_id} ==========")
        ctx = current_task_ctx()
        if ctx is None:
            raise FEMOVariableError("fork 执行需要 TaskContext（协程未绑执行上下文）")
        is_par = bool(node.meta.get('is_par_fork'))
        child_specs: List[ChildSpec] = []
        if is_par:
            # par 展开：每迭代一分支（range 兼容），循环帧=本 par 网关。
            # ⚠️ par 出边【不在母上下文过滤】——出边条件含循环变量
            # （如 if (@speaker.type=="ai")），母上下文里 par_var 未写入；
            # 入口选择移交分支协程（ChildSpec.select_from_gateway，
            # branch_main 在循环帧写入后于分支上下文求值——旧 par_branch 同语义）
            var_name = node.meta.get('par_var', '')
            iterable = self.evaluator.evaluate_iterable(
                node.meta.get('par_iterable', ''), ctx.facade)
            if isinstance(iterable, range):
                iterable = list(iterable)
            if not isinstance(iterable, (list, tuple)):
                raise FEMOVariableError(
                    f"par 迭代器 '{node.meta.get('par_iterable', '')}' 不是列表: {iterable!r}")
            for item in iterable:
                child_specs.append(ChildSpec(
                    select_from_gateway=gateway_id, loop_gw=gateway_id,
                    loop_var=var_name, loop_value=item))
            print(f"[FORK]   par 展开 {len(child_specs)} 分支（var={var_name}）")
        else:
            # 普通 fork：条件边过滤（母上下文求值——出边条件不含分支变量）
            branch_entries = []
            for e in flow.edges:
                if e.source != gateway_id:
                    continue
                if e.condition:
                    cond_result = self.evaluator.evaluate_condition(e.condition, ctx.facade)
                    print(f"[FORK]   边 {e.source} -> {e.target} 条件: {e.condition} 结果: {cond_result}")
                    if not cond_result:
                        continue
                else:
                    print(f"[FORK]   边 {e.source} -> {e.target} 无条件")
                branch_entries.append(e.target)
            for target in branch_entries:
                child_specs.append(ChildSpec(start_node=target))
            print(f"[FORK]   活跃分支入口: {branch_entries}")
        if not child_specs:
            # 零活跃分支：仍 register 空事件（接线约定 3，防 join(all) 死等）
            print("[FORK]   没有活跃分支（register 空事件防 join 死等）")
        tasks = fork_branches(self, self.world, ctx, flow, gateway_id,
                              child_specs, extra_actions, max_steps)
        if is_par:
            # par 循环帧豁免（拍板 1，D5 的 par 侧）：par 循环帧由
            # fork_branches 构造期直接放入子 env（不走 push_loop_frame），
            # _skip_frames 在此登记——分支到 join 签到凑齐时 merge 豁免本帧
            # （循环变量各分支不同值，不制造 conflict 噪音）；gather 收场
            # 后移除（帧生命周期=分支存续期，与 for 循环帧 push/pop 对称）。
            self._skip_frames.add(gateway_id)
        print(f"[FORK]   等待 {len(tasks)} 分支全部完成（纯收场，不连接 join）")
        try:
            await asyncio.gather(*tasks, return_exceptions=True)
        finally:
            if is_par:
                self._skip_frames.discard(gateway_id)
        # 编译器原则：分支有错必须上报，不能静默 flow_done（branch_main 已收集）
        if self._fork_errors:
            detail = "; ".join(f"[{name}] {err}" for name, err in self._fork_errors)
            self._fork_errors = []
            raise FEMOVariableError(f"fork 分支执行失败: {detail}")
        return None

    # ══════════════════════════════════════════════════
    #  Actor 类型查询
    # ══════════════════════════════════════════════════

    def _get_actor_type(self, actor_ref: str) -> Optional[str]:
        """根据 @xxx 引用查找 actor 类型，返回 'ai'/'human' 或 None"""
        if not isinstance(actor_ref, str) or not actor_ref.startswith('@'):
            return None
        name = actor_ref
        if name in self.script.actors:
            return self.script.actors[name].type.value
        return None

    # ══════════════════════════════════════════════════
    #  模块执行 — 使用 _execute_flow
    # ══════════════════════════════════════════════════

    async def _run_module(self, mod_name: str, caller_node_id: str = "", args: list = None, max_steps: int = 0):
        """执行子流程 Module（清单 D4：模块帧，不是 task——两维度正交的
        运行期落地；嵌套 mod_path 沿定义链由内向外解析（兄弟互调可见，词法，
        拍板 6 同构）；模块参数调用点 args 入帧，无 args 回退同名可见[拍板
        8③]）。"""
        ctx = current_task_ctx()
        if ctx is None:
            raise FEMOVariableError(f"模块 '{mod_name}' 执行需要 TaskContext（协程未绑执行上下文）")
        facade = ctx.facade

        # ── 嵌套模块 mod_path 解析（正确性关键：帧键与 ScopeTable owner 一致）──
        raw = (mod_name or '').strip()
        # 拆参与编译期共用 parser 的 _split_module_ref（单一事实源）：模块名
        # 允许点路径，'Outer.Inner(x)' → ('Outer.Inner', 'x')——此前运行时
        # 自带 \w+ 拆参正则不认 '.'，点路径带参会整串被当模块名查找而炸。
        clean_name, args_str = _split_module_ref(raw)
        mod_def = None
        mod_path = clean_name
        if ctx.module_frames and '.' not in clean_name:
            # 嵌套引用沿定义链由内向外解析（词法，拍板 6 的模块名侧）：自己
            # 的孩子 → 母层的孩子（=兄弟互调）→ … → 顶层。命中层的完整点
            # 路径作 mod_path——帧键/ScopeTable owner/词法链 action 合并全部
            # 只依赖它，checkpoint 续跑天然一致。内外同名时内层（更近祖先）
            # 胜出，与既有「子模块遮蔽顶层同名」行为一致。
            segs = ctx.module_frames[-1].name.split('.')
            for depth in range(len(segs), 0, -1):
                anc_path = '.'.join(segs[:depth])
                anc = self._resolve_module_def(anc_path)
                sub = (anc.modules or {}).get(clean_name)
                if sub is not None:
                    mod_def = sub
                    mod_path = f"{anc_path}.{clean_name}"
                    break
        if mod_def is None:
            mod_def = self.script.modules.get(clean_name)
        if mod_def is None and '.' in clean_name:
            # 顶层点路径（'Outer.Inner'）：主流程直引嵌套模块 / 调试器模块
            # 单测 wrapper 的进场通道（2026-09-12）——沿路径逐段下钻。帧键
            # 与 ScopeTable owner 同为完整点路径，module_initials/enter_module
            # 天然一致。
            mod_def = self._resolve_module_def(clean_name)
        if mod_def is None:
            # 编译期 validate_flow_refs 已拦截未声明的 module_ref——运行期
            # 再遇即流程装配不一致。原 print+return 会静默假跑：流程照常走完
            # 报 completed，模块一个节点都没执行（2026-09-12 收掉）。
            raise FEMOVariableError(
                f"模块 '{mod_name}' 未定义（运行期解析失败；编译期校验应已拦截，"
                f"此处出现即流程装配不一致，请检查 module_ref 拼写/模块是否已声明）")
        mod_meta = getattr(mod_def, 'meta', None) or {}
        mod_max_steps = mod_meta.get('max_steps', 0)

        # ── 模块参数通道（拍板 8③）：调用点 args 按位置对应形参求值入帧；
        # 无 args 的形参回退同名可见（旧"全局同名巧合"的兼容收编）──
        # ⚠️ R4 补（清单 §4.1 原文：initials = 调用点 args 求值结果 +
        # table.module_initials(mod_path)）：模块 vars: 声明的 local 初值必须
        # 一并入帧——R2 接线时漏了 module_initials，模块帧为空，模块内读写
        # 声明变量报"已声明但当前 task 中无值"（分支静默死亡、checkpoint 停
        # 在原节点的实锤场景=tests/test_v2_resume_e2e.py 模块内 assign）。
        # args 显式传参覆盖同名初值；不声明局部变量的模块 module_initials={}
        # → 零变化。
        call_initials: Dict[str, Any] = dict(self.world.table.module_initials(mod_path))
        params = list(getattr(mod_def, 'params', []) or [])
        if args_str and args_str.strip():
            act_args = [a.strip() for a in Evaluator._split_items(args_str) if a.strip()]
            if len(act_args) > len(params):
                raise FEMOVariableError(
                    f"模块 {mod_path} 调用实参数量（{len(act_args)}）超过形参数量（{len(params)}）")
            for pname, aexpr in zip(params, act_args):
                call_initials[pname] = self.evaluator.evaluate(aexpr, facade, strict=False)
        for p in params:
            if p not in call_initials and facade.has(p):
                call_initials[p] = facade.get(p)

        # ★ 前端信号：进入模块
        print(f"[runtime]📡 >>> 发送 module_enter: module_name={mod_path!r}, caller_node={caller_node_id!r}")
        self._emit_event('module_enter', {'module_name': mod_path, 'caller_node': caller_node_id})
        facade.enter_module(mod_path, call_initials)   # push 帧（模块 local+参数；$ 初值防御性跳过）
        ctx.module_frames.append(ModuleFrame(name=mod_path, step=0,
                                             max_steps=mod_max_steps,
                                             caller_node_id=caller_node_id))
        try:
            print(f"[runtime]📦 进入子流程: &{mod_path}")
            if mod_def.flow:
                extra_actions = self._chain_actions_for(mod_path)
                final_node = await self._execute_flow(mod_def.flow,
                                                      stop_at={'[OUT]'},
                                                      extra_actions=extra_actions)
                if final_node is not None and final_node not in ('[OUT]', '[BREAK]'):
                    raise FEMOVariableError(
                        f"模块 {mod_path} 异常终止于节点 {final_node}，预期应到达 [OUT] 或 [BREAK]。")
            print(f"[runtime]📦 退出子流程: &{mod_path}")
        finally:
            ctx.module_frames.pop()
            facade.exit_module()      # pop + 清帧：模块 local 出模块即清（宪法 1.2）
        # ★ 前端信号：退出模块
        print(f"[runtime]📡 <<< 发送 module_exit: module_name={mod_path!r}")
        self._emit_event('module_exit', {'module_name': mod_path})

    # ══════════════════════════════════════════════════
    #  Action 执行调度
    # ══════════════════════════════════════════════════

    def exec_action(self, action_name: str, local_vars: dict = None) -> Any:
        """执行一个 action（从全局 actions 查找）"""
        ad = self.script.actions.get(action_name)
        if ad is None:
            raise KeyError(f"Action '{action_name}' 未找到")
        return self._exec_action_def(ad)

    async def _exec_action_def(self, ad) -> Any:
        """执行已找到的 action 定义，统一调度"""
        etype = str(ad.executor_type).split('.')[-1].lower() if ad.executor_type else ''
        eparam = ad.executor_param or ''

        print(f"[runtime]{'='*40}")
        print(f"[runtime]⚡ 执行 action (@{etype}({eparam}))")
        print(f"[runtime]{'='*40}")

        if etype == 'func': return await self._exec_func(ad, eparam)
        elif etype == 'assign': return self._exec_assign(ad)  # assign 是同步的，暂不 await
        elif etype == 'ai': return await self._exec_ai(ad, eparam)
        elif etype == 'human': return await self._exec_human(ad, eparam)
        elif etype == 'mind': return await self._exec_mind(ad, eparam)
        elif etype == 'notice': return await self._exec_notice(ad, eparam)
        else:
            print(f"[runtime]⚠️  未支持的执行类型: @{etype}")
            return None

    # ══════════════════════════════════════════════════
    #  @func 处理
    # ══════════════════════════════════════════════════

    async def _exec_func(self, ad, eparam: str) -> Any:
        import inspect
        # ── 发送 node_start 事件 ──
        self._emit_event('node_start', {
            'node_name': self._get_current_node_id(),
            'node_type': 'func',
        })
        print(f"[DEBUG _exec_func] 发送 node_start 事件：{ad.name}")
        kwargs = {}
        #print(f"[runtime]_exec_func: action={ad.name}, in_mappings={[(im.local_name, im.global_expr) for im in ad.in_mappings]}")
        ctx = current_task_ctx()
        facade = ctx.facade if ctx is not None else None
        if ad.in_mappings:
            for im in ad.in_mappings:
                # 统一走 Evaluator（路径/动态键/@引用全收敛，清单 D7）
                val = self.evaluator.evaluate(im.global_expr, facade, strict=False)
                print(f"[runtime]📥 in: {im.local_name} = {val!r}")
                kwargs[im.local_name] = val
        else:
            # 自动推断：Python 函数参数名 == 剧本变量名（文档 §21：参数名与 vars
            # 变量名一致）。不给任何剧本做硬编码别名兜底（2026-09-02 拍板删除）；
            # 无对应变量且有默认值 → 用默认值；无默认值 → 响亮报错（原为 print
            # 警告后继续、下游 TypeError，现统一 fail loud）。
            parts = eparam.split('.', 1)
            if len(parts) == 2:
                mod_name, func_name = parts
                mod = self.bridge.modules.get(mod_name)
                if mod and hasattr(mod, func_name):
                    func = getattr(mod, func_name)
                    sig = inspect.signature(func)
                    for param_name, param in sig.parameters.items():
                        if param_name in ('self', 'cls'): continue
                        if facade.has(param_name):
                            val = facade.get(param_name)
                            kwargs[param_name] = val
                            print(f"[runtime]📥 in(auto): {param_name} = {val!r}")
                        elif param.default is not inspect.Parameter.empty:
                            pass
                        else:
                            raise FEMOVariableError(
                                f"in(auto): 参数 '{param_name}' 无对应变量且无默认值。"
                                f"请在 action 的 in: 中显式映射，或将 Python 参数名对齐 vars: 声明。"
                            )

        print(f"[runtime]📞 调用 {eparam}(**kwargs)")
        try:
            result = await self.engine.run_in_thread(self.bridge.call, eparam, **kwargs)
            print(f"[runtime]✅ 函数 {eparam} 执行成功，返回值: {result!r}")
        except Exception as e:
            self._emit_event('flow_error', {'error': str(e)})
            print(f"[runtime]❌ 函数 {eparam} 执行失败: {e}")
            raise

        # Out 写回
        if ad.outs and result is not None:
            self._apply_outs(ad, result)

        # ── 发送 func 结果事件 ──
        func_output = {}
        for od in ad.outs:
            var_name = getattr(od, 'global_name', None) or getattr(od, 'var_name', '')
            if var_name:
                try:
                    func_output[var_name] = facade.get(var_name)
                except Exception:
                    pass
        self._emit_event('func_result', {
            'node_name': self._get_current_node_id(),
            'input': kwargs,
            'output': func_output if func_output else repr(result),
        })
        print(f"[DEBUG _exec_func] 发送 func_result 事件：{ad.name}, output={func_output}")

        return result

    # ══════════════════════════════════════════════════
    #  @assign 处理
    # ══════════════════════════════════════════════════
    def _exec_assign(self, ad) -> Any:
        print(f"[runtime]📝 Assign Action: {ad.name}")
        # ── 发送 node_start 事件 ──
        self._emit_event('node_start', {
            'node_name': self._get_current_node_id(),
            'node_type': 'assign',
        })
        ctx = current_task_ctx()
        facade = ctx.facade if ctx is not None else None
        assign_input = {}   # 每条赋值实际喂入的值（RHS 求值结果/增量/add-remove 项）——气泡 In 面板用
        for i, od in enumerate(ad.outs):
            print(f"[runtime][DEBUG ASSIGN] out[{i}]: var_name={od.var_name!r}")
        for od in ad.outs:
            expr = od.var_name
            print(f"[runtime][DEBUG ASSIGN] 处理表达式: {expr!r}")

            # 匹配: path = value / path += N / path -= N / path = add(x) / path = remove(x)
            # （VAR_NAME_RE：含 $ shared / @ actor 变量 / 中文——拍板 8④）
            m = re.match(r'^(' + VAR_NAME_RE + r')\s*([+\-]?=)\s*(.+)$', expr)
            if not m:
                raise FEMOVariableError(
                    f"@assign 无法解析表达式: {expr!r}。"
                    f"请使用 'var = value', 'var += N', 'var -= N' 等格式。"
                )
            path = m.group(1)
            op_str = m.group(2)   # '=', '+=', '-='
            right_raw = m.group(3).strip()

            # 检查变量是否声明
            if facade is None or not facade.has(path):
                raise FEMOVariableError(
                    f"@assign 错误：变量 '{path}' 未声明。"
                    f"所有变量必须在 vars: 中预先声明。"
                )

            # 解析右侧值：引号字符串去引号，数字直接转，其他当作变量求值（Evaluator）
            right_val = self.evaluator.eval_right_value(right_raw, facade)

            # 根据运算符构造 intent 并执行
            if op_str == '+=':
                if not isinstance(right_val, (int, float)):
                    raise FEMOVariableError(f"@assign += 右侧需要数字，得到: {right_val!r}")
                intent = ('increment', right_val)
            elif op_str == '-=':
                if not isinstance(right_val, (int, float)):
                    raise FEMOVariableError(f"@assign -= 右侧需要数字，得到: {right_val!r}")
                intent = ('increment', -right_val)
            elif op_str == '=':
                # 检查是否是 add() / remove() 形式
                add_m = re.match(r'^add\((.+)\)$', right_raw)
                if add_m:
                    item = self.evaluator.eval_right_value(add_m.group(1).strip(), facade)
                    intent = ('add', item)
                else:
                    rem_m = re.match(r'^remove\((.+)\)$', right_raw)
                    if rem_m:
                        item = self.evaluator.eval_right_value(rem_m.group(1).strip(), facade)
                        intent = ('remove', item)
                    else:
                        intent = ('set', right_val)
            else:
                raise FEMOVariableError(f"@assign 不支持的运算符: {op_str!r}")

            assign_input[path] = intent[1]

            try:
                facade.apply_intent(path, intent)
            except Exception as e:
                raise FEMOVariableError(f"@assign 执行失败：{path} <- {right_val!r}，错误: {e}")

            print(f"[runtime][DEBUG ASSIGN] 赋值后 {path} = {facade.get(path)}")

        # ── 发送 assign 结果事件 ──
        assign_output = {}
        for od in ad.outs:
            expr = od.var_name
            m = re.match(r'^(' + VAR_NAME_RE + r')\s*[+\-]?=\s*(.+)$', expr)
            if m:
                var_path = m.group(1)
                try:
                    assign_output[var_path] = facade.get(var_path)
                except Exception:
                    pass
        self._emit_event('assign_result', {
            'node_name': self._get_current_node_id(),
            'input': assign_input,
            'output': assign_output,
        })

        return None

    async def handle_error(self, error: Exception, node_id: str = '') -> ErrorCategory:
        """统一错误处理入口（薄壳，2026-09-05 重构——裁决下沉 ErrorDispatcher）。

        全库零调用点（v4 §3.4 实锤），保留签名/返回类型兼容既有约定；
        行为=dispatch 归桶发信号（FATAL→notify_author / AGENT→node_retry）
        后映射回 ErrorCategory。执行者输出类错误（AI 赋值违规）不走这里——
        它们由 _exec_ai/_exec_human 直接调 self.errors.dispatch（errors 通道）。"""
        verdict = self.errors.dispatch(error, node_id)
        return {
            VERDICT_FATAL: ErrorCategory.FATAL,
            VERDICT_RETRY: ErrorCategory.AGENT,
            VERDICT_EXHAUSTED: ErrorCategory.AGENT,
            VERDICT_TOLERANT: ErrorCategory.TOLERANT,
        }[verdict]

    # ═══ R2/R3 施工补丁（2026-09-04）：_invoke_ai_llm 从「FEMO_runtime - 重构前副本.py」
    # ═══ 2451-2559 原样搬回——R2 换变量子系统时此方法随旧代码脱落，但 _exec_ai 1942 行
    # ═══ 调用点仍在（施工中间态），AI 节点会 AttributeError。依赖核查：_resolve_ai_source/
    # ═══ _resolve_actor_def/_resolve_ai_model/_emit_event/_llm_stop_event/engine.* 均在，
    # ═══ _host_ai_backend 由 femo_bridge.py 注入，与本文件无关。actor_thinking 传递
    # ═══ 随方法恢复（宿主侧重连三层优先级的第一层重新接通）。
    async def _invoke_ai_llm(self, blocks: dict, ad, eparam: str, actor_info: dict, scope_info: list,
                             _current_node_id: str, ai_name: str = '', wait_key: str = '',
                             emit_request: bool = True) -> str:
        """调用一次 LLM（宿主子代理后端 or 直连），返回最终回复文本。
        AI 输出容错重试的每一轮都走这里。
        ai_name：执行者演员名（_exec_ai 三级解析结果），随 ai_request 传给
        宿主——每个请求自带身份（2026-08-28 Par 并发修复）：par 循环体各分支
        node id 相同而演员不同，宿主旧取法（按 node_id 键控的共享映射）会被
        后到分支覆盖，speaker 行写上另一分支的演员名。
        wait_key/emit_request（2026-09-05 重构，施工清单 v4 §4⑤）：宿主后端分支
        专用——wait_key 由 _exec_ai 循环外一次生成，全部重试轮共用（宿主
        steer 后经同一 wait_key 回传）；emit_request=False 的重试轮不重发
        ai_request（重发会 spawn 新子代理，steer 链路断裂）。缺省时旧行为
        自生成 wait_key 并照常发 ai_request（兼容缺省调用方）。直连分支无视
        两参，逐字不动。"""
        def stream_cb(token):
            self._emit_event('ai_token', {
                'node_name': _current_node_id,
                'token': token
            })

        # 创建停止信号并保存引用
        self._llm_stop_event = threading.Event()

        # ★ 按 provider 限流，防止 429
        provider = self._resolve_ai_source(ad, eparam)
        await self.engine.throttle_llm(provider)

        # ── 宿主子代理后端（宿主提供 LLM 执行；引擎无 LLM 直连）──
        if getattr(self, '_host_ai_backend', False):
            # wait_key：_exec_ai 循环外一次生成全轮共用（v4 §4⑤）；缺省时旧行为自生成。
            if wait_key:
                host_wait_key = wait_key
            else:
                # 缺省兜底生成点同样带 run_tag 世代前缀（§5.6 三处同改）
                host_wait_key = f"{self._run_tag}ai_{_current_node_id}_{getattr(self, '_ai_request_counter', 0)}"
                self._ai_request_counter = getattr(self, '_ai_request_counter', 0) + 1
            # 角色级工具开关：actor 声明 tools: true/false 时带上布尔值，
            # tools: [..] 列表作为白名单；均未声明时 actor_tools=None，
            # 由宿主按其默认决定（缺省应恢复"可用工具"）。
            actor_tools: Optional[bool] = None
            actor_tool_list: List[str] = []
            actor_thinking = ''
            adef = self._resolve_actor_def(ad, eparam)
            actor_source = ''
            if adef is not None:
                actor_tools = getattr(adef, 'tools_enabled', None)
                actor_tool_list = list(getattr(adef, 'tools', None) or [])
                actor_source = str(getattr(adef, 'source', None) or '').strip()
                # actor 的 thinking 档位（None=剧本未声明 → 宿主剥离继承 effort，
                # 落到部署默认档位；声明了就按写的走，宿主注入对应 effort）
                actor_thinking = str(getattr(adef, 'thinking', None) or '').strip()
            if emit_request:
                self._emit_event('ai_request', {
                    'wait_key': host_wait_key,
                    'node_name': _current_node_id,
                    'ai_name': ai_name or '',
                    'blocks': blocks,
                    'actor_info': actor_info,
                    # source：剧本 actor 声明的模型（裸 id 或 provider/model），宿主据此选模型
                    'source': actor_source,
                    'scope': str(ad.scope) if getattr(ad, 'scope', None) else '',
                    'scope_info': scope_info,
                    'actor_tools': actor_tools,
                    'actor_tool_list': actor_tool_list,
                    'actor_thinking': actor_thinking,
                })
                # 分身调试（2026-08-31 首演空台词事故取证）：引擎侧视角落文件
                try:
                    import os as _os
                    import datetime as _dt
                    with open(_os.path.join('user_data', 'debug-main-actor.log'), 'a', encoding='utf-8') as _f:
                        _f.write(f"[{_dt.datetime.now().isoformat()}] [引擎] ai_request 已发出: node={_current_node_id} source={actor_source!r} wait_key={host_wait_key}\n")
                except Exception:
                    pass
            host_result = await self.engine.human_input.wait_for_input(host_wait_key, timeout=3600)
            if isinstance(host_result, dict) and host_result.get('__actor_failed__'):
                # 宿主执行体最终失败（B5 执行失败信号）：执行者已不在场——不打回
                # （node_retry 无接收者=挂等）、不重等同一 wait_key（无人应答）。
                # 上抛专用异常，由 _exec_ai 按「沉默收场」裁决（见 except 分支）。
                raise FEMOActorExecutionError(
                    str(host_result.get('kind') or ''),
                    str(host_result.get('detail') or ''))
            # 分身调试：等待返回的原始结果（截断 200 字）
            try:
                import os as _os
                import datetime as _dt
                with open(_os.path.join('user_data', 'debug-main-actor.log'), 'a', encoding='utf-8') as _f:
                    _f.write(f"[{_dt.datetime.now().isoformat()}] [引擎] wait 返回: {str(host_result)[:200]}\n")
            except Exception:
                pass
            # host 负责：启动子 agent、组装完整轨迹（思考链[仅工具轮]+回复+工具结果）。
            # 引擎在这里只取最终回复（用于继续流程/事件），轨迹全文走 save_ai_turn 落库。
            if isinstance(host_result, dict):
                # 转写分离（2026-08-29）：宿主按 TranscriptStep 契约回传结构化
                # 转写（生料契约见 femoCompiler/protocol.py——tool_calls/
                # tool_results 结构化，[TOOL CALL #N] 模板由引擎在这里套用），
                # 引擎逐 step 落库——cot/tool_call/tool_result 各归各位，
                # response 只存该轮发言。旧 payload（成品字符串）兼容透传。
                self._host_steps = normalize_transcript_steps(host_result.get('steps'))
                if not self._host_steps and host_result.get('trajectory'):
                    # 兜底：旧宿主 payload 无 steps 时把整段轨迹当单行（历史形态）
                    self._host_steps = [{'step': 0, 'cot': '', 'reply': host_result.get('trajectory') or '',
                                        'toolCall': '', 'toolResult': ''}]
                # 待办⑨：宿主回传的实际响应模型（provider/model），落库用；
                # main 节点在 save_ai_finish 处固定 'main'，不吃此值。
                self._host_model_id = str(host_result.get('model_id') or '')
                return host_result.get('output') or ''
            else:
                self._host_steps = []
                self._host_model_id = ''
                return host_result or ''
        else:
            # 直连模式（无宿主）：函数级 import 保持局部作用域，勿上移
            _adef_direct = self._resolve_actor_def(ad, eparam)
            if _adef_direct is not None and str(getattr(_adef_direct, 'source', None) or '').strip() == 'main':
                raise FEMOConfigError(
                    "source:main 需要宿主代答（主模型分身调用），直连模式不支持。"
                )
            from femoBridges.llmBridge import call_ai_with_blocks
            return await self.engine.run_in_thread(
                call_ai_with_blocks,
                blocks,
                stream_callback=stream_cb,
                stop_event=self._llm_stop_event,
                user_api_key=getattr(self, 'user_api_key', None),
                user_api_provider=getattr(self, 'user_api_provider', None),
                user_api_url=getattr(self, 'user_api_url', None),
                # 直连模式：source 声明了模型则覆盖配置默认模型
                model=self._resolve_ai_model(ad, eparam),
            )

    def _extract_ai_assignments(self, llm_output: str, out_whitelist: Optional[set] = None) -> tuple:
        """提取 AI 输出中的 SET VARIABLE 赋值。
        返回 (SET_VARIABLE 列表, assign_errors 列表)：
        - 解析/赋值失败（未声明变量、不在 out 白名单等）→ assign_errors（触发重试）
        - 格式类失败 → SET_VARIABLE（宽容路径，交给 resolve/丢弃）
        out_whitelist：本节点 out 声明的变量名集合；非 None 时 AI 只能赋值其中
        的变量（防幻觉乱赋值），其余报 FEMOVariableError 走重试。"""
        all_matches = re.findall(
            r'(?:SET\s+VARIABLE|设定变量)\s*[:：]\s*(?:<<|《|〈|《《)\s*(.+?)(?:>>|》|〉|》》)',
            llm_output
        )
        SET_VARIABLE = []
        assign_errors = []
        ctx = current_task_ctx()
        facade = ctx.facade if ctx is not None else None
        for match in all_matches:
            try:
                var_name, expr = self._parse_single_assignment(match.strip())
                # out 白名单：AI 只能赋值本节点 out 声明的变量（防幻觉乱赋值）。
                if out_whitelist is not None and var_name not in out_whitelist:
                    raise FEMOVariableError(
                        f"变量 '{var_name}' 不在本节点的 out 声明范围内（out 只声明了: "
                        f"{', '.join(sorted(out_whitelist)) if out_whitelist else '无'}）。"
                        f"AI 只能赋值 out 中声明的变量。"
                    )
                intent = parse_assign_syntax(expr, var_name)
                op, val = intent
                if op in ('set', 'add', 'remove') and isinstance(val, str):
                    val = self.evaluator.evaluate(val, facade, strict=False)
                intent = (op, val)
                facade.apply_intent(var_name, intent)
                print(f"[runtime]📤 AI赋值: {var_name} {intent}")
            except FEMOVariableError as e:
                print(f"[runtime]⚠️ AI 赋值变量错误: {match!r}, error={e}")
                assign_errors.append(str(e))
            except Exception as e:
                print(f"[runtime]解析失败详情: match={match!r}, error={e}")
                SET_VARIABLE.append(match.strip())
        return SET_VARIABLE, assign_errors

    async def _exec_ai(self, ad, eparam: str) -> Any:
        self._check_cancel()
        if not eparam and not ad.as_actor:
            print(f"[runtime]🤖 AI Action（无身份信息，将调用裸 AI）")
        else:
            print(f"[runtime]🤖 AI Action")

        ctx = current_task_ctx()
        facade = ctx.facade if ctx is not None else None
        prompt = self.evaluator.interpolate_prompt(
            str(ad.prompt or ""), facade, in_mappings=ad.in_mappings)
        if prompt is None:
            raise FEMOVariableError(f"AI Action '{ad.name}' 的 prompt 替换后变为 None，请检查 prompt 中的变量引用是否正确。")
        if not isinstance(prompt, str):
            prompt = str(prompt)


        # ── 发送 node_start 事件（必须在任何可能阻塞的操作之前）──
        # scope: self 保留字段在 _scope_info_for 内展开为[发言人演员名]。
        scope_info = self._scope_info_for(ad, eparam)
        self._emit_event('node_start', {
            'node_name': self._get_current_node_id(),
            'node_type': 'ai',
            'prompt': prompt,
            'scope': scope_info,
        })

        if ad.interrupt: print(f"[runtime]🔔 Interrupt: {ad.interrupt}")
        for od in ad.outs:
            var_name = getattr(od, 'global_name', None) or getattr(od, 'var_name', '')
            print(f"[runtime]📤 out: {var_name}")

        # ── 收集 blocks 并调用 LLM ──
        # 注意：此处不得 import llmBridge/llmProviders——其模块顶层 import requests，
        # 而宿主后端模式下系统 Python 无第三方依赖（纯标准库原则）。真正的 LLM
        # 调用在 _invoke_ai_llm 内按 _host_ai_backend 分支延迟 import（2026-08-21
        # 修复：原无条件死 import 使宿主后端模式 AI 节点必炸 No module named 'requests'）。
        from femoCompiler.block_collector import collect_blocks
        from femoBridges.ContextExample import MODE_FULL

        self._current_prompt = prompt
        # 直接传原始参数，让 _get_actor_info 上下文感知解析
        actor_info = self._get_actor_info(ad, eparam)
        turn_id_alloc = self._alloc_turn()   # 本节点独立 turn 号（par 并发安全）

        blocks = collect_blocks(
            action=ad,
            meta=self.script.meta,
            actors_def=self.script.actors,
            var_manager=facade,
            evaluator=self.evaluator,
            code_modules=self.bridge.modules,
            memory_defs=self.script.memories,
            context_defs=self.script.contexts,
            session_id=self._current_session_id,
            turn_id=turn_id_alloc,
            actor_info=actor_info,
            runner=self,
            base_dir=self.base_dir,
            # 默认上下文拼接模式：DSH 宿主后端由 femo_bridge 钉
            # first_full_then_incremental；直连等未钉的调用方=full（原行为）。
            # 剧本显式声明的自定义 context 方法不受影响（block_collector 分派）。
            context_mode=getattr(self, '_context_mode', MODE_FULL),
        )

        # ---- 存储 prompt 到 dialog ----
        from .save_dialog import save_human_turn
        meta_owner = self.script.meta.get('owner', [])
        raw_scope = self._raw_scope_for(ad)

        prompt_actor_info = {}
        if ad.as_actor and ad.as_actor in self.script.actors:
            as_def = self.script.actors[ad.as_actor]
            if as_def.type.value == 'human':
                prompt_actor_info['user'] = str(as_def.source)
        if 'user' not in prompt_actor_info and meta_owner:
            prompt_actor_info['user'] = str(meta_owner[0])

        # 本节点所有行共用 alloc 的 turn 号；oratio 按行内序（prompt=0, showprompt=1）
        turn_id, oratio_idx = turn_id_alloc, 0
        femo_id = self.script.meta.get('id', 'unknown')
        event = save_human_turn(
            session_id=self._current_session_id,
            turn_id=turn_id,
            oratio_idx=oratio_idx,
            user_input=prompt,
            actor_info=prompt_actor_info,
            meta_owner=meta_owner,
            action_scope=raw_scope,
            is_node_prompt=True,
            femo_id=femo_id,
            prompt_type='prompt',
            raw_action_scope=ad.scope,
        )
        if event:
            await self.engine.run_in_thread(event.wait)

        # showprompt 渲染提前、落库推迟（2026-08-29 合写）：show 行改与发言行
        # 同事务落库——要不然都有要不然都没有。prompt 行（幕后指令）保持节点
        # 开始落库：它是"节点启动过"的痕迹，且不属于对话流。
        showprompt_text = ''
        if ad.showprompt:
            showprompt_text = self.evaluator.interpolate_prompt(
                str(ad.showprompt), facade, in_mappings=ad.in_mappings)
        print(f"[runtime]💬 AI prompt 已存入 dialog: turn={turn_id}, oratio={oratio_idx}")

        # ── 发送上下文就绪事件 ──
        # 演员显示名双名制（2026-09-11 拍板，2026-09-12 三修定稿）：@戏中名（括号名）
        # ——@保留、不去重。括号名：有 soul id=Soul name；无 soul 时仅 model id
        # 为 main 的伪 soul 显示 'main'，其余不加括号。投影窗 speaker 标签/气泡
        # 浮层/直播帧全以此名为键，此处一处组装三端生效。原三级兜底
        # （soul 块正则 → @演员名 → "AI"）原样保留在后面。
        ai_name = None
        soul_display = ''
        soul_id_str = str((actor_info or {}).get('soul', '') or '')
        if soul_id_str:
            try:
                from femoCompiler.db_utils import get_soul_by_id
                soul_info = get_soul_by_id(soul_id_str)
                if soul_info:
                    soul_display = str(soul_info.get('soul_name', '') or '').strip()
            except Exception:
                pass
            if not soul_display and soul_id_str == 'main':
                # source:main 裸天使伪 soul：无角色卡，括号名=model id 'main'
                # （2026-09-12 拍板："如果是main就显示main"；普通无 soul AI
                # 不加括号，走后面的 @名兜底）
                soul_display = 'main'
        role_display = str(self._resolve_actor_name(eparam) or '').strip()
        if role_display and not role_display.startswith('@'):
            role_display = f'@{role_display}'
        if soul_display and role_display:
            ai_name = f"{role_display}（{soul_display}）"
        elif soul_display:
            ai_name = soul_display
        if not ai_name:
            soul_block = blocks.get('soul', '')
            match = re.search(r'名字[：:]\s*(\S+)', soul_block)
            if match:
                ai_name = match.group(1)
        if not ai_name:
            # 宿主后端模式兜底（2026-08-24）：无 soul 的 actor 用执行者名本身，
            # 别落到裸 "AI"——宿主投影窗的 speaker 行/角色窗 id/流式直播门控全以
            # 此名为键，"AI" 会让角色窗永远对不上号（actor_info 空老 bug 的收尾）。
            resolved_actor = self._resolve_actor_name(eparam)
            if resolved_actor:
                ai_name = resolved_actor if str(resolved_actor).startswith('@') else f'@{resolved_actor}'
        if not ai_name:
            ai_name = "AI"

        showprompt_for_frontend = None
        if hasattr(ad, 'showprompt') and ad.showprompt:
            showprompt_for_frontend = self.evaluator.interpolate_prompt(
                str(ad.showprompt), facade)

        self._emit_event('context_ready', {
            'node_name': self._get_current_node_id(),
            'context': blocks.get('context', ''),
            'showprompt': showprompt_for_frontend,
            'ai_name': ai_name,
        })

        # 提前捕获当前节点 ID，供线程池回调使用
        _current_node_id = self._get_current_node_id()

        # ── 重试轮共用 wait_key（2026-09-05 重构，施工清单 v4 §4.③(a)）：
        # 循环外一次生成——宿主停靠托管锚点、多轮 wait_for_input 配对键、
        # dispatcher 计数键三者同锚。counter 只拼字符串，宿主纯透传。──
        self._ai_request_counter = getattr(self, '_ai_request_counter', 0) + 1
        # run_tag 世代前缀（§5.6）：跨 Job 键永不重合——旧 run 的滞留信（宿主
        # 晚到投递）带着旧前缀，新 run 的 wait_for_input 用新前缀查询永远
        # pop 不到；run_tag=''（CLI 裸跑/现状构造点）时逐字节等于旧形态。
        node_wait_key = f"{self._run_tag}ai_{_current_node_id}_{self._ai_request_counter}"

        # ── AI 输出容错：赋值失败（未声明变量等）→ 错误反馈 → 重新调用本节点 ──
        # 上限 = max_retries + 1（未设置默认 2 次重试）；格式类失败进 SET_VARIABLE 宽容处理
        max_tries = max(1, (getattr(ad, 'max_retries', None) or 2) + 1)
        # dispatcher 的剧本反馈上限（按现状规则取值；显式 0 的 falsy bug 本期不修，裁决①）
        retries_max = max_tries - 1
        SET_VARIABLE = []
        assign_errors = []
        # 节点退出原因（node_settled 用）：ok=校验通过 / gave_up=反馈超限按结束
        settled_outcome = 'ok'
        # out 白名单（防 AI 幻觉乱赋值）：本节点 out 声明的变量名集合。
        out_whitelist = {
            getattr(od, 'var_name', '') for od in (ad.outs or [])
            if getattr(od, 'var_name', '')
        }
        for _attempt in range(max_tries):
            try:
                llm_output = await self._invoke_ai_llm(
                    blocks, ad, eparam, actor_info, scope_info, _current_node_id, ai_name or '',
                    wait_key=node_wait_key, emit_request=(_attempt == 0))
                #   ↑ emit_request=False 的重试轮【不重发 ai_request】——宿主 steer
                #     后经同一 wait_key 回传，重发会 spawn 新子代理，steer 链路断裂。
            except FEMOTransientError as e:
                # LLM 临时失败（限流/超时/网络）→ AGENT 桶：feedback 后重跑本节点
                if _attempt >= max_tries - 1:
                    print(f"[runtime]⚠️ LLM 临时失败重试用尽: {e}")
                    llm_output = None
                    break
                feedback = f'- LLM 调用临时失败（限流/超时/网络）：{e}'
                # 重试反馈不再注入 blocks['basic_safety']（2026-09-05 猫猫拍板
                # 删除：错误提示不该出现在子代理 prompt 的系统头段；后续将改为
                # 节点内部 react 轮次的工具结果注入）。重试调度与 ai_retry 通知
                # 保持原样。
                self._emit_event('ai_retry', {
                    'node_name': _current_node_id,
                    'attempt': _attempt + 1,
                    'errors': [feedback],
                })
                continue
            except FEMOActorExecutionError as e:
                # 宿主执行体最终失败（B5）：执行者已不在场——node_retry 无接收者、
                # 同一 wait_key 重等无人应答。裁决=通知作者 + llm_output=None 走
                # runtime 既有暂停分支（分支在节点挂起、断点保留，续跑=换新执行
                # 体重演该节点）——即 FEMOTransientError「重试用尽走暂停分支」的
                # 同款语义；宿主不再伪装空台词让引擎错误体系失明。
                print(f"[runtime]⚠️ 执行体失败，本场挂起（可续跑）: {e}")
                self._emit_event('notify_author', {
                    'node_name': _current_node_id,
                    'ai_name': ai_name or '',
                    'severity': 'agent_giveup',
                    'message': (f"节点 {_current_node_id}（{ai_name or ''}）的执行体失败"
                                f"（{e.kind}）：{e.detail}——本场已挂起存档，可点「继续」重演该节点。"),
                })
                settled_outcome = 'failed'
                llm_output = None
                self._host_steps = []
                break
            except FEMOConfigError as e:
                # LLM 配置错误（无 key/模型/URL）→ FATAL 桶：先发 notify_author(fatal)
                # 信号（v4 §4.③(d)，宪法要求发信号；宿主对 fatal 仅 log 防双份——
                # 实际作者投递由紧随的 flow_error 三通道承担），再原样 raise——
                # 传播到 bridge worker 统一收尾（flow_error + 全停）。
                print(f"[runtime]💥 LLM 配置错误（FATAL）: {e}")
                self.errors.dispatch(e, _current_node_id, bucket=ErrorCategory.FATAL,
                                     ai_name=ai_name or '', target=FEEDBACK_TARGET_AI)
                raise
            SET_VARIABLE, assign_errors = self._extract_ai_assignments(llm_output, out_whitelist)
            if not assign_errors:
                settled_outcome = 'ok'
                break
            # 赋值错误 → ErrorDispatcher 单次裁决与发信号（重试循环留在 runtime，
            # 裁决⑤）：未超限=node_retry 信号（宿主 steer 执行者续跑）+ continue；
            # 超限=notify_author 信号 + break（最后轮 output 宽容继续，现状语义）。
            verdict = self.errors.dispatch(
                None, _current_node_id, errors=assign_errors, wait_key=node_wait_key,
                ai_name=ai_name or '', max_retries=retries_max, attempt=_attempt + 1,
                target=FEEDBACK_TARGET_AI)
            if verdict == VERDICT_EXHAUSTED:
                settled_outcome = 'gave_up'
                break
            # VERDICT_RETRY → continue（宿主 steer 中；下一轮静默等同一 wait_key）
            print(f"[runtime]🔁 AI 赋值失败，重试（{_attempt + 1}/{max_tries - 1}）: {assign_errors}")
        
        #if llm_output:
        #    print(f"[runtime]🤖 AI 回复:\n{llm_output}")

        # 存储 AI 发言（2026-08-29 转写分离）：宿主侧按子会话 step 组装结构化
        # 转写，引擎逐 step 落库——cot/tool_call/tool_result 各归各位，response
        # 只存该轮发言，上游思考不再随 response 泄漏进下游上下文。
        # 兜底：无 steps（直连模式/旧 payload）→ 单行保存，与旧行为对齐（防半行）。
        host_steps = getattr(self, '_host_steps', None) or []
        if not host_steps and llm_output:
            host_steps = [{'step': 0, 'cot': '', 'reply': llm_output,
                          'toolCall': '', 'toolResult': ''}]
        from .save_dialog import save_ai_finish
        meta_owner = self.script.meta.get('owner', [])
        raw_scope = self._raw_scope_for(ad)

        # 收尾合写（2026-08-29）：showprompt 行 + 全部 react step 行同一事务——
        # show 行从节点开始推迟到此刻，与发言同 commit，消灭「有 show 没发言」半行。
        _adef_save = self._resolve_actor_def(ad, eparam)
        _a_source = str(getattr(_adef_save, 'source', None) or '').strip() if _adef_save is not None else ''
        event = save_ai_finish(
            session_id=self._current_session_id,
            turn_id=turn_id_alloc,
            showprompt=showprompt_text or None,
            steps=host_steps,
            actor_info=actor_info,
            meta_owner=meta_owner,
            action_scope=raw_scope,
            femo_id=femo_id,
            raw_action_scope=getattr(ad, 'scope', None),
            # 待办⑨：model_id 落值——source:main 节点固定 'main'（渠道标记）；
            # 普通节点取宿主回传的实际响应模型（provider/model），取不到保持空串。
            model_id='main' if _a_source == 'main' else (getattr(self, '_host_model_id', '') or ''),
        )
        if event:
            await self.engine.run_in_thread(event.wait)
        print(f"[runtime]🔢 turn → {turn_id_alloc}, 转写合写落库（show + {len(host_steps)} steps）")

        # ── 发送 ai_done 事件 ──
        self._emit_event('ai_done', {
            'node_name': self._get_current_node_id(),
            'output': llm_output or '',
        })

        # ── 节点审结信号（2026-09-05 重构，施工清单 v4 §4.③(e)）──────
        # 宿主停靠经纪人据此放行停靠者（ai/human 同发；wait_key 键控 par 分支
        # 隔离——ai_done payload 无 wait_key，按 node_name 匹配会在 par 场景串台）。
        # gave_up = 反馈超限按结束（最后轮 output 已宽容落盘）；failed = 执行体
        # 最终失败（B5 actor_failed 信号——无台词可落盘，作者已经 notify_author 通道知情）。
        self._emit_event(NODE_SETTLED_EVENT, {
            'node_name': _current_node_id,
            'wait_key': node_wait_key,
            'outcome': settled_outcome,
        })

        # 失败处理
        if llm_output is None:
            if ad.interrupt == 'HUMAN':
                print(f"[runtime]🔔 等待人类输入...")
                # 在线程池中执行 input，避免阻塞事件循环
                try:
                    user_input = await self.engine.run_in_thread(input, "  ✏️  > ")
                    user_input = user_input.strip() if user_input else ""
                except (EOFError, KeyboardInterrupt):
                    user_input = ""
                if user_input:
                    print(f"[runtime]📝 人类输入: {user_input}")
                    if ad.outs:
                        for od in ad.outs:
                            var_name = getattr(od, 'global_name', None) or getattr(od, 'var_name', '')
                            if var_name:
                                facade.apply_intent(var_name, ('set', user_input))
                                print(f"[runtime]📤 out: {var_name} = {user_input!r}")
                    return user_input
                return None
            else:
                # 直连 AI 失败挂起（C3 修复，§5.7）：节点门口断点已拍（全量
                # 快照，宿主后端/直连同款）→ raise FEMORunPaused → run_async 走
                # suspended(node_pause) 可续跑。替换旧 task_pause.pause() 的
                # `await event.wait()` 无超时挂死协程（C3：永挂无人 set）。
                # 发 flow_paused 不发 flow_error：宿主把 flow_error 当 failed
                # 终态处理（全场掐断+steer"运行出错"）；挂起时在飞子代理确实
                # 该收、停靠确实该放行——flow_paused 的宿主分支恰好就是这套
                # 清场，一处信号两用（前端显示"已暂停"文案，README §十四.4 备注）。
                cur = current_task_ctx()
                node_name = cur.current_node_id if cur else ''
                print(f"[runtime]⚠️ AI 调用失败（返回 None），变量已保存，分支在节点 {node_name} 挂起（可续跑）…")
                self._emit_event('flow_paused', {
                    'reason': 'node_pause',
                    'node_name': node_name,
                    'error': f'AI 调用失败，分支在节点 "{node_name}" 暂停，变量已保存',
                })
                raise FEMORunPaused(f'AI 调用失败，分支在节点 "{node_name}" 暂停，变量已保存')
        
        if llm_output == "":
            print(f"[runtime]🤖 AI 选择了沉默，无输出，流程继续。")

        if SET_VARIABLE:
            print(f"[runtime]⚠️ 解析失败的赋值已存入 SET_VARIABLE 列表: {SET_VARIABLE}")

        if hasattr(ad, 'resolve') and ad.resolve:
            resolve_args = getattr(ad, 'resolve_args', [])
            if resolve_args:
                resolve_kwargs = {}
                for arg_name in resolve_args:
                    if arg_name == 'SET_VARIABLE':
                        resolve_kwargs['SET_VARIABLE'] = SET_VARIABLE
                    elif facade is not None and facade.has(arg_name):
                        resolve_kwargs[arg_name] = facade.get(arg_name)
                    elif hasattr(ad, 'in_mappings'):
                        found = False
                        for im in ad.in_mappings:
                            if im.local_name == arg_name:
                                try:
                                    resolve_kwargs[arg_name] = self.evaluator.evaluate(im.global_expr, facade, strict=False)
                                    found = True
                                except KeyError:
                                    pass
                                break
                        if not found:
                            raise FEMOVariableError(
                                f"resolve 参数 '{arg_name}' 在全局变量和 in: 声明中均未找到。"
                            )
                    else:
                        raise FEMOVariableError(
                            f"resolve 参数 '{arg_name}' 在全局变量中未找到。"
                        )
            else:
                resolve_kwargs = {
                    'prompt': prompt,
                    'llm_output': llm_output,
                }
                if SET_VARIABLE:
                    resolve_kwargs['SET_VARIABLE'] = SET_VARIABLE
                if hasattr(ad, 'in_mappings'):
                    for im in ad.in_mappings:
                        try:
                            resolve_kwargs[im.local_name] = self.evaluator.evaluate(im.global_expr, facade, strict=False)
                        except KeyError:
                            pass

            result = call_python(self.bridge, ad.resolve, resolve_kwargs)
            triplets = result if isinstance(result, list) else []
            retry_info = {
                'retries_left': getattr(ad, 'max_retries', 0) or 0,
                'on_error': getattr(ad, 'fallback', 'abort'),
            }
            return process_ai_result(facade, triplets, ad.outs, retry_info)
        else:
            return {'status': 'ok', 'assigned_pairs': []}

    # ══════════════════════════════════════════════════
    #  @human 桩
    # ══════════════════════════════════════════════════


    _human_input_lock = None


    def _update_speaker(self, new_speaker: str):
        """
        更新发言者状态，返回 (turn_id, idx)
        - new_speaker: 'human', 'node', 或 'ai'
        - 返回 tuple: (turn_id, idx) 其中 idx 是 oratio_idx 或 step_idx
        """
        last = self.speaker["current"]
        self.speaker["last"] = last
        self.speaker["current"] = new_speaker

        if last == 'ai' and new_speaker in ('human', 'node'):
            # AI → 人类/节点：turn++
            self._current_turn_id += 1
            self._oratio_idx = 0
            self._step_idx = 0
            # turn_count 内建直通（读实时值，无存储写点）
        elif new_speaker == 'ai':
            if last in ('human', 'node', None):
                self._step_idx = 0
            else:
                self._step_idx += 1
            # turn 不变
        else:  # new_speaker 是 'human' 或 'node'
            if last in ('human', 'node'):
                self._oratio_idx += 1
            else:  # last is None or 'ai'
                self._oratio_idx = 0
            # turn 不变

        if new_speaker == 'ai':
            return self._current_turn_id, self._step_idx
        else:
            return self._current_turn_id, self._oratio_idx

    def _alloc_turn(self) -> int:
        """分配下一个 turn 号（2026-08-28 par 丢行根治，引擎级锁）。
        par/fork 并发分支在锁内排队领取严格递增的独立 turn 号——每个节点实例
        按领取顺序获得唯一身份，任何两行都不可能再撞 (turn, step) 键。
        取号所属 session 变化时（新开场 / 断点续跑换场）按该 session 的
        get_next_turn_id 起点重新对齐，续跑场次自然接续旧 turn 序列。
        注意：取号后本节点的所有行（prompt/showprompt/react）必须共用这个号，
        用 oratio/step 区分行，不得再改读共享状态机。"""
        with self._turn_lock:
            sid = self._current_session_id
            if getattr(self, '_turn_seq_sid', None) != sid or self._turn_seq is None:
                # 新 session（或本 run 首次取号）：从"该 session 下一个空位"起算
                self._turn_seq_sid = sid
                self._turn_seq = self._current_turn_id - 1
            self._turn_seq += 1
            self._current_turn_id = self._turn_seq
            return self._current_turn_id


    def _try_apply_human_variables(self, variables: dict, out_defs: list,
                                   facade=None) -> Optional[str]:
        """尝试应用人类输入的变量赋值；成功返回 None，失败返回错误信息（str）。
        容错原则：human 输入不稳定可重试，但未声明变量必须报错（不静默忽略）。
        支持动态字典键 out（damage_report.@hero → dict[实际角色]）。"""
        if not variables:
            return None

        def display_name(od):
            base = getattr(od, 'global_name', None) or getattr(od, 'var_name', '')
            dk = getattr(od, 'dynamic_key', None)
            return f"{base}.{dk}" if dk else base

        by_display = {display_name(od): od for od in (out_defs or [])}
        declared_display = set(by_display)

        for var_key, var_value in variables.items():
            raw = str(var_value).strip()
            if not raw:
                print(f"[runtime]⏭️ 变量 '{var_key}' 值为空，跳过")
                continue
            if var_key not in declared_display:
                return (f"变量 '{var_key}' 未声明（该节点 out 只声明了: "
                        f"{', '.join(sorted(declared_display)) or '无'}）。"
                        f"所有变量必须在 vars: 中预先声明。")
            od = by_display[var_key]
            try:
                # 构造表达式：+=/-= 前缀直接用（标准化空格），否则加 "= " 前缀
                if raw.startswith('+=') or raw.startswith('-='):
                    expr = raw[:2] + ' ' + raw[2:].strip()
                else:
                    expr = '= ' + raw
                op, val = parse_assign_syntax(expr, getattr(od, 'var_name', var_key))
                # 对 set/add/remove 的字符串值，用 Evaluator 解析变量引用（如 @Alice）
                if op in ('set', 'add', 'remove') and isinstance(val, str):
                    resolved = self.evaluator.evaluate(val, facade, strict=False)
                    val = resolved
                if getattr(od, 'dynamic_key', None):
                    # 动态字典键：dict.@actor（@actor 解析为实际角色实体）
                    self._set_out_var(od, val)
                    print(f"[runtime]📤 前端动态键赋值完成: {display_name(od)} = {val!r}")
                else:
                    facade.apply_intent(od.var_name, (op, val))
                    print(f"[runtime]📤 前端变量赋值完成: {od.var_name} {op} {val!r}, 当前值={facade.get(od.var_name)!r}")
            except FEMOVariableError as e:
                return str(e)
            except Exception as e:
                return f"变量 '{var_key}' 赋值失败: {e}"
        return None

    async def _exec_human(self, ad, eparam: str) -> Any:
        # 人类动作现在支持异步等待，不再阻塞事件循环
        print(f"[runtime]👤 Human Action")
        human_scope_info = self._scope_info_for(ad, eparam)
        self._emit_event('node_start', {
            'node_name': self._get_current_node_id(),
            'node_type': 'human',
            'scope': human_scope_info,
        })

        try:
            ctx = current_task_ctx()
            facade = ctx.facade if ctx is not None else None
            prompt = self.evaluator.interpolate_prompt(
                str(ad.prompt or ""), facade, in_mappings=ad.in_mappings)

            # ── 收集 context 和 memory（与 AI 节点相同）──
            from femoCompiler.block_collector import collect_blocks
            actor_info = self._get_actor_info(ad, eparam)
            print(f"[DEBUG _exec_human] 刚获取的 actor_info (准备给人类发言用): {actor_info}")
            turn_id_alloc = self._alloc_turn()   # 本节点独立 turn 号（par 并发安全）
            # oratio 分配（2026-08-29 合写）：0=节点 prompt、1=showprompt（渲染提前、
            # 与玩家输入同事务落库）、2+=玩家输入；无 showprompt 的节点输入从 1 起
            human_oratio = 2 if getattr(ad, 'showprompt', None) else 1
            femo_id = self.script.meta.get('id', 'unknown')
            blocks = collect_blocks(
                action=ad,
                meta=self.script.meta,
                actors_def=self.script.actors,
                var_manager=facade,
                evaluator=self.evaluator,
                code_modules=self.bridge.modules,
                memory_defs=None,
                context_defs=self.script.contexts,
                session_id=self._current_session_id,
                turn_id=turn_id_alloc,
                actor_info=actor_info,
                runner=self,
                base_dir=self.base_dir,
            )
            context_text = blocks.get('context', '')
            memory_text = blocks.get('memory', '')

            scope_info = self._scope_info_for(ad, eparam)
            # 【2026-09-08 角色窗按钮修复】人类节点等待 scope 必含执行者本人：
            # 宿主把 human_wait 的 scope 冻结为等待快照（waitingHuman.waitScope），
            # 角色窗按钮按「快照含本窗角色」点亮。执行者是唯一确定要输入的人——
            # 无论剧本 scope 怎么写（如仅 [@上帝]），都必须在快照里，否则轮到
            # 执行者发言时其角色窗永远不亮。node_start 的 scope 不加此保证：
            # 宿主侧 par 并发下同名节点的 node_start 会互相覆盖（最后到达者胜），
            # 本字段在事件发出时刻现场冻结，才是角色窗判定的权威源。
            _human_executor = self._resolve_actor_name(eparam)
            if _human_executor:
                _human_tag = _human_executor if str(_human_executor).startswith('@') else f'@{_human_executor}'
                if _human_tag not in scope_info:
                    scope_info = sorted(set(scope_info) | {_human_tag})
            # 构建 out_vars 列表（变量名完整显示，dynamic_key 拼成 dict.@actor）
            out_vars = []
            if ad.outs:
                for od in ad.outs:
                    var_name = getattr(od, 'global_name', None) or getattr(od, 'var_name', '')
                    dk = getattr(od, 'dynamic_key', None)
                    if var_name:
                        out_vars.append(f"{var_name}.{dk}" if dk else var_name)
            print(f"[runtime]📋 human_wait out_vars: {out_vars}")

            # ── 生成唯一 wait_key，用于精确路由人类输入（run_tag 世代前缀 §5.6）──
            self._human_input_counter += 1
            node_id = self._get_current_node_id()
            wait_key = f"{self._run_tag}human_{node_id}_{self._human_input_counter}"
            print(f"[runtime]🔑 human_wait 分配专属频道: wait_key={wait_key}")

            self._emit_event('human_wait', {
                'node_name': node_id,
                'wait_key': wait_key,
                'prompt': prompt,
                'scope': scope_info,
                'context': context_text,
                'memory': memory_text,
                'out_vars': out_vars,
            })

            if prompt:
                print(f"[runtime]📝 {prompt}")
                from .save_dialog import save_human_turn
                meta_owner = self.script.meta.get('owner', [])
                raw_scope = self._raw_scope_for(ad)

                h_actor_info = self._get_actor_info(ad, eparam)
                if 'user' not in h_actor_info:
                    owners = self.script.meta.get('owner', [])
                    if owners:
                        h_actor_info['user'] = str(owners[0])

                turn_id, oratio_idx = turn_id_alloc, 0
                femo_id = self.script.meta.get('id', 'unknown')
                event = save_human_turn(
                    session_id=self._current_session_id,
                    turn_id=turn_id,
                    oratio_idx=oratio_idx,
                    user_input=prompt,
                    actor_info=h_actor_info,
                    meta_owner=meta_owner,
                    action_scope=raw_scope,
                    is_node_prompt=True,
                    femo_id=femo_id,
                    raw_action_scope=ad.scope,
                )
                if event:
                    await self.engine.run_in_thread(event.wait)
                print(f"[runtime]💬 Human prompt 已存入 dialog: turn={turn_id}, oratio={oratio_idx}")

            # showprompt 渲染提前、落库推迟（2026-08-29 合写）：human 节点的 show
            # 行此前从未落库（老缺口），现在与玩家输入行同事务落库——要不然都有
            # 要不然都没有；输入为空（如超时放行）时只落 show 行 = 超时留痕。
            show_text = ''
            if getattr(ad, 'showprompt', None):
                show_text = self.evaluator.interpolate_prompt(
                    str(ad.showprompt), facade, in_mappings=ad.in_mappings)

            # ── 获取人类输入：FastAPI 模式 or CLI 模式 ──
            chat_text = ''
            variables = {}
            retry_hint = ''

            # 人类输入容错：赋值失败 → 带错误信息重新等待输入（不中断流程）
            if self._human_input_event is not None:
                # wait_key 在上面改动3中已计算，此处直接使用
                if 'wait_key' not in locals():
                    self._human_input_counter += 1
                    node_id = self._get_current_node_id()
                    wait_key = f"{self._run_tag}human_{node_id}_{self._human_input_counter}"
                print(f"[runtime]⏳ 等待前端人类输入... 频道: {wait_key}"
                      + (f"（上次被拒: {retry_hint}）" if retry_hint else ""))
                raw_input = await self.engine.human_input.wait_for_input(wait_key, timeout=3600)
                print(f"[runtime]📥 收到前端输入: type={type(raw_input).__name__}")
                print(f"[runtime]📥 raw_input = {raw_input}")
                # 新前端传 dict，CLI 模式传 str
                if isinstance(raw_input, dict):
                    chat_text = raw_input.get('chat_text', '')
                    variables = raw_input.get('variables', {})
                    print(f"[runtime]📥 结构化输入: chat_text={chat_text!r}, variables={variables}")
                else:
                    chat_text = str(raw_input) if raw_input else ''
                    print(f"[runtime]📥 兼容旧格式（纯字符串）: chat_text={chat_text!r}")
            else:
                # CLI 模式：将多行读取封装为同步函数，放到线程池执行
                print("（输入内容，按回车换行，输入空行或 /end 结束）")
                print("（命令：/godview 上帝视角 | /@角色名 切换视角）")

                # 同步读取函数，保留原有特殊命令处理
                def _sync_read_multiline():
                    lines = []
                    while True:
                        try:
                            sys.stdout.flush()
                            line = sys.stdin.readline()
                            if not line:
                                break
                            line = line.rstrip('\n')
                            if line == '' or line.strip().lower() == '/end':
                                break
                            # ── 特殊命令处理 ──
                            if line.startswith('/'):
                                cmd = line[1:].strip()
                                if cmd == 'godview':
                                    meta_owner = self.script.meta.get('owner', [])
                                    _actor_info = {'user': str(meta_owner[0])} if meta_owner else {}
                                    _blocks = collect_blocks(
                                        action=ad,
                                        meta=self.script.meta,
                                        actors_def=self.script.actors,
                                        var_manager=facade,
                                        evaluator=self.evaluator,
                                        code_modules=self.bridge.modules,
                                        memory_defs=None,
                                        context_defs=self.script.contexts,
                                        session_id=self._current_session_id,
                                        turn_id=self._current_turn_id,
                                        actor_info=_actor_info,
                                        runner=self,
                                        base_dir=self.base_dir,
                                    )
                                    if self._cli_renderer:
                                        self._cli_renderer.clear_and_show_context(
                                            "上帝视角（owner）",
                                            _blocks.get('context', '（暂无对话记录）')
                                        )
                                elif cmd.startswith('@'):
                                    _actor_info = self._get_actor_info(ad, cmd)
                                    self._current_actor_info = _actor_info
                                    _blocks = collect_blocks(
                                        action=ad,
                                        meta=self.script.meta,
                                        actors_def=self.script.actors,
                                        var_manager=facade,
                                        evaluator=self.evaluator,
                                        code_modules=self.bridge.modules,
                                        memory_defs=None,
                                        context_defs=self.script.contexts,
                                        session_id=self._current_session_id,
                                        turn_id=self._current_turn_id,
                                        actor_info=_actor_info,
                                        runner=self,
                                        base_dir=self.base_dir,
                                    )
                                    name = cmd.lstrip('@')
                                    if self._cli_renderer:
                                        self._cli_renderer.clear_and_show_context(
                                            f"{name} 的视角",
                                            _blocks.get('context', '（暂无对话记录）')
                                        )
                                else:
                                    print(f"⚠️ 未知命令: /{cmd}")
                                continue
                            lines.append(line)
                        except (EOFError, KeyboardInterrupt):
                            break
                        except Exception as e:
                            print(f"[runtime]\n⚠️ 读取输入时出错: {e}，跳过本次输入")
                            break
                    return '\n'.join(lines)

                raw_cli = await self.engine.run_in_thread(_sync_read_multiline)
                chat_text = raw_cli if raw_cli else ''
                # CLI 模式下 variables 保持空（CLI 不支持结构化输入）

            # ── 变量赋值：以 ad.outs 为准，复用 parse_assign_syntax ──
            print(f"[runtime]📋 该节点 out 声明: "
                  f"{[(getattr(od, 'var_name', ''), getattr(od, 'dynamic_key', None)) for od in (ad.outs or [])]}")

            # 人类输入容错循环（2026-09-05 重构，施工清单 v4 §4.⑥，裁决④⑥）：
            # human 与 ai 全节点统一走 ErrorDispatcher 三桶——赋值失败 →
            # node_retry(target='human') 信号（宿主 human 租约=投影窗 ⚠️ 提醒；
            # femoGen 画布同事件重开输入框）→ 既有"重等输入"分支原样（人类重输
            # =重试，引擎侧零新增机制）。反馈超限（P7 默认同 max_retries 上限）
            # → notify_author + 超时放行同款收尾 → move on。
            human_retries_max = max(1, (getattr(ad, 'max_retries', None) or 2) + 1) - 1
            human_settled_outcome = 'ok'
            human_actor_name = self._resolve_actor_name(eparam)
            while True:
                # ── 文本赋值（2026-09-01）：聊天框里的 SET VARIABLE: <<...>> 与 AI
                #    同一套提取器解析；前端结构化变量框的值优先覆盖（显式 UI 输入）。──
                merged_vars = text_assignments_to_dict(chat_text)
                merged_vars.update(variables or {})
                assign_err = self._try_apply_human_variables(merged_vars, ad.outs, facade=facade)
                if assign_err is None:
                    break
                retry_hint = assign_err
                verdict = self.errors.dispatch(
                    None, node_id, errors=[assign_err], wait_key=wait_key,
                    ai_name=human_actor_name, max_retries=human_retries_max,
                    target=FEEDBACK_TARGET_HUMAN)
                if verdict == VERDICT_EXHAUSTED:
                    human_settled_outcome = 'gave_up'
                    # 超时放行同款收尾：清掉最后一次非法输入——台账只落 show 行
                    # 留痕（超时留痕语义），非法赋值文本不进 dialog（防污染下游上下文）。
                    chat_text = ''
                    variables = {}
                    break
                # VERDICT_RETRY：宿主 human 租约已把提醒显示到投影窗（⚠️）；
                # femoGen 画布同事件重开输入框。既有"重等输入"分支原样——
                # 人类重输=重试，引擎侧零新增机制。
                print(f"[runtime]⚠️ 人类输入被拒绝: {assign_err}，请重新输入")
                # 重新等输入
                if self._human_input_event is not None:
                    print(f"[runtime]⏳ 重新等待前端人类输入... 频道: {wait_key}")
                    raw_input = await self.engine.human_input.wait_for_input(wait_key, timeout=3600)
                    if isinstance(raw_input, dict):
                        chat_text = raw_input.get('chat_text', '')
                        variables = raw_input.get('variables', {})
                    else:
                        chat_text = str(raw_input) if raw_input else ''
                        variables = {}
                else:
                    # CLI 模式：单行重试输入
                    cli_line = await self.engine.run_in_thread(
                        lambda: sys.stdin.readline().rstrip('\n'))
                    chat_text = cli_line
                    variables = {}

            # ── 拼接存储文本（runtime 立即拼接，save_dialog 无脑存） ──
            dialog_text = format_human_dialog(chat_text, variables)
            print(f"[runtime]📝 拼接后的存储文本: {dialog_text!r}")

            # ── 保存人类发言（2026-08-29 合写）：show 行与输入行同一事务——
            # 要么都有要不然都没有；输入为空（如超时放行）时只落 show 行=留痕。
            if dialog_text or show_text:
                from .save_dialog import save_human_finish
                meta_owner = self.script.meta.get('owner', [])
                raw_scope = self._raw_scope_for(ad)

                actor_info_save = self._get_actor_info(ad, eparam)
                femo_id = self.script.meta.get('id', 'unknown')
                event = save_human_finish(
                    session_id=self._current_session_id,
                    turn_id=turn_id_alloc,
                    showprompt=show_text or None,
                    user_input=dialog_text,
                    input_oratio=human_oratio,
                    actor_info=actor_info_save,
                    meta_owner=meta_owner,
                    action_scope=raw_scope,
                    femo_id=femo_id,
                    raw_action_scope=ad.scope,
                )
                if event:
                    await self.engine.run_in_thread(event.wait)
                print(f"[runtime]🔢 turn → {turn_id_alloc}, human 收尾合写落库（show + input oratio {human_oratio}）")

            self._emit_event('human_done', {
                'node_name': self._get_current_node_id(),
                'input': chat_text,
            })

            # ── 节点审结信号（2026-09-05 重构，施工清单 v4 §4.③(g)）──────
            # human 的停靠托管同样靠 node_settled 解除（ai/human 同构）。
            # gave_up = 反馈超限按结束（空输入只落 show 行=超时留痕同款）。
            self._emit_event(NODE_SETTLED_EVENT, {
                'node_name': node_id,
                'wait_key': wait_key,
                'outcome': human_settled_outcome,
            })

            return chat_text

        except Exception as e:
            print(f"[runtime]\n❌ 人类动作执行异常: {type(e).__name__}: {e}")
            import traceback
            traceback.print_exc()
            raise

    # ══════════════════════════════════════════════════
    #  @notice 处理（公告节点：只注入一条 prompt 进 dialog，无回答者）
    # ══════════════════════════════════════════════════

    async def _exec_notice(self, ad, eparam: str) -> Any:
        """notice 节点：把 prompt（变量替换后）按节点 scope 落一条 dialog 行，
        无 LLM、无等待、无 blocks/memory/context、无重试、无 react_steps 行。

        落库走 femoshow-<femo_id> 通道（showprompt 通道）：ContextExample /
        MemoryExample / chronica 的行判别都认这个前缀——后续 scope 内角色提
        上下文时以「[节点提醒]」读到本条（femo- 前缀的幕后指令行会被拼装
        跳过，读不到，所以不能照抄 AI/human 节点的 prompt 落库方式）。
        scope: self 语义 = 仅 meta.owner 可见（notice 无发言者，_build_scope
        按原始字符串注入 owner）；事件侧 scope 由 §守卫置空（无发言者可展开）。
        收尾发 notice_done（仿 func_result / assign_result 的瞬时节点完成
        事件）——不发则画布呼吸灯卡「运行中」直到 flow_done。"""
        self._check_cancel()
        ctx = current_task_ctx()
        facade = ctx.facade if ctx is not None else None

        # 1) prompt 变量替换（与 _exec_ai 同款：{var} / in: 映射同语义）
        prompt = self.evaluator.interpolate_prompt(
            str(ad.prompt or ""), facade, in_mappings=ad.in_mappings)
        if prompt is None or not str(prompt).strip():
            raise FEMOVariableError(f"notice Action '{ad.name}' 的 prompt 为空。")
        prompt = str(prompt)

        # 2) 事件①：node_start（画布按 node_type='notice' 记账，scope 供投影）
        scope_info = self._scope_info_for(ad, eparam)
        self._emit_event('node_start', {
            'node_name': self._get_current_node_id(),
            'node_type': 'notice',
            'prompt': prompt,
            'scope': scope_info,
        })

        # 3) 落库：一条 femoshow-<femo_id> 行（showprompt 通道），await 落库
        #    确认再放行——防止紧随其后的下游节点提上下文时读不到本行
        #    （与 _exec_ai 的 prompt 落库同款等待）。
        turn_id = self._alloc_turn()
        meta_owner = self.script.meta.get('owner', [])
        raw_scope = self._raw_scope_for(ad)
        femo_id = self.script.meta.get('id', 'unknown')
        from .save_dialog import save_human_turn
        event = save_human_turn(
            session_id=self._current_session_id,
            turn_id=turn_id,
            oratio_idx=1,               # show 行惯例（AI 的 showprompt 也是 1）
            user_input=prompt,
            actor_info={},              # 幕后行无发言者；owner 由 _build_scope 注入
            meta_owner=meta_owner,
            action_scope=raw_scope,
            is_node_prompt=True,
            femo_id=femo_id,
            prompt_type='showprompt',   # femoshow- 前缀 = 后续可读的关键
            raw_action_scope=ad.scope,
        )
        if event:
            await self.engine.run_in_thread(event.wait)
        print(f"[runtime]📢 notice '{ad.name}' 已落库: turn={turn_id}")

        # 4) 事件②：notice_done（无 wait_key/租约，不发 node_settled）
        self._emit_event('notice_done', {
            'node_name': self._get_current_node_id(),
            'text': prompt,
        })
        return None

    # ══════════════════════════════════════════════════
    #  @mind 处理（运行时按执行者类型分发）
    # ══════════════════════════════════════════════════

    async def _exec_mind(self, ad, eparam: str) -> Any:
        """mind 节点：运行时按实际执行者类型分发到 AI 或 human 路径。

        执行者可能是变量（@mind(@speaker)），由剧本在运行中赋值——每轮
        可能是人类也可能是 AI，编译期无法预判。因此 @mind 保持原样解析，
        每轮进入节点时重新解析执行者（_resolve_actor_name 读当前变量值），
        然后整体委托给 _exec_ai 或 _exec_human（事件、等待、赋值、重试等
        行为完全复用现有路径，node_type 事件也自动正确）。
        """
        print(f"[runtime]🧠 Mind Action: {ad.name}")
        if not eparam:
            raise ValueError(
                f"Mind Action '{ad.name}' 缺少执行者参数。期望: action {ad.name} @mind(@角色或变量):"
            )
        actor_name = self._resolve_actor_name(eparam)
        if actor_name not in self.script.actors:
            raise ValueError(
                f"Mind Action '{ad.name}' 的执行者 '{eparam}' 解析为 '{actor_name}'，"
                f"但 actors 中不存在该角色，无法确定执行者类型（ai/human）。"
            )
        atype = self.script.actors[actor_name].type.value
        print(f"[runtime]🧠 mind 分发: {actor_name} 是 {atype} 执行者 → "
              f"走 {'AI' if atype == 'ai' else 'human' if atype == 'human' else atype} 路径")
        if atype == 'ai':
            return await self._exec_ai(ad, eparam)
        if atype == 'human':
            return await self._exec_human(ad, eparam)
        raise ValueError(
            f"Mind Action '{ad.name}' 的执行者 '{actor_name}' 类型为 '{atype}'，"
            f"mind 仅支持 ai/human 执行者（blueprint 蓝图角色尚未实现）。"
        )

    # ══════════════════════════════════════════════════
    #  Out 写回
    # ══════════════════════════════════════════════════

    def _apply_outs(self, ad, result: Any, local_vars: dict = None):
        if not ad.outs: return
        #print(f"[runtime]_apply_outs: result={result!r}, outs={[(o.var_name, getattr(o, 'dynamic_key', None)) for o in ad.outs]}")
        outs = ad.outs
        if isinstance(result, tuple):
            if len(result) != len(outs):
                raise FEMOVariableError(
                    f"@func 返回值不匹配：out 声明了 {len(outs)} 个变量，但函数返回了 {len(result)} 个值。"
                )
            for i, od in enumerate(outs):
                self._set_out_var(od, result[i])
        elif isinstance(result, dict):
            # 检查 out 声明的变量和返回 dict 的 key 是否一一对应
            out_names = [self._extract_var_name(od.var_name) for od in outs]
            result_keys = list(result.keys())
            missing_in_result = [n for n in out_names if n not in result_keys]
            extra_in_result = [k for k in result_keys if k not in out_names]
            if missing_in_result and len(outs) == 1:
                # 单 out + 返回 dict 与 out 名完全不匹配：
                # 宽容回退——函数返回的字典整体作为单值赋给唯一 out
                # （如 enemy_phase 返回 hp 字典给 out: hp）
                self._set_out_var(outs[0], result)
                return
            if missing_in_result:
                raise FEMOVariableError(
                    f"@func 返回值不匹配：out 声明的变量 {missing_in_result} 在函数返回字典中不存在。"
                )
            if extra_in_result:
                raise FEMOVariableError(
                    f"@func 返回值不匹配：函数返回字典中的 key {extra_in_result} 未在 out 中声明。"
                )
            for od in outs:
                var_name = self._extract_var_name(od.var_name)
                self._set_out_var(od, result[var_name])
        else:
            if len(outs) == 1:
                self._set_out_var(outs[0], result)
            else:
                raise FEMOVariableError(
                    f"@func 返回值不匹配：out 声明了 {len(outs)} 个变量，但函数返回了单值。"
                )
            
            


    def _set_out_var(self, od, value: Any):
        """out 写回（统一走 facade.set 路径写：纯变量名/dict.@actor/dict[idx]
        全支持；动态键经 Evaluator.eval_key 完整帧路由）。"""
        ctx = current_task_ctx()
        facade = ctx.facade if ctx is not None else None
        if facade is None:
            raise FEMOVariableError("out 写回需要 TaskContext（协程未绑执行上下文）")
        expr = od.var_name
        dynamic_key = getattr(od, 'dynamic_key', None)
        if dynamic_key:
            resolved_key = self.evaluator.eval_key(dynamic_key, facade)
            if not isinstance(resolved_key, str):
                raise FEMOVariableError(f"动态键 {dynamic_key} 求值后不是字符串: {resolved_key!r}")
            path = f"{expr}[{resolved_key}]"
            facade.set(path, value)
            print(f"[runtime]📤 out (dict): {path} = {value!r}")
            return

        if '.@' in expr:
            container, dyn_key = self.evaluator._resolve_actor_path(expr, facade)
            if not dyn_key:
                raise FEMOVariableError(f"无法解析动态键路径: {expr!r}")

            container_val = facade.get(container)
            if container_val is not None and not isinstance(container_val, dict):
                raise FEMOVariableError(
                    f"无法写入 {container}[{dyn_key}]：变量 '{container}' 的类型是 {type(container_val).__name__}，"
                    f"但此处需要字典类型。请在 vars: 中将其初始值设为 '{{}}' 而非字符串。"
                )
            path = f"{container}[{dyn_key}]"
            facade.set(path, value)
            print(f"[runtime]📤 out (dict): {path} = {value!r}")
            return

        facade.set(expr, value)
        print(f"[runtime]📤 out: {expr} = {value!r}")

    def _extract_var_name(self, expr: str) -> str:
        m = re.match(r'^(@?[A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff]*)', expr)
        return m.group(1) if m else expr


    def _get_current_node_id(self) -> str:
        """获取当前线程所在的流图节点 ID，线程安全"""
        ctx = _current_context.get()
        return ctx.current_node_id if ctx else ""
        
    # ══════════════════════════════════════════════════
    #  主流程执行
    # ══════════════════════════════════════════════════

    def run(self, max_steps: int = None):
        """同步入口（仅用于命令行等无事件循环的场景）"""
        if self.engine.is_event_loop_running():
            raise RuntimeError(
                "FEMORunner.run() 不能在已有事件循环中调用。请使用 'await runner.run_async()'。"
            )
        self.engine.run_async_until_complete(self.run_async(max_steps))

    async def run_async(self, max_steps: int = None):
        """执行主流程（异步）"""
        # 重启 SaveQueue，避免上轮任务残留的停止状态
        from femoCompiler.save_dialog import save_queue
        save_queue.restart()

        # 每次 run 重置 fork 分支错误收集（编译器原则：分支报错必须上报，不静默）
        self._fork_errors = []
        # 本次 run 终态判定（A1 取消诚实化，§5.4）：取消/FEMORunPaused 路径置位，
        # flow_done 仅正常完成路径发出（取消路径不发——§八.12）。
        self._run_terminated = False
        # 每次 run 重置错误分发计数（wait_key 键控的 node_retry 次数，v4 §4②）
        self.errors.reset()

        if max_steps is None:
            global_meta = getattr(self.script, 'meta', None) or {}
            max_steps = global_meta.get('max_steps', 0)

        flow = self.script.flow
        if not flow:
            print("⚠️ 没有 flow 定义")
            return

        self.global_max_steps = max_steps
        self.global_step = 0

        flow_start_payload = {
            'entry': flow.entry,
            'max_steps': self.global_max_steps,
            # 引擎场次身份：宿主据此维护「其会话 ↔ femo 场次」的一对多账本
            'session_id': self._current_session_id,
            # 剧本全部角色（视角切换菜单用）
            'actors': list(self.script.actors.keys()),
            # 剧本 main 演员（source:main）名单：宿主主窗口回答制的流水可见性
            # 判定用——main 演员是编译期静态声明，必须开跑即登记（靠 ai_request
            # 运行时登记会漏掉首个 main 节点之前的发言，1005 场实测教训）
            'main_actors': [
                aname for aname, adef in self.script.actors.items()
                if str(getattr(adef, 'source', None) or '').strip() == 'main'
            ],
            # 剧本名（宿主剧终日记标题用）
            'name': str(global_meta.get('name', '') or ''),
        }
        self._emit_event('flow_start', flow_start_payload)
        # Job 旁挂（§4.2 契约）：JobManager 借此 mark_session 回填挂靠场次。
        self._rc_call('on_flow_start', {'session_id': self._current_session_id,
                                        'name': flow_start_payload.get('name', '')})

        try:
            print("\n🚀 开始执行 Flow")
            print(f"[runtime] Entry: {flow.entry}")
            print(f"[DEBUG] flow.nodes count={len(flow.nodes)}, flow.edges count={len(flow.edges)}")
            print("[DEBUG] 进入 _execute_flow")
            self._main_task = asyncio.current_task()
            try:
                if self.resume_positions:
                    # ── 分支直启（清单 D8）：不为 root 起协程（root 多半已 fork
                    # 终止），对 positions 中每个存活 task 起独立分支协程，从记录
                    # node_id 重跑；join 签到后暂停的场景恢复后重新 sign_in
                    # （merge 幂等）。该跑哪个 flow 由模块栈顶决定。
                    direct_tasks = []
                    print(f"[resume-diag] resume_positions keys={list(self.resume_positions.keys())}")
                    for tid, pos in self.resume_positions.items():
                        env = self.world.envs.get(tid)
                        ledger_alive = self.world.ledger.alive(tid)
                        try:
                            flow_i, extra_i = self._flow_for_stack(list(pos.get('mod_stack') or []))
                            flow_err = ''
                        except Exception as exc:
                            flow_i = extra_i = None
                            flow_err = str(exc)
                        start_node = pos.get('node_id')
                        node_in_flow = bool(flow_i is not None and flow_i.nodes.get(start_node))
                        # 【2026-09-06 探针】直启每个决策点全部照亮——静默跳过
                        # （env 缺失/ledger 非存活/flow 缺失/起点不在图中）任何
                        # 一个发生，恢复就会变成"秒跑完"假象。
                        print(f"[resume-diag] task={tid} env={'有' if env is not None else '无'} "
                              f"ledger_alive={ledger_alive} 起点={start_node} "
                              f"mod_stack={list(pos.get('mod_stack') or [])} "
                              f"flow_resolved={flow_i is not None}"
                              f"{' exc=' + flow_err if flow_err else ''} 起点在图中={node_in_flow}")
                        if env is None or not ledger_alive:
                            print(f"[resume-diag] ⏭️ task {tid} 跳过直启（env 缺失或 ledger 非存活——恢复世界不认这个 task）")
                            continue
                        if flow_i is None:
                            print(f"[resume-diag] ⚠️ task {tid} 的模块栈顶 flow 缺失，跳过直启")
                            continue
                        if not node_in_flow:
                            print(f"[resume-diag] ⚠️ task {tid} 起点 {start_node} 不在目标 flow 中（合成网关编号变动/节点被删——断点位置失效）")
                        t = self.engine.create_task(branch_main(
                            self, self.world, tid, env, pos['node_id'], flow_i,
                            extra_i, 0,
                            stack=(tuple(pos.get('mod_stack') or []),
                                   tuple(pos.get('loop_frames') or [])),
                            resume_callers=pos.get('module_frames') or []))
                        direct_tasks.append(t)
                    if direct_tasks:
                        print(f"[runtime]🔁 分支直启：{len(direct_tasks)} 个 task 从断点重放")
                        await asyncio.gather(*direct_tasks, return_exceptions=True)
                    else:
                        print("[resume-diag] ⚠️⚠️ 直启协程为零——没有任何 task 被重启，流程将立即收场（这就是'秒跑完'的直接原因）")
                    if self._fork_errors:
                        detail = "; ".join(f"[{n}] {e}" for n, e in self._fork_errors)
                        self._fork_errors = []
                        raise FEMOVariableError(f"直启分支执行失败: {detail}")
                else:
                    # 全新开演：root task 't0' 绑执行上下文跑主流程
                    root_env = self.world.envs.get('t0')
                    root_facade = self.world.new_facade(root_env)
                    root_ctx = TaskContext(task_id='t0', facade=root_facade)
                    with task_ctx(root_ctx):
                        await self._execute_flow(flow)
            except asyncio.CancelledError:
                # A1 取消诚实化（§5.4）：取消路径不再吞掉后照发 flow_done——
                # 置终态判定位 + 旁挂挂起落盘。reason 区分用户停止/外部取消。
                print("[runtime] 主协程被取消，流程终止")
                self._run_terminated = True
                self._rc_call('on_state_change', 'suspended',
                              'user_pause' if self._stopped else 'cancelled')
            except FEMORunPaused:
                # C3（§5.7）：直连模式 AI 失败挂起——节点门口断点已拍，
                # 走 suspended(node_pause) 可续跑（替换旧 task_pause 挂死）。
                self._run_terminated = True
                self._rc_call('on_state_change', 'suspended', 'node_pause')
            finally:
                self._main_task = None

            print("[DEBUG] 退出 _execute_flow")

            # 取消路径也要 wait_empty（v1 吸收论证）：stop 时 save_dialog 队列
            # 可能有未落库发言，跳过=丢台词（批次 1 实锤）；D2 修复后 10s 超时
            # 真实生效防卡（§5.8）。
            from femoCompiler.save_dialog import save_queue
            await self.engine.run_in_thread(
                save_queue.wait_empty,
                10
            )

            if not self._run_terminated:
                # 仅正常完成发 flow_done（A1 核心：取消路径不发——被取消的戏
                # 走 suspended，宿主 FSM 对"suspended 后迟到 flow_done"的拒绝
                # 是第二道防线，两道都要）。
                self._emit_event('flow_done', {})
                self._rc_call('on_run_end', 'finished')

        finally:
            print("[runtime]🧹 开始清理 Runtime 状态")

            # 关闭引擎，释放线程池和进程池
            try:
                await self.engine.shutdown()
            except Exception as e:
                print(f"[runtime] 引擎关闭异常: {e}")

            self.global_step = 0
            self.global_max_steps = 0

            self.evaluator.clear_func_cache()
            self._task_coros = {}
            self._coordinators = {}
            self._cascade = None    # run 级 JoinCascade 总线随 run 重建（嵌套 join 级联）
            self._skip_frames = set()
            self._positions = {}

            self._current_prompt = ""
            self._current_actor_info = {}

            self.speaker = {
                "current": None,
                "last": None
            }

            self._step_idx = 0
            self._oratio_idx = 0

            self._human_input_data = None

            print("[runtime]✅ Runtime 状态已重置")

    # ══════════════════════════════════════════════════
    #  条件求值
    # ══════════════════════════════════════════════════
    
    def _resolve_special_param(self, param_name: str) -> Any:
        """
        解析预留字段参数。
        prompt → 当前 action 的 prompt 文本
        @actor → actor_info 字典
        session/session_id → session ID
        turn/turn_id → turn ID
        """
        if param_name in ('prompt',):
            return self._current_prompt or ""
        if param_name in ('@actor',):
            return self._current_actor_info or {}
        if param_name in ('session', 'session_id'):
            return self._current_session_id or 0
        if param_name in ('turn', 'turn_id'):
            return self._current_turn_id or 0
        return None
        
        
    def _resolve_actor_name(self, executor_param: str) -> str:
        """把执行者参数解析为真实 actor 名。

        支持动态变量多层引用（例如 @speaker → @voter → @Cat），
        读当前变量值（局部优先于全局由 vm.get 决定）。
        """
        actor_name = executor_param
        ctx = current_task_ctx()
        facade = ctx.facade if ctx is not None else None
        while actor_name.startswith('@') and actor_name not in self.script.actors:
            if facade is None or not facade.has(actor_name):
                break
            resolved = facade.get(actor_name)
            if not resolved or not isinstance(resolved, str) or not resolved.startswith('@'):
                break
            actor_name = resolved
            print(f"[DEBUG _resolve_actor_name] 二次解析: actor_name={actor_name!r}")
        return actor_name

    def _scope_info_for(self, ad, eparam: str) -> list:
        """节点投影 scope 列表（node_start/human_wait 事件 + ai_request payload 用）。

        2026-08-31 猫猫拍板的 scope 默认语义：
        - 不写 scope / scope: 留空 = all（全员可见）——与显示层 2026-08-22 起的
          「空=未限定广播」语义对齐，消除 DB/显示两层分裂；
        - scope: self 保留字段 → [发言人演员名]：只有他自己的角色窗收到该节点
          的投影（god/stage 全量窗天然可见，owner 走 god 窗）；其他角色窗/其他
          角色视角不可见。DB 侧的 self 语义由 save_dialog._build_scope 按原始
          字符串独立判定（注入发言者自己+meta.owner），与本函数解耦；
        - 其余 scope 表达式原样走 scope_str_to_actor_list。
        """
        raw = getattr(ad, 'scope', None)
        raw = str(raw).strip() if raw else ''
        if not raw:
            raw = 'all'
        if raw.lower() == 'self':
            resolved = str(self._resolve_actor_name(eparam))
            if not resolved:
                # 无发言者（@notice 恒空；裸 @ai 也可能空）：事件 scope 置空，
                # 别产出 ['@'] 垃圾。DB 侧仍由 _build_scope 按原始字符串注入
                # 发言者/owner（notice 即仅 meta.owner 可见）。
                return []
            return [resolved if resolved.startswith('@') else f'@{resolved}']
        from .FEMO_scope_resolver import scope_str_to_actor_list
        ctx = current_task_ctx()
        facade = ctx.facade if ctx is not None else None
        return scope_str_to_actor_list(raw, self.script.actors, facade)

    def _raw_scope_for(self, ad) -> tuple:
        """DB 落库用的 (user_scope, soul_scope) 解析（save_* 各调用点共用）。

        2026-08-31 猫猫拍板：不写 scope / scope: 留空 = all（展开全部 actors，
        发言者+owner 天然包含在内）；scope: self 保留字段不在此解析（'self'
        不是合法 scope 表达式），返回空元组、连同原始字符串（调用点透传
        raw_action_scope）交由 save_dialog._build_scope 判定注入发言者+owner；
        其余表达式走 resolve_scope。节点 prompt/showprompt（femo-<id> 幕后指令
        行）跟随同一语义（猫猫拍板：节点 prompt/showprompt/AI/人类输出都跟随
        节点 scope 落库）；节点无绑定 action 时由调用点保持空 → _build_scope
        兜底注入 femo-id+owner。
        """
        from .FEMO_scope_resolver import resolve_scope
        raw = getattr(ad, 'scope', None)
        text = str(raw).strip() if raw else ''
        if text and text.lower() == 'self':
            return ([], [])
        ctx = current_task_ctx()
        facade = ctx.facade if ctx is not None else None
        return resolve_scope(text if text else 'all', self.script.actors, facade)

    def _get_actor_info(self, action, executor_param: str) -> dict:
        """解析当前 action 的 actor 信息"""
        info = {}
        actor_name = self._resolve_actor_name(executor_param)
        # 如果 executor_param 是动态变量，但解析后的 actor_name 是静态 actor，则视为静态
        if executor_param.startswith('@') and executor_param not in self.script.actors:
            if actor_name not in self.script.actors:
                # 只有解析后仍然不是静态 actor 时，才检查循环变量一致性
                ctx = _current_context.get()
                if ctx and ctx.current_loop_var is not None:
                    if executor_param != ctx.current_loop_var:
                        raise ValueError(
                            f"变量名不一致：for 循环使用 {ctx.current_loop_var}，"
                            f"但 action 定义使用 {executor_param}。请统一变量名。"
                        )
        
        if actor_name in self.script.actors:
            adef = self.script.actors[actor_name]
            adef_type = getattr(adef, 'type', None)
            atype = adef_type.value if adef_type else ''
            #print(f"[DEBUG _get_actor_info] 匹配到 actor: {actor_name}, type={atype}, soul={getattr(adef, 'soul', None)!r}, source={getattr(adef, 'source', None)!r}")
            #print(f"[runtime]found adef: {adef}")
            #print(f"[runtime]adef.__dict__: {adef.__dict__}")

            #print(f"[runtime]atype: {repr(atype)}")
            if atype == 'ai':
                soul_id = getattr(adef, 'soul', None)
                if soul_id is not None:
                    info['soul'] = str(soul_id)
                elif str(getattr(adef, 'source', None) or '').strip() == 'main':
                    # source:main 裸演员：伪 soul "main" 作为身份键（可见性/落库一致）
                    info['soul'] = 'main'
            elif atype == 'human':
                source = getattr(adef, 'source', None)
                if source is not None:
                    info['user'] = str(source)
                soul_id = getattr(adef, 'soul', None)
                if soul_id is not None:
                    info['soul'] = str(soul_id)
                # 若 source 缺失，从 meta.owner 回退
                if 'user' not in info:
                    owners = self.script.meta.get('owner', [])
                    if owners:
                        info['user'] = str(owners[0])
        else:
            print(f"[runtime]actor_name NOT FOUND in actors!")
        # 处理 human as(@soul)
        if hasattr(action, 'as_actor') and action.as_actor:
            as_name = action.as_actor
            if as_name in self.script.actors:
                soul_id = getattr(self.script.actors[as_name], 'soul', None)
                if soul_id is not None:
                    info['soul'] = str(soul_id)
        # 收集动态属性（拍板 8⑥ 词法口径）：facade.visible_view() 给出当前
        # 词法可见的全集（帧栈 shadowing 合并+shared）——遍历其中字典，提取
        # 以 actor_name 为键的条目（模块外节点收不到模块内局部字典）。
        ctx = current_task_ctx()
        if ctx is not None:
            for var_name, var_value in ctx.facade.visible_view().items():
                if isinstance(var_value, dict) and actor_name in var_value:
                    if var_name not in info:
                        info[var_name] = var_value[actor_name]
        print(f"[DEBUG _get_actor_info] 最终 actor_info = {info}")
        return info

    def _resolve_actor_def(self, action, executor_param: str):
        """解析动作执行者对应的演员定义。

        支持动态变量 @xxx 解析（执行者每轮可能是变量赋值的演员名），
        非静态演员时回退 as_actor；找不到返回 None。
        """
        actor_name = executor_param
        # 支持动态变量 @xxx 解析
        ctx = current_task_ctx()
        facade = ctx.facade if ctx is not None else None
        while actor_name.startswith('@') and actor_name not in self.script.actors:
            if facade is None or not facade.has(actor_name):
                break
            resolved = facade.get(actor_name)
            if not resolved or not isinstance(resolved, str) or not resolved.startswith('@'):
                break
            actor_name = resolved

        # 如果仍然不是静态演员，尝试 as_actor
        if not actor_name or actor_name not in self.script.actors:
            if hasattr(action, 'as_actor') and action.as_actor:
                actor_name = action.as_actor

        if actor_name in self.script.actors:
            return self.script.actors[actor_name]
        return None

    def _resolve_ai_source(self, action, executor_param: str) -> str:
        """
        解析当前 AI 动作实际调用的 API provider 标识（限流分桶用）。
        source 含 '/' 时取 provider 部分；裸 id / 无 source 回退用户自设 provider。
        返回 provider 字符串，如 "deepseek"；若无法确定则返回 "unknown"。
        """
        adef = self._resolve_actor_def(action, executor_param)
        if adef is not None:
            source = getattr(adef, 'source', None)
            if source:
                s = str(source)
                if '/' in s:
                    return s.split('/', 1)[0]

        # 回退：使用用户自设的 API provider
        if self.user_api_provider:
            return str(self.user_api_provider)

        # 兜底
        return "unknown"

    def _resolve_ai_model(self, action, executor_param: str) -> str:
        """
        直连模式：source 声明的模型覆盖配置默认模型。
        裸 id 原样使用；provider/model 取 '/' 后模型部分；无 source 用 user_api_model。
        """
        adef = self._resolve_actor_def(action, executor_param)
        if adef is not None:
            source = getattr(adef, 'source', None)
            if source:
                s = str(source)
                if '/' in s:
                    return s.split('/', 1)[1]
                return s
        return str(getattr(self, 'user_api_model', None) or '')

# ============================================================
#  便捷入口
# ============================================================
def run_script(script, base_dir: str = ".", max_steps: int = 100, event_callback=None):
    """同步快捷入口（仅用于无事件循环的场景）"""
    import asyncio
    return asyncio.run(run_script_async(script, base_dir, max_steps, event_callback))

async def run_script_async(script, base_dir: str = ".", max_steps: int = 100, event_callback=None):
    """异步快捷入口（用于 FastAPI 等异步环境）"""
    runner = FEMORunner(script, base_dir=base_dir, verbose=True, event_callback=event_callback)
    try:
        await runner.run_async(max_steps=max_steps)
    except FEMOVariableError as e:
        print(f"[runtime]\n❌ 变量错误: {e}")
        if event_callback:
            event_callback('flow_error', {'error': str(e)})
        # 不再 sys.exit，因为是在服务器里
    except Exception as e:
        print(f"[runtime]\n❌ 运行错误: {e}")
        if event_callback:
            event_callback('flow_error', {'error': str(e)})
        raise
    return runner
