"""OpenAI-compatible chat client for the local vLLM server (Nemotron on the GB10)."""
import time

import httpx

from . import config

_client = httpx.Client(timeout=300)


def chat(messages, tools=None, max_tokens=2048, thinking=False, temperature=0.2):
    body = {"model": config.LLM_MODEL, "messages": messages, "max_tokens": max_tokens,
            "temperature": temperature, "chat_template_kwargs": {"enable_thinking": thinking}}
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    t0 = time.time()
    r = _client.post(f"{config.LLM_URL}/chat/completions", json=body)
    r.raise_for_status()
    j = r.json()
    msg = j["choices"][0]["message"]
    u = j.get("usage") or {}
    return {"message": msg, "ms": int((time.time() - t0) * 1000),
            "prompt_tokens": u.get("prompt_tokens", 0), "completion_tokens": u.get("completion_tokens", 0)}


def models():
    try:
        return _client.get(f"{config.LLM_URL}/models", timeout=5).json()
    except (httpx.HTTPError, ValueError):
        return None
