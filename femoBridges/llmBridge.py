"""
femoBridge/llmBridge.py —— FEMO 通用 LLM 桥接器
================================================
自动加载 .env，通过 llm_providers 统一调用多家大模型。
支持浏览器传入 API Key / URL，或自动检测 .env 中已有的密钥。
代码原则：所有代码不许写try静默兜底不报错，有错必须报错。
"""

import os
import threading
import sys
from femoBridges.llmProviders import stream_chat, detect_provider, get_provider_config
from femoCompiler.FEMO_errors import FEMOConfigError, FEMOTransientError


# 供应商列表（名称与 llm_providers 保持一致）
PROVIDER_LIST = {
    "deepseek": {"env_prefix": "DEEPSEEK"},
    "glm": {"env_prefix": "GLM"},
    "kimi": {"env_prefix": "KIMI"},
    "minimax": {"env_prefix": "MINIMAX"},
    "claude": {"env_prefix": "CLAUDE"},
    "gemini": {"env_prefix": "GEMINI"},
    "mimo": {"env_prefix": "MIMO"},
    "baidu": {"env_prefix": "BAIDU"},
    "qianwen": {"env_prefix": "QIANWEN"},
    "hunyuan": {"env_prefix": "HUNYUAN"},
    "spark": {"env_prefix": "SPARK"},
    "openai": {"env_prefix": "OPENAI"},
}


# ── 0. 加载根目录的 .env ──
def _load_dotenv():
    """自动从项目根目录加载 .env（带简单降级）"""
    current_dir = os.path.dirname(os.path.abspath(__file__))
    root_dir = os.path.dirname(current_dir)
    dotenv_path = os.path.join(root_dir, ".env")

    if not os.path.exists(dotenv_path):
        print(f"[llmBridge] ⚠️ 未找到 .env 文件: {dotenv_path}")
        return

    # 简易解析器（兼容等号前后空格、引号）
    with open(dotenv_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key not in os.environ:
                os.environ[key] = value

    # 打印已加载的提供商（部分隐藏）
    loaded = [p for p, cfg in PROVIDER_LIST.items()
              if os.getenv(f"{cfg['env_prefix']}_API_KEY")]
    if loaded:
        print(f"[llmBridge] 🏠 已从 .env 加载提供商: {', '.join(loaded)}")

_load_dotenv()




def call_ai_with_blocks(
    blocks: dict,
    model: str = "default",
    stream_callback=None,
    user_api_key: str = None,
    user_api_provider: str = None,
    user_api_url: str = None,
    stop_event: threading.Event = None,
) -> str:
    """
    输入：blocks 字典
    输出：AI 完整回复文本，同时可通过 stream_callback 实现流式输出
    """

    # ── 0.5 确保当前线程有事件循环（线程池内需要）──
    import asyncio as _asyncio
    try:
        _asyncio.get_running_loop()
    except RuntimeError:
        _asyncio.set_event_loop(_asyncio.new_event_loop())

    # ── 1. 组装 prompt ──
    try:
        from prompt_assembler import assemble
        system_prompt, user_prompt = assemble(blocks)
    except ImportError:
        system_prompt = "\n\n".join(filter(None, [
            blocks.get('basic_safety', ''),
            blocks.get('basic_output', ''),
            blocks.get('soul', ''),
            blocks.get('user_info', ''),
        ]))
        context = blocks.get('context', '')
        prompt = blocks.get('prompt', '')
        memory = blocks.get('memory', '')

        parts = [context, prompt]
        if memory:
            parts.append("---\n[回忆]\n根据以上情况，你偶然回忆起了以下记忆，可能有用也可能无用：")
            parts.append(memory)
            parts.append(prompt)  # 提醒当前任务

        user_prompt = "\n\n".join(filter(None, parts))

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    # ── 2. 确定 API 密钥、模型与提供者（优先级：前端 > 环境变量 > 清晰报错）──
    # 注意：本函数仅直连模式（hostAiBackend=false）调用；宿主子代理模式
    # （默认，3081 即此）走 ai_request 事件不经此路径，无 key 属正常，不会报错。
    if user_api_provider and user_api_provider in PROVIDER_LIST:
        provider = user_api_provider
    else:
        provider = detect_provider()
        if not provider:
            raise FEMOConfigError(
                "直连模式未检测到任何 API Key：请设置 .env 中的 *_API_KEY 或传入 "
                "user_api_key。宿主子代理模式（hostAiBackend=true）无需 key，不走此路径。"
            )

    env_prefix = PROVIDER_LIST[provider]['env_prefix']

    # API Key
    if user_api_key:
        final_api_key = user_api_key
        print(f"[llmBridge] 🌐 使用浏览器传入的 API Key (provider={provider})")
    else:
        final_api_key = os.getenv(f"{env_prefix}_API_KEY")
        if final_api_key:
            print(f"[llmBridge] 🏠 使用本地 .env 中的 {env_prefix}_API_KEY")
        else:
            raise FEMOConfigError(
                f"直连模式缺少 API Key：未传入且环境变量 {env_prefix}_API_KEY 不存在。"
                "宿主子代理模式（默认）无需 key，不走此路径。"
            )

    # Model
    if model and model != "default":
        final_model = model
        print(f"[llmBridge] 🌐 使用浏览器传入的模型: {final_model}")
    else:
        final_model = os.getenv(f"{env_prefix}_API_MODEL")
        if final_model:
            print(f"[llmBridge] 🏠 使用环境变量中的模型: {final_model}")
        else:
            raise FEMOConfigError(
                f"直连模式缺少模型名：未传入且环境变量 {env_prefix}_API_MODEL 不存在。"
                "宿主子代理模式（默认）无需 key，不走此路径。"
            )

    # API URL
    if user_api_url:
        final_api_url = user_api_url
        print(f"[llmBridge] 🌐 使用浏览器传入的 API URL: {final_api_url}")
    else:
        final_api_url = os.getenv(f"{env_prefix}_API_URL")
        if final_api_url:
            print(f"[llmBridge] 🏠 使用环境变量中的 API URL: {final_api_url}")
        else:
            raise FEMOConfigError(
                f"直连模式缺少 API URL：未传入且环境变量 {env_prefix}_API_URL 不存在。"
                "宿主子代理模式（默认）无需 key，不走此路径。"
            )

    # ── 3. 调用统一流式生成器 ──
    try:
        generator = stream_chat(
            provider=provider,
            messages=messages,
            system_prompt=system_prompt,
            model=final_model,
            deep_think=(final_model != "default"),
            sampling_params={},
            stop_event=stop_event,
            api_key=final_api_key,
            api_url=final_api_url,
        )
    except Exception as e:
        print(f"[llmBridge] ❌ 启动流式请求失败: {e}")
        raise FEMOTransientError(f"LLM 流式请求启动失败（临时错误，可重试）: {e}") from e

    # ── 4. 流式接收并处理 ──
    answer = ""
    thinking = ""
    response_started = False

    try:
        for chunk in generator:
            # 检查停止信号
            if stop_event and stop_event.is_set():
                print("[llmBridge] 收到停止信号，中断流式输出")
                break

            if isinstance(chunk, dict):
                if chunk.get("type") == "response_start":
                    response_started = True
                continue

            if isinstance(chunk, str):
                if not response_started and chunk.strip():
                    response_started = True
                if response_started:
                    answer += chunk
                    if stream_callback:
                        stream_callback(chunk)
                else:
                    thinking += chunk

        # ── 5. 日志输出（可注释掉） ──
        soul_name = ""
        actor_info = blocks.get('_actor_info', {})
        if actor_info and 'soul' in actor_info:
            try:
                from femoCompiler.db_utils import get_soul_by_id
                soul = get_soul_by_id(str(actor_info['soul']))
                if soul:
                    soul_name = soul.get('soul_name', '')
            except Exception:
                pass
        if not soul_name:
            soul_block = blocks.get('soul', '')
            import re
            match = re.search(r'名字[：:]\s*(\S+)', soul_block)
            if match:
                soul_name = match.group(1)
        tag = soul_name if soul_name else "AI"

        #print(f"[{tag}]:")
        #if thinking:
        #    print("-思考-:")
        #    print(thinking)
        #    print("-回答-:")
        #print(answer)

        return answer

    except Exception as e:
        print(f"[llmBridge] ❌ 流式请求失败: {e}")
        raise FEMOTransientError(f"LLM 流式请求失败（临时错误，可重试）: {e}") from e
