# femoCompiler/vars/checkpoint.py
"""
vars/checkpoint.py — per-task 快照编解码（语言层）
==================================================
施工清单 v2 §3.5。快照单位从旧「分支的 globals∪locals 合并视图」改为
**per-task 完整状态**：

    {version, envs: {task_id: TaskEnv}, world.shared, forks, ledger, positions}

恢复 = 原样重建（envs / shared / fork 事件血统 / task 活性签到 / 执行流
位置）——变量归谁、血统如何、活到哪，恢复后与暂停时完全一致；不再有任何
顺序的 dict.update 硬覆盖。

恢复执行模型 = **分支直启**（对比审查吸收）：恢复时不为 root 起协程
（root 多半已 fork 终止），直接对 positions 中每个 task 起独立分支协程、
从记录 node_id 执行；该跑哪个 flow 由 def_chain/模块栈顶决定（栈顶为
剧本级 → mainflow；否则对应模块 flow）。joined 前已签到的 task 随 env
恢复，凑齐判定不丢签到记录。

旧 checkpoint 数据（合并视图平铺格式）不兼容——已拍板作废，续跑按
fresh 开演。serialize_var 自含实现（与 task_pause._serialize_var 同逻辑；
语言层不反向依赖执行层——旧四件套 FEMO_checkpoint → task_pause 的坑不重犯；
接线收尾时 task_pause 反过来改用本函数）。
"""
import json
from typing import Any, Dict, Tuple

from femoCompiler.vars.env import ForkRegistry, TaskEnv, TaskLedger, WorldStore

VERSION = 2


def serialize_var(value: Any) -> Any:
    """值 → 可 JSON 化形态：标量原样；list/tuple 递归；dict 的 key 转 str
    递归；不可 JSON 化（@func 返回的对象等）→ repr 字符串留痕。"""
    if isinstance(value, (str, int, float, bool, type(None))):
        return value
    if isinstance(value, (list, tuple)):
        return [serialize_var(v) for v in value]
    if isinstance(value, dict):
        return {str(k): serialize_var(v) for k, v in value.items()}
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return repr(value)


def serialize_env(env: TaskEnv) -> Dict[str, Any]:
    """TaskEnv → 可 JSON 化 dict（frames 逐值过 serialize_var）。"""
    return {
        'task_id': env.task_id,
        'fork_id': env.fork_id,
        'frames': {fk: {name: serialize_var(v) for name, v in frame.items()}
                   for fk, frame in env.frames.items()},
    }


def deserialize_env(data: Dict[str, Any]) -> TaskEnv:
    return TaskEnv(
        task_id=data['task_id'],
        frames={fk: dict(frame) for fk, frame in data['frames'].items()},
        fork_id=data.get('fork_id'),
    )


def dump_state(*, envs: Dict[str, TaskEnv], world: WorldStore,
               forks: ForkRegistry, ledger: TaskLedger,
               positions: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    """完整世界快照。positions: {task_id: {'node_id': ..., 'def_chain': [...]}}
    —— 位置键 = task_id（现状 branch_key=module_name 在模块内 fork 时两分支
    同名键互相覆盖 → 续跑丢分支；task_id 天然唯一）。
    shared_names 随快照存取（声明集是 run 常量）——restore 重建 WorldStore
    时原样带回，否则恢复后任何 shared 读写都会误报"未声明为 shared"。"""
    return {
        'version': VERSION,
        'envs': {tid: serialize_env(env) for tid, env in envs.items()},
        'shared': {k: serialize_var(v) for k, v in world.snapshot().items()},
        'shared_names': sorted(world.shared_names),
        'forks': forks.snapshot(),
        'ledger': ledger.snapshot(),
        'positions': positions,
    }


def restore_state(data: Dict[str, Any]) -> Tuple[
        Dict[str, TaskEnv], WorldStore, ForkRegistry, TaskLedger,
        Dict[str, Dict[str, Any]]]:
    """快照 → (envs, world, forks, ledger, positions)。结构不符/版本不符
    → 响亮报错（旧格式已拍板作废，请重新开演）。"""
    if not isinstance(data, dict) or data.get('version') != VERSION:
        got = data.get('version') if isinstance(data, dict) else type(data).__name__
        raise ValueError(
            f"checkpoint 快照版本不符（期望 version {VERSION}，得到 {got}）。"
            f"旧格式快照已作废，请重新开演。")
    try:
        envs = {tid: deserialize_env(d) for tid, d in data['envs'].items()}
        world = WorldStore(shared_names=frozenset(data.get('shared_names') or []),
                           initial={})
        world.restore(data.get('shared') or {})
        forks = ForkRegistry()
        forks.restore(data.get('forks') or {})
        ledger = TaskLedger()
        ledger.restore(data.get('ledger') or {})
        positions = dict(data.get('positions') or {})
        return envs, world, forks, ledger, positions
    except (KeyError, TypeError, AttributeError) as e:
        raise ValueError(f"checkpoint 快照结构损坏，无法恢复: {e}") from e


def dumps_json(state: Dict[str, Any]) -> str:
    """快捷：dump_state 产物 → JSON 串（ensure_ascii=False 保中文）。"""
    return json.dumps(state, ensure_ascii=False, default=str)
