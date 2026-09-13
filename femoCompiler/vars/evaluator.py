# femoCompiler/vars/evaluator.py
"""
vars/evaluator.py — 统一求值器（语言层）
========================================
施工清单 v2 §3.3。一切"运行时把表达式变成值"的唯一入口，六类动态解析场景
（动态键 / actor 追链 / scope 展开的取值面 / prompt 插值 / 条件与迭代器
表达式 / SET VARIABLE 右值）全部收敛到此——替代旧 runtime 里四套各自为政
的求值通道（eval_expr / _eval_condition / _eval_iterable_expr / _eval_key），
变量替换统一经 VarFacade（帧路由自动生效）。

- evaluate(expr, facade, strict)：字面量/列表字典字面量/@引用/变量路径/
  函数调用。strict=False（默认，对齐旧 eval_expr 宽松回退）时未声明按
  字面量返回；strict=True 时未声明响亮报错。
- evaluate_condition：条件表达式安全求值（tokenize → 属性访问合并 →
  变量替换 → in 比较规范化 → 白名单 eval），五步管线自旧 runtime 迁移，
  逻辑等价。
- interpolate_prompt：{var} 插值 + in: 显式映射（含 showprompt 场景——
  顺带修复旧 blocks 侧 showprompt 从不替换变量的 bug：hasattr 恒 False）。
- resolve_actor_ref / resolve_actor_attr：委托 actor_resolver（追链 10 层/
  保留属性优先/动态属性查可见域字典——逻辑一字不动，只换数据源）。

设计约束：不 import asyncio、不发事件、不碰 IO。
"""
import ast
import re
from typing import Any, Callable, Dict, List, Optional

from femoCompiler.vars.model import FEMOVariableError
from femoCompiler.actor_resolver import resolve_actor_attr, resolve_actor_var

_SAFE_BUILTINS = {
    'True': True, 'False': False, 'None': None,
    'len': len, 'int': int, 'str': str, 'float': float,
    'bool': bool, 'abs': abs, 'min': min, 'max': max,
    'sum': sum, 'any': any, 'all': all,
    'isinstance': isinstance, 'hasattr': hasattr,
    'list': list, 'dict': dict, 'set': set, 'tuple': tuple,
    'range': range, 'enumerate': enumerate,
}


class Evaluator:
    """统一求值器。actors = 剧本演员表（@名 → ActorDef-like，鸭子类型）；
    code_modules = PythonBridge.modules（evaluator 的函数调用分支用，
    可 None——无 code: 区的剧本不需要）。"""

    def __init__(self, actors: Optional[Dict[str, Any]] = None,
                 code_modules: Optional[Dict[str, Any]] = None):
        self._actors = actors or {}
        self._code_modules = code_modules or {}
        self._func_cache: Dict[str, Any] = {}

    # ── 主入口 ────────────────────────────────────────────
    def evaluate(self, expr: Any, facade, strict: bool = False) -> Any:
        """表达式 → 值。语义对齐旧 FEMORunner.eval_expr：
        复合表达式拒绝（条件判断走 evaluate_condition）。"""
        if not isinstance(expr, str):
            return expr
        expr = expr.strip()
        if any(op in expr for op in (' and ', ' or ', ' not ', ' in ', ' is ',
                                     '==', '!=', '<=', '>=', '<', '>')):
            raise FEMOVariableError(
                f"evaluate 不支持复合表达式：{expr!r}。条件判断请使用 evaluate_condition。")

        # .type 属性
        type_match = re.match(r'^(@?\w[\w.\[\]]*)\.type$', expr)
        if type_match:
            val = self.evaluate(type_match.group(1), facade, strict=strict)
            if isinstance(val, str) and val.startswith('@'):
                actor_type = self._get_actor_type(val)
                if actor_type is None:
                    raise FEMOVariableError(
                        f"'{val}' 不是有效的 actor 引用，无法访问 .type 属性")
                return actor_type
            raise FEMOVariableError(f"变量 '{type_match.group(1)}' 的值 '{val}' 不是 actor 引用")

        # @ 引用（静态演员 → 名字本身；@变量 → 帧路由取值；不在此追链——
        # 执行者解析的追链走 resolve_actor_ref）
        if expr.startswith('@'):
            if expr in self._actors:
                return expr
            if facade.has(expr):
                return facade.get(expr)
            if strict:
                raise FEMOVariableError(f"未知的 actor 引用: {expr}")
            return expr

        # 引号字符串
        if (expr.startswith('"') and expr.endswith('"') and len(expr) >= 2) or \
           (expr.startswith("'") and expr.endswith("'") and len(expr) >= 2):
            return expr[1:-1]

        # 布尔 / None
        if expr in ('true', 'True'):
            return True
        if expr in ('false', 'False'):
            return False
        if expr == 'None':
            return None

        # 数字
        try:
            if '.' in expr:
                return float(expr)
            return int(expr)
        except ValueError:
            pass

        # 列表字面量
        if expr.startswith('[') and expr.endswith(']'):
            inner = expr[1:-1].strip()
            if not inner:
                return []
            return [self.evaluate(it.strip(), facade, strict=strict)
                    for it in self._split_items(inner)]

        # 字典字面量
        if expr.startswith('{') and expr.endswith('}'):
            inner = expr[1:-1].strip()
            if not inner:
                return {}
            return self._parse_dict_literal(inner, facade, strict)

        # 函数调用（module.func(args)）
        fc = re.match(r'^(\w+\.\w+)\(([^)]*)\)$', expr)
        if fc:
            return self._call_module_func(fc.group(1), fc.group(2), facade)

        # 变量路径 / 简单名：命中（含帧值恰为 None）原样返回；
        # 未声明：strict 报错 / 宽松按字面量返回（保留旧 eval_expr 宽松回退）
        try:
            return facade.get(expr)
        except FEMOVariableError:
            if strict:
                raise
            return expr

    # ── 迭代器表达式 ──────────────────────────────────────
    def evaluate_iterable(self, expr: str, facade) -> Any:
        """迭代器表达式：Python eval 优先（range(1,100)、切片等）+
        FEMO 变量视图注入；失败回退 evaluate（FEMO 字面量语法 [@a1,@a2]），
        再失败响亮报错。（迁移自 _eval_iterable_expr；诊断 print 段删除。）"""
        import builtins
        from collections import ChainMap

        class _FEMOView:
            """FEMO 变量视图：按 facade 的帧路由供值（替代旧 FEMOVarMap）。
            未声明转 KeyError——ChainMap 依赖 KeyError 跳到下一层 map。"""
            def __getitem__(self, key):
                try:
                    return facade.get(key)
                except FEMOVariableError:
                    raise KeyError(key) from None
            def __contains__(self, key):
                return facade.has(key)

        ns = ChainMap(_FEMOView(), vars(builtins))
        try:
            return eval(expr, {"__builtins__": builtins}, ns)
        except Exception:
            try:
                return self.evaluate(expr, facade, strict=False)
            except Exception:
                raise FEMOVariableError(f"无法求值迭代器表达式: {expr!r}")

    # ── 条件表达式 ────────────────────────────────────────
    def evaluate_condition(self, cond: str, facade) -> bool:
        """条件求值：tokenize → 属性访问合并 → 变量替换 → in 比较规范化
        → 白名单 eval。（五步管线自旧 runtime 五个 def 等价迁移。）"""
        tokens = self._tokenize_condition(cond.strip())
        tokens = self._merge_attr_access(tokens, facade)
        tokens = self._replace_variables(tokens, facade)
        tokens = self._merge_dots_and_negatives(tokens)
        tokens = self._normalize_in_comparison(tokens)
        expr = ' '.join(tokens)
        return eval(expr, {"__builtins__": {}}, _SAFE_BUILTINS)

    def _tokenize_condition(self, expr: str) -> List[str]:
        tokens: List[str] = []
        i = 0
        n = len(expr)
        while i < n:
            c = expr[i]
            if c in (' ', '\t'):
                i += 1
                continue
            if c in ('"', "'"):
                quote = c
                j = i + 1
                while j < n and expr[j] != quote:
                    if expr[j] == '\\':
                        j += 1
                    j += 1
                if j >= n:
                    raise FEMOVariableError(f"条件表达式中的字符串未闭合: {expr[i:]}")
                tokens.append(expr[i:j + 1])
                i = j + 1
                continue
            if c in '()[]{}':
                tokens.append(c)
                i += 1
                continue
            if c.isdigit() or (c == '-' and i + 1 < n and expr[i + 1].isdigit()
                               and (i == 0 or tokens[-1] in '([=<>!]'
                                    or tokens[-1] in ('and', 'or', 'not', 'in', 'is')
                                    or tokens[-1] in '([=<>!+-*/%')):
                j = i + 1 if c == '-' else i
                has_dot = False
                while j < n and (expr[j].isdigit() or (expr[j] == '.' and not has_dot)):
                    if expr[j] == '.':
                        has_dot = True
                    j += 1
                tokens.append(expr[i:j])
                i = j
                continue
            two_char = expr[i:i + 2]
            if two_char in ('==', '!=', '<=', '>=', '//', '**', '<<', '>>', '&&', '||'):
                tokens.append(two_char)
                i += 2
                continue
            if c in '+-*/%<>=!&|^~.':
                tokens.append(c)
                i += 1
                continue
            j = i
            while j < n and (expr[j].isalnum() or expr[j] in '_@'):
                j += 1
            if j > i:
                tokens.append(expr[i:j])
                i = j
                continue
            raise FEMOVariableError(f"条件表达式包含无法识别的字符: {c!r}")
        return tokens

    def _merge_attr_access(self, tokens: List[str], facade) -> List[str]:
        """合并 actor 属性访问：A . @B 或 @B . A → 求值为字面量。"""
        result: List[str] = []
        i = 0
        n = len(tokens)
        while i < n:
            if i + 2 < n and tokens[i + 1] == '.' and \
                    (tokens[i].startswith('@') or tokens[i + 2].startswith('@')):
                merged = f"{tokens[i]}.{tokens[i + 2]}"
                val = self._eval_actor_attr(merged, facade)
                result.append(repr(val))
                i += 3
                continue
            result.append(tokens[i])
            i += 1
        return result

    def _eval_actor_attr(self, attr_expr: str, facade) -> Any:
        parts = attr_expr.split('.', 1)
        if len(parts) != 2:
            raise FEMOVariableError(f"无效的属性访问: {attr_expr}")
        left, right = parts
        if left.startswith('@'):
            actor_ref, attr_name = left, right
        elif right.startswith('@'):
            actor_ref, attr_name = right, left
        else:
            raise FEMOVariableError(f"属性访问中必须包含一个 @actor 引用: {attr_expr}")
        return self.resolve_actor_attr(actor_ref, attr_name, facade)

    def _replace_variables(self, tokens: List[str], facade) -> List[str]:
        result: List[str] = []
        for token in tokens:
            if token in ('and', 'or', 'not', 'in', 'is', 'True', 'False', 'None'):
                result.append(token)
                continue
            if token in ('true', 'TRUE'):
                result.append('True')
                continue
            if token in ('false', 'FALSE'):
                result.append('False')
                continue
            if (token in '()[]{}' or token in '+-*/%<>=!&|^~.'
                    or token in ('==', '!=', '<=', '>=', '//', '**', '<<', '>>', '&&', '||')
                    or token.startswith(('"', "'"))
                    or (token[0].isdigit() or (token[0] == '-' and len(token) > 1 and token[1].isdigit()))):
                result.append(token)
                continue
            if token.startswith('@'):
                if token in self._actors:
                    result.append(repr(token))
                    continue
                if facade.has(token):
                    result.append(repr(facade.get(token)))
                    continue
                raise FEMOVariableError(f"条件表达式中未声明的 actor 或变量: {token}")
            if facade.has(token):
                result.append(repr(facade.get(token)))
                continue
            if token in _SAFE_BUILTINS:
                result.append(token)
                continue
            raise FEMOVariableError(f"条件表达式中未声明的变量: {token}")
        return result

    @staticmethod
    def _merge_dots_and_negatives(tokens: List[str]) -> List[str]:
        merged: List[str] = []
        i = 0
        while i < len(tokens):
            tok = tokens[i]
            if tok == '-' and i + 1 < len(tokens) and tokens[i + 1][0].isdigit():
                merged.append('-' + tokens[i + 1])
                i += 2
                continue
            if (i > 0 and tokens[i - 1].isdigit() and tok == '.'
                    and i + 1 < len(tokens) and tokens[i + 1].isdigit()):
                prev = merged.pop()
                merged.append(prev + '.' + tokens[i + 1])
                i += 2
                continue
            merged.append(tok)
            i += 1
        return merged

    @staticmethod
    def _normalize_in_comparison(tokens: List[str]) -> List[str]:
        """处理 Python 链式比较问题：'x in y ==/!= True/False' → 正确形式。"""
        i = 0
        n = len(tokens)
        result: List[str] = []
        while i < n:
            if i + 4 < n and tokens[i + 1] == 'in':
                val, container = tokens[i], tokens[i + 2]
                op, bool_val = tokens[i + 3], tokens[i + 4]
                if op in ('==', '!=') and bool_val in ('True', 'False'):
                    inner = ['(', val, 'in', container, ')']
                    if (op == '==' and bool_val == 'True') or (op == '!=' and bool_val == 'False'):
                        result.extend(inner)
                    else:
                        result.append('not')
                        result.extend(inner)
                    i += 5
                    continue
            result.append(tokens[i])
            i += 1
        return result

    # ── 动态键 ────────────────────────────────────────────
    def eval_key(self, key_str: str, facade) -> Any:
        """dict[key] 的 key 求值：变量 → 帧路由取值（修复旧 _eval_key 只查
        globals 的 bug——par 循环变量作 key 现在能解析到局部值）；
        字面量数字 / 字符串直取。"""
        t = key_str.strip().strip('"').strip("'")
        if facade.has(t):
            return facade.get(t)
        try:
            return int(t)
        except ValueError:
            return t

    # ── actor 链与属性（委托 actor_resolver，逻辑一字不动） ──
    def resolve_actor_ref(self, ref: str, facade) -> str:
        """@引用 → 真实演员名（追链最多 10 层）。"""
        try:
            return resolve_actor_var(facade, self._actors, ref)
        except ValueError as e:
            raise FEMOVariableError(str(e)) from e

    def resolve_actor_attr(self, actor_ref: str, attr_name: str, facade) -> Any:
        """@actor.attr / attr.@actor 双向访问（保留属性优先→可见域字典）。"""
        try:
            return resolve_actor_attr(facade, self._actors, actor_ref, attr_name)
        except ValueError as e:
            raise FEMOVariableError(str(e)) from e

    def _get_actor_type(self, actor_ref: str) -> Optional[str]:
        if not isinstance(actor_ref, str) or not actor_ref.startswith('@'):
            return None
        adef = self._actors.get(actor_ref)
        if adef is None:
            return None
        t = getattr(adef, 'type', None)
        return t.value if t is not None else None

    # ── prompt 插值 ───────────────────────────────────────
    def interpolate_prompt(self, text: str, facade,
                           in_mappings: Optional[List[Any]] = None) -> str:
        """{var} 插值 + in: 显式映射先替换。
        （迁移自 _replace_prompt_vars + _exec_ai/_exec_human 三段重复的
        in_mappings 手工 replace；统一后 blocks 侧 showprompt 也走此——
        修复旧 hasattr 恒 False 导致的 showprompt 不替换 bug。）"""
        if not isinstance(text, str):
            raise FEMOVariableError(
                f"interpolate_prompt 需要字符串参数，收到 {type(text)}")
        result = text
        for im in (in_mappings or []):
            try:
                val = self.evaluate(im.global_expr, facade, strict=False)
                result = result.replace('{' + im.local_name + '}', str(val))
            except FEMOVariableError:
                raise
            except Exception:
                pass    # 保留旧 in_mappings 替换的宽松语义（失败留给 {var} 主路径）
        result = re.sub(r'\{([^}]+)\}', lambda m: self._prompt_replacer(m, facade), result)
        if result is None:
            raise FEMOVariableError("interpolate_prompt: re.sub 返回了 None")
        return result

    def _prompt_replacer(self, m: re.Match, facade) -> str:
        var_path = m.group(1)
        # 1. 实体视角 @actor.attr（直接求值）
        if re.match(r'^@\w+\.\w+(\.\w+)?$', var_path):
            translated = self._translate_actor_attr(var_path, facade)
            return str(translated)
        # 2. .@ 动态键模式
        if '.@' in var_path:
            container, dynamic_key = self._resolve_actor_path(var_path, facade)
            if dynamic_key:
                val = facade.get(f"{container}[{dynamic_key}]")
                if val is None:
                    raise FEMOVariableError(f"Prompt 动态键 {{{var_path}}} 的值为 None。")
                return str(val)
        # 3. @ 开头且不是静态演员 → 帧路由取值
        if var_path.startswith('@') and var_path not in self._actors:
            if facade.has(var_path):
                val = facade.get(var_path)
                if val is None:
                    raise FEMOVariableError(
                        f"Prompt 变量 {{{var_path}}} 的值为 None，请检查变量是否已赋值。")
                return str(val)
            raise FEMOVariableError(
                f"Prompt 变量 {{{var_path}}} 在 actors 和 vars 中均未找到。")
        # 4. 普通路径求值
        try:
            val = self.evaluate(var_path, facade, strict=False)
            if val is None:
                raise FEMOVariableError(
                    f"Prompt 变量 {{{var_path}}} 的值为 None，请检查变量是否已初始化。")
            return str(val)
        except FEMOVariableError:
            raise
        except Exception as e:
            raise FEMOVariableError(f"Prompt 变量替换失败: {{{var_path}}}，错误: {e}") from e

    def _translate_actor_attr(self, expr: str, facade) -> str:
        """@actor.attr → 实际值（prompt 替换用）。多级属性不支持（旧语义）。
        facade 必须传——属性非保留字时 actor_resolver 内部要用它查 vars 字典
        （旧实现传 self.vm；漏传 None 会在 vm.has 处 AttributeError）。"""
        pattern = r'(@\w+)\.(\w+)(\.\w+)?'

        def replacer(m: re.Match) -> str:
            if m.group(3):
                raise FEMOVariableError(f"不支持多级属性访问: {m.group(0)}")
            value = self.resolve_actor_attr(m.group(1), m.group(2), facade)
            return str(value)

        return re.sub(pattern, replacer, expr)

    def _resolve_actor_path(self, path: str, facade) -> tuple:
        """vote_results.@voter / @voter.salary → (容器路径, 动态键)。
        （迁移自 FEMORunner._resolve_actor_path。）"""
        if '.@' not in path and not path.startswith('@'):
            return path, None
        parts = path.split('.')
        resolved_parts = []
        dynamic_key = None
        for i, part in enumerate(parts):
            if part.startswith('@'):
                val = self.evaluate(part, facade, strict=False)
                if val is None:
                    val = part
                resolved_parts.append(str(val))
                if i == len(parts) - 1:
                    dynamic_key = str(val)
            else:
                resolved_parts.append(part)
        container = '.'.join(resolved_parts[:-1]) if len(resolved_parts) > 1 \
            else resolved_parts[0]
        return container, dynamic_key

    # ── 赋值右值 ──────────────────────────────────────────
    def eval_right_value(self, raw: str, facade) -> Any:
        """赋值右值：引号串去引号（含中文引号）/ 布尔 / 数字 / 字面量 /
        变量表达式。（迁移自 FEMORunner._eval_right_value。）"""
        raw = raw.strip()
        if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in ('"', "'", '“', '”'):
            return raw[1:-1]
        if raw.lower() == 'true':
            return True
        if raw.lower() == 'false':
            return False
        try:
            if '.' in raw:
                return float(raw)
            return int(raw)
        except ValueError:
            pass
        if (raw.startswith('[') and raw.endswith(']')) or \
                (raw.startswith('{') and raw.endswith('}')):
            try:
                return ast.literal_eval(raw)
            except (ValueError, SyntaxError) as e:
                raise FEMOVariableError(f"无法解析字面量 {raw!r}: {e}") from e
        return self.evaluate(raw, facade, strict=False)

    def clear_func_cache(self) -> None:
        """清空函数调用缓存。**接线约定（步骤 C4）**：runtime 的
        _follow_next_edge 在每条边评估前调用——对齐旧语义
        （self._func_cache = {}），否则条件边里的副作用函数（随机发牌、
        读文件）会被缓存跨节点复用（狼人杀随机发牌直接失效）。"""
        self._func_cache.clear()

    # ── 内部 ──────────────────────────────────────────────
    @staticmethod
    def _split_items(s: str) -> List[str]:
        items, depth, cur, in_str, qc = [], 0, [], False, None
        for c in s:
            if in_str:
                cur.append(c)
                if c == qc:
                    in_str = False
            else:
                if c in ('"', "'"):
                    in_str, qc = True, c
                    cur.append(c)
                elif c in ('[', '{', '('):
                    depth += 1
                    cur.append(c)
                elif c in (']', '}', ')'):
                    depth -= 1
                    cur.append(c)
                elif c == ',' and depth == 0:
                    items.append(''.join(cur))
                    cur = []
                else:
                    cur.append(c)
        if cur:
            items.append(''.join(cur))
        return items

    def _parse_dict_literal(self, inner: str, facade, strict: bool) -> Dict[str, Any]:
        result: Dict[str, Any] = {}
        for item in self._split_items(inner):
            if ':' in item:
                k, v = item.split(':', 1)
                key = k.strip().strip('"').strip("'")
                result[key] = self.evaluate(v.strip(), facade, strict=strict)
        return result

    def _call_module_func(self, func_path: str, args_str: str, facade) -> Any:
        """module.func(args) → 外部 Python 函数（evaluator 的函数调用分支）。
        桥/模块缺失返回 None（旧语义）；参数逐个 evaluate。"""
        cache_key = f"{func_path}({args_str})"
        if cache_key in self._func_cache:
            return self._func_cache[cache_key]
        parts = func_path.split('.', 1)
        if len(parts) != 2:
            return None
        mod = self._code_modules.get(parts[0])
        if mod is None or not hasattr(mod, parts[1]):
            return None
        func = getattr(mod, parts[1])
        args = []
        if args_str.strip():
            for arg in args_str.split(','):
                arg = arg.strip()
                if not arg:
                    continue
                args.append(self.evaluate(arg, facade, strict=False))
        result = func(*args)
        self._func_cache[cache_key] = result
        return result
