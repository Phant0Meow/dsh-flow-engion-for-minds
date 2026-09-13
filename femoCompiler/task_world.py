# femoCompiler/task_world.py
"""
task_world.py — vars 变量子系统与执行引擎之间的接线适配层
==========================================================
施工清单 v2 §3.7（2026-09-05 三次合流定稿）。依赖方向单向无环：
`vars/* ← task_world ← FEMO_runtime`——本文件只 import vars 包（duck 访问
script/flow，不 import FEMO_parser/FEMO_runtime，避免任何反向依赖）。

两层 task 概念的桥（清单 §1.2）：
- asyncio.Task（协程原语，femoAsync，零改动）；
- 剧本 task 号（t0,t1,...，语义层单链）——桥 = runner 侧一张
  `_task_coros: {task_id: asyncio.Task}` 映射表（join(N) 掐尾
  `_task_coros[tid].cancel()`，stop() 对它双保险）。

职责（唯一新文件，约 300 行）：
- TaskContext / ModuleFrame：瘦身执行上下文（替代 ExecutionContext 的执行流
  职责；locals 变量职责归 facade.env）；
- _task_ctx(contextvars) + task_ctx()：每协程绑一个 TaskContext——
  asyncio.create_task 会 copy_context，分支协程内 set 不回渗母协程；
- TaskIdGen：t<seq> 分配器（checkpoint 恢复后取最大号 +1 续分配防撞号）；
- TaskWorld：assemble_world 的一次装配产物（table/world/forks/ledger/
  evaluator/envs 登记表 + idgen + builtins_getter）；
- fork_branches / branch_main / join_sign_in：fork/join 执行器辅助
  （R3 接线时由 FEMORunner 调用；本文件不自行起跑）；
- GraphQuery：join 入边图拓扑反溯（当前 flow 图内，模块边界即停）。

设计约束：不发事件（emit_event 由 runner 注入协调器）、不碰 IO；核心判定
同步无 await——单事件循环内签到+判定+唤醒原子，规避 check-then-act 竞态。
"""
import ast
import asyncio
import contextvars
import copy as _copy
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from femoCompiler.vars.env import (
    SCRIPT_FRAME, ForkRegistry, TaskEnv, TaskLedger, VarFacade, WorldStore,
    deepcopy_frames,
)
from femoCompiler.vars.evaluator import Evaluator
from femoCompiler.vars.join import JoinCascade, JoinCoordinator
from femoCompiler.vars.merge import merge_frames
from femoCompiler.vars.model import FEMOVariableError, ScopeTable


# ── 执行上下文 ───────────────────────────────────────────────

@dataclass
class ModuleFrame:
    """模块执行流帧（步数限制用）——name 为模块完整路径（'Outer.Inner'），
    与 ScopeTable owner / TaskEnv 帧键同构。
    caller_node_id = 母 flow 中绑定本模块的调用节点（R4 断点续跑补：直启
    恢复跑完模块 flow 后按它回母 flow 续传——正常场景由母协程收场后继续，
    直启场景母协程不存在；普通 fork 分支不消费此字段）。"""
    name: str
    step: int = 0
    max_steps: int = 0
    caller_node_id: str = ""


@dataclass
class TaskContext:
    """每协程一个的执行上下文（contextvars 隔离；栈是协程私有状态，
    跨协程只经 export_stack/restore_stack 传结构，绝不共享实例——接线约定 1）。
    resume_unwind_pending（R4）：断点恢复 run 中 join 变身者的标记——变身者
    携 merge 产物跑完模块 flow 到 [OUT] 后，由 branch_main 调
    _resume_module_unwind 逐层弹栈回母 flow 续传（正常 run 的变身者不置位：
    母协程 gather 收场后本来就会继续母 flow，重复 unwind 会双跑 mainflow）。"""
    task_id: str
    facade: VarFacade
    current_node_id: str = ""
    current_loop_var: Optional[str] = None
    module_frames: List[ModuleFrame] = field(default_factory=list)
    resume_unwind_pending: bool = False


_task_ctx: contextvars.ContextVar = contextvars.ContextVar('femo_task_ctx', default=None)


def current_task_ctx() -> Optional[TaskContext]:
    return _task_ctx.get()


@contextmanager
def task_ctx(ctx: TaskContext):
    """进入某 task 的执行上下文（with 用；退出 reset——与旧
    ExecutionContext.__enter__/__exit__ 同语义）。适用：完整包裹分支生命周期
    的场景。⚠️ join 变身**不用**它——变身是"协程余下生命周期全部属于新
    task"，用 set_task_ctx（set 不 reset：协程死亡后其 context 副本自然
    消亡，不会泄漏到其他协程）。"""
    token = _task_ctx.set(ctx)
    try:
        yield ctx
    finally:
        _task_ctx.reset(token)


def set_task_ctx(ctx: TaskContext) -> None:
    """set 不 reset（变身专用）：join 幸运者协程从此以后都属于新 task；
    若用 with 版会在函数返回时 reset 回死掉的母 task，出口节点读不到新
    环境（R1 单测抓出的真设计错误）。"""
    _task_ctx.set(ctx)


# ── task 号分配器 ────────────────────────────────────────────

class TaskIdGen:
    """t<seq> 分配器。root='t0' 手动装配；next() 从 t1 起。
    断点恢复：restore_from(快照最大号) 续分配防撞号（清单 D8）。"""

    def __init__(self, start: int = 0):
        self._seq = start

    def next(self) -> str:
        self._seq += 1
        return f"t{self._seq}"

    def restore_from(self, max_used: int) -> None:
        self._seq = max(int(max_used), self._seq)

    @staticmethod
    def max_task_seq(ids) -> int:
        """从 task_id 集合提取最大序号（'t12' → 12；非 t 前缀忽略）。"""
        best = 0
        for tid in ids or ():
            if isinstance(tid, str) and tid.startswith('t') and tid[1:].isdigit():
                best = max(best, int(tid[1:]))
        return best


# ── 一次装配产物 ─────────────────────────────────────────────

def _normalize_initial(value: Any) -> Any:
    """声明初值 literal_eval 归一（对齐旧 FEMORunner.__init__ L793-801 的
    二段求值：parser 产出中仍为字符串形态的结构（嵌套字典等）在此展开；
    普通文本 literal_eval 失败原样保留——行为逐项一致）。"""
    if isinstance(value, str):
        try:
            return ast.literal_eval(value)
        except (ValueError, SyntaxError):
            return value
    return value


class TaskWorld:
    """assemble_world 的一次装配产物：本 run 的全部变量世界组件 +
    存活 task 的 env 登记表 + facade 工厂。"""

    def __init__(self, table: ScopeTable, world: WorldStore, forks: ForkRegistry,
                 ledger: TaskLedger, evaluator: Evaluator, idgen: TaskIdGen,
                 actor_names: frozenset = frozenset(),
                 builtins_getter: Optional[Callable[[str], Any]] = None):
        self.table = table
        self.world = world
        self.forks = forks
        self.ledger = ledger
        self.evaluator = evaluator
        self.idgen = idgen
        self.actor_names = frozenset(actor_names)
        self.builtins_getter = builtins_getter
        self.envs: Dict[str, TaskEnv] = {}       # 存活 task 的 env 登记（checkpoint dump 用）

    # ── env 登记 ──
    def register_env(self, env: TaskEnv) -> None:
        self.envs[env.task_id] = env

    def drop_env(self, task_id: str) -> None:
        self.envs.pop(task_id, None)             # task 死亡时移除（幂等）

    # ── facade 工厂（每协程一个实例——接线约定 1）──
    def new_facade(self, env: TaskEnv) -> VarFacade:
        return VarFacade(env, self.table, self.world,
                         builtins_getter=self.builtins_getter,
                         key_eval=self.evaluator.eval_key,
                         actor_names=self.actor_names)

    # ── checkpoint 支撑 ──
    def max_task_seq(self) -> int:
        return TaskIdGen.max_task_seq(self.envs.keys())


def assemble_world(script, builtins_getter: Optional[Callable[[str], Any]] = None,
                   code_modules: Optional[Dict[str, Any]] = None) -> TaskWorld:
    """run 装配一次成型（替代 FEMORunner.__init__ 的 VarManager + literal_eval
    二段求值 + session/turn 写 globals）。script duck 访问：scope_table（步骤 B
    产物）/ actors。root task = 't0'（环境变量归属 __script__ 帧）。"""
    table: ScopeTable = getattr(script, 'scope_table', None)
    if table is None:
        raise FEMOVariableError(
            "script.scope_table 未装配（parse_script 步骤 B 产物缺失）——"
            "请先经 FEMO_parser.parse_script 构造 Script。")
    shared_initials = {k: _normalize_initial(v)
                       for k, v in table.initials_shared().items()}
    global_initials = {k: _normalize_initial(v)
                       for k, v in table.initials_global_context().items()}
    world = WorldStore(table.shared_names(), shared_initials)
    forks = ForkRegistry()
    ledger = TaskLedger()
    evaluator = Evaluator(script.actors, code_modules)
    actor_names = frozenset(getattr(script, 'actors', {}) or {})
    tw = TaskWorld(table=table, world=world, forks=forks, ledger=ledger,
                   evaluator=evaluator, idgen=TaskIdGen(start=0),
                   actor_names=actor_names, builtins_getter=builtins_getter)
    root_env = TaskEnv.create_root('t0', global_initials)
    tw.register_env(root_env)
    ledger.register('t0', None)
    forks.register_root(deepcopy_frames(root_env.frames, 'register_root'))
    return tw


def seed_new_declarations(tw: TaskWorld, script) -> Tuple[list, list]:
    """断点续跑 vars 增删容差（2026-09-06 用户拍板）：快照世界整包恢复后，
    新剧本声明了而快照世界没有的变量按声明初值补种；快照有而新剧本已删的
    成为孤儿值（无人读即无害——不删，留档防别处引用）。
    返回 (补种名列表, 孤儿名列表)。
    ⚠️ 语义边界：补种值=声明初值，不是"运行到断点时该有的中间态"——续跑
    路径期望中间态的，需作者在续跑前显式赋值（SET VARIABLE / 投影窗输入）。"""
    table: ScopeTable = getattr(tw, 'table', None)
    seeded: list = []
    orphaned: list = []
    if table is None:
        return seeded, orphaned
    # 1) shared（WorldStore）：新声明的 shared 名并入声明集 + 缺失初值补种
    ws: WorldStore = tw.world
    seeded += ['$' + n for n in ws.seed_missing(
        table.shared_names(),
        {k: _normalize_initial(v) for k, v in table.initials_shared().items()})]
    declared_shared = table.shared_names()
    for name in ws.snapshot():
        if name not in declared_shared:
            orphaned.append('$' + name)
    # 2) 帧：'__script__'（剧本级）+ 模块名帧——缺失声明的补种、孤儿登记。
    #    其余帧键（__for_1__ 等循环合成帧）不在声明域，不碰。
    mod_names = table.module_names()
    globals_init = {k: _normalize_initial(v)
                    for k, v in table.initials_global_context().items()}
    for env in tw.envs.values():
        for frame_key, frame in env.frames.items():
            if frame_key == SCRIPT_FRAME:
                initials = globals_init
            elif frame_key in mod_names:
                initials = {k: _normalize_initial(v)
                            for k, v in table.module_initials(frame_key).items()}
            else:
                continue
            for name, value in initials.items():
                if name not in frame:
                    frame[name] = value
                    seeded.append(name)
            for name in list(frame.keys()):
                if not table.is_declared(name):
                    orphaned.append(name)
    return seeded, orphaned


# ── fork 执行器辅助（R3 接线；本文件不起跑）──────────────────

@dataclass
class ChildSpec:
    """一个 fork/par 分支的起跑参数。
    start_node: 分支入口节点 id（普通 fork：runner 已完成条件边过滤）；
    select_from_gateway: par 专用——入口在**分支协程内**从该网关的出边选择
      （par 出边条件含循环变量如 if (@speaker.type=="ai")，必须等循环帧
      写入后在分支上下文求值；旧架构同语义，R2 合流时曾误提到母上下文）；
    loop_gw/loop_var/loop_value: par 分支的循环帧（普通 fork 为 None）——
    帧在子 env 构造期直接放入（deepcopy 自母 env，par_gw 为新键不冲突）。"""
    start_node: str = ""
    select_from_gateway: Optional[str] = None
    loop_gw: Optional[str] = None
    loop_var: Optional[str] = None
    loop_value: Any = None


def fork_branches(runner, tw: TaskWorld, mother_ctx: TaskContext, flow,
                  gateway_id: str, child_specs: List[ChildSpec],
                  extra_actions: dict, max_steps: int) -> List[asyncio.Task]:
    """fork 执行器三步曲（清单 D2）：
    1. register：fork_id + base=母 frames deepcopy（fail loud，拍板 3）+
       血统链（parent_event=母 fork_id）+ children；母 task mark_dead；
       **零活跃分支（child_specs 为空）也 register(children=())**——防
       join(all) 死等（接线约定 3）；
    2. 复制：每分支 母env.deepcopy_for（值复制非指针）；
    3. 起协程：每子 task 一个 branch_main（par 分支先放循环帧+写 par_var），
       engine.create_task 登记 _task_coros。
    返回 asyncio.Task 列表——runner gather(return_exceptions=True) 纯收场
    （**gather 必须保留**：不 gather 则 run_async finally 的 engine.shutdown()
    会杀掉未完分支）。"""
    mother_env = mother_ctx.facade.env
    fork_id = tw.forks.next_fork_id()
    mod_stack, loop_keys = mother_ctx.facade.export_stack()
    # 1. 母 task 终止（变量上母 task 不再存在；gather 只是调度等待）
    tw.ledger.mark_dead(mother_ctx.task_id)
    tw.drop_env(mother_ctx.task_id)
    children: List[str] = []
    tasks: List[asyncio.Task] = []
    for spec in (child_specs or []):
        child_id = tw.idgen.next()
        child_env = mother_env.deepcopy_for(child_id, fork_id)
        if spec.loop_gw is not None:
            # par 分支循环帧：构造期直接放入（par_gw 为新键，与母复制来的
            # 循环帧——for 内 par 场景——不冲突）；值本轮重写
            child_env.frames[spec.loop_gw] = (
                {spec.loop_var: spec.loop_value} if spec.loop_var else {})
        tw.register_env(child_env)
        tw.ledger.register(child_id, fork_id)
        children.append(child_id)
        stack = (mod_stack, tuple(loop_keys) + ((spec.loop_gw,) if spec.loop_gw else ()))
        # 模块帧继承（R4 补）：模块内 fork 的分支协程也在模块内——module_frames
        # 必须从母 ctx 带走（每分支独立副本：step/层数各自推进，共享会互串）。
        # 缺失的实锤后果=①模块内 fork 分支的模块步数上限失效（module_frames
        # 空 → 走全局步数）；②checkpoint positions 的 module_frames 为空 →
        # 恢复直启后变身者无帧可弹，_resume_module_unwind 断链。
        inherited_frames = [
            ModuleFrame(name=mf.name, step=mf.step, max_steps=mf.max_steps,
                        caller_node_id=mf.caller_node_id)
            for mf in mother_ctx.module_frames
        ]
        coro = branch_main(runner, tw, child_id, child_env, spec.start_node,
                           flow, extra_actions, max_steps, stack=stack,
                           select_from_gateway=spec.select_from_gateway,
                           module_frames_inherit=inherited_frames)
        task = runner.engine.create_task(coro)
        runner._task_coros[child_id] = task
        # 收场兜底（R1 单测抓出）：task 未启动即被 cancel 时协程一行都不执行、
        # branch_main 的 finally 不会跑——done_callback 保证 mark_dead/drop_env
        # 对一切结束方式（正常/异常/未启动取消）都发生（幂等）。
        def _settled(tid=child_id):
            tw.ledger.mark_dead(tid)
            tw.drop_env(tid)
        task.add_done_callback(lambda _t, _cb=_settled: _cb())
        tasks.append(task)
    # 事件登记（children 确定后；零活跃分支 children=()）
    tw.forks.register(fork_id, mother_env.frames, mother_ctx.task_id,
                      mother_env.fork_id, gateway_id, tuple(children))
    return tasks


async def branch_main(runner, tw: TaskWorld, task_id: str, child_env: TaskEnv,
                      start_node: str, flow, extra_actions: dict,
                      max_steps: int, stack: Tuple[Tuple[str, ...], Tuple[str, ...]] = (),
                      select_from_gateway: Optional[str] = None,
                      resume_callers: Optional[List[Dict[str, str]]] = None,
                      module_frames_inherit: Optional[List[ModuleFrame]] = None):
    """分支协程主体：绑 TaskContext → （par）分支内选入口 → 跑 _execute_path → 收场。
    - select_from_gateway 非 None 时：入口在该网关出边中于**分支上下文**选择
      （循环帧已写入，par 条件边如 if (@speaker.type=="ai") 可正确求值；
      条件边取第一条命中的、无条件边直接命中——旧 par_branch 同语义）；
    - join(N) 掐尾 / 全场 stop：asyncio cancel → except CancelledError 安静
      退场（finally mark_dead 幂等）——只掐单链不影响其他分支（文档 §8.3）；
    - 分支异常必须上报（_fork_errors，编译器原则：分支报错不静默）；
    - resume_callers（R4 断点直启专用）：非 None = 恢复场景——按快照调用链
      重建 module_frames（含每层模块的母 flow 调用节点），执行流跑完后调
      runner._resume_module_unwind 逐层弹栈回母 flow 续传（正常 fork 分支传
      None，无此语义）。"""
    facade = tw.new_facade(child_env)
    if stack:
        facade.restore_stack(list(stack[0]), list(stack[1]))
    if select_from_gateway:
        start_node = None
        for e in flow.edges:
            if e.source != select_from_gateway:
                continue
            if e.condition:
                if runner.evaluator.evaluate_condition(e.condition, facade):
                    start_node = e.target
                    break
            else:
                start_node = e.target
                break
        if start_node is None:
            print(f"[branch]⚠️ task {task_id} 在网关 {select_from_gateway} 无命中入口，分支结束")
    ctx = TaskContext(task_id=task_id, facade=facade)
    if resume_callers is not None:
        ctx.module_frames = [ModuleFrame(name=f.get('name', ''),
                                         caller_node_id=f.get('caller_node_id', ''))
                             for f in resume_callers]
        # 【2026-09-06 断头修复】直启起点在模块内：模块 flow 跑到 [OUT] 后必须
        # 弹栈回母 flow 续传（branch_main 收尾检查 resume_unwind_pending →
        # _resume_module_unwind）。原实现只在 join 变身路径置位（join_sign_in），
        # 普通直启从不置位——模块出口后 mainflow 断头、flow_done 照发
        # （用户实拍：恢复后女巫结算完直接"已跑完"，第二夜永远不来）。
        # 母协程在直启场景不存在，无"重复 unwind 双跑 mainflow"风险。
        if ctx.module_frames:
            ctx.resume_unwind_pending = True
    elif module_frames_inherit:
        ctx.module_frames = module_frames_inherit
    runner._task_coros[task_id] = asyncio.current_task()
    try:
        with task_ctx(ctx):
            if start_node:
                await runner._execute_path(flow, start_node, stop_at=None,
                                           extra_actions=extra_actions,
                                           max_steps=max_steps)
            if ctx.resume_unwind_pending:
                await runner._resume_module_unwind(ctx)
    except asyncio.CancelledError:
        pass                                    # 掐尾/全场停止：安静退场
    except Exception as e:
        runner._fork_errors.append((start_node or select_from_gateway or '?', e))
    finally:
        runner._task_coros.pop(task_id, None)
        tw.ledger.mark_dead(task_id)            # 幂等
        tw.drop_env(task_id)
        if resume_callers is not None:
            # 【2026-09-06 探针】仅直启（恢复）分支打印收场——含 forks 错误数。
            print(f"[resume-diag] 直启分支 {task_id} 收场（起点={start_node}，"
                  f"fork_errors={len(runner._fork_errors)}）")


# ── join 接线入口（R3 接线；_execute_path 与 _run_join 两处都调它）──

async def join_sign_in(runner, tw: TaskWorld, flow, join_id: str, node,
                       extra_actions: dict, max_steps: int) -> Optional[str]:
    """遇 gateway_join 的统一入口（⚠️ 分支路径与主流程路径两处都调）：
    到达即签到挂起；返回出口节点 id = 幸运者变身继续；返回 None = 本 task
    终止（非触发者/迟到者），调用方不得再跑出口节点。
    变身：新 env + restore_stack（模块帧照旧——数据在 merged env；循环帧
    按签到者键列表重建为空帧——D5B）+ _task_ctx 换新 TaskContext +
    _task_coros 换登记（后续 join(N) 可能掐它）。"""
    ctx = current_task_ctx()
    if ctx is None:
        raise FEMOVariableError(f"join '{join_id}' 签到时无 TaskContext（协程未绑执行上下文）")
    coord = runner._coordinator_for(join_id, node, flow, tw)   # per join_id 缓存（代次内置）
    merged_env = await coord.sign_in(ctx.task_id, ctx.facade.env)
    if merged_env is None:
        return None
    # ── 变身：本协程携带新 task 从 join 出口继续（出口只跑一遍）──
    old_task_id = ctx.task_id
    # merge 产物 env 登记（R4 补）：world.envs 是 checkpoint dump 的 env 来源
    # （root 在 assemble_world、fork 子任务在 fork_branches 登记）——merge 产物
    # 此前从不入表，快照会漏掉 join 后继续跑的 task，恢复时该分支变量整包
    # 丢失（直启循环 env 缺失即跳过该 task）。纯登记无副作用：envs 的消费者
    # 仅 checkpoint dump 与 max_task_seq；死亡清理由 branch_main finally 的
    # drop_env 幂等兜底（join(N) 掐尾者经 cancel 同样走到该 finally）。
    tw.register_env(merged_env)
    new_facade = tw.new_facade(merged_env)
    mod_stack, loop_keys = ctx.facade.export_stack()
    new_facade.restore_stack(list(mod_stack), list(loop_keys))
    new_ctx = TaskContext(task_id=merged_env.task_id, facade=new_facade,
                          current_node_id=join_id,
                          current_loop_var=ctx.current_loop_var,
                          module_frames=list(ctx.module_frames))
    if getattr(runner, 'resume_positions', None):
        # 断点恢复 run 的变身者：跑完当前模块 flow 到 [OUT] 后由 branch_main
        # 触发 _resume_module_unwind 回母 flow 续传（母协程已不存在）。正常
        # run 不置位——母协程本来就会续跑，重复 unwind 会双跑 mainflow。
        # ⚠️ 标记写回 ctx（branch_main 局部持有的对象）——branch_main 收尾
        # 读它；new_ctx 是 set_task_ctx 置换的新对象，branch_main 不可见。
        ctx.resume_unwind_pending = True
    runner._task_coros.pop(old_task_id, None)            # 源 task 已终止
    runner._task_coros[merged_env.task_id] = asyncio.current_task()
    # 变身：set 不 reset——协程余下生命周期（出口节点/后续循环/再次 fork）
    # 全部属于新 task；reset 会把已死的母 task 回渗给调用方（R1 单测抓出）
    set_task_ctx(new_ctx)
    await runner._execute_node_content(node, flow, extra_actions,
                                       max_steps, node_id=join_id)
    for e in flow.edges:
        if e.source == join_id:
            return e.target
    return None


def make_coordinator(tw: TaskWorld, join_id: str, mode, sources,
                     emit_event: Callable, cancel_fn: Callable,
                     graph_query, skip_frames: Set[str],
                     cascade: Optional['JoinCascade'] = None) -> JoinCoordinator:
    """JoinCoordinator 工厂（runner._coordinator_for 的实现内核）。
    skip_frames 以**可变 set 引用**传入（runner 的 _skip_frames 随循环帧
    push/pop 维护，_converge 时取当下快照——清单 D5）。
    cascade：run 级 JoinCascade 共享总线（R3 接线）——嵌套 join 级联要求
    **跨协调器**共享（上游 converge publish 唤醒下游等待者）；不传则协调器
    各自 new，上游输出永远无法唤醒下游（验收④嵌套 join 死等）。"""
    def task_id_gen() -> str:
        new_id = tw.idgen.next()
        # 预登记占位：_converge 内 register_merge 会覆盖 fork_id
        tw.ledger.register(new_id, None)
        return new_id

    def merge_fn(base_frames, flat_envs, skip_frames):
        result = merge_frames(base_frames, flat_envs, skip_frames=tuple(skip_frames))
        # 模块帧占位补齐（2026-09-12）：merge_frames 只输出**有键**的帧，
        # 而「模块帧里一个变量都没有」是合法且常见的（作者把变量池全放剧本级
        # vars:，模块只装 action/flow）。空模块帧一旦被抹掉，restore_stack
        # 重建词法链时就找不到它——join 变身当场抛「模块帧 'X' 不在 env 中
        # （词法链断裂）」。模块帧承载的是词法链而非数据，必须与 skip_frames
        # 里的循环帧区别对待：base 里有、merge 后变成空洞的帧，补回空帧。
        skip = set(skip_frames)
        for fk in base_frames:
            if fk not in skip and fk not in result.frames:
                result.frames[fk] = {}
        return result

    return JoinCoordinator(
        join_id=join_id, mode=mode, sources=sources,
        forks=tw.forks, ledger=tw.ledger,
        merge_fn=merge_fn, task_id_gen=task_id_gen,
        emit_event=emit_event, cancel_fn=cancel_fn,
        graph_query=graph_query, skip_frames=skip_frames,
        cascade=cascade)


# ── join 入边图拓扑反溯 ─────────────────────────────────────

class GraphQuery:
    """沿 join 入边在 **join 节点所属的 flow 图内**反向上溯（模块边界即停——
    每个模块 flow 一个 GraphQuery 实例；到达 join 的所有路径都在该图内，
    模块入口 [IN] 也是图内节点，图内反溯即完备）。flow 为 duck 对象
    （FlowGraph：nodes/edges，edge.source/target/condition）。"""

    def __init__(self, flow):
        self._flow = flow

    def upstream_sources(self, join_id: str) -> Dict[str, List[str]]:
        """返回 {'fork_gateways': [...], 'join_gateways': [...]}：
        - 遇 fork/par 网关 → 收集并停止上溯（其孩子即等待集成员，
          由 JoinCoordinator._wait_set 沿签到者血统链对齐 fork 事件）；
        - 遇嵌套 join 网关（非自身）→ 收集级联（等待对象=该 join 的输出
          task，上游未凑齐时下游级联等待）；
        - 穿过普通节点 / for 网关（for 不产生新 task）/ [START]/[IN]。"""
        fork_gateways: List[str] = []
        join_gateways: List[str] = []
        visited: Set[str] = set()
        queue: List[str] = [join_id]
        while queue:
            nid = queue.pop()
            if nid in visited:
                continue
            visited.add(nid)
            node = self._flow.nodes.get(nid)
            if node is None:
                continue
            gw_kind = (node.meta or {}).get('gw_kind', '')
            if nid != join_id and gw_kind == 'join':
                join_gateways.append(nid)
                continue                    # 嵌套 join：级联等待，不上溯其上游
            if gw_kind in ('fork', 'par'):
                fork_gateways.append(nid)
                continue                    # fork 的孩子由等待集对齐，不再上溯其上
            for e in self._flow.edges:
                if e.target == nid:
                    queue.append(e.source)
        return {'fork_gateways': fork_gateways, 'join_gateways': join_gateways}
