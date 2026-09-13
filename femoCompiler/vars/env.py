# femoCompiler/vars/env.py
"""
vars/env.py — 运行时变量容器（语言层）
======================================
施工清单 v2 §3.2。四个组件：

- WorldStore：$ 变量唯一存储（维度 A 的 shared 侧，整场 run 一份）。
  未声明（不在 shared_names）读写一律响亮报错。
- ForkRegistry：fork 事件表 {fork_id → base 快照 + 血统}。merge 的 base
  记账（拍板 3）+ 推广 LCA 的血统依据；血统挂 fork 事件层（树）而非
  task 层（merge 多亲构成 DAG）——merge 产物的 fork_id = 本次 merge 所用
  的 LCA fork 事件 id（血统代表，链不断，三方案三版审查自我修正）。
- TaskLedger：task 活性/签到登记（join 凑齐判定的最小配套）。
- TaskEnv：单 task 的 context 帧（维度 A 的 task 私有侧，纯数据——
  frames: {frame_key: {规范名: 值}}；可 deepcopy、可序列化）。
- VarFacade：变量读写门面。绑定 (env, table, world, builtins_getter,
  key_eval, actor_names)。名字解析按**定义链**（拍板 6：词法作用域），
  值的取写沿**帧栈**（栈顶优先 = 运行期 shadowing：循环帧 > 模块帧 >
  __script__）；声明为 shared 的变量永远直通 WorldStore（声明维度说了算）。

设计约束：不 import asyncio、不发事件、不碰 IO（单事件循环协作式调度下
无 await 的读改写天然原子，无需加锁）。deepcopy 失败 fail loud（拍板 3：
不许静默退共享引用——那正是本次要根治的分支串值坑）。
"""
import copy as _copy
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

from femoCompiler.vars.model import (
    FEMOVariableError, ScopeTable, VarDecl, parse_var_path,
)

# 内建变量：引擎管理的运行时状态镜像——不进任何存储，读时经 builtins_getter
# 实时返回 runner 属性，写报只读（对齐拍板：消除 turn_count 被写提升分裂）。
BUILTIN_NAMES = ('session_id', 'turn_count')

SCRIPT_FRAME = '__script__'   # 剧本级 global+context 变量的帧


# ── WorldStore：$ 变量唯一存储 ───────────────────────────────

class WorldStore:
    """$ 变量唯一存储。shared_names 来自 ScopeTable（声明说了算）；
    未声明读写一律 FEMOVariableError（猫猫：未声明响亮报错）。"""

    def __init__(self, shared_names: frozenset, initial: Optional[Dict[str, Any]] = None):
        self._shared_names = frozenset(shared_names)
        self._shared: Dict[str, Any] = dict(initial or {})

    def _check(self, name: str) -> None:
        if name not in self._shared_names:
            raise FEMOVariableError(
                f"变量 '{name}' 未声明为 shared（$）。所有变量必须在 vars: 中预先声明。")

    def get(self, name: str) -> Any:
        self._check(name)
        return self._shared.get(name)

    def set(self, name: str, value: Any) -> None:
        self._check(name)
        self._shared[name] = value

    def slot(self, name: str) -> Tuple[Dict[str, Any], str]:
        """定位内部存储槽 (容器 dict, key)——resolve_var 的 shared 侧。"""
        self._check(name)
        return self._shared, name

    @property
    def shared_names(self) -> frozenset:
        """已声明的 shared 规范名集（run 常量；checkpoint 存取用）。"""
        return self._shared_names

    def snapshot(self) -> Dict[str, Any]:
        return dict(self._shared)

    def restore(self, data: Dict[str, Any]) -> None:
        self._shared = dict(data or {})

    def seed_missing(self, declared: frozenset, initials: Dict[str, Any]) -> list:
        """断点续跑 vars 增删容差（2026-09-06 用户拍板）：新剧本声明了而
        快照世界没有的 shared 变量——声明集并入 + 按声明初值补种，返回补种
        名列表。孤儿（快照有、新剧本已删）不在此处理：无人读即无害。"""
        added = frozenset(declared) - self._shared_names
        if added:
            self._shared_names = frozenset(self._shared_names | added)
        seeded = []
        for name, value in (initials or {}).items():
            if name not in self._shared:
                self._shared[name] = value
                seeded.append(name)
        return seeded


# ── ForkRegistry：fork 事件表（base 记账 + 血统） ────────────

@dataclass
class ForkEvent:
    fork_id: str                       # 'f1','f2',...
    base_frames: Dict[str, Dict[str, Any]]   # fork 时点母 task frames 的 deepcopy
    mother_task_id: str
    parent_event: Optional[str]        # 母 task 的 fork_id（root 产物=None）→ 血统链
    gateway_id: str                    # 产生本事件的 fork 网关节点 id
    children: Tuple[str, ...] = ()


class ForkRegistry:
    """fork 事件表。base 记账（拍板 3）+ 血统链（推广 LCA）。
    只服务于 merge/join；parse 与调度不知道它的存在。"""

    def __init__(self):
        self._events: Dict[str, ForkEvent] = {}
        self._seq = 0
        self._root_base: Optional[Dict[str, Dict[str, Any]]] = None

    def next_fork_id(self) -> str:
        self._seq += 1
        return f"f{self._seq}"

    def register_root(self, base_frames: Dict[str, Dict[str, Any]]) -> None:
        """run 装配时登记 root 快照（root task 初始 frames 的 deepcopy）。"""
        self._root_base = deepcopy_frames(base_frames, "register_root")

    def register(self, fork_id: str, base_frames: Dict[str, Dict[str, Any]],
                 mother_task_id: str, parent_event: Optional[str],
                 gateway_id: str, children: Tuple[str, ...]) -> None:
        """fork 执行器调用：base = 母 task frames 的 deepcopy（拍板 3）。
        【可选优化暂不启用】母 task 终止后 frames 恒定冻结，base 可存引用
        免一次拷贝——默认 deepcopy 防御"fork 后再写母 env"的污染。"""
        self._events[fork_id] = ForkEvent(
            fork_id=fork_id,
            base_frames=deepcopy_frames(base_frames, f"fork {fork_id}"),
            mother_task_id=mother_task_id,
            parent_event=parent_event,
            gateway_id=gateway_id,
            children=tuple(children),
        )

    def get_event(self, fork_id: str) -> ForkEvent:
        ev = self._events.get(fork_id)
        if ev is None:
            raise FEMOVariableError(f"fork 事件 '{fork_id}' 不存在")
        return ev

    def get_base(self, fork_id: str) -> Dict[str, Dict[str, Any]]:
        return self.get_event(fork_id).base_frames

    def has_gateway_event(self, gateway_id: str) -> bool:
        """该 fork 网关是否已发生过任何 fork 事件（含零活跃分支的空事件——
        fork 执行器接线约定：零活跃分支也 register children=()；join 协调器
        的 unseen 判定据此剪除已发生网关，防 join(all) 死等）。"""
        return any(ev.gateway_id == gateway_id for ev in self._events.values())

    def child_fork_of(self, task_id: str) -> Optional[ForkEvent]:
        """task_id 作为母 task 产生的 fork 事件（宪法 1.1：task fork 后即
        终止，至多产生一个孩子事件；root/merge 产物 None）。join 等待集
        下钻用：血脉已延续的母 task 不算"未到达 join"（vars/join 的
        _collect_live_children 递归到血脉叶子）。"""
        for ev in self._events.values():
            if ev.mother_task_id == task_id:
                return ev
        return None

    def root_base(self) -> Dict[str, Dict[str, Any]]:
        if self._root_base is None:
            raise FEMOVariableError("root base 快照尚未登记（run 装配缺失）")
        return self._root_base

    def fork_chain(self, start_fork_id: Optional[str]) -> List[str]:
        """血统链：start（最近）→ 根，沿 parent_event 上溯。"""
        chain: List[str] = []
        fid = start_fork_id
        seen = set()
        while fid is not None:
            if fid in seen:
                raise FEMOVariableError(f"fork 血统链循环引用于 {fid!r}")
            seen.add(fid)
            chain.append(fid)
            fid = self.get_event(fid).parent_event
        return chain

    def lca_base(self, fork_ids: List[Optional[str]]) -> Tuple[Dict[str, Dict[str, Any]], Optional[str], str]:
        """推广 LCA：各 fork_id 沿血统链上溯，取最近公共 fork 事件的 base。
        全同源 → 该事件 base；无公共 fork（跨树乱 join/含未登记产物）→
        root_base 兜底（保守正确：冲突多判也只是丢弃+警告）。
        返回 (base_frames, lca_fork_id|None, 来源说明串)——lca_fork_id 作为
        merge 产物的血统代表（链连续，三方案三版审查自我修正）；来源说明串
        进 merge_conflict 事件便于排查。"""
        non_null = [f for f in fork_ids if f is not None]
        if not non_null or len(non_null) != len(fork_ids):
            return self.root_base(), None, "root 兜底（存在无 fork 血统的到达者）"
        chains = [self.fork_chain(f) for f in non_null]
        common = set(chains[0])
        for c in chains[1:]:
            common &= set(c)
        if not common:
            return self.root_base(), None, "root 兜底（到达者无公共 fork 祖先）"
        # 最近公共祖先 = 在所有链中都存在、且离 start 最近（链内 index 最小）
        # 者——链首是最近的 fork 事件。此前误写 max（注释还写反了：链内
        # index 大是离根近、离 start 远），join 分支血统深度 ≥2 时（如模块内
        # par 从外层 fork 第二次进入起）base 错拿祖先的进模块前快照：空模块
        # 帧被 merge 抹掉后 restore_stack 抛「模块帧不在 env 中」，实锤于
        # 谁是卧底 模块内投票 par（2026-09-12 修）。
        best = min(common, key=lambda f: min(c.index(f) for c in chains))
        return self.get_base(best), best, f"LCA fork 事件 {best}"

    def snapshot(self) -> Dict[str, Any]:
        return {
            'seq': self._seq,
            'root_base': self._root_base,
            'events': {
                fid: {'base_frames': ev.base_frames, 'mother': ev.mother_task_id,
                      'parent_event': ev.parent_event, 'gateway_id': ev.gateway_id,
                      'children': list(ev.children)}
                for fid, ev in self._events.items()},
        }

    def restore(self, data: Dict[str, Any]) -> None:
        self._seq = int(data.get('seq', 0))
        self._root_base = data.get('root_base')
        self._events = {}
        for fid, ev in (data.get('events') or {}).items():
            self._events[fid] = ForkEvent(
                fork_id=fid, base_frames=ev['base_frames'], mother_task_id=ev['mother'],
                parent_event=ev['parent_event'], gateway_id=ev['gateway_id'],
                children=tuple(ev['children']))


# ── TaskLedger：task 活性/签到登记 ───────────────────────────

@dataclass
class TaskInfo:
    fork_id: Optional[str]      # 由哪次 fork 产生（root=None；merge 产物=LCA 事件 id）
    alive: bool = True
    signed_in: bool = False


class TaskLedger:
    """task 活性与签到登记（join 凑齐判定的最小配套——拓扑等待集里
    「signed_in ∪ 已终止」的查询源）。merge 产物经 register_merge 登记，
    fork_id 记 LCA 事件（血统代表）。"""

    def __init__(self):
        self._tasks: Dict[str, TaskInfo] = {}

    def register(self, task_id: str, fork_id: Optional[str]) -> None:
        self._tasks[task_id] = TaskInfo(fork_id=fork_id)

    def register_children(self, fork_id: str, child_ids) -> None:
        """fork 执行器批量登记孩子（全部 alive、未签到）。"""
        for cid in child_ids:
            self.register(cid, fork_id)

    def register_merge(self, task_id: str, lca_fork_id: Optional[str]) -> None:
        """merge 产物登记：fork_id 记本次 merge 的 LCA fork 事件（血统代表，
        链连续——三方案三版审查自我修正）。"""
        self.register(task_id, lca_fork_id)

    def mark_dead(self, task_id: str) -> None:
        self._require(task_id).alive = False

    def sign_in(self, task_id: str) -> None:
        self._require(task_id).signed_in = True

    def alive(self, task_id: str) -> bool:
        return self._require(task_id).alive

    def signed_in(self, task_id: str) -> bool:
        return self._require(task_id).signed_in

    def fork_id_of(self, task_id: str) -> Optional[str]:
        return self._require(task_id).fork_id

    def _require(self, task_id: str) -> TaskInfo:
        info = self._tasks.get(task_id)
        if info is None:
            raise FEMOVariableError(f"task '{task_id}' 未在 TaskLedger 登记")
        return info

    def snapshot(self) -> Dict[str, Any]:
        return {tid: {'fork_id': t.fork_id, 'alive': t.alive, 'signed_in': t.signed_in}
                for tid, t in self._tasks.items()}

    def restore(self, data: Dict[str, Any]) -> None:
        self._tasks = {tid: TaskInfo(fork_id=t['fork_id'], alive=t['alive'],
                                     signed_in=t['signed_in'])
                       for tid, t in (data or {}).items()}


# ── TaskEnv：单 task 的 context 帧（纯数据） ─────────────────

class TaskEnv:
    """单 task 的 context 变量环境（维度 A 的 task 私有侧）。
    frames: {frame_key: {规范名: 值}}
      frame_key：'__script__'=剧本级 global+context；模块完整路径=模块 local；
      循环网关 id=循环变量（拍板 1：join 收口删帧豁免 merge）。
    纯数据（不持有 table/world/runner 引用），可 deepcopy、可 JSON 序列化。"""

    def __init__(self, task_id: str, frames: Dict[str, Dict[str, Any]],
                 fork_id: Optional[str] = None):
        self.task_id = task_id
        self.frames = frames
        self.fork_id = fork_id

    @classmethod
    def create_root(cls, task_id: str, global_initials: Dict[str, Any]) -> 'TaskEnv':
        """root task 装配：剧本级初值进 '__script__' 帧。
        （替代 FEMORunner.__init__ 的 VarManager(script.vars) + ast.literal_eval
        二段求值——初值求值合并到装配点一次完成。）"""
        return cls(task_id=task_id, frames={SCRIPT_FRAME: dict(global_initials or {})},
                   fork_id=None)

    def deepcopy_for(self, new_task_id: str, new_fork_id: str) -> 'TaskEnv':
        """fork 值复制（拍板 3/4：deepcopy 嵌套容器一并复制，非指针）。
        换 task_id/fork_id；base 不在 env 上（在 ForkRegistry），不会被连带复制。
        deepcopy 失败（变量含文件句柄等不可拷对象）→ FEMOVariableError 响亮
        报错（拍板 3；不许静默退共享引用——那正是本次要根治的分支串值坑）。"""
        try:
            clone = _copy.deepcopy(self)
        except Exception as e:
            raise FEMOVariableError(
                f"fork 值复制失败：task '{self.task_id}' 的 context 含不可深拷贝对象"
                f"（{type(e).__name__}: {e}）。变量中不应存放此类对象"
                f"（文件句柄/连接等）——请改为存放其描述（路径/id）。") from e
        clone.task_id = new_task_id
        clone.fork_id = new_fork_id
        return clone

    def flatten(self) -> Dict[Tuple[str, str], Any]:
        """{(frame_key, 规范名): 值}——merge 与 checkpoint 的统一视图。"""
        out: Dict[Tuple[str, str], Any] = {}
        for fk, frame in self.frames.items():
            for name, value in frame.items():
                out[(fk, name)] = value
        return out


def deepcopy_frames(frames: Dict[str, Dict[str, Any]], where: str) -> Dict[str, Dict[str, Any]]:
    """frames 深拷贝（fail loud）——base 快照与 fork base 记账共用。
    （2026-09-05 R1 转公开：task_world.fork_branches 复用；原 _deepcopy_frames
    私有名仅本文件 3 处内部引用，改名零风险。）"""
    try:
        return _copy.deepcopy(frames)
    except Exception as e:
        raise FEMOVariableError(
            f"{where}: base 快照深拷贝失败（{type(e).__name__}: {e}）。"
            f"变量中不应存放不可深拷贝对象。") from e


# ── VarFacade：变量读写门面 ─────────────────────────────────

_ABSENT = object()


class VarFacade:
    """变量读写门面：执行器所有变量读写经此；fork/merge/checkpoint 直接
    操作 TaskEnv 不经门面。

    名字解析（两段式）：
    1. 声明合法性 = ScopeTable.lookup(name, def_chain)——词法，拍板 6；
       查不到 → 未声明响亮报错（@名 在 actor_names 的静态演员引用除外）。
    2. 值定位 = 沿帧栈从顶向下找第一个含此名的帧（运行期 shadowing：
       循环帧 > 模块帧 > __script__）；栈中无 → 声明 owner 帧取声明初值。
    写定位：栈帧命中改之（循环变量 SET VARIABLE 改循环帧、模块内写母变量
    改母帧）；栈中无 → 声明 owner 帧。声明为 shared → 永远直通 WorldStore。

    替代 VarManager 全类：get/has/set/resolve_var 接口同名保留，
    block_collector / FEMO_scope_resolver / actor_resolver 换绑即可。"""

    def __init__(self, env: TaskEnv, table: ScopeTable, world: WorldStore,
                 builtins_getter: Optional[Callable[[str], Any]] = None,
                 key_eval: Optional[Callable[[str, 'VarFacade'], Any]] = None,
                 actor_names: frozenset = frozenset()):
        self._env = env
        self._table = table
        self._world = world
        self._builtins = builtins_getter
        self._key_eval = key_eval
        self._actor_names = frozenset(actor_names)
        self._stack_frames: List[str] = [SCRIPT_FRAME]
        self._mod_stack: List[str] = []       # 模块帧栈（循环帧不在此）

    # ── 作用域状态 ──
    @property
    def def_chain(self) -> Tuple[str, ...]:
        """当前执行模块的静态定义链（词法，拍板 6）——由模块栈顶推导，
        与运行期调用历史无关。"""
        if not self._mod_stack:
            return ()
        return self._table.module_def_chain(self._mod_stack[-1])

    def _decl(self, root: str):
        return self._table.lookup(root, self.def_chain)

    def _decl_for(self, root: str):
        """引用入口的声明解析：'$x' 前缀引用剥前缀查声明，且要求该名字
        声明为 shared（'$x 即显式直取全局那份'；引用未声明为 shared 的
        $x → None → 未声明响亮报错，对齐旧 resolve 的 find_shared 语义）。"""
        if root.startswith('$'):
            decl = self._table.lookup(root[1:], self.def_chain)
            if decl is None or not decl.shared:
                return None
            return decl
        return self._table.lookup(root, self.def_chain)

    def _frame_hit(self, root: str):
        """沿帧栈从顶向下找第一个含 root 的帧 → (frame_key, frame)；无 → None。"""
        for fk in reversed(self._stack_frames):
            frame = self._env.frames.get(fk)
            if frame is not None and root in frame:
                return fk, frame
        return None

    def _owner_frame(self, decl: VarDecl) -> Dict[str, Any]:
        fk = decl.owner or SCRIPT_FRAME
        frame = self._env.frames.get(fk)
        if frame is None:
            raise FEMOVariableError(
                f"变量 '{decl.name}' 的声明帧 '{fk}' 不存在（模块未激活却引用其 local）")
        return frame

    def _base_object(self, root: str, decl: VarDecl):
        """root 的值：栈帧命中 → 声明 owner 帧初值；都无 → 已声明无值报错。"""
        hit = self._frame_hit(root)
        if hit is not None:
            return hit[1][root]
        frame = self._owner_frame(decl)
        obj = frame.get(root, _ABSENT)
        if obj is _ABSENT:
            raise FEMOVariableError(
                f"变量 '{root}' 已声明但当前 task 中无值（帧 '{decl.owner or SCRIPT_FRAME}' 未装配）。")
        return obj

    # ── 内建 ──
    def _builtin(self, name: str) -> Any:
        if self._builtins is None:
            raise FEMOVariableError(f"内建变量 '{name}' 的直通层未接线")
        return self._builtins(name)

    # ── 读 ──
    def get(self, path: str) -> Any:
        """读变量。路径支持 hp.@wolf / task_list[@coder] / a.b[0]；
        动态键经注入的 key_eval（完整帧路由，修复旧 _eval_key 只查 globals）。"""
        if not path:
            return None
        if path in BUILTIN_NAMES:
            return self._builtin(path)
        p = parse_var_path(path)
        decl = self._decl_for(p.root)
        if decl is None:
            if p.root in self._actor_names and not p.keys:
                return p.root            # 静态演员引用：返回名字本身（旧语义）
            raise FEMOVariableError(
                f"变量 '{p.root}' 未声明。所有变量必须在 vars: 中预先声明。")
        if decl.shared:
            obj = self._world.get(decl.name)
        else:
            obj = self._base_object(p.root, decl)
        return self._drill(obj, p.keys)

    def has(self, name: str) -> bool:
        """名字当前是否可读（温和版：未声明/无值 → False，不报错）。"""
        try:
            self.get(name)
            return True
        except FEMOVariableError:
            return False

    def _has(self, name: str) -> bool:     # 兼容旧内部调用点（_exec_assign 等）
        return self.has(name)

    # ── 键下钻 ──
    def _resolve_key(self, key) -> Any:
        from femoCompiler.vars.model import Literal, Expr
        if isinstance(key, Literal):
            return key.value
        # Expr：动态键求值——注入回调优先（Evaluator.eval_key，完整帧路由）；
        # 未注入时字面量兜底（去引号/int）。
        if self._key_eval is not None:
            return self._key_eval(key.src, self)
        t = key.src.strip()
        if (t.startswith('"') and t.endswith('"')) or (t.startswith("'") and t.endswith("'")):
            return t[1:-1]
        try:
            return int(t)
        except ValueError:
            return t

    def _drill(self, obj: Any, keys, value: Any = _ABSENT) -> Any:
        """沿 keys 下钻读取；value 非 _ABSENT 时为就地写入模式。"""
        from femoCompiler.vars.model import Literal, Expr
        for i, key in enumerate(keys):
            is_last = (i == len(keys) - 1)
            k = self._resolve_key(key)
            if is_last and value is not _ABSENT:
                if isinstance(obj, dict):
                    obj[k] = value
                elif isinstance(obj, (list, tuple)):
                    obj[int(k)] = value
                else:
                    setattr(obj, k, value)
                return value
            if isinstance(obj, dict):
                obj = obj.get(k)
            elif isinstance(obj, (list, tuple)):
                obj = obj[int(k)] if isinstance(k, int) or str(k).isdigit() else obj[str(k)]
            else:
                obj = getattr(obj, k, None)
            if obj is None and not is_last:
                break       # 中间层 None：结果 None（保留旧 _drill 语义）
        return obj

    # ── 写 ──
    def set(self, path: str, value: Any) -> Any:
        """写变量。整变量赋值：栈帧命中改之（shadowing），否则声明 owner 帧。
        路径赋值（hp.@wolf=50）：容器就地改——容器在哪本账就改哪本
        （context=本 task 副本；shared=全局一份，就地改即全局生效）。"""
        if not path:
            raise FEMOVariableError("变量路径为空，无法赋值")
        if path in BUILTIN_NAMES:
            raise FEMOVariableError(
                f"'{path}' 是引擎管理的内建只读变量，剧本不可赋值。")
        p = parse_var_path(path)
        decl = self._decl_for(p.root)
        if decl is None:
            raise FEMOVariableError(
                f"变量 '{p.root}' 未声明，无法赋值。请在 vars: 中声明该变量。")
        if decl.shared and not p.keys:
            self._world.set(decl.name, value)
            return value
        if not p.keys:
            hit = self._frame_hit(p.root)
            if hit is not None:
                hit[1][p.root] = value
            else:
                self._owner_frame(decl)[p.root] = value
            return value
        # 路径写：先按读逻辑取容器（不含最后一段），就地写
        if decl.shared:
            obj = self._world.get(decl.name)
        else:
            obj = self._base_object(p.root, decl)
        return self._drill(obj, p.keys, value=value)

    def resolve_var(self, name: str) -> Tuple[Dict[str, Any], str]:
        """定位到 (容器 dict, key)，调用方可直接读/写该槽位（旧接口同名）。"""
        decl = self._decl_for(name)
        if decl is None:
            raise FEMOVariableError(
                f"变量 '{name}' 未声明。所有变量必须在 vars: 中预先声明。")
        if decl.shared:
            return self._world.slot(decl.name)
        hit = self._frame_hit(name)
        if hit is not None:
            return hit[1], name
        return self._owner_frame(decl), name

    # ── 赋值意图 ──
    def apply_intent(self, name: str, intent: Tuple[str, Any]) -> None:
        """('set', v) / ('increment', n) / ('add', item) / ('remove', item)。
        替代模块级 apply_assign(vm,...) 的 vm 调用层；意图判定仍在
        parse_assign_syntax（不动），落地统一在此。"""
        op, val = intent
        if op == 'set':
            self.set(name, val)
        elif op == 'increment':
            current = self.get(name) or 0
            self.set(name, current + val)
        elif op == 'add':
            current = self.get(name) or []
            if not isinstance(current, list):
                current = [current]
            if val not in current:
                current.append(val)
            self.set(name, current)
        elif op == 'remove':
            current = self.get(name) or []
            if isinstance(current, list) and val in current:
                current.remove(val)
            self.set(name, current)
        else:
            raise FEMOVariableError(f"未知赋值操作 '{op}'（变量 '{name}'）")

    # ── 帧：模块进出 / 循环进出 ──
    def enter_module(self, mod_path: str, initials: Dict[str, Any]) -> None:
        """进入模块：push 模块帧（local 初值）。替代旧 _run_module 直写
        vm.globals 且退出不清的 bug 点；声明为 $ 的初值键防御性跳过
        （shared 不进帧、不随模块进出销毁——全局一份语义）。"""
        env_frames = self._env.frames
        if mod_path in env_frames:
            raise FEMOVariableError(
                f"模块 '{mod_path}' 的帧已存在（同 task 递归进入同模块不支持，"
                f"请改用全局变量控制跳出或调整流程）。")
        filtered = {}
        for name, val in (initials or {}).items():
            decl = self._table.lookup(name, self._table.module_def_chain(mod_path))
            if decl is not None and decl.shared:
                continue
            filtered[name] = val
        env_frames[mod_path] = filtered
        self._stack_frames.append(mod_path)
        self._mod_stack.append(mod_path)

    def exit_module(self) -> None:
        """退出模块：pop 帧 + 删除帧内全部键（模块 local 出模块即清，宪法 1.2）。"""
        if not self._mod_stack:
            raise FEMOVariableError("模块栈为空，无法退出模块")
        mod_path = self._mod_stack[-1]
        if self._stack_frames[-1] != mod_path:
            raise FEMOVariableError(
                f"模块 '{mod_path}' 退出时栈顶不是其帧（{self._stack_frames[-1]!r}）"
                f"——循环帧未平衡，执行流状态错误。")
        self._mod_stack.pop()
        self._stack_frames.pop()
        self._env.frames.pop(mod_path, None)

    def push_loop_frame(self, gw_id: str) -> None:
        """for/par 循环变量专用帧（拍板 1：join 收口删帧豁免 merge）。"""
        if gw_id in self._env.frames:
            raise FEMOVariableError(f"循环帧 '{gw_id}' 已存在（循环未平衡）")
        self._env.frames[gw_id] = {}
        self._stack_frames.append(gw_id)

    def pop_loop_frame(self, gw_id: str) -> None:
        if not self._stack_frames or self._stack_frames[-1] != gw_id:
            raise FEMOVariableError(
                f"循环帧 '{gw_id}' 不在栈顶，无法弹出（循环未平衡）")
        self._stack_frames.pop()
        self._env.frames.pop(gw_id, None)

    def set_loop_var(self, gw_id: str, name: str, value: Any) -> None:
        """循环变量写入（执行器专用通道：for/par 每迭代写循环帧）。"""
        frame = self._env.frames.get(gw_id)
        if frame is None:
            raise FEMOVariableError(f"循环帧 '{gw_id}' 不存在（未 push）")
        frame[name] = value

    # ── 接线口子（2026-09-05 R1，清单 v2 §3.2"vars 三口子"+export_stack）──
    @property
    def env(self) -> TaskEnv:
        """只读暴露本 task 的 TaskEnv——fork 执行器（base deepcopy）、join
        协调器（env 交接）、checkpoint（序列化）的公开通道；runner 不摸
        `_env` 私有属性。"""
        return self._env

    def visible_view(self) -> Dict[str, Any]:
        """当前词法可见的变量全集：沿帧栈 shadowing 合并（栈顶优先）+ shared
        全部（与帧名空间不相交——声明唯一）。消费者：_get_actor_info 动态
        属性收集（拍板 8⑥ 词法口径，替代旧 globals+locals 全量遍历）。"""
        view: Dict[str, Any] = {}
        for fk in self._stack_frames:
            frame = self._env.frames.get(fk)
            if frame:
                view.update(frame)
        view.update(self._world.snapshot())
        return view

    def export_stack(self) -> Tuple[Tuple[str, ...], Tuple[str, ...]]:
        """导出 (模块栈, 循环帧栈)——fork 分支继承栈结构的读侧（与
        restore_stack 对称）。栈是协程私有，跨协程只传结构不传实例。"""
        loop_keys = tuple(k for k in self._stack_frames
                          if k != SCRIPT_FRAME and k not in self._mod_stack)
        return tuple(self._mod_stack), loop_keys

    def restore_stack(self, mod_stack, loop_frames) -> None:
        """按给定模块栈+循环帧栈重建（服务幸运者变身与断点直启）。
        - 模块帧必须已存在于 env.frames（变身场景 merged env 含模块帧数据；
          直启场景 checkpoint 快照含）——缺失=词法链断裂，响亮报错；
        - 循环帧：env.frames 已有则复用（直启场景，快照带数据）；没有则
          重建为空帧（变身场景 D5B：merge skip 掉循环帧，下一轮迭代重写）。"""
        for mk in mod_stack:
            if mk not in self._env.frames:
                raise FEMOVariableError(
                    f"restore_stack: 模块帧 '{mk}' 不在 env 中（词法链断裂）")
        for gw in loop_frames:
            if gw == SCRIPT_FRAME or gw in mod_stack:
                raise FEMOVariableError(
                    f"restore_stack: 循环帧键 '{gw}' 与模块栈/剧本帧冲突")
            if gw not in self._env.frames:
                self._env.frames[gw] = {}
        self._mod_stack = list(mod_stack)
        self._stack_frames = [SCRIPT_FRAME] + list(mod_stack) + list(loop_frames)

    # ── 调试 ──
    def __repr__(self):
        return (f"VarFacade(task={self._env.task_id}, def_chain={self.def_chain}, "
                f"frames={list(self._env.frames)}, stack={list(self._stack_frames)})")
