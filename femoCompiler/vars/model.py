# femoCompiler/FEMO_varmodel.py
"""
FEMO_varmodel.py — 变量声明模型 + 作用域表 + 路径模型（语言层 · 零依赖）
=======================================================================
变量系统重构（施工清单 v2，2026-09-04 猫猫拍板）的编译期/声明侧基座。
parser 与 runtime 共用；本文件不 import 任何其他 femo 模块（语言层单一定
义点，FEMOVariableError 在此定义，接线时 FEMO_runtime re-export）。

职责：
- VarDecl / split_spec_name：声明元数据（$ 剥前缀、规范名、两维度正交——
  shared=bool 是维度 A，owner=None|模块路径 是维度 B，互不约束）；
- parse_var_path / VarPath：统一路径模型。替代旧 VarManager._tokenize、
  FEMORunner._resolve_actor_path 两套散装拆解。动态键（[...] 内非字面量）
  标记为 Expr 节点——运行时才解析的值，求值时机交给 Evaluator/Facade；
- ScopeTable / build_scope_table：声明注册表 + 词法可见域查询。
  lookup 按**定义链**（拍板 6：词法作用域，Python 式——由模块书写嵌套
  静态确定，与运行期调用栈无关）。同块内 $x 与 x 规范名相同 → 建表即报错
  （语义同旧 extract_var_decls 的重复声明拦截，前移到建表时）。

代码原则：所有代码不许 try 静默兜底不报错，有错必须报错。
"""
import re
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple


class FEMOVariableError(Exception):
    """FEMO 变量相关错误（语言层单一定义点；接线时 FEMO_runtime re-export 本类，
    调用方无感）。"""


# ── 声明模型 ─────────────────────────────────────────────────

@dataclass(frozen=True)
class VarDecl:
    """变量声明 IR。
    name: 规范名——$ 前缀剥掉、@ 保留（'$@选中的人' → '@选中的人'）
    shared: 维度 A（True=shared 全局一份 / False=context 每 task 一份）
    owner: 维度 B（None=剧本级 global / 模块完整路径串=module local，
           如 'Outer.Inner'——完整路径天然区分嵌套同名子模块）
    initial: 声明初值（字面量已 parse 的 Python 值）"""
    name: str
    shared: bool
    owner: Optional[str]
    initial: Any = None


def split_spec_name(key: str) -> Tuple[str, bool]:
    """声明键 → (规范名, 是否 shared)。'$x'→('x',True)；'x'→('x',False)；
    '$@a'→('@a',True)。替代旧 extract_var_decls 的 startswith('$') 散装逻辑。"""
    key = key.strip()
    if key.startswith('$'):
        return key[1:], True
    return key, False


# ── 路径模型 ─────────────────────────────────────────────────

@dataclass(frozen=True)
class Literal:
    """字面键：hp.@wolfClaire 的 '@wolfClaire'、a.b 的 'b'、a[0] 的 0、
    a["k"] 的 'k'。"""
    value: Any


@dataclass(frozen=True)
class Expr:
    """动态键：[...] 内的非字面量（task_list[@coder]、hp[expr]）——
    运行时才解析为具体值（求值经注入的 key_eval 回调 / Evaluator.eval_key）。"""
    src: str


@dataclass(frozen=True)
class VarPath:
    """解析后的变量路径：root（根名，可含 @ 前缀——@变量是合法声明名）+
    后续访问键序列。"""
    root: str
    keys: Tuple[Any, ...] = ()

    @property
    def is_plain(self) -> bool:
        return not self.keys


_INT_RE = re.compile(r'^-?\d+$')


def _parse_key_token(token: str) -> Any:
    """[...] 内 token → Literal / Expr。
    整数字面量 / 引号字符串 → Literal；其余（变量名、@x、表达式）→ Expr。"""
    t = token.strip()
    if (t.startswith('"') and t.endswith('"') and len(t) >= 2) or \
       (t.startswith("'") and t.endswith("'") and len(t) >= 2):
        return Literal(t[1:-1])
    if _INT_RE.match(t):
        return Literal(int(t))
    return Expr(t)


def parse_var_path(path: str) -> VarPath:
    """变量路径 → VarPath。
    支持：'x'、'hp.@wolfClaire'（. 后 @ 名 = 字面实体名键）、'a.b'、
    'a[0]'、'a["k"]'、'task_list[@coder]'（动态键）、混合 'hp[@coder].x'。
    替代 VarManager._tokenize（含其 _eval_key 只查 globals 的 bug——动态键
    在此标记为 Expr，求值交给 Facade 的 key_eval 回调，完整走词法帧路由）。"""
    if not path or not path.strip():
        raise FEMOVariableError("变量路径为空")
    path = path.strip()
    root_parts = []
    keys = []
    i = 0
    n = len(path)
    current = []
    # 第一段：root（到第一个 '.' 或 '[' 为止）
    while i < n and path[i] not in '.[':
        current.append(path[i])
        i += 1
    root = ''.join(current).strip()
    if not root:
        raise FEMOVariableError(f"变量路径缺少根名: {path!r}")
    # 后续段
    while i < n:
        c = path[i]
        if c == '.':
            i += 1
            current = []
            while i < n and path[i] not in '.[':
                current.append(path[i])
                i += 1
            seg = ''.join(current).strip()
            if not seg:
                raise FEMOVariableError(f"变量路径存在空的 '.' 段: {path!r}")
            keys.append(Literal(seg))
        elif c == '[':
            try:
                j = path.index(']', i)
            except ValueError:
                raise FEMOVariableError(f"变量路径的 '[' 未闭合: {path!r}") from None
            keys.append(_parse_key_token(path[i + 1:j]))
            i = j + 1
        else:
            raise FEMOVariableError(f"变量路径存在无法解析的字符 {c!r}: {path!r}")
    return VarPath(root=root, keys=tuple(keys))


# ── 作用域表 ─────────────────────────────────────────────────

class ScopeTable:
    """声明注册表 + 词法可见域查询（维度 B 权威）。

    索引：{(owner_or_None, 规范名): VarDecl}——不同 owner 的同名变量各占
    一条（Python shadowing 的声明基础）；同 owner 内同名（含 '$x' 与 'x'
    规范名相同）在 build_scope_table 建表时响亮报错。
    """

    def __init__(self, decls):
        self._by_owner_name: Dict[Tuple[Optional[str], str], VarDecl] = {}
        self._mod_def_chains: Dict[str, Tuple[str, ...]] = {}
        for decl in decls:
            key = (decl.owner, decl.name)
            if key in self._by_owner_name:
                where = f"模块 {decl.owner}" if decl.owner else "剧本 vars:"
                # 编译期语法层错误 → SyntaxError（与 parse_script 编译期校验
                # 家族一致；ScopeTable 只在编译期建表，运行时只查表不建表）
                raise SyntaxError(
                    f"变量 '{decl.name}' 在 {where} 中重复声明"
                    f"（'$' 与不带 '$' 的规范名相同也视为重复）")
            self._by_owner_name[key] = decl

    def register_module_chain(self, mod_path: str) -> None:
        """登记模块的定义链（build_scope_table 时按书写嵌套算好）。
        'Outer.Inner' → ('Outer', 'Inner')（外→内）。"""
        self._mod_def_chains[mod_path] = tuple(mod_path.split('.'))

    def module_def_chain(self, mod_path: str) -> Tuple[str, ...]:
        """模块的静态定义链（外→内）。未知模块 → 只含自身。
        剧本级用 () —— 由调用方以空链表达。"""
        if mod_path in self._mod_def_chains:
            return self._mod_def_chains[mod_path]
        return tuple(mod_path.split('.')) if mod_path else ()

    def lookup(self, name: str, def_chain: Tuple[str, ...]) -> Optional[VarDecl]:
        """名字 → 声明（词法可见域，拍板 6）。
        def_chain = 当前执行模块的静态定义链（外→内，如 ('Outer','Inner')；
        剧本级传 ()）。查找顺序：定义链**由内到外**构造 owner 路径串
        （'Outer.Inner' → 'Outer'）逐级查 → 剧本级 global。
        先命中先得 = Python shadowing；查不到返回 None。"""
        for depth in range(len(def_chain), 0, -1):
            owner_path = '.'.join(def_chain[:depth])
            decl = self._by_owner_name.get((owner_path, name))
            if decl is not None:
                return decl
        return self._by_owner_name.get((None, name))

    def is_declared(self, name: str) -> bool:
        """名字是否在任意层级声明过（不含词法约束的粗判——编译期全集校验用）。"""
        return any(d.name == name for d in self._by_owner_name.values())

    def shared_names(self) -> frozenset:
        return frozenset(d.name for d in self._by_owner_name.values() if d.shared)

    def initials_shared(self) -> Dict[str, Any]:
        """$ 变量初值（键=规范名）——run 装配写 WorldStore 用（各写一次）。"""
        return {d.name: d.initial for d in self._by_owner_name.values()
                if d.shared and d.initial is not None}

    def initials_global_context(self) -> Dict[str, Any]:
        """剧本级 context 变量初值——root task 的 '__script__' 帧装配用。"""
        return {d.name: d.initial for (owner, _), d in self._by_owner_name.items()
                if owner is None and not d.shared}

    def module_initials(self, mod_path: str) -> Dict[str, Any]:
        """模块 local（非 $）初值——enter_module push 帧用。
        模块声明的 $ 变量不在此列（initial 归 run 装配写 shared 一次，
        不随模块进出销毁——全局一份语义）。"""
        return {d.name: d.initial for (owner, _), d in
                self._by_owner_name.items()
                if owner == mod_path and not d.shared}

    def module_names(self) -> frozenset:
        """有 vars 声明的模块路径全集（断点续跑 vars 补种定帧归属用）。"""
        return frozenset(owner for (owner, _) in self._by_owner_name if owner)


def build_scope_table(global_vars: Dict[str, Any],
                      module_vars: Dict[str, Dict[str, Any]]) -> ScopeTable:
    """声明源 → ScopeTable。
    global_vars: 剧本 vars 块（key 可带 $/@，如 {'x': 1, '$s': '', '$@选中的人': ''}）
    module_vars: {模块完整路径: 该模块 vars 块}——路径化扁平输入，
    parser 接线时遍历书写嵌套产出（'Outer' / 'Outer.Inner'）。
    替代 FEMO_parser.extract_var_decls + _assign_module_var_decls（duck 字典
    升级为类型化模型，$ 剥名/同名拦截/owner 标注/定义链登记全部收拢）。"""
    decls = []
    for key, value in (global_vars or {}).items():
        name, shared = split_spec_name(key)
        decls.append(VarDecl(name=name, shared=shared, owner=None, initial=value))
    for mod_path, block in (module_vars or {}).items():
        for key, value in (block or {}).items():
            name, shared = split_spec_name(key)
            decls.append(VarDecl(name=name, shared=shared, owner=mod_path,
                                 initial=value))
    table = ScopeTable(decls)
    for mod_path in (module_vars or {}):
        table.register_module_chain(mod_path)
    return table
