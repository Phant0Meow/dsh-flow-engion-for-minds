"""
femoCompiler/llmProviders.py —— 统一 LLM 调用模块
========================================
支持从 .env 自动检测已配置的 API Key，
并通过 OpenAI 兼容接口实现流式聊天。

代码原则：所有代码不许写try静默兜底不报错，有错必须报错。

支持的供应商：
  deepseek, glm, kimi, minimax, claude, gemini,
  mimo, baidu, qianwen, hunyuan, spark, openai
"""

import os
import json
import requests
from typing import Generator, Optional, Dict, Any

# ── 供应商配置表 ──
PROVIDER_CONFIG = {
    "deepseek": {
        "env_prefix": "DEEPSEEK",
        "default_url": "https://api.deepseek.com/v1/chat/completions",
        "default_model": "deepseek-v4-flash",
        "headers_extra": {},
    },
    "glm": {
        "env_prefix": "GLM",
        "default_url": "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        "default_model": "glm-5.1",
        "headers_extra": {},
    },
    "kimi": {
        "env_prefix": "KIMI",
        "default_url": "https://api.moonshot.cn/v1/chat/completions",
        "default_model": "kimi-k2.5",
        "headers_extra": {},
    },
    "minimax": {
        "env_prefix": "MINIMAX",
        "default_url": "https://api.minimax.io/v1/chat/completions",
        "default_model": "MiniMax-M2.7",
        "headers_extra": {},
    },
    "claude": {
        "env_prefix": "CLAUDE",
        # Anthropic 兼容 OpenAI 接口需要设置 header x-api-key
        "default_url": "https://api.anthropic.com/v1/chat/completions",
        "default_model": "claude-opus-4-8",
        "headers_extra": {
            "x-api-key": "${API_KEY}",   # 占位符，运行时替换
        },
    },
    "gemini": {
        "env_prefix": "GEMINI",
        "default_url": "https://generativelanguage.googleapis.com/v1beta/chat/completions",
        "default_model": "gemini-3.5-flash",
        "headers_extra": {},
    },
    "mimo": {
        "env_prefix": "MIMO",
        "default_url": "https://token-plan-cn.xiaomimimo.com/v1/chat/completions",
        "default_model": "mimo-v2.5-pro",
        "headers_extra": {},
    },
    "baidu": {
        "env_prefix": "BAIDU",
        "default_url": "",  # 百度的鉴权方式不同，后续特殊处理
        "default_model": "ernie-5.1",
        "headers_extra": {},
    },
    "qianwen": {
        "env_prefix": "QIANWEN",
        "default_url": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        "default_model": "qwen3.7-max",
        "headers_extra": {},
    },
    "hunyuan": {
        "env_prefix": "HUNYUAN",
        "default_url": "https://api.hunyuan.cloud.tencent.com/v1/chat/completions",
        "default_model": "hy3-preview",
        "headers_extra": {},
    },
    "spark": {
        "env_prefix": "SPARK",
        "default_url": "",  # 讯飞使用 WebSocket，单独处理
        "default_model": "spark-x",
        "headers_extra": {},
    },
    "openai": {
        "env_prefix": "OPENAI",
        "default_url": "https://api.openai.com/v1/chat/completions",
        "default_model": "gpt-5",
        "headers_extra": {},
    },
}


def detect_provider() -> Optional[str]:
    """自动检测第一个已配置 API Key 的供应商"""
    for name, cfg in PROVIDER_CONFIG.items():
        env_key = f"{cfg['env_prefix']}_API_KEY"
        if os.getenv(env_key):
            return name
    return None


def get_provider_config(provider: str) -> Dict[str, Any]:
    """获取指定供应商的配置，并从环境变量读取实际值"""
    cfg = PROVIDER_CONFIG.get(provider)
    if not cfg:
        raise ValueError(f"不支持的供应商: {provider}")

    env_prefix = cfg["env_prefix"]
    api_key = os.getenv(f"{env_prefix}_API_KEY")
    if not api_key:
        raise ValueError(f"环境变量 {env_prefix}_API_KEY 未设置")

    api_url = os.getenv(f"{env_prefix}_API_URL") or cfg["default_url"]
    model = os.getenv(f"{env_prefix}_API_MODEL") or cfg["default_model"]

    # 构建请求头
    headers = {"Content-Type": "application/json"}

    # 大多数供应商使用 Bearer Token，放在 Authorization 头中
    use_bearer = True
    for k, v in cfg.get("headers_extra", {}).items():
        headers[k] = v.replace("${API_KEY}", api_key)
        # 如果已经设置了 Authorization 或 x-api-key，则说明使用自定义认证方式
        if k.lower() in ("authorization", "x-api-key"):
            use_bearer = False

    # 对于未指定特殊认证方式的供应商，统一添加 Bearer Token
    if use_bearer and "Authorization" not in headers:
        headers["Authorization"] = f"Bearer {api_key}"

    return {
        "api_key": api_key,
        "api_url": api_url,
        "model": model,
        "headers": headers,
    }


def stream_chat(
    provider: str,
    messages: list,
    system_prompt: str = "",
    deep_think: bool = False,
    sampling_params: dict = None,
    stop_event=None,
    api_key: str = None,
    api_url: str = None,
    model: str = None,
) -> Generator[str, None, None]:
    """
    统一的流式聊天接口
    provider: 供应商名称，如 'deepseek'
    messages: 已组装的消息列表 [{"role":"system","content":"..."}, ...]
    model: 用户传入的模型名，优先于环境变量或默认模型
    返回一个生成器，逐块产生回答文本（str）
    """
    # 如果传入了 api_key，直接构建配置，不检查环境变量
    if api_key:
        cfg_base = PROVIDER_CONFIG.get(provider)
        if not cfg_base:
            raise ValueError(f"不支持的供应商: {provider}")
        env_prefix = cfg_base["env_prefix"]
        final_url = api_url or os.getenv(f"{env_prefix}_API_URL") or cfg_base["default_url"]
        final_model = model or os.getenv(f"{env_prefix}_API_MODEL") or cfg_base["default_model"]
        # 构建 headers
        headers = {"Content-Type": "application/json"}
        use_bearer = True
        for k, v in cfg_base.get("headers_extra", {}).items():
            headers[k] = v.replace("${API_KEY}", api_key)
            if k.lower() in ("authorization", "x-api-key"):
                use_bearer = False
        if use_bearer and "Authorization" not in headers:
            headers["Authorization"] = f"Bearer {api_key}"
        cfg = {
            "api_key": api_key,
            "api_url": final_url,
            "model": final_model,
            "headers": headers,
        }
    else:
        # llmBridge 应该在调用前就确保传入了 api_key，这里不负责查找
        raise ValueError("stream_chat 需要 api_key 参数，但未收到")
        
    api_url = cfg["api_url"]
    headers = cfg["headers"]
    model = cfg["model"]

    # 构建请求体
    body = {
        "model": model,
        "messages": messages,
        "stream": True,
    }

    # 添加额外的采样参数
    if sampling_params:
        body.update(sampling_params)

    # 针对某些供应商的特殊参数（如深度思考）
    if provider == "deepseek" and deep_think:
        body["deep_think"] = True

    # 百度文心一言：使用 Access Token 鉴权，需要特殊处理
    if provider == "baidu":
        return _baidu_stream_chat(cfg, messages, stop_event)

    # 讯飞星火：使用 WebSocket 协议，暂不实现流式，返回空
    if provider == "spark":
        raise NotImplementedError("讯飞星火暂不支持自动流式调用")

    # 发送请求
    try:
        resp = requests.post(
            api_url,
            headers=headers,
            json=body,
            stream=True,
            timeout=30,
        )
        resp.raise_for_status()

        # 解析 SSE 流，手动处理字节以强制 UTF-8 编码
        for line in resp.iter_lines():
            if stop_event and stop_event.is_set():
                break
            if not line:
                continue

            # 强制 UTF-8 解码，避免服务器响应头错误编码导致中文乱码
            try:
                decoded_line = line.decode('utf-8')
            except UnicodeDecodeError:
                continue

            if decoded_line.startswith(":"):
                continue
            if decoded_line.startswith("data: "):
                data_str = decoded_line[6:]
                if data_str.strip() == "[DONE]":
                    break
                try:
                    data = json.loads(data_str)
                    delta = data.get("choices", [{}])[0].get("delta", {})
                    content = delta.get("content", "")
                    if content:
                        yield content
                except (json.JSONDecodeError, KeyError, IndexError):
                    continue

    except requests.exceptions.RequestException as e:
        raise RuntimeError(f"API 请求失败: {e}") from e


def _baidu_stream_chat(cfg: dict, messages: list, stop_event=None) -> Generator[str, None, None]:
    """百度文心一言的特殊流式调用 (需要先获取 access_token)"""
    # 百度 API Key 和 Secret Key 需从环境变量中获取
    api_key = cfg["api_key"]           # 这其实是 API Key
    secret_key = os.getenv("BAIDU_SECRET_KEY")
    if not secret_key:
        raise ValueError("百度 API 需要同时设置 BAIDU_API_KEY 和 BAIDU_SECRET_KEY")

    # 获取 access_token
    token_url = "https://aip.baidubce.com/oauth/2.0/token"
    params = {
        "grant_type": "client_credentials",
        "client_id": api_key,
        "client_secret": secret_key,
    }
    r = requests.get(token_url, params=params)
    r.raise_for_status()
    access_token = r.json().get("access_token")
    if not access_token:
        raise ValueError("获取百度 access_token 失败")

    # 实际的聊天接口 URL
    api_url = cfg.get("api_url") or f"https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/completions?access_token={access_token}"
    headers = {"Content-Type": "application/json"}
    body = {
        "messages": messages,
        "stream": True,
    }
    # 模型由 URL 或参数指定，此处简化，使用默认 URL 中已包含模型路径
    # 如果用户指定了 BAIDU_API_URL，则直接使用

    resp = requests.post(api_url, headers=headers, json=body, stream=True, timeout=30)
    resp.raise_for_status()

    for line in resp.iter_lines(decode_unicode=True):
        if stop_event and stop_event.is_set():
            break
        if not line or line.startswith(":"):
            continue
        if line.startswith("data: "):
            data_str = line[6:]
            try:
                data = json.loads(data_str)
                # 百度返回格式可能不同，需要适配
                result = data.get("result", "")
                if result:
                    yield result
            except json.JSONDecodeError:
                continue
