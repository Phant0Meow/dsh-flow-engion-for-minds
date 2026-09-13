"""
femoCompiler/FEMO_normalizer.py — 脚本标准化器
将随意编写的 .femo 脚本转换为结构清晰、无语法糖的标准化文本，
供后续编译器（FEMO_parser）直接解析，无需再处理裸动作、续行、控制流内嵌等复杂情况。

处理步骤：
  0. 去注释、空行，连接续行
  1. 识别 mainflow: 之后的流程区域
  2. 在流程区域内：
     a. 提取所有节点定义 [Name]: action/module，并移出流程区域
     b. 将裸动作、&module 替换为自动生成的节点引用并注册
     c. 分离链内嵌控制关键字（fork/for/par/join），插入临时网关节点
     d. 将 to 行与 join 同级化，拆分 to [X] -> [Y]
  3. 补充缺失的空节点定义（凡引用过的 [Node] 若未定义，则自动创建空定义）
  4. 收集所有节点定义，统一输出到 mainflow: 之前
  5. 重新输出整洁的流程区域
"""

import re
from typing import List, Dict


class FEMONormalizer:
    """FEMO 脚本标准化器"""

    def __init__(self):
        self._gateway_counter = 0
        # 节点定义存储：key 为不带括号的节点名（普通动作名如 EveMove 或 &module）
        self._definitions: Dict[str, str] = {}

    def _next_gateway_id(self, prefix: str = "gw") -> str:
        """生成唯一的网关 ID，形如 __fork_1__, __join_2__"""
        self._gateway_counter += 1
        return f"__{prefix}_{self._gateway_counter}__"

    def _process_flow_block(self, inner_lines: List[str], base_indent: int) -> List[str]:
        """处理一个 flow 块的内部内容，返回标准化后的行列表（保持原缩进），
        并将本块产生的定义行输出在流程区之前。
        """
        if not inner_lines:
            return []

        # 记录已有定义，以便检测本块新增的定义
        old_def_keys = set(self._definitions.keys())

        # 1. 计算内部行的最小缩进（从内容行实际缩进取最小值；
        #    初始 None 防止 base_indent+2 假设被 4 空格缩进剧本打破）
        min_indent = None
        for line in inner_lines:
            if line.strip():
                indent = len(line) - len(line.lstrip())
                if min_indent is None or indent < min_indent:
                    min_indent = indent
        if min_indent is None:
            min_indent = base_indent + 2

        # 2. 去除最小缩进
        dedented_lines = []
        for line in inner_lines:
            if line.strip():
                dedented_lines.append(line[min_indent:])
            else:
                dedented_lines.append('')

        # 3. 按 [START] 或 [IN] 分割声明区和流程区
        decl_lines = []
        flow_part = []
        flow_started = False
        for dline in dedented_lines:
            stripped = dline.strip()
            if not flow_started and re.search(r'\[(START|IN)\]', stripped):
                flow_started = True
            if not flow_started:
                decl_lines.append(dline)
            else:
                flow_part.append(dline)

        # ★ 兜底（2026-08-24）：没有 [START]/[IN] 标记、且声明区里连一条节点
        # 定义（[X]: 绑定）都没有时，整块内容其实是流程——原逻辑会把它们全部
        # 当声明区静默吞掉（实测 notify-theater 裸名 mainflow 被吃成空图，引
        # 擎空流程秒跑完还报 ✅）。
        # 只兜「全部行都是纯裸名 action/&module 引用」这一种可证明形态：按顺
        # 序合成规范单链 [START] -> a -> b -> [END]（与最小模板同形）。混入控
        # 制块/箭头等复杂形态时维持原状，由 parse_script 的空流程图保险丝响
        # 亮报错，提示作者补 [START]——宁可报错不可静默。
        if not flow_started and decl_lines:
            has_def = any(re.search(r'\[\w+\]\s*:', ln) for ln in decl_lines)
            if not has_def:
                steps = [ln.strip() for ln in decl_lines if ln.strip()]
                simple = bool(steps) and all(
                    re.fullmatch(r'[\w\u4e00-\u9fff&]+', s) is not None
                    and re.fullmatch(r'(?:for|par|fork|join|to)', s) is None
                    for s in steps
                )
                if simple:
                    flow_part = ['[START] -> ' + ' -> '.join(steps) + ' -> [END]']
                    decl_lines = []

        # 4. 从声明区提取定义
        local_defs = {}
        for line in decl_lines:
            modified = line
            while True:
                m = re.search(r'\[(\w+)\]\s*:\s*(\S.*?)(?=\s*->|\s*$)', modified)
                if not m:
                    break
                node_name = m.group(1)
                binding = m.group(2).strip()
                self._definitions[node_name] = binding
                local_defs[node_name] = binding
                start, end = m.span()
                modified = modified[:start] + f'[{node_name}]' + modified[end:]

        # 5. 流程区替换裸动作（同时可能产生内联定义）
        expanded_flow = []
        for line in flow_part:
            expanded_flow.append(self._replace_bare_actions(line))

        # 6. 补充缺失的节点定义
        self._fill_missing_node_definitions(expanded_flow)

        # 7. 收集本块新增的所有定义（包括内联产生的）
        new_def_keys = set(self._definitions.keys()) - old_def_keys
        for key in new_def_keys:
            if key not in local_defs:
                local_defs[key] = self._definitions[key]

        # 8. 构建输出行（带缩进）
        result = []
        for node, binding in local_defs.items():
            def_line = f"[{node}]: {binding}" if binding else f"[{node}]:"
            result.append(' ' * min_indent + def_line)
        for line in expanded_flow:
            result.append(' ' * min_indent + line)

        return result
        
        
    def normalize(self, text: str) -> str:
        lines = text.splitlines()
        # 找出多行文本块区间（prompt: | / showprompt: | / key = |），块内注释豁免
        prompt_ranges = self._find_multiline_ranges(lines)
        # 去注释、空行
        clean_lines = []
        for idx, raw_line in enumerate(lines):
            if any(s <= idx < e for s, e in prompt_ranges):
                clean_lines.append(raw_line)   # prompt 块内原样保留（# // 是内容）
                continue
            line = self._remove_comment(raw_line)
            if line.strip() == '':
                continue
            clean_lines.append(line)

        # ★ 移除所有 sketch: 块（无论在顶层还是模块内）
        clean_lines = self._remove_sketch_blocks(clean_lines)

        # 收集所有 flow/mainflow 块的起止索引
        blocks = []
        i = 0
        while i < len(clean_lines):
            line = clean_lines[i]
            stripped = line.lstrip()
            if re.match(r'^(mainflow|flow)\s*:', stripped):
                indent = len(line) - len(line.lstrip())
                j = i + 1
                while j < len(clean_lines):
                    next_line = clean_lines[j]
                    if next_line.strip() == '':
                        j += 1
                        continue
                    next_indent = len(next_line) - len(next_line.lstrip())
                    if next_indent <= indent:
                        break
                    j += 1
                blocks.append((i, j))
                i = j
            else:
                i += 1

        if not blocks:
            return '\n'.join(clean_lines)

        result = list(clean_lines)
        for start_idx, end_idx in reversed(blocks):
            header_line = result[start_idx]
            inner_lines = result[start_idx+1:end_idx]
            indent = len(header_line) - len(header_line.lstrip())
            processed_inner = self._process_flow_block(inner_lines, indent)
            result[start_idx+1:end_idx] = processed_inner

        return '\n'.join(result)
        
        
    def _remove_sketch_blocks(self, lines: List[str]) -> List[str]:
        """删除所有 sketch: 及其缩进块内容"""
        result = []
        i = 0
        n = len(lines)
        while i < n:
            line = lines[i]
            m = re.match(r'(\s*)sketch\s*:', line)
            if m:
                base_indent = len(m.group(1))
                i += 1  # 跳过 sketch: 行本身
                # 跳过所有缩进严格大于 base_indent 的行（块内容）
                while i < n and (len(lines[i]) - len(lines[i].lstrip())) > base_indent:
                    i += 1
                continue  # 不添加到结果中
            else:
                result.append(line)
                i += 1
        return result
        
        
    def _find_multiline_ranges(self, lines: List[str]) -> List[tuple]:
        """找出多行文本块的行区间 [start, end)：prompt: | / showprompt: | / key = |。
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

    def _remove_comment(self, line: str) -> str:
        in_str = False
        quote_char = None
        for i, ch in enumerate(line):
            if in_str:
                if ch == '\\' and i + 1 < len(line):
                    pass
                elif ch == quote_char:
                    in_str = False
            else:
                if ch in ('"', "'"):
                    in_str = True
                    quote_char = ch
                elif ch == '#' or (ch == '/' and i + 1 < len(line) and line[i + 1] == '/'):
                    return line[:i].rstrip()
        return line

    def _replace_bare_actions(self, line: str) -> str:
        """将不在 [] 中的独立动作名或 &module 替换为 [自动节点]，但保护控制关键字片段"""
        # 按 '->' 分割，保留分隔符
        parts = re.split(r'(\s*->\s*)', line)
        new_parts = []
        for part in parts:
            if re.match(r'\s*->\s*', part):
                # 箭头本身，直接保留
                new_parts.append(part)
                continue
            stripped = part.strip()
            # 1) 先检查是否为内联节点定义：[node]: binding
            def_match = re.match(r'^\[(\w+)\]:\s*(.*)$', stripped)
            if def_match:
                node_name = def_match.group(1)
                binding = def_match.group(2).strip()
                # 记录定义（若同名已存在则覆盖，通常不会）
                self._definitions[node_name] = binding
                # 替换为仅 [node]，保留原有缩进空白
                leading = part[:len(part) - len(part.lstrip())]
                new_parts.append(leading + f'[{node_name}]')
                continue

            # 1.5) to 行：提取 to [node]: ref 绑定（to [DONE]:finish -> [END]）
            if stripped.startswith('to '):
                tm = re.match(r'^to\s+\[(\w+)\]\s*:\s*(\S+)', stripped)
                if tm:
                    self._definitions[tm.group(1)] = tm.group(2)
                    leading = part[:len(part) - len(part.lstrip())]
                    new_parts.append(leading + f'to [{tm.group(1)}]')
                    continue
                new_parts.append(part)
                continue

            # 2) 检查是否为控制关键字片段（if, for, par, fork, join, to）
            if re.match(r'\b(if|for|par|fork|join|to)\b', stripped):
                new_parts.append(part)
                continue

            # 3) 普通片段：应用裸动作替换
            leading = part[:len(part) - len(part.lstrip())]
            content = part.lstrip()
            new_content = self._replace_bare_in_fragment(content)
            new_parts.append(leading + new_content)
        return ''.join(new_parts)

    def _replace_bare_in_fragment(self, fragment: str) -> str:
        """对不包含控制关键字的片段进行裸动作替换"""
        def replacer(m):
            token = m.group(1)
            # 关键字保护（作为兜底）
            keywords = {'fork', 'for', 'par', 'join', 'to', 'if', 'in', 'all', 'any', 'n'}
            if token.lower() in keywords:
                return token
            # 生成节点内部键：&module 的节点名不带 &（绑定保留 & 前缀）
            base = token.lstrip('&')
            node_key = base
            original_key = base
            counter = 1
            while node_key in self._definitions:
                node_key = f'{original_key}_{counter}'
                counter += 1
            self._definitions[node_key] = token
            return f'[{node_key}]'

        # 第一步·模块引用预处理（点路径 &Outer.Inner、带参 &Name(args)，
        # 二者可组合），必须先于裸词替换且作用于整段：裸词正则不识别 '.' 和
        # '('——点路径会被拆成 &Outer + Inner 两个独立 token（语义损坏成两个
        # 节点），参数表达式会丢参并被捏造成幽灵 action 节点（实锤
        # 2026-09-12：&Inner2(visits) 编译报"未声明的动作 'visits'"）。无参
        # 形态一并由此处理，与带参同一事实源。
        fragment = re.sub(
            r'(?<!\[)&([\w\u4e00-\u9fff]+(?:\.[\w\u4e00-\u9fff]+)*)(?:\s*\(([^)]*)\))?',
            lambda m: self._handle_module_ref(m.group(1), m.group(2)),
            fragment
        )

        # 第二步·裸词替换：先切出节点标签段 [label] 整段保护（label 可含
        # 点路径，如预处理刚生成的 [Outer.Inner2]）——裸词替换不得进入标签
        # 内部，否则其中间的点段（Inner2）会被捏造成幽灵节点。只对标签外
        # 的部分做替换；注意 & 是非单词字符，\b 在 & 前不成立，必须用
        # (&?\b\w+) 才能把 & 一并捕获。
        def _bare_pass(seg: str) -> str:
            return re.sub(r'(&?\b\w+)\b(?!\])', replacer, seg)

        parts = re.split(r'(\[[^\]]*\])', fragment)
        return ''.join(
            part if idx % 2 == 1 else _bare_pass(part)
            for idx, part in enumerate(parts)
        )

    def _handle_module_ref(self, mod_name: str, args) -> str:
        # args=None = 无参调用（token 不带括号）；带参时参数原文随绑定交给
        # 运行时求值入帧。mod_name 允许点路径（'Outer.Inner'，嵌套模块完整
        # 路径），节点键同步用它，保证不同路径的同名模块节点不互相吞并。
        token = f'&{mod_name}({args})' if args is not None else f'&{mod_name}'
        node_key = mod_name   # 节点名不带 &
        counter = 1
        while node_key in self._definitions:
            node_key = f'{mod_name}_{counter}'
            counter += 1
        self._definitions[node_key] = token
        return f'[{node_key}]'

    def _fill_missing_node_definitions(self, flow_lines: List[str]):
        """扫描所有 [...] 节点引用，若未定义则添加空定义（跳过保留字和内部网关）"""
        RESERVED = {'START', 'END', 'BREAK', 'IN', 'OUT'}
        for line in flow_lines:
            refs = re.findall(r'\[(\w+)\]', line)
            for name in refs:
                if name in RESERVED:
                    continue
                if name.startswith('__') and name.endswith('__'):
                    continue  # 内部网关节点不声明
                if name not in self._definitions:
                    self._definitions[name] = ''  # 空定义

# 测试入口
if __name__ == '__main__':
    print("请输入 FEMO 流程文本（多行），输入完成后在新行输入 'END' 并回车，或按 Ctrl+D (Unix) / Ctrl+Z (Windows) 结束。")
    lines = []
    try:
        while True:
            line = input()
            if line.strip() == 'END':
                break
            lines.append(line)
    except EOFError:
        pass

    user_text = '\n'.join(lines)
    if 'mainflow:' not in user_text:
        user_text = 'mainflow:\n' + user_text

    norm = FEMONormalizer()
    result = norm.normalize(user_text)
    print("\n--- 标准化结果 ---")
    print(result)
