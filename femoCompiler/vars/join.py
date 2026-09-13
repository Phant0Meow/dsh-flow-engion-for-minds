# femoCompiler/vars/join.py
"""
vars/join.py — join 协调器（签到 / 凑齐判定 / 掐尾）
====================================================
施工清单 v2 §3.6。实现拍板 2 的 join 语义：

- join(all)：在 join 节点**等待**，join 列表里的所有节点都运行完（各自链
  上的 task 到达）才运行出口节点；先到的分支不跑出口。
- join(N)：N 个到齐即跑出口；尚未到齐的分支**直接掐掉 task 单链**
  （cancel 回调，不管跑到哪）+ join_latecomer 警告。
- 凑齐判定 = **task 维度**「signed_in ∪ 已终止」（对比审查吸收，防死等）：
  已终止未签到 = missing ≡ base（其对变量的修改丢弃）+ join_missed 警告
  （"分支未到达 join"）。
- 等待集 = **图拓扑反溯**（不认 fork_id——fork/join 完全解耦，拍板一）：
  沿 join 入边反向收集上游 fork 网关（穿过普通节点与 for 网关）与嵌套
  join；运行期把拓扑里的 fork 网关对齐到签到者血统链上的 fork 事件，
  收集其全部孩子（含已终止）。串行直连（上溯无 fork）→ 等待集={签到者}
  → 到达即过。嵌套 join 级联：上游 join 的输出 task 到达即签到，上游未
  凑齐时本 join 自然不 ready，其 converge 后输出签到触发重算——无特殊
  代码路径。
- merge = pick LCA base → merge_frames（skip_frames=循环帧豁免，拍板 1）
  → 冲突保留 base + merge_conflict 事件（拍板 7 文案）→ 新 task
  （fork_id = LCA 事件 id，血统连续）→ 由触发凑齐的协程变身携带新 env
  从 join 出口继续（出口节点只跑一遍）；其余到达协程终止。
- 循环体里的 join：凑齐关闭后，若上代签到者已全部终止且新签到者的血统
  属于新代 → 自动开新代次（generation++）。

设计约束：核心判定（_wait_set/_ready/_converge）为同步方法——单事件循环
内无 await 的检查+登记+唤醒是原子的，规避 check-then-act 竞态；不做超时
（拍板语义无超时：活着的分支要么等（all）要么被掐（N），不替作者设限）。
"""
import asyncio
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from femoCompiler.vars.env import ForkEvent, ForkRegistry, TaskEnv, TaskLedger
from femoCompiler.vars.merge import MISSING, merge_conflict_message, merge_frames
from femoCompiler.vars.model import FEMOVariableError

_MISSING_MARK = '(absent)'


def _conflict_to_dict(conf) -> Dict[str, Any]:
    """MergeConflict → 事件可序列化 payload（MISSING 哨兵转义）。"""
    return {
        'path': conf.path,
        'base': _MISSING_MARK if conf.base is MISSING else conf.base,
        'values': dict(conf.values),
        'missing': list(conf.missing),
    }


class JoinCascade:
    """嵌套 join 级联的共享总线：{join_id: 输出 task_id} 登记 + 下游等待者
    唤醒。上游 join converge 时 publish（登记输出并 set 下游订阅的事件）；
    下游 join 因 pending_nested 挂起前 subscribe 上游。"""

    def __init__(self):
        self._outputs: Dict[str, str] = {}
        self._waiters: Dict[str, List[asyncio.Event]] = {}

    def publish(self, join_id: str, task_id: str) -> None:
        self._outputs[join_id] = task_id
        for ev in self._waiters.pop(join_id, []):
            ev.set()

    def output(self, join_id: str) -> Optional[str]:
        return self._outputs.get(join_id)

    def subscribe(self, join_id: str, event: asyncio.Event) -> None:
        """幂等订阅：输出已 publish 时直接 set（防先发布后订阅丢唤醒）。"""
        if join_id in self._outputs:
            event.set()
        else:
            self._waiters.setdefault(join_id, []).append(event)


class JoinCoordinator:
    """join 节点的运行时协调器（每 join 节点一个实例）。

    构造参数：
      join_id / mode('all'|int) / sources —— 编译期声明数据（parse_join 产出入
        边来源列表，用于事件显示与文档对照）
      forks / ledger —— fork 事件表与 task 登记（等待集与 LCA 查询）
      merge_fn —— (base_frames, flat_envs, skip_frames) -> MergeResult
        （缺省绑定 vars.merge.merge_frames）
      task_id_gen —— () -> str：merge 产物的新 task id 分配（Runner 注入）
      emit_event —— (event_type, payload) -> None（merge_conflict / join_missed /
        join_latecomer）
      cancel_fn —— (task_id) -> None：join(N) 凑齐时掐掉未到分支的回调
        （Runner 取消其协程；只掐单链，不影响其他模块对同一 action 的调用）
      graph_query —— 提供 upstream_sources(join_id) -> {'fork_gateways': [...],
        'join_gateways': [...]}：沿 join 入边反向图拓扑（接线时 Runner 用
        FlowGraph 实现；单测注入假拓扑）
      cascade —— JoinCascade 共享总线（嵌套 join 级联：上游 converge 登记
        输出并唤醒下游等待者）
      skip_frames —— 豁免帧集合（循环网关 id，拍板 1；Runner 随 push/pop 维护）
    """

    def __init__(self, join_id: str, mode, sources: Tuple[str, ...],
                 forks: ForkRegistry, ledger: TaskLedger,
                 merge_fn: Optional[Callable] = None,
                 task_id_gen: Optional[Callable[[], str]] = None,
                 emit_event: Optional[Callable[[str, Dict[str, Any]], None]] = None,
                 cancel_fn: Optional[Callable[[str], None]] = None,
                 graph_query: Optional[Any] = None,
                 cascade: Optional[JoinCascade] = None,
                 skip_frames: Optional[Set[str]] = None):
        self.join_id = join_id
        self.mode = mode                     # 'all' | int
        self.sources = tuple(sources or ())
        self._forks = forks
        self._ledger = ledger
        self._merge_fn = merge_fn or merge_frames
        self._task_id_gen = task_id_gen or self._default_task_id
        self._emit = emit_event or (lambda t, p: None)
        self._cancel = cancel_fn
        self._graph_query = graph_query
        self._cascade = cascade if cascade is not None else JoinCascade()
        self._skip_frames = skip_frames if skip_frames is not None else set()
        self._static_topo: Optional[Dict[str, List[str]]] = None
        # 运行状态
        self._arrived: Dict[str, TaskEnv] = {}
        self._closed = False
        self._waiters: List[asyncio.Event] = []
        self._generation = 0
        self._consumed_forks: Set[str] = set()   # 本代消费的 LCA 血统事件（代次判定）

    # ── 对外：task 到达 join ──────────────────────────────
    async def sign_in(self, task_id: str, env: TaskEnv) -> Optional[TaskEnv]:
        """到达 join：交出 env、登记签到、凑齐判定。
        返回 merged env = 本协程变身"幸运者"（触发凑齐的最后到达者）携新
        task 从 join 出口继续（出口节点只跑一遍）；返回 None = 本 task 终止
        （非触发者/迟到者），调用方不得再跑出口节点。
        等待者循环：每次唤醒（本 join 凑齐 / 上游级联 publish）都重算等待集
        ——级联唤醒后若上游输出未签到仍继续等，凑齐条件满足才收口。"""
        if self._closed:
            if self._should_start_new_generation(task_id):
                self._start_new_generation()
            else:
                self._emit('join_latecomer', {
                    'join_id': self.join_id, 'task_id': task_id,
                    'message': 'join 已凑齐，迟到的签到者终止（context 丢弃）'})
                return None
        self._ledger.sign_in(task_id)
        self._arrived[task_id] = env
        while True:
            required, pending_nested, unseen_gws = self._wait_set()
            ready = (not pending_nested and not unseen_gws
                     and self._ready(required))
            if ready:
                if self._closed:
                    # 已由其他触发者 converge（本协程是等待者）→ 终止
                    return None
                # ── 凑齐：本协程（最后到达者）变身执行 merge，出口只跑一遍 ──
                merged = self._converge(required)
                self._closed = True
                self._wake_all()
                return merged
            await self._park(subscribe_to=pending_nested)

    async def _park(self, subscribe_to: Tuple[str, ...] = ()) -> None:
        """未凑齐：挂起。唤醒源：本 join 触发凑齐（_wake_all）/ 上游级联
        publish（subscribe_to 的上游 converge）。"""
        ev = asyncio.Event()
        for jid in subscribe_to:
            self._cascade.subscribe(jid, ev)
        self._waiters.append(ev)
        await ev.wait()

    def _wake_all(self) -> None:
        ws, self._waiters = self._waiters, []
        for ev in ws:
            ev.set()

    # ── 凑齐判定（task 维度）─────────────────────────────
    def _wait_set(self) -> Tuple[Set[str], Set[str], Set[str]]:
        """等待集合计算。返回 (required task 集, 未凑齐的嵌套 join 集,
        尚未发生的上游 fork 网关集)。"""
        required: Set[str] = set()
        pending_nested: Set[str] = set()
        seen_gws: Set[str] = set()
        topo = self._static_topology()
        fork_gateways = topo.get('fork_gateways', [])
        for tid in self._arrived:
            chain = self._forks.fork_chain(self._ledger.fork_id_of(tid))
            for fid in chain:
                ev = self._forks.get_event(fid)
                if ev.gateway_id in fork_gateways:
                    seen_gws.add(ev.gateway_id)
                    self._collect_live_children(ev, required)
        for jid in topo.get('join_gateways', []):
            out_tid = self._cascade.output(jid)
            if out_tid is None:
                pending_nested.add(jid)      # 上游 join 尚未凑齐 → 级联等待
            else:
                required.add(out_tid)
        # unseen = 拓扑里有、但尚未发生过的上游 fork 网关。
        # 「已发生」判定含零活跃分支的空事件（fork 执行器接线约定：零活跃
        # 也 register children=()）——网关已发生却无孩子在等待集 = 其分支
        # 全灭或不上本 join，死亡语义由 required 的 missing ≡ base 覆盖，
        # 剪除不阻塞（否则上游 fork 出边全 False 的剧本会让 join(all) 死等）。
        unseen = {gw for gw in fork_gateways
                  if gw not in seen_gws and not self._forks.has_gateway_event(gw)}
        if not required and not unseen and not pending_nested:
            # 串行直连：上溯无任何 fork/join → 等待集 = 到达者自己（到达即过）
            required = set(self._arrived)
        return required, pending_nested, unseen

    def _collect_live_children(self, ev: 'ForkEvent', required: Set[str]) -> None:
        """fork 事件的孩子进等待集；孩子若已分流（成为另一 fork 事件的母），
        递归下钻到血脉叶子——fork 母 task 的终止是宪法 1.1 的正常结果
        （血脉已通过 deepcopy 延续给孩子），不是"分支未到达 join"：
        不进 missing、不误报 join_missed（嵌套 fork 汇合场景）。"""
        for cid in ev.children:
            child_ev = self._forks.child_fork_of(cid)
            if child_ev is not None:
                self._collect_live_children(child_ev, required)
            else:
                required.add(cid)

    def _ready(self, required: Set[str]) -> bool:
        """all：等待集中每个 task「signed_in ∪ 已终止」；
        N：已签到数 ≥ count。死亡未签到的 missing 由 _converge 处理。"""
        if self.mode == 'all':
            return all(self._ledger.signed_in(t) or not self._ledger.alive(t)
                       for t in required)
        count = int(self.mode)
        arrived = sum(1 for t in required if self._ledger.signed_in(t))
        return arrived >= count

    def _converge(self, required: Set[str]) -> TaskEnv:
        """凑齐：missing 处理 → LCA base → merge_frames（循环帧豁免）→
        新 task → 事件发射 → join(N) 掐尾。"""
        arrived_ids = list(self._arrived)
        missing = [t for t in required
                   if t not in self._arrived and not self._ledger.alive(t)]
        if missing:
            self._emit('join_missed', {
                'join_id': self.join_id, 'tasks': list(missing),
                'message': '分支未到达 join（已终止未签到），其变量修改按 missing ≡ base 丢弃'})
        flat_envs = {tid: env.flatten() for tid, env in self._arrived.items()}
        fork_ids = [self._ledger.fork_id_of(t) for t in arrived_ids]
        base_frames, lca_fid, base_desc = self._forks.lca_base(fork_ids)
        result = self._merge_fn(base_frames, flat_envs,
                                skip_frames=tuple(self._skip_frames))
        if result.conflicts:
            self._emit('merge_conflict', {
                'join_id': self.join_id, 'base': base_desc,
                'conflicts': [_conflict_to_dict(c) for c in result.conflicts],
                'message': merge_conflict_message()})
        new_task_id = self._task_id_gen()
        merged = TaskEnv(task_id=new_task_id, frames=result.frames,
                         fork_id=lca_fid)
        self._ledger.register_merge(new_task_id, lca_fid)
        # 源 task 终止（merge 后源 task 全部不再使用——宪法 1.1）
        for tid in arrived_ids:
            self._ledger.mark_dead(tid)
        if lca_fid is not None:
            self._consumed_forks.add(lca_fid)   # 本代消费的血统事件（代次判定）
        self._cascade.publish(self.join_id, new_task_id)   # 嵌套 join 级联唤醒
        # join(N)：掐掉等待集中活跃未签到的分支（单链立即停，不管跑到哪）
        if self.mode != 'all':
            latecomers = [t for t in required
                          if t not in self._arrived and self._ledger.alive(t)]
            for tid in latecomers:
                self._ledger.mark_dead(tid)
                if self._cancel is not None:
                    self._cancel(tid)
            if latecomers:
                self._emit('join_latecomer', {
                    'join_id': self.join_id, 'tasks': list(latecomers),
                    'message': f'join({self.mode}) 已凑齐，未到达的分支被掐断'})
        return merged

    # ── 代次（循环体里的 join 每轮复用同一节点）───────────
    def _should_start_new_generation(self, task_id: str) -> bool:
        """关闭后新签到：区分「同代迟到者」与「新代首轮」。
        判据 = 签到者**最近的 fork 事件**是否已被本代消费（本代 LCA 事件
        集）——同代迟到者的最近事件 ∈ consumed（如 f1 的第三个兄弟）；
        循环新一轮的 fork 事件（同网关、新事件 id）∉ consumed → 开新代。"""
        tid_fork = self._ledger.fork_id_of(task_id)
        if tid_fork is None:
            return True                       # 无 fork 血统（串行/新根）→ 新代
        return tid_fork not in self._consumed_forks

    def _start_new_generation(self) -> None:
        self._arrived = {}
        self._closed = False
        self._waiters = []
        self._consumed_forks = set()
        self._generation += 1

    @staticmethod
    def _default_task_id() -> str:
        raise FEMOVariableError('join merge 需要 task_id_gen 注入（Runner 的 t<seq> 分配器）')

    def _static_topology(self) -> Dict[str, List[str]]:
        if self._static_topo is None:
            if self._graph_query is None:
                self._static_topo = {'fork_gateways': [], 'join_gateways': []}
            else:
                self._static_topo = self._graph_query.upstream_sources(self.join_id)
        return self._static_topo
