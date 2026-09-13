# femoCompiler/vars/merge.py
"""
vars/merge.py — N 方三方合并引擎（语言层 · 纯函数，零依赖）
===========================================================
施工清单 v2（2026-09-04 猫猫拍板）语义的直接编码：

- base = fork 时点快照（join 时刻按到达者血统链 LCA 动态选取——见
  vars/env.ForkRegistry.lca_base；base 的唯一作用是区分"改过/没动过"）
- **MISSING ≡ base**（专用哨兵，绝不与 None 混用——None 是合法变量值）：
  分支没有此键 = 该分支对此变量"无立场"（含嵌套 join 内层冲突丢弃的传播），
  视为与 base 一致
- 合并下钻（叶子级递归，对比审查吸收）：dict 递归下钻（"A 改 hp.@wolf、
  B 改 hp.@cat"两个修改都保留）；list/tuple 整值比较（位置语义，递归下钻
  会索引错位合错）；类型分歧（dict vs 非 dict 等）整值判定
- 冲突 = **保留 base 值**（拍板 7：猫猫原话"检测到 context variable
  conflict，编译器暂时默认保留base。未来会加处理conflict的机制"）+
  MergeConflict 记录（完整保留各方值——未来作者语法从这里消费）
- == 内容比较精确聚类，不用 repr 预分桶（同值异键序的 dict 不误判两方）；
  不可比较对象（未实现 __eq__）== 退化为恒等 → deepcopy 后必判冲突
  （保守：宁可丢弃不可错合）
- 帧豁免：skip_frames 中的帧整体不参与 diff、不进结果（拍板 1：循环帧
  join 收口直接删除，循环变量天然每分支不同，不制造噪音 conflict）

设计约束：零依赖、零状态、不发事件、不碰 IO——纯函数，穷尽单测。
调用方用 env.flatten() 把 TaskEnv 展平成 {(frame_key, name): value} 喂进来。
"""
from dataclasses import dataclass, field
from typing import Any, Dict, List, Tuple

# 缺失哨兵：merge 语义里 MISSING ≡ base（该分支对此键无立场）。
# 出现在分支 context = 该分支没有此变量（可能被嵌套 merge 丢弃/从未初始化）；
# 出现在 base 里 = fork 时点就没有此变量（各方都是新增）。
MISSING = object()


@dataclass
class MergeConflict:
    """一次冲突的完整留痕（供 merge_conflict 事件与未来作者语法消费）。"""
    path: str                    # 点路径，如 "hp.@wolfClaire" 或 "__script__::day"
    base: Any                    # base 值
    values: Dict[str, Any]       # {task_id: 各方值}（MISSING 的方列入 missing）
    missing: List[str] = field(default_factory=list)


@dataclass
class MergeResult:
    frames: Dict[str, Dict[str, Any]]   # 合并后帧结构（不含 skip_frames）
    conflicts: List[MergeConflict]


def values_equal(a: Any, b: Any) -> bool:
    """结构化相等：dict/list 走 ==（深比较）；其余 == 退化为恒等
    （自定义类未实现 __eq__ 时 deepcopy 后必不等 → 判冲突，保守正确）。"""
    return a == b


def merge_values_n(base: Any, candidates: Dict[str, Any],
                   path: str = '') -> Tuple[Any, List[MergeConflict]]:
    """单键 N 方三方判定。candidates: {task_id: value | MISSING}。
    返回 (合并值, 冲突列表)；冲突时合并值 = base（拍板 7 保留 base）。"""
    groups: List[Tuple[Any, List[str]]] = []   # [(代表值, [task_id])]
    missing_tids: List[str] = []
    for tid, raw in candidates.items():
        if raw is MISSING:
            missing_tids.append(tid)
            continue
        if values_equal(raw, base):
            continue
        for rep, tids in groups:
            if values_equal(raw, rep):
                tids.append(tid)
                break
        else:
            groups.append((raw, [tid]))

    if not groups:
        return base, []
    if len(groups) == 1:
        return groups[0][0], []
    # ≥2 种互异的非 base 值 → 冲突：保留 base 值 + 完整记录
    values = {}
    for rep, tids in groups:
        for tid in tids:
            values[tid] = rep
    return base, [MergeConflict(path=path, base=base, values=values,
                                missing=list(missing_tids))]


def merge_any(base: Any, candidates: Dict[str, Any],
              path: str = '') -> Tuple[Any, List[MergeConflict]]:
    """单键合并入口：dict 值递归下钻，其余整值三方判定。
    base / candidates 的值均可能是 MISSING（≡base 归一后参与）。
    下钻条件：base 与全部分支（归一后）都是 dict——任一非 dict → 整值判定
    （list 是位置语义不下钻；标量不下钻；类型分歧整值冲突）。"""
    vals: Dict[str, Any] = {tid: (base if v is MISSING else v)
                            for tid, v in candidates.items()}
    if isinstance(base, dict) and all(isinstance(v, dict) for v in vals.values()):
        all_keys: set = set(base.keys())
        for v in vals.values():
            all_keys.update(v.keys())
        merged: Dict[str, Any] = {}
        conflicts: List[MergeConflict] = []
        for k in sorted(all_keys, key=str):
            sub_base = base.get(k, MISSING)
            sub_cands = {tid: d.get(k, MISSING) for tid, d in vals.items()}
            sub_path = f"{path}.{k}" if path else str(k)
            sub_val, sub_conf = merge_any(sub_base, sub_cands, path=sub_path)
            if sub_conf:
                conflicts.extend(sub_conf)
            if sub_val is not MISSING:
                merged[k] = sub_val
            # sub_val is MISSING = 新增键冲突被丢弃（base 无此键）→ 不进结果
        return merged, conflicts
    return merge_values_n(base, candidates, path=path)


def merge_frames(base_frames: Dict[str, Dict[str, Any]],
                 flat_envs: Dict[str, Dict[Tuple[str, str], Any]],
                 skip_frames: Tuple[str, ...] = ()) -> MergeResult:
    """整本 context 三方合并。
    base_frames: {frame_key: {规范名: 值}} —— fork 时点快照（LCA 选取）；
    flat_envs: {task_id: env.flatten()} —— 各到达 task 的展平视图；
    skip_frames: 豁免帧（拍板 1：循环帧 join 收口删除，不参与 diff 不报冲突）。
    返回 MergeResult：合并后帧结构 + 冲突明细（调用方发 merge_conflict 事件，
    文案见拍板 7）。"""
    skip = set(skip_frames)
    all_keys: set = set()
    for fk, frame in base_frames.items():
        if fk in skip:
            continue
        for name in frame:
            all_keys.add((fk, name))
    for _, flat in flat_envs.items():
        for key in flat:
            if key[0] in skip:
                continue
            all_keys.add(key)

    frames: Dict[str, Dict[str, Any]] = {}
    conflicts: List[MergeConflict] = []
    for fk, name in sorted(all_keys):
        base_val = base_frames.get(fk, {}).get(name, MISSING)
        candidates = {tid: flat.get((fk, name), MISSING)
                      for tid, flat in flat_envs.items()}
        path = f"{fk}::{name}"
        val, conf = merge_any(base_val, candidates, path=path)
        conflicts.extend(conf)
        if val is not MISSING:
            frames.setdefault(fk, {})[name] = val
        # val is MISSING = base 无此键且各方新增冲突 → 整键丢弃（保留"无"）
    return MergeResult(frames=frames, conflicts=conflicts)


def merge_conflict_message() -> str:
    """merge_conflict 事件的固定文案（拍板 7 猫猫原话）。"""
    return ("检测到 context variable conflict，编译器暂时默认保留base。"
            "未来会加处理conflict的机制。")
