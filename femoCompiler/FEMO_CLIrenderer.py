"""
femoCompiler/FEMO_CLIrenderer.py — 终端美化输出模块
===================================
为 FEMO 运行时提供统一的命令行打印接口。
通过事件回调机制集成，与运行时核心逻辑解耦。
"""

import os
import sys
import time
from typing import Any, Dict, Optional


class CLIRenderer:
    """命令行渲染器，负责所有终端输出的格式和时机"""

    def __init__(self, verbose: bool = False):
        self.verbose = verbose
        self._streaming = False          # 是否正在流式输出 AI 回答
        self._current_node_name = ""     # 当前节点名，用于流式输出前缀
        self._context_shown = False      # 标记是否已经展示过首次上下文

    # ── 事件分发入口 ──
    def handle_event(self, event_type: str, data: Dict[str, Any]):
        """FEMORunner 通过 event_callback 调用此方法"""
        method = getattr(self, f"on_{event_type}", None)
        if method:
            try:
                method(data)
            except Exception as e:
                print(f"\n[CLI_renderer] ⚠️ 渲染事件 '{event_type}' 时出错: {e}")

    # ── 具体事件处理 ──
    def on_flow_start(self, data: dict):
        entry = data.get("entry", "?")
        max_steps = data.get("max_steps", 0)
        print()
        print("=" * 60)
        print("🚀 开始执行 Flow")
        print(f"   入口: {entry}")
        if max_steps:
            print(f"   最大步数: {max_steps}")
        print("=" * 60)
        self._context_shown = False   # 每次新流程开始时重置上下文显示标记

    def on_step(self, data: dict):
        step_no = data.get("step", 0)
        prev = data.get("prev_node", "?")
        current = data.get("current_node", "?")
        kind = data.get("kind", "?")
        print(f"\n📍 Step {step_no}: [{prev}] → [{current}] ({kind})")

    def on_node_start(self, data: dict):
        node_name = data.get("node_name", "")
        node_type = data.get("node_type", "")
        prompt = data.get("prompt", "")
        self._current_node_name = node_name

        print(f"{'─' * 40}")
        if node_type == "ai":
            print(f"🤖 AI 节点: {node_name}")
            if prompt and self.verbose:
                print(f"   Prompt: {prompt[:100]}{'...' if len(prompt)>100 else ''}")
        elif node_type == "human":
            print(f"👤 人类节点: {node_name}")
        elif node_type == "func":
            print(f"🔧 函数节点: {node_name}")
        elif node_type == "assign":
            print(f"📝 赋值节点: {node_name}")
        else:
            print(f"⚡ 节点: {node_name} ({node_type})")

    def on_context_ready(self, data: dict):
        length = data.get("length", 0)
        if self.verbose:
            print(f"   📖 上下文: {length} 条记录")

    def on_memory_ready(self, data: dict):
        length = data.get("length", 0)
        if self.verbose:
            print(f"   🧠 记忆: {length} 条记录")

    def on_ai_token(self, data: dict):
        token = data.get("token", "")
        if not self._streaming:
            print()
            if self._current_node_name:
                print(f"[{self._current_node_name}]:")
            self._streaming = True
        # 处理可能存在的转义换行，使其真正换行
        token = token.replace('\\n', '\n')
        sys.stdout.write(token)
        sys.stdout.flush()

    def on_ai_response(self, data: dict):
        """非流式时的完整回复（备用）"""
        response = data.get("output", "")
        if not self._streaming:
            print()
            if self._current_node_name:
                print(f"[{self._current_node_name}]:")
            print(response)
        else:
            # 流式已经在 on_ai_token 输出完毕，这里只收尾
            print()  # 结束换行
        self._streaming = False

    def on_human_wait(self, data: dict):
        prompt = data.get("prompt", "")
        context = data.get("context", "")

        # 只在第一次遇到人类节点时展示完整上下文
        if not self._context_shown and context:
            print()
            print("=" * 60)
            print("📖 首次进入 — 当前对话上下文：")
            print(context)
            print("=" * 60)
            self._context_shown = True

        if prompt:
            print(f"\n💬 {prompt}")

    def on_func_result(self, data: dict):
        if self.verbose:
            print(f"   ✅ 函数完成: {data.get('node_name', '')}")
            output = data.get('output', '')
            if output:
                print(f"      结果: {output}")

    def on_assign_result(self, data: dict):
        if self.verbose:
            print(f"   ✅ 赋值完成: {data.get('node_name', '')}")
            output = data.get('output', '')
            if output:
                print(f"      结果: {output}")

    def on_flow_done(self, data: dict):
        total_steps = data.get("total_steps", 0)
        duration = data.get("duration", 0)
        print()
        print("=" * 60)
        print("🏁 Flow 执行结束")
        if total_steps:
            print(f"   共执行 {total_steps} 个节点")
        if duration:
            print(f"   耗时 {duration:.1f} 秒")
        print("=" * 60)

    def on_flow_error(self, data: dict):
        error = data.get("error", "未知错误")
        print(f"\n❌ 运行错误: {error}")

    def on_error(self, data: dict):
        print(f"\n❌ 错误: {data.get('message', '')}")

    # ── 特殊交互：清屏并显示上下文（用于 /godview 和 /@actor） ──
    def clear_and_show_context(self, title: str, context: str):
        """清屏，打印标题和完整上下文，然后恢复输入区域"""
        os.system('clear' if os.name != 'nt' else 'cls')
        print(f"\n{'=' * 60}")
        print(f"👁️  {title}")
        print(f"{'=' * 60}")
        if context:
            print(context)
        else:
            print("（暂无可见对话记录）")
        print(f"{'=' * 60}")
        print("（继续输入内容，或输入 /end 结束）")
        self._context_shown = True   # 手动切换视角后视为已展示上下文，避免紧接着的人类节点再重复显示

    # ── 流式输出结束后的收尾 ──
    def finish_stream(self):
        if self._streaming:
            print()
            self._streaming = False


# ── 辅助函数：将旧的 print 迁移到事件 ──
def emit_step(runner, step_no, prev_node, current_node, kind):
    """在 _execute_flow 的循环中调用，替代原来的 print"""
    if runner._event_callback:
        runner._event_callback('step', {
            'step': step_no,
            'prev_node': prev_node,
            'current_node': current_node,
            'kind': kind,
        })


def emit_context_ready(runner, length):
    if runner._event_callback:
        runner._event_callback('context_ready', {'length': length})


def emit_memory_ready(runner, length):
    if runner._event_callback:
        runner._event_callback('memory_ready', {'length': length})
