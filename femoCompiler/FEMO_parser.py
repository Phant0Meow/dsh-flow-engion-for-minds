"""
FEMO Parser v5.0 — 两阶段解析器
阶段1: 缩进块切割 (Block Builder)
阶段2: 语义分发 (Block Evaluator) + Flow 子解析
所有解析结果数据类及条件求值工具均在此文件。

代码原则：所有代码不许写try静默兜底不报错，有错必须报错。

TODO（2026-09-03 拍板，日后做，与变量系统重构无关）：
  编译期拦截递归 module——flow 图上检测 module 直接/间接调用自身。
  当前按"已拦好"的假设设计（变量系统帧键 = 模块名#task_id，同 task
  递归同模块在运行期帧键撞键自然 fail loud）；日后 Parser 拦截落地
  后两边就都连上了。
"""

import re
import ast
import os
import keyword
from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any, Tuple, Callable, Set
from enum import Enum
from femoCompiler.FEMO_config import get_db_path
from femoCompiler import host_manifest
from femoBridges.getDir.get_dir import get_user_dir
from femoCompiler.vars.model import ScopeTable, build_scope_table

# ============================================================
# 1. 基础枚举与数据类（保持不变，从旧文件迁移）
# ============================================================

# ── 全局保留字段：用于解析时判断多行块结束 ──
_TOP_KEYWORDS = (
    'meta:', 'vars:', 'code:', 'actors:',
    'action ', 'module ', 'flow:', 'mainflow:',
    'memory ', 'context ',
)
_FIELD_KEYWORDS = (
    'prompt:', 'showprompt:', 'memory:', 'context:', 'scope:',
    'out:', 'in:', 'fallback:', 'resolve:',
    'interrupt:', 'timeout:', 'max_tries:',
)


class ExecutorType(Enum):
    AI = "ai"
    HUMAN = "human"
    FUNC = "func"
    ASSIGN = "assign"
    MIND = "mind"
    NOTICE = "notice"

class ActorType(Enum):
    AI = "ai"
    HUMAN = "human"
    BLUEPRINT = "blueprint"

class OutType(Enum):
    STRING = "string"
    TEXT = "text"
    BOOL = "bool"
    INT = "int"
    FLOAT = "float"
    ARRAY = "array"
    OBJECT = "object"
    DROPDOWN = "dropdown"
    ENUM = "enum"
    ACTOR = "actor"
    ASSIGN = "assign"

@dataclass(frozen=True)
class ActorRef:
    name: str
    attribute: Optional[str] = None
    def __repr__(self):
        return f"@{self.name}" + (f".{self.attribute}" if self.attribute else "")

@dataclass(frozen=True)
class VarRef:
    name: str
    def __repr__(self): return f"{{{self.name}}}"

@dataclass(frozen=True)
class DynamicActorRef:
    var_name: str
    def __repr__(self): return f"@{{{self.var_name}}}"

@dataclass
class ActorDef:
    type: ActorType
    ref: str
    name: str
    soul: Optional[str] = None
    source: Optional[str] = None
    tools: List[str] = field(default_factory=list)
    # tools: true/false 布尔开关（None = 剧本未声明，交由宿主默认决定）；
    # tools: [name, ...] 仍走 tools 列表（白名单）。
    tools_enabled: Optional[bool] = None
    # thinking: <档位> 思考档位（词汇集见 host_manifest，解析期校验）；
    # None = 剧本未声明 → 请求不带 reasoning_effort（剥离继承后落到
    # 部署默认档位/提供方默认，语义同宿主模型选择器的 Default 项）。
    thinking: Optional[str] = None
    is_blueprint: bool = False

@dataclass
class InMapping:
    local_name: str
    global_expr: str
    bare: bool = False   # 裸项（缺 "= 变量表达式" 映射）——编译期报错用（2026-09-07）

@dataclass
class OutDef:
    var_name: str
    dynamic_key: Optional[str] = None
    out_type: OutType = OutType.STRING
    label: str = ""
    choices: Optional[str] = None

@dataclass
class ActionDef:
    name: str
    executor_type: ExecutorType
    executor_param: str
    as_actor: Optional[str] = None
    prompt: Optional[str] = None
    showprompt: Optional[str] = None
    scope: str = ""          # 现在存原始字符串，如 "[@God, @Diana] + my_list"
    in_mappings: List[InMapping] = field(default_factory=list)
    outs: List[OutDef] = field(default_factory=list)
    resolve: Optional[str] = None
    max_retries: int = 0
    fallback: Optional[str] = None
    memory: Optional[str] = None
    context: Optional[str] = None
    interrupt: Optional[Any] = None
    resolve_args: List[str] = field(default_factory=list)

@dataclass
class MethodDef:
    name: str
    module_alias: str
    func_name: str
    in_params: List[str] = field(default_factory=list)
    out_defs: List[OutDef] = field(default_factory=list)

@dataclass
class FlowNode:
    id: str
    type: str = "action"
    label: str = ""
    action_name: Optional[str] = None
    module_ref: Optional[str] = None
    meta: Dict[str, Any] = field(default_factory=dict)
    extra_actions: List[str] = field(default_factory=list)
    def __post_init__(self):
        if not self.label:
            self.label = self.id

@dataclass
class FlowEdge:
    source: str
    target: str
    condition: str = ""

@dataclass
class FlowGraph:
    nodes: Dict[str, FlowNode] = field(default_factory=dict)
    edges: List[FlowEdge] = field(default_factory=list)

    @property
    def entry(self) -> str:
        # 优先使用 [START] 或 [IN] 节点
        for special in ('[START]', '[IN]'):
            if special in self.nodes:
                return special
        targets = {e.target for e in self.edges}
        for nid in self.nodes:
            if nid not in targets:
                return nid
        return ""

    def add_node(self, node: FlowNode):
        if node.id not in self.nodes:
            self.nodes[node.id] = node

    def add_edge(self, src, tgt, condition=""):
        if src and tgt and src != tgt:
            # 同 (src, tgt, condition) 只注册一条。for/par 的出口行接另一个
            # 控制块时（`-> [A] -> [B] -> for ...:`），解析器会经「出口行
            # 预解析的 tail」与「主循环 ctrl_match 的 pre_tail」两条路径触达
            # 同一条链，重复边会被 _execute_flow 的多出边 fork 语义扇出成
            # 两个分支、下游节点双跑（2026-09-12 实锤：模块内投票 6 票跑成
            # 10 票）。真正的多分支语义靠不同 target 表达。
            for e in self.edges:
                if e.source == src and e.target == tgt and e.condition == condition:
                    return
            self.edges.append(FlowEdge(source=src, target=tgt, condition=condition))

@dataclass
class ModuleDef:
    name: str
    params: List[str] = field(default_factory=list)
    locals: Dict[str, Any] = field(default_factory=dict)
    actions: Dict[str, ActionDef] = field(default_factory=dict)
    modules: Dict[str, 'ModuleDef'] = field(default_factory=dict)   # 嵌套子模块
    memories: Dict[str, MethodDef] = field(default_factory=dict)
    contexts: Dict[str, MethodDef] = field(default_factory=dict)
    flow: Optional[FlowGraph] = None
    meta: Dict[str, Any] = field(default_factory=dict)

@dataclass
class Script:
    meta: Dict[str, Any] = field(default_factory=dict)
    vars: Dict[str, Any] = field(default_factory=dict)
    # 变量声明注册表（步骤 B，2026-09-04）：声明/词法可见域/初值装配的单一
    # 权威，由 build_scope_table 从 script.vars + 各模块 vars（书写嵌套）建成
    scope_table: Optional[ScopeTable] = None
    code: Dict[str, str] = field(default_factory=dict)
    actors: Dict[str, ActorDef] = field(default_factory=dict)
    actions: Dict[str, ActionDef] = field(default_factory=dict)
    modules: Dict[str, ModuleDef] = field(default_factory=dict)
    memories: Dict[str, MethodDef] = field(default_factory=dict)
    contexts: Dict[str, MethodDef] = field(default_factory=dict)
    flow: Optional[FlowGraph] = None
    # 编译期 warning 收集（2026-09-07 warning 桶）：校验器对「值得作者知道但
    # 不阻断」的观察在此累积（{'where': 位置, 'message': 提示}），parse_script
    # 照常返回 Script；随 check/job_start 回执上浮宿主。真正的错误仍 raise。
    warnings: List[Dict[str, str]] = field(default_factory=list)

# ============================================================
# 2. 块切割器 (Block Builder)
# ============================================================

@dataclass
class Block:
    type: str                  # 'meta', 'vars', 'action', 'module', 'flow', ...
    header: str                # 原始头行
    indent: int
    daughters: List['Block'] = field(default_factory=list)
    content_lines: List[str] = field(default_factory=list)  # 自身内容行（不含子块）

def _strip_comment(line: str) -> str:
    in_str, qc = False, None
    i = 0
    while i < len(line):
        c = line[i]
        if in_str:
            if c == qc:
                in_str = False
        else:
            if c in ('"', "'"):
                in_str, qc = True, c
            elif c == '#':
                return line[:i].rstrip()
            elif line[i:i+2] == '//':
                return line[:i].rstrip()
        i += 1
    return line
    
def normalize_symbols(line: str) -> str:
    """只对 FEMO 语法行替换中文符号，不影响文本内容。
    注意：-- -> -> 不在全局替换（文档约定仅 flow/mainflow 区等价，由 eval_flow 单独做）。"""
    line = line.replace('：', ':').replace('，', ',')
    line = line.replace('“', '"').replace('”', '"')
    line = line.replace('（', '(').replace('）', ')')
    line = line.replace('【', '[').replace('】', ']')
    line = line.replace('｜', '|')
    return line

def _is_blank_or_comment(line: str) -> bool:
    s = line.strip()
    return s == '' or s.startswith('#') or s.startswith('//')

def _indent_of(line: str) -> int:
    return len(line) - len(line.lstrip())

def _detect_type(line: str) -> str:
    s = line.strip()
    s = s.replace('：', ':')  # 中文冒号等价
    if s.startswith('meta:'):      return 'meta'
    if s.startswith('vars:'):      return 'vars'
    if s.startswith('code:'):      return 'code'
    if s.startswith('actors:'):    return 'actors'
    if re.match(r'^module\s+\w+', s): return 'module'
    if re.match(r'^action\s+', s):    return 'action'
    if re.match(r'^memory\s+', s):    return 'memory'
    if re.match(r'^context\s+', s):   return 'context'
    if s.startswith('flow:') or s.startswith('mainflow:'): return 'flow'
    return 'unknown'

def _find_multiline_ranges(lines: List[str]) -> List[Tuple[int, int]]:
    """找出多行文本块的行区间 [start, end)：prompt: | / showprompt: | / key = |。
    键名前缀支持 @ / $@ / $（D 收尾 2026-09-05 补：$x = | 多行初值此前不被
    识别，块内注释豁免失效会剥坏内容——与前端 femoParser.jsx 同形对齐）。
    块内注释豁免（# 和 // 是文本内容）。"""
    ranges = []
    i = 0
    n = len(lines)
    while i < n:
        m = re.match(
            r'^\s*(?:(?:prompt|showprompt):\s*[|｜]|(?:@|\$@|\$)?[\w\u4e00-\u9fff]+\s*=\s*[|｜])\s*(?:#.*)?$',
            lines[i],
        )
        if m:
            base = len(lines[i]) - len(lines[i].lstrip())
            j = i + 1
            while j < n:
                if not lines[j].strip():
                    j += 1
                    continue           # 空行算块内容
                if len(lines[j]) - len(lines[j].lstrip()) <= base:
                    break              # 缩进回到字段层 → 块结束
                j += 1
            ranges.append((i + 1, j))
            i = j
            continue
        i += 1
    return ranges

def build_blocks(text: str, base_indent: int = 0) -> List[Block]:
    """将脚本文本按缩进切分为块树，支持模块递归"""
    raw_lines = text.split('\n')
    prompt_ranges = _find_multiline_ranges(raw_lines)
    lines = []
    for idx, raw in enumerate(raw_lines):
        if any(s <= idx < e for s, e in prompt_ranges):
            # prompt 块内：原样保留（注释豁免，不剥 # //）
            content = raw.strip()
            if content:
                indent = len(raw) - len(raw.lstrip())
                lines.append((indent, content))
            continue
        stripped = raw.rstrip()
        if _is_blank_or_comment(stripped):
            continue
        indent = len(raw) - len(raw.lstrip())
        content = _strip_comment(raw).strip()
        lines.append((indent, content))

    blocks: List[Block] = []
    i = 0
    while i < len(lines):
        indent, content = lines[i]
        if indent < base_indent:
            break
        btype = _detect_type(content)
        header = content
        block = Block(type=btype, header=header, indent=indent)

        if btype == 'module':
            inner_lines = []
            j = i + 1
            while j < len(lines) and lines[j][0] > indent:
                inner_lines.append(lines[j])
                j += 1
            if inner_lines:
                # 相对缩进：子行缩进 - 当前行缩进 - 1（保证至少1个空格）
                inner_text = '\n'.join(
                    ' ' * max(0, il[0] - indent - 1) + il[1]
                    for il in inner_lines
                )
                block.daughters = build_blocks(inner_text, base_indent=0)
            blocks.append(block)
            i = j
        else:
            j = i + 1
            while j < len(lines) and lines[j][0] > indent:
                # 保留原始缩进（空格 + 内容），多行文本依赖此缩进判断
                original_line = ' ' * lines[j][0] + lines[j][1]
                block.content_lines.append(original_line)
                j += 1
            blocks.append(block)
            i = j

    return blocks

# ============================================================
# 3. 语义分发器 (Block Evaluator) — 辅助函数
# ============================================================

def _parse_value(s: str) -> Any:
    s = s.strip()
    if s.startswith('[') and s.endswith(']'):
        inner = s[1:-1].strip()
        if not inner:
            return []
        items = _split_br(inner)
        return [_parse_value(it.strip()) for it in items]
    if s.startswith('{') and s.endswith('}'):
        inner = s[1:-1].strip()
        if not inner:
            return {}            # 空字典
        # 非空字典：逐个键值对解析
        d = {}
        for pair in _split_br(inner):
            if ':' in pair:
                k, v = pair.split(':', 1)
                key = _parse_dict_key(k.strip())
                d[key] = _parse_value(v.strip())
        return d
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        return s[1:-1]
    if s == 'true':
        return True
    if s == 'false':
        return False
    if s.startswith('@{') and s.endswith('}'):
        return s  # 动态引用原样保留
    if s.startswith('@'):
        return s  # ActorRef 字符串表示
    try:
        if '.' in s:
            return float(s)
        return int(s)
    except ValueError:
        return s

def _parse_dict_key(k: str) -> Any:
    if (k.startswith('"') and k.endswith('"')) or (k.startswith("'") and k.endswith("'")):
        k = k[1:-1]
    if k.startswith('@'):
        return ActorRef(k[1:].split('.')[0], k[1:].split('.')[1] if '.' in k[1:] else None)
    return k

def _split_br(s: str) -> List[str]:
    items, depth, cur = [], 0, []
    in_str, qc = False, None
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

def _eval_kv_block(lines: List[str]) -> Dict[str, Any]:
    d = {}
    i = 0
    while i < len(lines):
        line = lines[i]
        # 归一化当前行（可能影响等号、引号等），但保留原始行用于多行文本
        norm_line = normalize_symbols(line)
        if '=' in norm_line:
            k, v = norm_line.split('=', 1)
            k, v = k.strip(), v.strip()
            
            # ---- 特殊处理 owner 字段：始终保留为字符串列表 ----
            if k == 'owner':
                raw_v = v.strip()
                # 去掉外层方括号（如果有），否则保留原值
                if raw_v.startswith('[') and raw_v.endswith(']'):
                    inner = raw_v[1:-1].strip()
                else:
                    inner = raw_v
                if not inner:
                    d[k] = []
                else:
                    # 支持中文逗号、顿号，全部替换为英文逗号
                    inner = inner.replace('，', ',').replace('、', ',')
                    items = _split_br(inner)
                    d[k] = [it.strip().strip('"').strip("'") for it in items]
                i += 1
                continue
            # ---- 其他键正常处理 ----
            
            if v == '|':
                i += 1
                v_lines = []
                # 多行文本内容不进行符号归一化，保留原样
                while i < len(lines) and (lines[i].startswith(' ') or lines[i].startswith('\t')):
                    v_lines.append(lines[i].strip())
                    i += 1
                v = '\n'.join(v_lines)
                d[k] = v
                continue
            d[k] = _parse_value(v.strip())
        i += 1
    return d

def _parse_tools(s: str) -> List[str]:
    s = s.strip()
    if s.startswith('[') and s.endswith(']'):
        inner = s[1:-1].strip()
        if not inner:
            return []
        return [t.strip().strip('"').strip("'") for t in inner.split(',')]
    return []


# thinking 档位词汇（A2.1 解耦）：这里是内置缺省（standalone 自圆满），
# 运行期以宿主清单 host_manifest.thinking_levels() 为准——清单由接口侧
# 提供（--host-manifest），换 harness 换清单文件，引擎零改动。无 default——
# 「默认」由「不带 thinking 声明」表达（语义同宿主模型选择器的 Default 项）。
# 另接受显式 `default` 值：解析期归一化为未声明，与不传字段完全等效。
THINKING_LEVELS = host_manifest.DEFAULT_THINKING_LEVELS


def _parse_thinking(s: str) -> str:
    """actor 的 thinking 档位：小写归一 + 词汇校验，非法直接编译报错
    （fail loud，不静默透传给网关）。`default` 显式值 ≡ 未声明（返回空串，
    上游按「无 thinking 声明」处理，效果与不传字段完全一致）。"""
    v = s.strip().strip('"').strip("'").lower()
    if v == 'default':
        return ''
    levels = host_manifest.thinking_levels()
    if v not in levels:
        raise ValueError(
            f"thinking 档位不合法: {v!r}（允许: default/{'/'.join(levels)}）")
    return v


def _parse_out_multi(s: str) -> List[OutDef]:
    s = s.strip().rstrip(',').strip()
    if not s:
        return []
    items = _split_br(s)
    result = []
    for item in items:
        item = item.strip()
        if not item:
            continue
        # 赋值形式（$ 前缀 shared 变量同样支持：$x -= 1 / $@选中的人 = @某）
        m = re.match(r'^([\w\[\].$]+)\s*([+\-]?=)\s*(.+)$', item)
        if m:
            var_name = m.group(1)
            op = m.group(2)
            value = m.group(3).strip()
            result.append(OutDef(var_name=f"{var_name} {op} {value}", out_type=OutType.ASSIGN, label=""))
            continue
        # 函数调用形式（字符类含 $/@：$var(string, "标签") / dict.@key(string)）
        pm = re.match(r'^([$\w.{}@]+)\(([^)]*)\)', item)
        if pm:
            full_name, params_str = pm.group(1), pm.group(2)
            if '.' in full_name:
                parts = full_name.split('.', 1)
                var_name, dynamic_key = parts[0], parts[1]
            else:
                var_name, dynamic_key = full_name, None
            out_type, label, choices = OutType.STRING, "", None
            params = _split_br(params_str)
            positional_idx = 0
            for p in params:
                p = p.strip()
                if p.startswith('choices='):
                    choices = p[len('choices='):].strip()
                elif p.startswith('label='):
                    label = p[len('label='):].strip().strip('"').strip("'")
                else:
                    if positional_idx == 0:
                        try:
                            out_type = OutType(p.lower())
                        except:
                            pass
                    elif positional_idx == 1:
                        label = p.strip().strip('"').strip("'")
                    positional_idx += 1
            result.append(OutDef(var_name=var_name, dynamic_key=dynamic_key,
                                 out_type=out_type, label=label, choices=choices))
            continue
        # 纯变量名
        result.append(OutDef(var_name=item, out_type=OutType.STRING, label=""))
    return result
    


def _parse_action_fields(block: Block) -> dict:
    f = {
        'prompt': None, 'showprompt': None,
        'scope': [], 'in_mappings': [], 'outs': [],
        'resolve': None, 'max_retries': 0, 'fallback': None,
        'memory': None, 'context': None, 'interrupt': None,
    }
    lines = block.content_lines
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        # 对语法行进行符号归一化，但保留原始行用于提取 prompt 文本
        normalized_line = normalize_symbols(line)
        if normalized_line.startswith('prompt:'):
            pv = normalized_line[len('prompt:'):].strip()
            # 支持中文竖线（｜）作为多行标志
            if pv in ('|', '｜'):
                base_indent = len(lines[i]) - len(lines[i].lstrip())
                j = i + 1
                plines = []
                while j < len(lines):
                    line_j = lines[j]
                    stripped = line_j.lstrip()
                    indent = len(line_j) - len(stripped)
                    # 同缩进 + 二级字段关键字 → 结束
                    if indent == base_indent and any(stripped.startswith(k) for k in _FIELD_KEYWORDS):
                        break
                    # 缩进小于等于当前缩进，且是一级关键字 → 结束
                    if indent <= base_indent and any(stripped.startswith(k) for k in _TOP_KEYWORDS):
                        break
                    # 否则属于 prompt 内容
                    plines.append(line_j.strip())
                    j += 1
                f['prompt'] = '\n'.join(plines)
                i = j
                continue
            else:
                f['prompt'] = pv.strip('"').strip("'")
        elif normalized_line.startswith('showprompt:'):
            pv = normalized_line[len('showprompt:'):].strip()
            # 支持中文竖线（｜）作为多行标志
            if pv in ('|', '｜'):
                base_indent = len(lines[i]) - len(lines[i].lstrip())
                j = i + 1
                plines = []
                while j < len(lines):
                    line_j = lines[j]
                    stripped = line_j.lstrip()
                    indent = len(line_j) - len(stripped)
                    # 同缩进 + 二级字段关键字 → 结束
                    if indent == base_indent and any(stripped.startswith(k) for k in _FIELD_KEYWORDS):
                        break
                    # 缩进小于等于当前缩进，且是一级关键字 → 结束
                    if indent <= base_indent and any(stripped.startswith(k) for k in _TOP_KEYWORDS):
                        break
                    # 否则属于 prompt 内容
                    plines.append(line_j.strip())
                    j += 1
                f['showprompt'] = '\n'.join(plines)
                i = j
                continue
            else:
                f['showprompt'] = pv.strip('"').strip("'")
        elif normalized_line.startswith('scope:'):
            # 保留原始 scope 字符串，去掉 'scope:' 前缀并去除两端空白
            raw_scope = line.strip()[len('scope:'):].strip()
            f['scope'] = raw_scope
        elif normalized_line.startswith('in:'):
            rest = normalized_line[len('in:'):].strip()
            if not rest:
                base_indent = len(lines[i]) - len(lines[i].lstrip())
                j = i + 1
                mappings = []
                while j < len(lines):
                    line_j = lines[j]
                    stripped = line_j.lstrip()
                    indent = len(line_j) - len(stripped)
                    # 同缩进 + 二级字段关键字 → 结束
                    if indent == base_indent and any(stripped.startswith(k) for k in _FIELD_KEYWORDS):
                        break
                    # 缩进小于等于当前缩进，且是一级关键字 → 结束
                    if indent <= base_indent and any(stripped.startswith(k) for k in _TOP_KEYWORDS):
                        break
                    # 处理映射行
                    mline = line_j.strip().rstrip(',')
                    if '=' in mline:
                        k, v = mline.split('=', 1)
                        mappings.append(InMapping(k.strip(), v.strip()))
                    else:
                        mappings.append(InMapping(mline, mline, bare=True))
                    j += 1
                f['in_mappings'] = mappings
                i = j
                continue
            else:
                for mapping_str in rest.split(','):
                    mapping_str = mapping_str.strip()
                    if '=' in mapping_str:
                        k, v = mapping_str.split('=', 1)
                        f['in_mappings'].append(InMapping(k.strip(), v.strip()))
                    else:
                        f['in_mappings'].append(InMapping(mapping_str, mapping_str, bare=True))
        elif normalized_line.startswith('out:'):
            out_rest = normalized_line[len('out:'):].strip()
            base_indent = len(lines[i]) - len(lines[i].lstrip())
            j = i + 1
            # 首行（若有内容）+ 后续缩进续行统一收集：
            #   out: x += 1        （单行 + 续行）
            #        y = {}        （缩进续行，同样生效）
            #   out:               （纯多行模式，首行无内容）
            if out_rest:
                f['outs'].extend(_parse_out_multi(out_rest))
            while j < len(lines):
                line_j = lines[j]
                stripped = line_j.lstrip()
                indent = len(line_j) - len(stripped)
                # 同缩进 + 二级字段关键字 → 结束
                if indent == base_indent and any(stripped.startswith(k) for k in _FIELD_KEYWORDS):
                    break
                # 缩进小于等于当前缩进，且是一级关键字 → 结束
                if indent <= base_indent and any(stripped.startswith(k) for k in _TOP_KEYWORDS):
                    break
                ol = normalize_symbols(lines[j].strip())
                if ol:
                    f['outs'].extend(_parse_out_multi(ol))
                j += 1
            i = j
            continue
        elif line.startswith('resolve:'):
            raw = line[len('resolve:'):].strip()
            m = re.match(r'^(\S+)\(([^)]*)\)$', raw)
            if m:
                f['resolve'] = m.group(1).strip()
                f['resolve_args'] = [a.strip() for a in m.group(2).split(',') if a.strip()]
            else:
                f['resolve'] = raw
                f['resolve_args'] = []
        elif line.startswith('max_retries:'):
            try:
                f['max_retries'] = int(line[len('max_retries:'):].strip())
            except:
                pass
        elif line.startswith('fallback:'):
            f['fallback'] = line[len('fallback:'):].strip()
        elif line.startswith('memory:'):
            f['memory'] = line[len('memory:'):].strip()
        elif line.startswith('context:'):
            f['context'] = line[len('context:'):].strip()
        elif line.startswith('interrupt:'):
            f['interrupt'] = line[len('interrupt:'):].strip()
        i += 1
    return f

# ============================================================
# 语义分发器 — 各类型 evaluator
# ============================================================

def eval_meta(block: Block) -> Dict[str, Any]:
    return _eval_kv_block(block.content_lines)

def eval_vars(block: Block) -> Dict[str, Any]:
    d = _eval_kv_block(block.content_lines)
    def normalize(v):
        if isinstance(v, dict):
            return {normalize(k): normalize(val) for k, val in v.items()}
        if isinstance(v, list):
            return [normalize(item) for item in v]
        if isinstance(v, ActorRef):
            return str(v)
        return v
    return {k: normalize(v) for k, v in d.items()}

def eval_code(block: Block) -> Dict[str, str]:
    d = {}
    for line in block.content_lines:
        if '=' in line:
            k, v = line.split('=', 1)
            k = k.strip()
            v = v.strip()
            if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
                v = v[1:-1]
            d[k] = v
    return d

def eval_actors(block: Block) -> Dict[str, ActorDef]:
    actors = {}
    lines = block.content_lines
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        bm = re.match(r'^(?:blueprint\s+|@)(\w+)\s*:\s*$', line)
        if bm:
            name = bm.group(1)
            attrs = {}
            j = i + 1
            while j < len(lines) and lines[j].startswith(' '):
                al = lines[j].strip()
                if '=' in al:
                    ak, av = al.split('=', 1)
                    ak, av = ak.strip(), av.strip().strip('"').strip("'")
                    if ak == 'tools':
                        av_l = av.strip()
                        if av_l in ('true', 'false'):
                            attrs['tools_enabled'] = av_l == 'true'
                        else:
                            attrs['tools'] = _parse_tools(av)
                            if not attrs['tools']:
                                # 显式空白名单 [] ≡ 明确禁用（tools_enabled=False）。
                                # 与「不写 tools」（tools_enabled=None，宿主默认全开）
                                # 严格区分——否则 ai_request 载荷无法区分两者
                                # （2026-09-12 语义修正）。
                                attrs['tools_enabled'] = False
                    elif ak == 'thinking':
                        attrs['thinking'] = _parse_thinking(av)
                    elif ak in ('soul', 'source'):
                        attrs[ak] = av  # 保持字符串，不转数字
                    else:
                        attrs[ak] = av
                j += 1
            actors[name] = ActorDef(type=ActorType.BLUEPRINT, ref=name, name=name,
                                    source=attrs.get('source'), tools=attrs.get('tools', []),
                                    tools_enabled=attrs.get('tools_enabled'),
                                    thinking=attrs.get('thinking'),
                                    is_blueprint=True)
            i = j
            continue
        if '=' in line:
            left, rest = line.split('=', 1)
            left_parts = left.strip().split()
            if len(left_parts) >= 2 and left_parts[0] in ('ai', 'human'):
                ats = left_parts[0]
                nm = left_parts[1]
                at = ActorType.AI if ats == 'ai' else ActorType.HUMAN
                soul, source, tools, tools_enabled, thinking = None, None, [], None, None
                for p in _split_br(rest):
                    p = p.strip()
                    if p.startswith('soul:'):
                        raw_soul = p[5:].strip().strip('"').strip("'")
                        soul = raw_soul if raw_soul else None
                        #print(f"[DEBUG eval_actors] raw_soul={raw_soul!r}, final soul={soul!r}")
                    elif p.startswith('source:'):
                        source = p[7:].strip().strip('"').strip("'")
                        #print(f"[DEBUG eval_actors] source={source!r}")
                    elif p.startswith('thinking:'):
                        thinking = _parse_thinking(p[len('thinking:'):])
                    elif p.startswith('thinking ='):
                        thinking = _parse_thinking(p[len('thinking ='):])
                    elif p.startswith('tools:'):
                        raw_tools = p[6:].strip()
                        if raw_tools in ('true', 'false'):
                            tools_enabled = raw_tools == 'true'
                        else:
                            tools = _parse_tools(raw_tools)
                            if not tools:
                                tools_enabled = False   # 显式空列表 [] ≡ 明确禁用（≠ 不写）
                    elif p.startswith('tools ='):
                        raw_tools = p[len('tools ='):].strip()
                        if raw_tools in ('true', 'false'):
                            tools_enabled = raw_tools == 'true'
                        else:
                            tools = _parse_tools(raw_tools)
                            if not tools:
                                tools_enabled = False   # 显式空列表 [] ≡ 明确禁用（≠ 不写）
                actors[nm] = ActorDef(type=at, ref=nm, name=nm, soul=soul, source=source,
                                      tools=tools, tools_enabled=tools_enabled, thinking=thinking)
                #print(f"[DEBUG eval_actors] 创建 human actor: {nm}, soul={soul!r}, source={source!r}")
        else:
            # 裸 actor：`ai @名`（无 `=`、无属性）→ soul/source 缺省（soul 非必须；
            # 无 soul 角色 = 无角色设定的裸执行者，上下文见 ContextExample 全可见语义）。
            left_parts = line.strip().split()
            if len(left_parts) >= 2 and left_parts[0] in ('ai', 'human'):
                ats, nm = left_parts[0], left_parts[1]
                at = ActorType.AI if ats == 'ai' else ActorType.HUMAN
                actors[nm] = ActorDef(type=at, ref=nm, name=nm, soul=None, source=None,
                                      tools=[], tools_enabled=None)
        i += 1
    return actors

def eval_action(block: Block) -> ActionDef:
    header = normalize_symbols(block.header)
    m = re.match(r'^action\s+(\w+)\s+@(\w+)(?:\(([^)]*)\))?\s*(?:as\s*\(([^)]*)\))?\s*:\s*$', header)
    if not m:
        raise ValueError(f"无法解析 action 头部: {header}")
    name = m.group(1)
    etype = m.group(2)
    eparam = (m.group(3) or '').strip()
    as_actor = m.group(4)
    fields = _parse_action_fields(block)
    return ActionDef(
        name=name,
        executor_type=ExecutorType(etype),
        executor_param=eparam,
        as_actor=as_actor,
        **fields
    )

def eval_method(block: Block) -> MethodDef:
    header = normalize_symbols(block.header)
    m = re.match(r'^(memory|context)\s+(\w+)\s*\(\s*(\w+)\.(\w+)\s*\)\s*:\s*$', header)
    if not m:
        raise ValueError(f"无法解析 method 头部: {header}")
    name = m.group(2)
    module_alias = m.group(3)
    func_name = m.group(4)
    in_params = []
    out_defs = []
    lines = block.content_lines
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if line.startswith('in:'):
            rest = line[3:].strip()
            if rest:
                in_params = [p.strip() for p in rest.split(',') if p.strip()]
            else:
                i += 1
                while i < len(lines) and lines[i].startswith(' '):
                    pl = lines[i].strip().rstrip(',')
                    if pl:
                        in_params.append(pl)
                    i += 1
                continue
        elif line.startswith('out:'):
            rest = line[4:].strip()
            if rest:
                out_defs = _parse_out_multi(rest)
            else:
                i += 1
                out_lines = []
                while i < len(lines) and lines[i].startswith(' '):
                    out_lines.append(lines[i].strip())
                    i += 1
                if out_lines:
                    out_defs = _parse_out_multi(' '.join(out_lines))
                continue
        i += 1
    return MethodDef(name=name, module_alias=module_alias, func_name=func_name,
                     in_params=in_params, out_defs=out_defs)

# ============================================================
# 4. Flow 子解析 (原 FlowBuilder 完整移植)
# ============================================================

# ---- 缩进树构建 (为 flow 内部使用) ----
@dataclass
class IndentBlock:
    indent: int
    line: str
    daughters: List['IndentBlock'] = field(default_factory=list)

def build_indent_tree(text: str) -> List[IndentBlock]:
    """把 flow 文本按缩进解析成一棵树，忽略空行和注释"""
    lines = []
    for raw in text.split('\n'):
        stripped = raw.rstrip()
        if not stripped or stripped.lstrip().startswith('#') or stripped.lstrip().startswith('//'):
            continue
        indent = len(raw) - len(raw.lstrip())
        content = raw.strip()
        lines.append((indent, content))

    if not lines:
        return []

    root_blocks: List[IndentBlock] = []
    stack: List[Tuple[int, List[IndentBlock]]] = [(-1, root_blocks)]

    for indent, content in lines:
        block = IndentBlock(indent=indent, line=content)
        while stack[-1][0] >= indent:
            stack.pop()
        stack[-1][1].append(block)
        stack.append((indent, block.daughters))

    return root_blocks

# ---- Token 解析器 ----
def tokenize_chain(line: str) -> List[dict]:
    """解析一条 -> 链式行，支持嵌套括号的条件表达式"""
    line = re.sub(r'(?<!\s)--(?!\s)', '->', line)
    content = re.sub(r'^->\s*', '', line)

    conds = []
    # 使用 Python 编译器安全地提取 if (...) 中的完整表达式
    def extract_conditions(s):
        parts = []
        i = 0
        while i < len(s):
            if s.startswith('if', i):
                j = i + 2
                while j < len(s) and s[j].isspace():
                    j += 1
                if j < len(s) and s[j] == '(':
                    # 找到匹配的右括号
                    start = j
                    depth = 1
                    j += 1
                    while j < len(s) and depth > 0:
                        if s[j] == '(':
                            depth += 1
                        elif s[j] == ')':
                            depth -= 1
                        j += 1
                    if depth == 0:
                        expr = s[start+1:j-1].strip()
                        conds.append(expr)
                        parts.append(f'__COND_{len(conds)-1}__')
                        i = j
                        continue
            parts.append(s[i])
            i += 1
        return ''.join(parts)

    protected = extract_conditions(content)

    parts = re.split(r'\s*->\s*', protected)
    parts = [p.strip() for p in parts if p.strip()]

    tokens = []
    for part in parts:
        cond_match = re.match(r'^__COND_(\d+)__$', part)
        if cond_match:
            idx = int(cond_match.group(1))
            tokens.append({'type': 'cond', 'expr': conds[idx]})
        elif part == '[END]':
            tokens.append({'type': 'node', 'name': '[END]', 'ntype': 'end'})
        elif part == '[BREAK]':
            tokens.append({'type': 'node', 'name': '[BREAK]', 'ntype': 'break'})
        else:
            if part in ('for', 'par', 'fork', 'join', 'to'):
                raise SyntaxError(f"控制关键字 '{part}' 不能出现在普通链中")
            tokens.append({'type': 'node', 'name': part, 'ntype': 'action'})
    return tokens

def chain_tokens(g: FlowGraph, tokens: List[dict], entry: str, reg_node_fn, reg_auto_fn) -> str:
    """处理一条 token 链，返回链尾节点ID"""
    current = entry if entry is not None else None
    pending_cond = None

    for tok in tokens:
        if tok['type'] == 'cond':
            pending_cond = tok['expr']
        elif tok['type'] == 'node':
            name = tok['name']
            if re.match(r'^\[.+\]', name):
                # 正式节点
                nid = reg_node_fn(g, name, tok.get('ntype', 'action'))
                g.add_edge(current, nid, condition=pending_cond or "")
                pending_cond = None
                current = nid
            else:
                raise SyntaxError(f"未声明的动作或模块 '{name}'，请在 flow 前用 [节点]: 语法定义。")

    return current

def _split_module_ref(ref: str) -> Tuple[str, Optional[str]]:
    """module_ref → (模块名, 参数原文)。'Name(a, b)' → ('Name', 'a, b')；
    'Outer.Inner(x)' → ('Outer.Inner', 'x')；'Name' → ('Name', None)。
    模块名允许点路径（嵌套模块完整路径）。运行时 _run_module 的拆参共用
    本函数（单一事实源，两处正则曾各自为政导致点路径带参拆参失败）：
    编译期只校验模块名，参数原文由运行时求值入帧。"""
    raw = (ref or '').strip()
    m = re.match(r'^([\w\u4e00-\u9fff]+(?:\.[\w\u4e00-\u9fff]+)*)\s*\((.*)\)$', raw, re.S)
    if m:
        return m.group(1), m.group(2)
    return raw, None

def validate_flow_refs(
    flow: FlowGraph,
    known_actions: Dict[str, Any],
    known_modules: Optional[Dict[str, Any]],
    where: str,
) -> None:
    """校验 flow 中节点绑定的 action/module 均已声明。

    背景（2026-08-18）：标准化器（FEMO_normalizer._replace_bare_in_fragment）把
    任意裸 token 无条件替换成 [节点] 绑定，不校验是否已声明——裸名引用未声明的
    action 因此能混过编译，运行时才炸。解析器必须兜底：裸名引用必须是已声明的
    action/module；空节点（[名字] 无绑定）合法。
    module 绑定允许带参（&Name(args)）与点路径（&Outer.Inner）——剥参后只
    校验模块名，参数原文由运行时 _run_module 求值入帧。known_modules 传
    None 时跳过模块校验（mainflow 的模块引用由 parse_script 尾部后置校验，
    含嵌套点路径且不受块书写顺序影响）。"""
    if flow is None:
        return
    for node in flow.nodes.values():
        if node.action_name and node.action_name not in known_actions:
            raise SyntaxError(
                f"{where} 中引用了未声明的动作 '{node.action_name}'（节点 {node.id}）。"
                f"裸名引用必须是已声明的 action；空节点请写 [名字]（不绑定动作）。"
            )
        if node.module_ref and known_modules is not None:
            ref_name, _args = _split_module_ref(node.module_ref)
            if ref_name not in known_modules:
                raise SyntaxError(
                    f"{where} 中引用了未声明的模块 '{node.module_ref}'（节点 {node.id}）。"
                )


def _collect_module_paths(mods: Dict[str, 'ModuleDef'], prefix: str,
                          out: Dict[str, 'ModuleDef']) -> None:
    """收集全部嵌套模块的完整点路径（'Outer.Inner'）→ 定义。mainflow 点路径
    直引内层模块的编译期可见集（运行时 _run_module 的点路径通道自
    2026-09-12 起支持，此处对齐）。"""
    for name, mod in (mods or {}).items():
        path = f'{prefix}.{name}' if prefix else name
        out[path] = mod
        _collect_module_paths(mod.modules or {}, path, out)


def validate_module_flows(mod: ModuleDef, script: 'Script',
                          inherited_actions: Optional[List[Dict[str, Any]]] = None,
                          inherited_modules: Optional[List[Dict[str, Any]]] = None) -> None:
    """递归校验模块 flow 的引用。

    action 可见域与变量词法链同构（拍板 6）：本模块 actions + 祖先链模块
    actions + 全局 script.actions——运行时 _execute_node_content 按
    「模块帧 actions 优先、script.actions 兜底」查找（模块帧初值由
    _run_module/_flow_for_stack 沿 mod_path 词法链合并），校验域必须与之
    对齐，不能比运行时更严。
    module 可见域走同一条词法链：全局 module + 全部嵌套点路径 + 祖先链
    各层声明的直接子模块（兄弟互调 &InnerA 即母层声明的名字）+ 本模块
    直接子模块。运行时 _run_module 沿定义链由内向外逐层解析，内外同名时
    内层（更近祖先）胜出。兄弟的 action 仍不可见——它不是祖先声明的名字。"""
    visible: Dict[str, Any] = dict(script.actions)
    for layer in (inherited_actions or []):
        visible.update(layer)
    visible.update(mod.actions)
    if mod.flow is not None:
        known_modules = dict(script.modules)
        _collect_module_paths(script.modules, '', known_modules)
        for layer in (inherited_modules or []):
            known_modules.update(layer)
        known_modules.update(mod.modules)
        validate_flow_refs(
            mod.flow,
            visible,
            known_modules,
            f"module {mod.name}",
        )
    sub_chain_actions = (inherited_actions or []) + [mod.actions]
    sub_chain_modules = (inherited_modules or []) + [mod.modules]
    for sub in mod.modules.values():
        validate_module_flows(sub, script, sub_chain_actions, sub_chain_modules)


# ---- 安全条件求值 ----
def eval_condition(expr: str, context: dict) -> bool:
    """安全求值 Python 表达式，供运行时和流程图解析使用"""
    safe_expr = re.sub(r'@(\w+)', r'"@\1"', expr)
    try:
        tree = ast.parse(safe_expr, mode='eval')
    except SyntaxError:
        raise SyntaxError(f"条件表达式语法错误: {expr} -> 解析为 '{safe_expr}'")

    safe_builtins = {
        'True': True, 'False': False, 'None': None,
        'len': len, 'int': int, 'str': str, 'float': float,
        'bool': bool, 'abs': abs, 'min': min, 'max': max,
        'sum': sum, 'any': any, 'all': all,
        'isinstance': isinstance, 'hasattr': hasattr,
        'list': list, 'dict': dict, 'set': set, 'tuple': tuple,
        'range': range, 'enumerate': enumerate,
    }

    namespace = {**safe_builtins, **context}
    try:
        result = eval(compile(tree, '<cond>', 'eval'), {"__builtins__": {}}, namespace)
        return bool(result)
    except Exception as e:
        raise RuntimeError(f"条件表达式求值失败: '{expr}', 上下文: {list(context.keys())}, 错误: {e}")

# ---- FlowBuilder 主类 ----
class FlowBuilder:
    def __init__(self):
        self._counter = 0
        self.node_bindings: Dict[str, str] = {}   # 节点绑定表 {节点名: 动作或&模块}

    def _next_id(self, prefix: str) -> str:
        self._counter += 1
        return f"__{prefix}_{self._counter}__"
        
    def _reg_auto_node(self, g: FlowGraph, action_ref: str) -> str:
        """为裸动作或模块引用自动创建节点，自动处理重名（后缀 _1, _2 ...）"""
        if action_ref.startswith('&'):
            base_label = action_ref          # e.g. "&MD"
            module_ref = action_ref[1:]
            action_name = None
        else:
            base_label = action_ref
            module_ref = None
            action_name = action_ref

        node_id = f'[{base_label}]'
        counter = 1
        while node_id in g.nodes:
            node_id = f'[{base_label}_{counter}]'
            counter += 1

        node = FlowNode(
            id=node_id, type='action', label=base_label,
            action_name=action_name, module_ref=module_ref,
        )
        g.add_node(node)
        return node_id

    def _reg_node(self, g: FlowGraph, name: str, ntype: str = "action") -> str:
        m = re.match(r'^\[([^\]]+)\]', name)
        if m:
            node_id = f'[{m.group(1)}]'
            label = m.group(1)
            rest = name[m.end():].lstrip(':')
        else:
            raise ValueError(f"不能将裸动作/模块注册为节点: {name}")

        if node_id in g.nodes:
            return node_id

        action_name = None
        module_ref = None
        # 优先从绑定字典获取（标准化器提供的声明区信息）
        node_key = m.group(1)   # 节点名（不含方括号）
        binding = self.node_bindings.get(node_key, '')
        if binding:
            if binding.startswith('&'):
                module_ref = binding[1:]
            else:
                action_name = binding
        elif rest:
            rest = rest.strip()
            if rest.startswith('&'):
                module_ref = rest[1:]
            else:
                action_name = rest

        if node_id in ('[START]', '[END]', '[BREAK]', '[IN]', '[OUT]'):
            special_map = {
                '[START]': 'start', '[END]': 'end', '[BREAK]': 'break',
                '[IN]': 'start', '[OUT]': 'end',
            }
            ntype = special_map.get(node_id, ntype)

        node = FlowNode(
            id=node_id, type=ntype, label=label,
            action_name=action_name, module_ref=module_ref,
        )
        g.add_node(node)
        return node_id

    def _reg_gateway(self, g: FlowGraph, prefix: str, ntype: str, meta: dict = None) -> str:
        gid = self._next_id(prefix)
        g.add_node(FlowNode(id=gid, type=ntype, meta=meta or {}))
        return gid


    def build_flow(self, text: str) -> FlowGraph:
        blocks = build_indent_tree(text)
        g = FlowGraph()
        self._pending_exit_candidates = {}  # 临时存储 for/par 的出口候选，供出口行连接
        self._parse_flow_blocks(blocks, g, None)
        return g

    def _parse_flow_blocks(self, blocks: List[IndentBlock], g: FlowGraph, pending_from: Optional[str]):
        """递归解析顶层或嵌套的流程块列表"""
        i = 0
        while i < len(blocks):
            block = blocks[i]
            line = block.line.strip()

            # ── 出口行 `-> Target` ──
            if line.startswith('->') and not re.search(r'\b(for|par|fork|join)\b', line):
                # 孤立出口行不允许，除非是由外部 for/par 消费
                raise SyntaxError(f"孤立的出口行，只能紧跟在 for/par 块之后消费: {line}")

            # ── join(...): 独立行（无前导链） ──
            if re.match(r'^join\s*(?:\((\w+)\))?\s*:\s*$', line):
                join_gw = self.parse_join(block, g)
                # 检查下一个同级块是否为 'to Target' 出口行（支持链：to [X]:ref -> [Y]）
                if i + 1 < len(blocks):
                    next_line = blocks[i + 1].line.strip()
                    if next_line.startswith('to '):
                        target_str = next_line[3:].strip()
                        target_id = self.parse_single_chain(target_str, join_gw, g)
                        pending_from = target_id if target_id is not None else join_gw
                        i += 2
                        continue
                pending_from = join_gw
                i += 1
                continue

            # ── 控制块首行 [Node] -> for/par/fork/join ──
            ctrl_match = re.match(r'^(.+?)\s*->\s*(for|par|fork|join)\b(.*):\s*$', line)
            if ctrl_match:
                ctrl_type = ctrl_match.group(2)
                if ctrl_type == 'for':
                    # 提取变量和迭代器
                    params = ctrl_match.group(3).strip()
                    var_m = re.match(r'(@?\w+)\s+in\s+(.+)', params)
                    if not var_m:
                        raise SyntaxError(f"for 语法错误: {line}")
                    var_name = var_m.group(1)
                    iterable = var_m.group(2)
                    loop_gw = self._reg_gateway(g, "for", "gateway",
                                                meta={"gw_kind": "for", "var_name": var_name, "iterable": iterable})
                    pre_tail = self.parse_single_chain(ctrl_match.group(1).strip(), None, g)
                    if pre_tail:
                        g.add_edge(pre_tail, loop_gw)
                    # 处理 for 体
                    nested, plain = self._separate_nested_blocks(block.daughters)
                    exit_candidates = self._process_inner_single_lines(plain, loop_gw, g)
                    for nest_block in nested:
                        self._process_nested_control_block(nest_block, g)
                    # 检查下一个同级块是否为出口行（支持链：-> [X]:ref -> [Y]；
                    # 若出口行同时是控制块入口（-> [A] -> [B] -> fork:），
                    # 链部分建出口边，控制块行留给主循环处理）
                    target_id = None
                    if i + 1 < len(blocks):
                        next_line = blocks[i + 1].line.strip()
                        if next_line.startswith('->'):
                            m_ctrl = re.search(r'\s*->\s*(for|par|fork|join)\b', next_line)
                            if m_ctrl:
                                chain_part = next_line[2:m_ctrl.start()].strip()
                                if chain_part:
                                    head = self.parse_single_chain(chain_part.split('->', 1)[0].strip(), None, g)
                                    tail = self.parse_single_chain(chain_part, None, g)
                                    target_id = head if head is not None else tail
                                    pending_from = tail if tail is not None else target_id
                                # 不消费该行：主循环会处理 -> ... -> fork: 整行
                            else:
                                chain_str = next_line[2:].strip()
                                head = self.parse_single_chain(chain_str.split('->', 1)[0].strip(), None, g)
                                tail = self.parse_single_chain(chain_str, None, g)
                                target_id = head if head is not None else tail
                                pending_from = tail if tail is not None else target_id
                                i += 1  # 消费出口行
                    # 为每个出口候选节点添加回边到循环网关
                    for nid in exit_candidates:
                        g.add_edge(nid, loop_gw)
                    if target_id:
                        g.add_edge(loop_gw, target_id)      # 循环结束后的出口边（连链首）
                        pending_from = pending_from if pending_from is not None else target_id
                    else:
                        if not exit_candidates:
                            raise SyntaxError(
                                f"for 循环体缺少出口标记（行末 '->'），必须至少有一个出口，或者提供出口行 -> Target"
                            )
                        break_id = self._reg_node(g, "[BREAK]", "break")
                        g.add_edge(loop_gw, break_id)
                        pending_from = break_id

                elif ctrl_type == 'par':
                    join_gw = self.parse_par(block, g)
                    # 检查下一个同级块是否为出口行（支持链：-> [X]:ref -> [Y]；
                    # 若出口行同时是控制块入口（-> [A] -> [B] -> fork:），
                    # 链部分建出口边，控制块行留给主循环处理）
                    target_id = None
                    if i + 1 < len(blocks):
                        next_line = blocks[i + 1].line.strip()
                        if next_line.startswith('->'):
                            m_ctrl = re.search(r'\s*->\s*(for|par|fork|join)\b', next_line)
                            if m_ctrl:
                                chain_part = next_line[2:m_ctrl.start()].strip()
                                if chain_part:
                                    head = self.parse_single_chain(chain_part.split('->', 1)[0].strip(), None, g)
                                    tail = self.parse_single_chain(chain_part, None, g)
                                    target_id = head if head is not None else tail
                                    pending_from = tail if tail is not None else target_id
                                # 不消费该行：主循环会处理 -> ... -> fork: 整行
                            else:
                                chain_str = next_line[2:].strip()
                                head = self.parse_single_chain(chain_str.split('->', 1)[0].strip(), None, g)
                                tail = self.parse_single_chain(chain_str, None, g)
                                target_id = head if head is not None else tail
                                pending_from = tail if tail is not None else target_id
                                i += 1
                    if target_id:
                        g.add_edge(join_gw, target_id)      # 出口边连链首
                        pending_from = pending_from if pending_from is not None else target_id
                    else:
                        # 如果没有出口行，默认连 [BREAK]
                        break_id = self._reg_node(g, "[BREAK]", "break")
                        g.add_edge(join_gw, break_id)
                        pending_from = break_id

                elif ctrl_type == 'fork':
                    fork_gw = self._reg_gateway(g, "fork", "gateway", meta={"gw_kind": "fork"})
                    pre_tail = self.parse_single_chain(ctrl_match.group(1).strip(), None, g)
                    if pre_tail:
                        g.add_edge(pre_tail, fork_gw)
                    for daughter in block.daughters:
                        cl = daughter.line.strip()
                        if not cl.startswith('->'):
                            raise SyntaxError(f"fork 体内行必须以 '->' 开头: {cl}")
                        if cl.rstrip().endswith('->'):
                            raise SyntaxError(f"fork 体内不允许使用出口标记 '->' : {cl}")
                        core = cl[2:].lstrip()
                        self.parse_single_chain(core, fork_gw, g)
                    pending_from = None  # fork 无统一出口

                elif ctrl_type == 'join':
                    # 带前导链的 join 实际上不允许，但根据要求不改 join，所以不支持前导链
                    raise SyntaxError("join 不支持前导链，请使用 'join(...):' 独立行")
                i += 1
                continue

            # ── 普通单链行（独立起点，不使用 pending_from）──
            if line.startswith('['):
                tail = self.parse_single_chain(line, None, g)
                # 普通链的末端作为新的 pending_from，供后续可能的控制块前导链或出口行使用
                pending_from = tail
                i += 1
                continue

            # 其他情况报错
            raise SyntaxError(f"无法识别的流程行: {line}")
        
        
    # ─── 控制块解析辅助 ────────────────────────────────────────────
    def _parse_control_head(self, line: str):
        """解析 [Node] -> for/par/fork/join(...) : 行，返回 (前导链文本, 控制类型, 参数字符串)"""
        m = re.match(r'^(.+?)\s*->\s*(for|par|fork|join)\b(.*):\s*$', line)
        if not m:
            raise SyntaxError(f"无法解析控制块首行: {line}")
        pre_chain = m.group(1).strip()
        ctrl_type = m.group(2)
        params = m.group(3).strip()
        return pre_chain, ctrl_type, params

    def _separate_nested_blocks(self, daughters: List[IndentBlock]):
        """将子块列表分为嵌套控制块和纯单链行"""
        nested = []
        plain = []
        for daughter in daughters:
            line = daughter.line.strip()
            # 嵌套控制块的首行模式：以 [Node] 开头，且包含 -> for/par/fork/join
            if re.match(r'^\[.+\]\s*->\s*(for|par|fork|join)\b', line):
                nested.append(daughter)
            else:
                plain.append(daughter)
        return nested, plain

    def parse_single_chain(self, line: str, entry: Optional[str], g: FlowGraph):
        """解析一条普通单链，返回链尾节点ID，entry可为None"""
        tokens = tokenize_chain(line)
        if not tokens:
            return entry
        return chain_tokens(g, tokens, entry, self._reg_node, self._reg_auto_node)

    def _process_inner_single_lines(self, plain_daughters: List[IndentBlock],
                                    gateway_id: str, g: FlowGraph) -> List[str]:
        """处理 for/par 体内的纯单链行，返回出口候选节点ID列表"""
        exit_candidates = []
        for daughter in plain_daughters:
            raw_line = daughter.line.strip()
            # 判断行首 -> 和行尾 ->
            starts_with_arrow = raw_line.startswith('->')
            ends_with_arrow = raw_line.rstrip().endswith('->')

            # 剥除首尾 ->
            core = raw_line
            if starts_with_arrow:
                core = core[2:].lstrip()  # 去掉开头的 '->'
            if ends_with_arrow:
                # 去掉末尾的 '->'，注意可能后面有空格
                core = re.sub(r'\s*->\s*$', '', core).rstrip()

            # 决定解析入口
            entry = gateway_id if starts_with_arrow else None
            tail = self.parse_single_chain(core, entry, g)
            if tail is None:
                continue

            if ends_with_arrow:
                exit_candidates.append(tail)
        return exit_candidates

    # ─── 具体控制块解析器 ─────────────────────────────────────────
    def parse_for(self, block: IndentBlock, g: FlowGraph) -> str:
        """解析 for 循环块，返回出口节点ID（或[BREAK]）"""
        pre_chain, _, params = self._parse_control_head(block.line.strip())
        # 提取变量和迭代对象
        m = re.match(r'(@?\w+)\s+in\s+(.+)', params)
        if not m:
            raise SyntaxError(f"for 语法错误: {block.line}")
        var_name = m.group(1)
        iterable = m.group(2)

        # 创建循环网关
        loop_gw = self._reg_gateway(g, "for", "gateway",
                                    meta={"gw_kind": "for", "var_name": var_name, "iterable": iterable})

        # 解析前导链，连接到循环网关
        pre_tail = self.parse_single_chain(pre_chain, None, g) if pre_chain else None
        if pre_tail:
            g.add_edge(pre_tail, loop_gw)

        # 分离嵌套块和单链行
        nested, plain = self._separate_nested_blocks(block.daughters)
        # 先处理单链行
        exit_candidates = self._process_inner_single_lines(plain, loop_gw, g)
        # 递归处理嵌套控制块（它们可能贡献更多的体内节点，也参与后续单链行的连接）
        for nest_block in nested:
            self._process_nested_control_block(nest_block, g)

        # 出口行处理 (由外层 parse_flow_blocks 调用时处理，这里先假设没有出口行，暂连[BREAK])
        # 为保持独立性，我们在此统一：如果没有出口行，连[BREAK]；出口行由外部消费，外部会调用 set_exit
        # 我们先收集 exit_candidates，并提供一个方法 set_for_exit(target) 来连接出口。
        # 但为了简化，我们把出口候选存在一个临时属性或返回出去？
        # 设计：parse_for 只处理内部并返回 (loop_gw, exit_candidates, <后续>)。由于出口行在外部被消费，我们需要让外部能访问这些信息。
        # 简便做法：在 FlowBuilder 实例上临时存储，或者返回三元组。这里我们让 parse_for 返回一个特殊对象，或者我们直接在这里连接一个默认出口（[BREAK]），外部可通过在消费出口行后修改边。
        # 更优雅：parse_for 处理完内部后，不处理出口，而是将 loop_gw 和 exit_candidates 存储，然后外部调用 connect_exit 方法。但阶段四才重写 build_flow，现在我们可以先让 parse_for 始终连到 [BREAK]，阶段四再由外部覆盖。
        # 现在我们按阶段三的要求，提供可用的函数，具体行为与阶段四配合。我们先假设默认连 [BREAK]。
        break_node_id = self._reg_node(g, "[BREAK]", "break")
        for nid in exit_candidates:
            g.add_edge(nid, break_node_id)
        return break_node_id   # for 块出口视为 [BREAK]，阶段四会用出口行覆盖

    def parse_par(self, block: IndentBlock, g: FlowGraph) -> str:
        """解析 par 并行循环块，返回出口节点ID（或[BREAK]）"""
        pre_chain, _, params = self._parse_control_head(block.line.strip())
        m = re.match(r'(@?\w+)\s+in\s+(.+)', params)
        if not m:
            raise SyntaxError(f"par 语法错误: {block.line}")
        var_name = m.group(1)
        iterable = m.group(2)

        join_gw = self._reg_gateway(g, "par_join", "gateway",
                                    meta={"gw_kind": "join", "join_mode": "all"})
        fork_gw = self._reg_gateway(g, "par_fork", "gateway",
                                    meta={"gw_kind": "fork", "is_par_fork": True,
                                          "par_var": var_name, "par_iterable": iterable})

        pre_tail = self.parse_single_chain(pre_chain, None, g) if pre_chain else None
        if pre_tail:
            g.add_edge(pre_tail, fork_gw)

        nested, plain = self._separate_nested_blocks(block.daughters)
        exit_candidates = self._process_inner_single_lines(plain, fork_gw, g)
        for nest_block in nested:
            self._process_nested_control_block(nest_block, g)

        for nid in exit_candidates:
            g.add_edge(nid, join_gw)

        # 返回 join_gw 给调用方，由调用方决定出口边（[BREAK] 或显式 -> Target）
        return join_gw

    def parse_fork(self, block: IndentBlock, g: FlowGraph) -> Optional[str]:
        """解析 fork 块，无统一出口，返回 None"""
        pre_chain, _, _ = self._parse_control_head(block.line.strip())
        fork_gw = self._reg_gateway(g, "fork", "gateway", meta={"gw_kind": "fork"})

        pre_tail = self.parse_single_chain(pre_chain, None, g) if pre_chain else None
        if pre_tail:
            g.add_edge(pre_tail, fork_gw)

        # fork 内部只允许 -> 开头的行
        for daughter in block.daughters:
            line = daughter.line.strip()
            if not line.startswith('->'):
                raise SyntaxError(f"fork 体内行必须以 '->' 开头: {line}")
            core = line[2:].lstrip()
            self.parse_single_chain(core, fork_gw, g)
        return None   # 无统一出口

    def parse_join(self, block: IndentBlock, g: FlowGraph) -> str:
        """解析 join 块（保留原逻辑，不支持前导链）"""
        # 仅当 join 独立行时使用，即首行不包含前导链
        m = re.match(r'^join\s*(?:\((\w+)\))?\s*:\s*$', block.line.strip())
        if not m:
            raise SyntaxError(f"join 语法错误: {block.line.strip()}")
        mode = m.group(1) if m.group(1) else 'all'
        join_gw = self._reg_gateway(g, "join", "gateway",
                                    meta={"gw_kind": "join", "join_mode": mode})
        # 处理子块中的入边声明（[Node] -> ）
        for daughter in block.daughters:
            cl = daughter.line.strip()
            if not cl.startswith('['):
                raise SyntaxError(f"join 内部只能有 [Node] -> 入边声明: {cl}")
            # 去掉可能的末尾 '->'
            source_str = re.sub(r'\s*->\s*$', '', cl)
            source_id = self._reg_node(g, source_str)
            g.add_edge(source_id, join_gw)
        return join_gw

    def _process_nested_control_block(self, block: IndentBlock, g: FlowGraph):
        """递归处理嵌套控制块"""
        line = block.line.strip()
        # 判断类型
        if re.search(r'\bfor\b', line):
            self.parse_for(block, g)
        elif re.search(r'\bpar\b', line):
            self.parse_par(block, g)
        elif re.search(r'\bfork\b', line):
            self.parse_fork(block, g)
        elif re.search(r'\bjoin\b', line):
            self.parse_join(block, g)
        else:
            raise SyntaxError(f"未知嵌套控制块: {line}")

# ============================================================
# 5. 顶层解析入口
# ============================================================

def eval_flow(block: Block, known_actions: Dict[str, Any] = None, known_modules: Dict[str, Any] = None) -> FlowGraph:
    # 标准化器已经把声明区提取到 mainflow 之前，此处 flow 文本只包含流程描述。
    flow_lines = block.content_lines
    flow_text = '\n'.join(flow_lines)
    flow_text = normalize_symbols(flow_text)
    # -- 仅在 flow/mainflow 区等价 ->（文档约定）
    flow_text = flow_text.replace('--', '->')

    # 节点绑定已由标准化器处理，不再需要从 flow 内部解析。
    # 但标准化器生成的节点定义放在 mainflow 之前，解析器不会读到它们。
    # 我们需要一个方式将节点绑定传递给 FlowBuilder。
    # 暂时留空，因为我们的新语法中所有节点引用都必须已在流程中注册（通过 [Node] -> 形式出现）。
    # 事实上，标准化器生成的 [Node]: binding 被移到了脚本顶部，不属于 flow 文本。
    # 所以此时无需绑定表，流程图中的节点引用会自动通过 reg_node 注册。
    builder = FlowBuilder()
    # 忽略旧绑定表传递
    g = builder.build_flow(flow_text)
    # mainflow 引用校验。模块引用的校验不在此处（known_modules=None 跳过）：
    # 内联时机早于全部 module 块解析，点路径可见集与书写顺序耦合——模块引用
    # 由 parse_script 尾部的后置校验统一做（含嵌套点路径，与块顺序无关）。
    if known_actions is not None:
        validate_flow_refs(g, known_actions, known_modules, 'mainflow')
    return g

def eval_module(block: Block) -> ModuleDef:
    header = normalize_symbols(block.header)
    m = re.match(r'^module\s+(\w+)(?:\s*\(([^)]*)\))?\s*:?\s*$', header)
    if not m:
        raise ValueError(f"无法解析 module 头部: {header}")
    name = m.group(1)
    params = [p.strip() for p in m.group(2).split(',') if p.strip()] if m.group(2) else []
    mod = ModuleDef(name=name, params=params)

    for daughter in block.daughters:
        t = daughter.type
        if t == 'meta':
            mod.meta = eval_meta(daughter)
        elif t == 'vars':
            mod.locals = eval_vars(daughter)
        elif t == 'action':
            act = eval_action(daughter)
            mod.actions[act.name] = act
        elif t == 'module':
            sub = eval_module(daughter)
            mod.modules[sub.name] = sub
        elif t == 'memory':
            mem = eval_method(daughter)
            mod.memories[mem.name] = mem
        elif t == 'context':
            ctx = eval_method(daughter)
            mod.contexts[ctx.name] = ctx
        elif t == 'flow':
            mod.flow = eval_flow(daughter)
    return mod

def _node_is_ai_action(node: FlowNode, actions: Dict[str, ActionDef]) -> bool:
    """
    判断 FlowNode 绑定的 Action 是否为 AI 类型。
    仅当节点有 action_name 且 ActionDef.executor_type == AI 时返回 True。
    gateway、start、end、module_call 等节点返回 False。
    """
    if not node or not node.action_name:
        return False
    action = actions.get(node.action_name)
    is_ai = action.executor_type == ExecutorType.AI
    print(f"[parser] 🔍 节点 {node.id}: action_name={node.action_name}, executor_type={action.executor_type}, is_ai={is_ai}")
    return is_ai


def inject_delay_nodes(flow: FlowGraph, actions: Dict[str, ActionDef], delay_seconds: int) -> None:
    """
    遍历 flow 所有边，若 source 和 target 节点都绑定 AI Action，
    在中间插入一个 delay 节点。

    原始边: A --(cond)--> B
    变成:   A --(cond)--> [delay_X] --()--> B

    delay 节点 type='delay'，meta 内存 is_delay_node=True 和 delay_seconds。
    原边 condition 跟第一段走（A→delay），第二段（delay→B）无条件。
    """
    print(f"[parser] ⏱️ inject_delay_nodes: 开始, delay={delay_seconds}s, 边数={len(flow.edges)}, 节点数={len(flow.nodes)}")

    new_edges = []
    delay_counter = 0

    for edge in flow.edges:
        source_node = flow.nodes.get(edge.source)
        target_node = flow.nodes.get(edge.target)

        source_is_ai = _node_is_ai_action(source_node, actions) if source_node else False
        target_is_ai = _node_is_ai_action(target_node, actions) if target_node else False

        if source_is_ai and target_is_ai:
            delay_counter += 1
            delay_id = f"[__delay_{edge.source}_{edge.target}_{delay_counter}__]"

            delay_node = FlowNode(
                id=delay_id,
                type='delay',
                label=f'delay({delay_seconds}s)',
                meta={'is_delay_node': True, 'delay_seconds': delay_seconds},
            )
            flow.add_node(delay_node)

            # 第一段: source -> delay, 保留原 condition
            new_edges.append(FlowEdge(
                source=edge.source,
                target=delay_id,
                condition=edge.condition,
            ))
            # 第二段: delay -> target, 无条件
            new_edges.append(FlowEdge(
                source=delay_id,
                target=edge.target,
                condition="",
            ))
            print(f"[parser] ⏱️ 注入 delay: {edge.source} --({edge.condition or '无条件'})--> {delay_id} --()--> {edge.target}")
        else:
            new_edges.append(edge)

    flow.edges = new_edges
    print(f"[parser] ⏱️ inject_delay_nodes: 完成, 注入 {delay_counter} 个 delay 节点, 新边数={len(flow.edges)}")


def validate_actor_souls(text: str, soul_exists: Optional[Callable[[str], bool]] = None) -> None:
    """编译期校验 actors 区块的 soul 是否存在（normalize 前扫原始文本，行号对应用户所见）。

    报错 = 全部错误一次列出：每条含行号 + 该行原文 + soul id；末尾附可用列表
    （soul_exists 携带 _soul_ids 属性时）。soul_exists 为 None 时跳过（保持纯解析可测）。
    裸 actor（无 soul 字段）合法——soul 非必须（用户决策：无角色设定的简单剧本可不写）。
    """
    if soul_exists is None:
        return
    lines = text.split('\n')
    in_actors = False
    errors = []
    for idx, raw in enumerate(lines):
        s = raw.strip()
        if not s or s.startswith('#') or s.startswith('//'):
            continue
        if not in_actors:
            if s.startswith('actors:') or s.startswith('actors：'):
                in_actors = True
            continue
        # actors 区块结束：回到顶层区块（无缩进非空行）
        if raw[0] != ' ' and raw[0] != '\t':
            break
        m = re.match(r'^(ai|human)\s+(@?[\w\u4e00-\u9fff]+)', s)
        if not m:
            continue
        sm = re.search(r'soul\s*[：:]\s*([^\s,，]+)', s)
        if not sm:
            continue  # 无 soul = 合法
        sid = sm.group(1).strip('"').strip("'")
        if sid and not soul_exists(sid):
            errors.append((idx + 1, s, sid))
    if errors:
        detail = '\n'.join(
            f"actors 第 {ln} 行: {line} → soul \"{sid}\" 不存在"
            for ln, line, sid in errors
        )
        avail = getattr(soul_exists, '_soul_ids', None)
        msg = f"编译错误：soul id 不存在。\n{detail}"
        if avail:
            msg += f"\n可用列表：{' / '.join(sorted(avail))}"
        raise ValueError(msg)


def validate_actor_sources(script, models: Optional[Dict[str, Any]] = None) -> None:
    """编译期校验 AI actor 的 source 字段是否为宿主可用模型（models 缺省/为空不校验；
    models 由宿主在 job_start/check 经协议参数注入——A2.1 宿主清单/模型注入通道）。

    source 语法（与宿主约定，见语法文档）：
    - 裸 id（不含 '/'）→ 必须在 models['defaultProvider'] 的模型列表中；
    - 'provider/model' → 在全部 provider 的模型列表中查。
    human（source 为数字 user 身份）与 blueprint 跳过。
    校验失败 raise ValueError（编译错误，信息含可用模型列表）。
    """
    if not models:
        return
    default_provider = models.get('defaultProvider')
    provider_index = {}
    for p in models.get('providers', []):
        pid = p.get('id')
        if pid:
            # 模型条目容忍两种形态：纯 id 字符串，或宿主的富对象 {id, name}
            # （富对象形状是通道接通首日（2026-09-07）实测暴露的 unhashable bug）
            ids = set()
            for m in (p.get('models') or []):
                mid = m.get('id') if isinstance(m, dict) else m
                if mid:
                    ids.add(str(mid))
            provider_index[pid] = ids
    if not provider_index:
        return
    for name, adef in (script.actors or {}).items():
        if adef.type != ActorType.AI:
            continue
        s = str(getattr(adef, 'source', None) or '').strip()
        if not s:
            continue
        if s == 'main':
            # 保留字：主会话本尊出演（source:main）——不是模型名，豁免模型白名单
            continue
        if '/' in s:
            pid, mid = s.split('/', 1)
            ok = mid in provider_index.get(pid, set())
        else:
            ok = default_provider is not None and s in provider_index.get(default_provider, set())
        if not ok:
            available = ', '.join(
                f"{pid}/{mid}"
                for pid, mset in provider_index.items()
                for mid in sorted(mset)
            ) or '(无可用模型)'
            raise ValueError(
                f"actors: ai @{str(name).lstrip('@')}: source \"{s}\" 不是可用模型。"
                f"可用列表：{available}（或省略 source 跟随主模型）"
            )


def add_warning(script: 'Script', message: str, where: str = '') -> None:
    """编译期 warning 收集点（2026-09-07 warning 桶）：不阻断编译，作者知情。

    与 raise 的分工——raise = 编译拒绝（作者必须改）；warning = 编译放行
    （作者自行判断）。消息随 script.warnings 上浮 check/job_start 回执。"""
    script.warnings.append({'where': where, 'message': str(message)})


def validate_flow_reentry(script) -> None:
    """编译期检测：回到「多条无条件出边」的节点会导致分支数爆炸。

    原因：每次回到该节点往下运行都会从一变成多分支（普通节点多出边 =
    自动 fork），分支数指数增长。条件出边（if 分流）回流是安全的
    （只走评估为真的分支），不检测。排除项：for/par/fork/join 网关
    （多出边是迭代/并发语义，非爆炸模式）；重复边去重（par 出口链可能
    重复生成同一条边）。用户拍板文案。
    """
    def check(flow: Optional[FlowGraph], where: str) -> None:
        if not flow:
            return
        # 去重（par 出口链可能重复生成相同边）
        seen = set()
        uniq_edges = []
        for e in flow.edges:
            key = (e.source, e.target, e.condition)
            if key not in seen:
                seen.add(key)
                uniq_edges.append(e)
        for nid, node in flow.nodes.items():
            # 网关节点跳过（for/par/fork/join 的迭代/并发语义）
            if node.type == 'gateway' or (node.meta or {}).get('gw_kind') in ('for', 'par', 'fork', 'join'):
                continue
            unconditional_outs = [
                e for e in uniq_edges if e.source == nid and not e.condition
            ]
            # 「回到」= 入边来自流程内部；入口启动边（[START]/[IN] 出发）不算
            has_in = any(
                e.target == nid and e.source not in ('[START]', '[IN]')
                for e in uniq_edges
            )
            if len(unconditional_outs) >= 2 and has_in:
                # 【2026-09-07 warning 桶落地】原 raise 阻断已退役（2026-09-07
                # 用户拍板：编译期不再阻断回流场景，坚持运行则应能跑），现按
                # WARNING 语义收集——编译放行，提示随 script.warnings 上浮
                # check/job_start 回执（原报错文案保留为提示正文）。
                add_warning(
                    script,
                    f"节点 [{nid}] 有多个出边，不能回到这种节点。"
                    "原因是，每次回到这里往下运行都会从一变成多分支，分支数会爆炸。"
                    "建议在本节点之后的分支中加空节点，让他们回到空节点。",
                    where=where,
                )

    check(script.flow, "mainflow")
    for mname, mod in (script.modules or {}).items():
        check(mod.flow, f"module {mname}")


# ── 变量声明校验（2026-08-26 新增）──────────────────────────
# 与前端 femoParser.jsx validateDeclarations 规则一致：
#   1. for 循环变量必须在 vars:（或模块 vars:）中声明
#   2. for 迭代器若为裸标识符（非列表/引号字符串）必须已声明
#   3. if 条件表达式里的裸标识符（非引号字符串/数字/保留字）
#      必须是已声明变量/actor/循环变量
# 纯增量校验，只读 script 对象不修改，不影响现有校验流程。

_VAR_DECL_RESERVED = frozenset([
    'and', 'or', 'not', 'in', 'is',
    'True', 'False', 'None', 'true', 'false', 'TRUE', 'FALSE',
])


def _extract_cond_identifiers(cond: str) -> list:
    """剥离字符串字面量后提取裸标识符（与前端 _extractCondIdentifiers 一致）。"""
    no_str = re.sub(r'"[^"]*"|\'[^\']*\'', '""', cond)
    return re.findall(r'@?[\w]+(?:\.[\w]+)*', no_str)


def _main_ident(ident: str) -> str:
    dot = ident.find('.')
    return ident[:dot] if dot >= 0 else ident


def validate_variable_declarations(script: 'Script') -> None:
    """编译期变量声明校验（步骤 B，2026-09-04 查表版）。

    可见域权威 = script.scope_table（词法定义链，拍板 6）：名字在某 def_chain
    下查得到声明即合法。校验规则与报错文案与旧 set 并集版逐条一致：
      1) for 循环变量与迭代器必须在声明表可见
      2) if 条件表达式里的裸标识符（非字面量/保留字）必须可见
    loop_vars（循环变量，运行期绑定）在声明表之外单独放行。
    模块 flow 的 def_chain = 书写嵌套定义链（'Outer.Inner' → ('Outer','Inner')，
    与运行期调用栈无关）；mainflow = ()（剧本级，只见 global）。
    """
    table = script.scope_table
    if table is None:
        raise SyntaxError('script.scope_table 未装配（parse_script 变量声明装配缺失）')
    actors = set((script.actors or {}).keys())

    def validate_flow(flow: Optional[FlowGraph], def_chain: Tuple[str, ...],
                      ctx_name: str) -> None:
        if flow is None:
            return
        loop_vars = set()

        # 1) for 循环变量与迭代器声明检查
        for node in flow.nodes.values():
            meta = node.meta or {}
            if meta.get('gw_kind') != 'for':
                continue
            var_name = meta.get('var_name', '')
            iterable = meta.get('iterable', '')
            if not var_name:
                continue
            if table.lookup(var_name, def_chain) is None:
                raise SyntaxError(
                    f'for 循环变量 "{var_name}" 未在 vars: 中声明'
                    f'（{ctx_name}，for 条件: "for {var_name} in {iterable}"）。'
                    f'所有循环变量必须在 vars: 中预先声明，例如: {var_name} = ""'
                )
            loop_vars.add(var_name)
            iterable_s = iterable.strip()
            if re.match(r'^@?[\w]+$', iterable_s) and table.lookup(iterable_s, def_chain) is None:
                raise SyntaxError(
                    f'for 迭代器 "{iterable_s}" 未在 vars: 中声明'
                    f'（{ctx_name}，for 条件: "for {var_name} in {iterable}"）'
                )

        # 2) 条件表达式裸标识符检查
        def visible(name: str) -> bool:
            return (table.lookup(name, def_chain) is not None
                    or name in actors or name in loop_vars)

        for edge in flow.edges:
            if not edge.condition:
                continue
            for ident in _extract_cond_identifiers(edge.condition):
                if ident in _VAR_DECL_RESERVED:
                    continue
                main = _main_ident(ident)
                if re.match(r'^\d+(\.\d+)?$', main):
                    continue
                if main.startswith('@'):
                    if not visible(main):
                        raise SyntaxError(
                            f'条件 "{edge.condition}" 引用了未声明的 actor/变量 "{main}"'
                            f'（{ctx_name}，边 {edge.source} -> {edge.target}）'
                        )
                elif not visible(main):
                    raise SyntaxError(
                        f'条件 "{edge.condition}" 引用了未声明的变量 "{main}"'
                        f'（{ctx_name}，边 {edge.source} -> {edge.target}）。'
                        f'字符串字面量请加引号，如 == "ai"；所有变量须在 vars: 中声明'
                    )

    validate_flow(script.flow, (), 'mainflow')

    # 模块 flow 可见域（词法定义链，拍板 6）：def_chain = 书写嵌套
    # （子模块可见母模块 local，Python 式，不反向）——旧版 ancestor_locals
    # 沿 mod.modules 书写嵌套累积，即同一词法链，语义逐条一致。
    def walk(mod: ModuleDef, parent_chain: Tuple[str, ...], path: str) -> None:
        chain = parent_chain + (mod.name,)
        validate_flow(mod.flow, chain, f'module {path}')
        for sub_name, sub in (mod.modules or {}).items():
            walk(sub, chain, f'{path}.{sub_name}')

    for mname, mod in (script.modules or {}).items():
        walk(mod, (), mname)


# ── join 在环上的编译期警告（2026-09-07）────────────────────────
# join(all)/join(N) 的语义是"等全部（N 个）上游到齐再放行"。若 join 节点
# 位于流程环路上（能从自己出发绕回自己），环上的 fork 会先于 join 发生、
# 又只有 join 放行后才会再发生——等待集永远凑不齐，剧本必然无声卡死
# （实锤：警长版被"图到文本"自动加 join(all) 后，DayPhase 永远进不去）。
# 循环里的合流请直接用普通多线汇入（[A] -> [next] 逐条），"到即走"。
# 不作 error：join 的代次机制在部分环形态下仍可收敛，作者知情后自行判断。

def validate_join_on_cycle(script) -> None:
    def check(flow, where: str) -> None:
        if flow is None:
            return
        nodes = flow.nodes or {}
        joins = [nid for nid, n in nodes.items()
                 if (n.meta or {}).get('gw_kind') == 'join']
        for join_id in joins:
            # 正向 BFS：从 join 的后继出发，看能否绕回 join 自己
            frontier = [e.target for e in flow.edges if e.source == join_id]
            visited = set(frontier)
            on_cycle = False
            while frontier and not on_cycle:
                nid = frontier.pop()
                if nid == join_id:
                    on_cycle = True
                    break
                for e in flow.edges:
                    if e.source == nid and e.target not in visited:
                        visited.add(e.target)
                        frontier.append(e.target)
            if on_cycle:
                add_warning(
                    script,
                    f"join 节点 [{join_id}] 位于流程环路上（从它出发能绕回它自己）。"
                    "join 会等待上游到齐，而环路里的一部分上游只有 join 放行之后才会发生，"
                    "这会让剧本永远等待下去。请把循环里的合流改成普通多线汇入"
                    "（逐条 [A] -> [next]，到即走），不要用 join(...):。",
                    where=where,
                )

    check(script.flow, 'mainflow')
    for mname, mod in (script.modules or {}).items():
        check(mod.flow, f'module {mname}')


# ── 动作/作用域编译期硬校验（2026-09-07 猫猫拍板五类）──────────────
# 五类语法错误此前被静默吞掉（裸 in: 变 InMapping(x,x)、@func: 空参数、
# scope: self, @xxx 混写、scope 引用不存在的 actor、变量名撞 Python 保留字），
# 编译放行 → 运行期才炸甚至无声悬挂。现全部编译期拒绝（FATAL 桶：错误链路
# 里"编译/语法错"语义，job_start/check 同步拒绝，作者必须改）。
# 前端 femoParser.jsx 的 validateActionSyntax 与本函数规则逐条对齐（两份
# 语法检查相互独立：引擎不带前端可跑，前端不带引擎可出图）。

_PY_KEYWORDS = frozenset(keyword.kwlist)

def _strip_spec_name(name: str) -> str:
    """声明名 → 保留字比对用标识符：剥 $/@ 前缀（'$alive'→'alive'，'@狼人'→'狼人'）。"""
    return (name or '').lstrip('$@').strip()


def _out_target_root(raw: str) -> str:
    """out: 项原文 → 赋值目标根名。
    'day += 1'→'day'；'vote_results.@voter(string, "")'→'vote_results'；
    '@KILL(string, "击杀目标")'→'KILL'（剥 @ 后）。"""
    t = (raw or '').strip().rstrip(',').strip()
    t = re.sub(r'\([^)]*\)\s*$', '', t).strip()          # 剥尾部类型标签 (bool, "xx")
    t = re.split(r'\+=|-=|=(?!=)', t, maxsplit=1)[0].strip()      # 剥赋值运算符及右侧
    return _strip_spec_name(t)


def _find_source_line(text: str, predicate) -> Tuple[int, str]:
    """在用户原文里定位满足 predicate 的第一行 → (行号, 原文行)；找不到 → (0, '')。
    行号对应用户所见原文（与 validate_actor_souls 同一约定）。"""
    for idx, raw in enumerate(text.split('\n')):
        s = raw.strip()
        if not s or s.startswith('#') or s.startswith('//'):
            continue
        if predicate(s):
            return idx + 1, s
    return 0, ''


def _scope_line_lookup(text: str, raw_scope: str) -> Tuple[int, str]:
    """按 scope 原文定位行（normalize 差异容错：前缀 scope/：，空白）。"""
    target = raw_scope.strip()
    def pred(s: str) -> bool:
        m = re.match(r'^scope\s*[：:]\s*(.+)$', normalize_symbols(s).strip())
        return bool(m and m.group(1).strip() == target)
    return _find_source_line(text, pred)


def _action_line_lookup(text: str, action_name: str) -> Tuple[int, str]:
    def pred(s: str) -> bool:
        return bool(re.match(rf'^action\s+{re.escape(action_name)}\s+@', normalize_symbols(s).strip()))
    return _find_source_line(text, pred)


def _vars_line_lookup(text: str, raw_name: str) -> Tuple[int, str]:
    def pred(s: str) -> bool:
        return bool(re.match(rf'^{re.escape(raw_name)}\s*=', s))
    return _find_source_line(text, pred)


def _iter_module_actions(script: 'Script'):
    """遍历全部 action → (ActionDef, ctx 位置名, 词法定义链)。"""
    for ad in (script.actions or {}).values():
        yield ad, '顶层', ()
    def walk(mod: 'ModuleDef', parent_chain: Tuple[str, ...], path: str):
        chain = parent_chain + (mod.name,)
        for ad in (mod.actions or {}).values():
            yield ad, f'module {path}', chain
        for sub_name, sub in (mod.modules or {}).items():
            yield from walk(sub, chain, f'{path}.{sub_name}')
    for mname, mod in (script.modules or {}).items():
        yield from walk(mod, (), mname)


def _check_scope_expr(raw_scope: str, actors: Set[str], lookup_var, ctx: str,
                      loc: str, errors: List[str]) -> None:
    """scope 表达式校验（与 FEMO_scope_resolver 运行期语义对齐）：
    合法 = 空(=all) / 纯 all / 纯 self / [列表] / 裸变量 / '[列表] + 变量' 组合。"""
    s = (raw_scope or '').strip()
    if not s or s.lower() in ('all', 'self'):
        return
    # ② self 与其他目标混用（self 只能单独用）
    if re.search(r'\bself\b', s, re.IGNORECASE):
        errors.append(
            f'{ctx}{loc}: scope: {s} → "self" 只能单独使用（scope: self = 仅发言者可见）；'
            f'多目标请写成方括号列表，如 scope: [@上帝, @player]'
        )
        return
    for part in re.split(r'\+', s):
        part = part.strip()
        if not part:
            continue
        if part.startswith('['):
            if not part.endswith(']'):
                errors.append(f'{ctx}{loc}: scope: {s} → 方括号不闭合，请检查列表格式')
                continue
            for item in re.split(r'[,，]', part[1:-1]):
                item = item.strip()
                if not item:
                    continue
                if item.startswith('{') and item.endswith('}'):
                    continue   # 花括号动态项（如 {playersInPark}）无法静态解析，交运行期
                # ③ 引用不存在的角色/变量（@名 必须是已声明角色或已声明 @actor 变量）
                if item.startswith('@'):
                    if item not in actors and not lookup_var(item):
                        errors.append(
                            f'{ctx}{loc}: scope: {s} → "{item}" 不是已声明的角色，'
                            f'也不是已声明的变量。可用角色：{" / ".join(sorted(actors)) or "(无)"}'
                        )
                else:
                    if not lookup_var(item):
                        errors.append(
                            f'{ctx}{loc}: scope: {s} → "{item}" 未在 vars: 中声明'
                            f'（scope 列表里的名字必须是角色 @名 或已声明变量）'
                        )
        else:
            # ② 裸部分含逗号 = 多目标没加方括号
            if re.search(r'[,，]', part):
                suggestion = '[' + ', '.join(x.strip() for x in re.split(r'[,，]', part)) + ']' 
                errors.append(
                    f'{ctx}{loc}: scope: {s} → 多个目标必须用方括号列表包裹，'
                    f'请写成 scope: {suggestion}'
                )
            elif not lookup_var(part):
                errors.append(
                    f'{ctx}{loc}: scope: {s} → "{part}" 未在 vars: 中声明'
                    f'（裸名按变量解析，必须先在 vars: 声明；角色请带 @）'
                )


def validate_action_syntax(text: str, script: 'Script') -> None:
    """编译期动作/作用域硬校验（五类，全部一次列出；任何一条 → SyntaxError）：
      ① @func 缺少"模块别名.函数名"（@func: / @func() / @func(别名)）
      ② in: 项缺 "= 变量表达式" 映射（裸项，多行/单行都查）
      ③ scope 引用不存在的角色（@名 不在 actors 也不是已声明变量）
      ④ scope 格式错误（self 与其他目标混用；多目标未加方括号）
      ⑤ 变量名与 Python 保留字冲突（vars:/out: 目标/in: 左侧/for·par 循环变量）
    另：⑥ @notice 分级校验（空 prompt / out / resolve → error；惰性字段 /
    scope:self / 误填执行者 → warning 桶，见 add_warning）；⑦ @assign 空 out
    → warning 桶（赋值节点什么都不赋值，运行时空过，多半不是本意）。
    行号对应用户原文（best-effort，解析后的归一文本与原文可能有空白差异）。"""
    errors: List[str] = []
    actors: Set[str] = set((script.actors or {}).keys())
    table = script.scope_table

    def lookup_var(name: str, chain: Tuple[str, ...] = ()) -> bool:
        if table is None:
            return False
        return table.lookup(name, chain) is not None

    # ⑤ vars: 声明（全局 + 模块，含嵌套）
    kw_hits: List[Tuple[str, str]] = []   # (raw_name, ctx)
    for raw_name in (script.vars or {}).keys():
        if _strip_spec_name(raw_name) in _PY_KEYWORDS:
            kw_hits.append((raw_name, 'vars:'))
    def walk_kw(mod: 'ModuleDef', path: str):
        for raw_name in (mod.locals or {}).keys():
            if _strip_spec_name(raw_name) in _PY_KEYWORDS:
                kw_hits.append((raw_name, f'module {path} vars:'))
        for sub_name, sub in (mod.modules or {}).items():
            walk_kw(sub, f'{path}.{sub_name}')
    for mname, mod in (script.modules or {}).items():
        walk_kw(mod, mname)
    for raw_name, ctx in kw_hits:
        line, srcline = _vars_line_lookup(text, raw_name)
        loc = f'，第 {line} 行: {srcline}' if line else ''
        errors.append(
            f'{ctx}{loc} → 变量名 "{_strip_spec_name(raw_name)}" 是 Python 保留字，'
            f'不能用作变量名，请换一个不冲突的名字'
        )

    # ①②③⑤ 逐 action 检查
    for ad, ctx, chain in _iter_module_actions(script):
        loc_src = ''
        # ① @func 必须带 模块别名.函数名
        if ad.executor_type == ExecutorType.FUNC:
            param = (ad.executor_param or '').strip()
            if not re.match(r'^[\w\u4e00-\u9fff]+\.[\w\u4e00-\u9fff]+$', param):
                line, srcline = _action_line_lookup(text, ad.name)
                loc_src = srcline
                loc = f'，第 {line} 行: {srcline}' if line else ''
                errors.append(
                    f'action "{ad.name}"（{ctx}{loc}）→ @func 缺少"模块别名.函数名"。'
                    f'必须写成 @func(模块别名.函数名)，别名在 code: 区声明。'
                    f'示例：@func(werewolf_utils.get_order)'
                )
        # ② in: 裸项
        bare = [im.local_name for im in (ad.in_mappings or []) if im.bare]
        if bare:
            if not loc_src:
                line, srcline = _action_line_lookup(text, ad.name)
                loc = f'，第 {line} 行: {srcline}' if line else ''
            else:
                loc = f'，action 头见上'
            errors.append(
                f'action "{ad.name}"（{ctx}{loc}）→ in: 项缺少 "= 变量表达式" 映射：'
                f'{", ".join(bare)}。in: 的每一项必须是 "参数名 = 变量表达式"，'
                f'例如 in: from_ = speak_from'
            )
        # ⑤ in: 左侧保留字
        for im in (ad.in_mappings or []):
            if _strip_spec_name(im.local_name) in _PY_KEYWORDS and not im.bare:
                errors.append(
                    f'action "{ad.name}"（{ctx}）→ in: 参数名 "{_strip_spec_name(im.local_name)}" '
                    f'是 Python 保留字，不能用作参数名，请改名'
                )
        # ⑤ out: 目标保留字
        for od in (ad.outs or []):
            target = _out_target_root(od.var_name)
            if target in _PY_KEYWORDS:
                errors.append(
                    f'action "{ad.name}"（{ctx}）→ out: 目标 "{target}" '
                    f'是 Python 保留字，不能用作变量名，请改名'
                )
        # ③④ scope
        if (ad.scope or '').strip():
            line, srcline = _scope_line_lookup(text, ad.scope)
            loc = f'，第 {line} 行' if line else ''
            scope_errors_before = len(errors)
            _check_scope_expr(ad.scope, actors,
                              lambda n: lookup_var(n, chain), ctx, loc, errors)
            # scope 报错附上原文行（若找到了且还没在消息里）
            if line and len(errors) > scope_errors_before and srcline and srcline not in errors[-1]:
                errors[-1] = errors[-1].replace(f'（{ctx}，第 {line} 行', f'（{ctx}，第 {line} 行: {srcline}', 1)

        # ⑥ @notice 分级校验（2026-09-07）：error = 静默错误行为；warning = 惰性死配置
        if ad.executor_type == ExecutorType.NOTICE:
            def _nloc():
                l, src = _action_line_lookup(text, ad.name)
                return f'，第 {l} 行: {src}' if l else ''
            # error：prompt 为空——没有内容的公告必然是写错
            if not (ad.prompt or '').strip():
                errors.append(
                    f'action "{ad.name}"（{ctx}{_nloc()}）→ @notice 的 prompt 为空。'
                    f'公告节点必须要有 prompt（它就是注入上下文的公告本体）'
                )
            # error：out/resolve——无回答者，作者期待的赋值/校验永远不会发生，
            # 下游静默读陈旧值
            if ad.outs:
                targets = ", ".join(od.var_name for od in ad.outs)
                errors.append(
                    f'action "{ad.name}"（{ctx}{_nloc()}）→ @notice 不支持 out:（{targets}）。'
                    f'公告节点没有回答者，out 声明的变量永远不会被赋值，'
                    f'赋值请用 @assign 或让 AI/human 输出'
                )
            if (ad.resolve or '').strip():
                errors.append(
                    f'action "{ad.name}"（{ctx}{_nloc()}）→ @notice 不支持 resolve:。'
                    f'公告节点没有回答者，校验函数永远不会被调用'
                )
            # warning：惰性死配置——写了永不生效但也不破坏流程，知情即可
            def _warn(field_label: str, advice: str):
                add_warning(script,
                            f'action "{ad.name}"（{ctx}）→ @notice 的 {field_label} '
                            f'不生效：{advice}',
                            where=f'action "{ad.name}"')
            if (ad.memory or '').strip():
                _warn('memory:', '公告节点不检索记忆、不收集 blocks')
            if (ad.context or '').strip():
                _warn('context:', '公告节点不提取上下文、不收集 blocks')
            if (ad.showprompt or '').strip():
                _warn('showprompt:', '公告的 prompt 本身就是可见行，showprompt 语义重复')
            if ad.max_retries:
                _warn('max_retries:', '公告节点无回答，没有重试回路')
            if (ad.fallback or '').strip():
                _warn('fallback:', '公告节点无回答，永远不会失败跳转')
            if str(ad.scope or '').strip().lower() == 'self':
                _warn('scope: self', '公告无发言者，self = 仅 meta.owner 可见')
            if (ad.executor_param or '').strip():
                _warn(f'执行者参数 (@notice({ad.executor_param}))',
                      '公告没有发言者，该参数被整体忽略')

        # ⑦ @assign 空 out 校验（2026-09-07 warning 桶，用户拍板）：out 为空 =
        # 赋值节点什么都不赋值，运行时空过——惰性死配置，不阻断编译但作者应知情
        # （与 ⑥ @notice 的 warning 同级：写了不生效/缺了不报错，但多半不是本意）。
        if ad.executor_type == ExecutorType.ASSIGN and not (ad.outs or []):
            def _aloc():
                l, src = _action_line_lookup(text, ad.name)
                return f'，第 {l} 行: {src}' if l else ''
            add_warning(
                script,
                f'action "{ad.name}"（{ctx}{_aloc()}）→ @assign 的 out: 为空。'
                f'赋值节点没有任何 out 声明，运行时会空过（什么都不赋值）；'
                f'若想赋值请补 out:，若不需要赋值请考虑去掉该节点或换执行者类型',
                where=f'action "{ad.name}"',
            )

    # ⑤ for/par 循环变量保留字
    def walk_flows(flow: Optional[FlowGraph], where: str):
        if flow is None:
            return
        for node in flow.nodes.values():
            meta = node.meta or {}
            if meta.get('gw_kind') in ('for', 'par'):
                var_name = meta.get('var_name') or meta.get('par_var') or ''
                if _strip_spec_name(var_name) in _PY_KEYWORDS:
                    errors.append(
                        f'{where} 循环变量 "{_strip_spec_name(var_name)}" '
                        f'是 Python 保留字，不能用作循环变量名，请改名'
                    )
    walk_flows(script.flow, 'mainflow')
    for mname, mod in (script.modules or {}).items():
        walk_flows(mod.flow, f'module {mname}')

    if errors:
        raise SyntaxError(
            '编译错误：剧本语法检查未通过（共 '
            f'{len(errors)} 处）。\n' + '\n'.join(f'  {i}. {e}' for i, e in enumerate(errors, 1))
        )


# ── 变量声明装配（步骤 B，2026-09-04）────────────────────────
# 声明/词法可见域/初值的单一权威 = femoCompiler.vars.model.build_scope_table
# （$ 剥名/规范名冲突拦截/定义链登记全部在表内）；parser 只负责把书写嵌套的
# 模块 vars 收成扁平路径字典（'Outer' / 'Outer.Inner'）喂给它。
# 两个维度正交（猫猫拍板）：owner=维度 B 词法可见性，shared=维度 A 并发复制——
# **模块 vars: 声明 $ 完全合法**，编译期对 $ 的声明位置不做任何限制。
# script.vars 原样保留（$ 键不剥，旧路径零影响）。

def _collect_module_vars(mod: ModuleDef, path: str,
                         out: Dict[str, Dict[str, Any]]) -> None:
    """沿书写嵌套收集模块 vars 块 → {模块完整路径: locals 字典}。
    空 locals 的模块也登记（ScopeTable 定义链注册需要，拍板 6 词法链）。"""
    out[path] = mod.locals or {}
    for sub_name, sub in (mod.modules or {}).items():
        _collect_module_vars(sub, f'{path}.{sub_name}', out)


# ── join/fork 编译期零配对限制（2026-09-03 猫猫二次拍板）────────
# fork 与 join 完全解耦、互不干涉：fork 只管分叉（原 task 停 → 几个新 task
# 往下跑，后面 join 不 join 与它无关）；join 只管把到达的 task 停掉汇成一个
# 新主支继续跑（分支从哪儿来、来自几个 fork、嵌不嵌套，与它无关）。
# 剧本作者写多嵌套多自由，编译器按规定的跑法执行即可——编译期不做任何
# join/fork 配对限制（此前的"配对唯一 fork/禁嵌套/禁多接收端"校验已回滚）。
# 运行期 join 协调器（步骤 3）：到达即签到，凑齐判定=沿 join 入边反向上溯
# 图拓扑收集等待集合（详见施工清单 v3 §3.3）。


def parse_script(text: str, base_dir: str = ".", models: Optional[Dict[str, Any]] = None,
                 soul_checker: Optional[Callable[[str], bool]] = None) -> Script:
    """主解析入口：文本 → Script 对象；models 非空时编译期校验 AI actor 的 source；
    soul_checker 非空时编译期校验 actors 的 soul 存在性（normalize 前执行，行号对应用户原文）。"""

    # 编译期 soul 校验：normalize 前扫原始文本（行号对应用户所见）
    validate_actor_souls(text, soul_checker)
    raw_text = text   # 动作语法校验的行号定位用原文（normalize 前）

    # ── 前置标准化：消除语法糖、续行、裸动作等 ──
    from femoCompiler.FEMO_normalizer import FEMONormalizer
    normalizer = FEMONormalizer()
    text = normalizer.normalize(text)

    blocks = build_blocks(text)
    script = Script()

    for block in blocks:
        t = block.type
        if t == 'meta':
            script.meta = eval_meta(block)
        elif t == 'vars':
            script.vars = eval_vars(block)
        elif t == 'code':
            script.code = eval_code(block)
        elif t == 'actors':
            script.actors = eval_actors(block)
        elif t == 'action':
            act = eval_action(block)
            script.actions[act.name] = act
        elif t == 'module':
            mod = eval_module(block)
            script.modules[mod.name] = mod
        elif t == 'memory':
            mem = eval_method(block)
            script.memories[mem.name] = mem
        elif t == 'context':
            ctx = eval_method(block)
            script.contexts[ctx.name] = ctx
        elif t == 'flow':
            # known_modules 传 None：mainflow 的模块引用（含嵌套点路径）
            # 由下方后置校验统一做，与 mainflow/module 块的书写顺序解耦
            script.flow = eval_flow(block, script.actions)

    # 编译期检测（2026-08-24，待议缝隙①转正）：声明了 action 却解析出空流程
    # 图——几乎必然是流程区被静默吞掉或语法没接上，绝不允许空图秒跑完假报
    # ✅（实测 notify-theater 裸名 mainflow 被 normalizer 吞成空图的实锤形态）。
    # 无 action 的纯数据/工具剧本不在此列。
    if script.actions and not script.flow.nodes:
        raise SyntaxError(
            'mainflow 是空的：剧本声明了 action，但流程图没有任何节点。'
            '请检查 mainflow 区是否漏了 [START] 标记或连线（如 [START] -> 动作 -> [END]）。'
        )

    # 模块 flow 引用校验（模块内 action/嵌套 module/全局 module）
    for mod in script.modules.values():
        validate_module_flows(mod, script)

    # mainflow 模块引用后置校验：可见集 = 顶层裸名 + 全部嵌套点路径——
    # 主流程点路径直引内层模块（&Outer.Inner，运行时 _run_module 点路径
    # 通道 2026-09-12 起支持）在此放行；裸写内层名（不带路径，如 &Inner）
    # 仍拒绝——运行时从主流程解析不到裸内层名。后置时机同时解除了模块
    # 块必须写在 mainflow 之前的隐含顺序要求。
    mainflow_modules: Dict[str, Any] = dict(script.modules)
    _collect_module_paths(script.modules, '', mainflow_modules)
    validate_flow_refs(script.flow, script.actions, mainflow_modules, 'mainflow')

    # 注：meta.database 解析块已移除——set_db_path 无调用点，该机制从未生效；
    # 运行时数据库路径统一由 FEMO_config.get_db_path() 解析
    # （get_user_dir()/user_data/memory/Chronica.wor）。

    owner_val = script.meta.get('owner')
    if not owner_val:
        # owner 留空（缺失/空列表）→ 归属宿主清单的缺省用户（A2.1：
        # 默认用户是宿主环境事实，不再是编译器写死；清单缺失回落 u001）
        script.meta['owner'] = [host_manifest.default_user_id()]
    elif isinstance(owner_val, (int, float)):
        script.meta['owner'] = [str(owner_val)]
    elif isinstance(owner_val, str):
        script.meta['owner'] = [owner_val]
    elif isinstance(owner_val, list):
        script.meta['owner'] = [str(x) for x in owner_val]

    # 编译期校验 AI actor 的 source（宿主模型白名单；models=None 跳过）
    validate_actor_sources(script, models)

    # 编译期检测：回到「多条无条件出边」的节点（分支数爆炸模式）
    validate_flow_reentry(script)

    # 变量声明装配（步骤 B，2026-09-04）：build_scope_table 是声明/可见域/
    # 初值的单一权威（$ 剥名/规范名冲突拦截/定义链登记全在表内）；
    # script.vars 原样保留（$ 键不剥，旧路径零影响）。
    # 两维度正交（猫猫拍板）：owner=词法可见性，shared=并发复制——
    # 模块 vars: 声明 $ 完全合法，编译期对 $ 不做任何位置限制。
    module_vars: Dict[str, Dict[str, Any]] = {}
    for mod in script.modules.values():
        _collect_module_vars(mod, mod.name, module_vars)
    script.scope_table = build_scope_table(script.vars or {}, module_vars)

    # 编译期变量声明校验（2026-08-26 建立；2026-09-04 步骤 B 改查
    # scope_table——for 循环变量/迭代器/条件裸标识符，规则与文案逐条不变）
    validate_variable_declarations(script)

    # 编译期动作/作用域硬校验（2026-09-07 五类：@func 缺函数名 / in: 裸项 /
    # scope 引用不存在角色 / scope 格式错（self 混用·多目标无方括号）/
    # 变量名撞 Python 保留字）——此前全部静默吞掉，现编译期一次列全并拒绝
    validate_action_syntax(raw_text, script)

    # join 在环上 → 无声卡死预警（warning 桶：编译放行，随回执上浮）
    validate_join_on_cycle(script)

    return script
