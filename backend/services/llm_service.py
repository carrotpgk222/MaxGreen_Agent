from __future__ import annotations

import json
import os
import re
import time
from typing import Any

import requests


class LLMGatewayError(RuntimeError):
    pass


def _config() -> tuple[str, str, str]:
    base_url = (os.getenv("LLM_GATEWAY_URL") or "").strip().rstrip("/")
    api_key = (os.getenv("LLM_GATEWAY_API_KEY") or "").strip()
    model = (os.getenv("LLM_MODEL") or "").strip()

    missing = [
        name
        for name, value in (
            ("LLM_GATEWAY_URL", base_url),
            ("LLM_GATEWAY_API_KEY", api_key),
            ("LLM_MODEL", model),
        )
        if not value
    ]
    if missing:
        raise LLMGatewayError(f"Missing LLM configuration: {', '.join(missing)}")

    return base_url, api_key, model


def is_configured() -> bool:
    try:
        _config()
        return True
    except LLMGatewayError:
        return False


def configured_model() -> str:
    return (os.getenv("LLM_MODEL") or "").strip()


def _post_chat(
    url: str,
    api_key: str,
    model: str,
    messages: list[dict[str, str]],
    timeout_seconds: int,
) -> requests.Response:
    try:
        return requests.post(
            url,
            headers={
                "Content-Type": "application/json",
                "x-api-key": api_key,
            },
            json={
                "model": model,
                "messages": messages,
                "stream": False,
            },
            timeout=timeout_seconds,
        )
    except requests.RequestException as exc:
        raise LLMGatewayError(f"Could not reach the LLM gateway: {exc}") from exc


def _flatten_system_messages(messages: list[dict[str, str]]) -> list[dict[str, str]]:
    """Fallback for gateways that accept /api/chat but reject a system role."""
    system_parts = [str(item.get("content") or "") for item in messages if item.get("role") == "system"]
    non_system = [item for item in messages if item.get("role") != "system"]
    if not system_parts:
        return messages

    combined = "SYSTEM INSTRUCTIONS (follow these rules):\n" + "\n\n".join(system_parts)
    flattened: list[dict[str, str]] = []
    inserted = False
    for item in non_system:
        if not inserted and item.get("role") == "user":
            flattened.append(
                {
                    "role": "user",
                    "content": combined + "\n\nUSER TASK / DATA:\n" + str(item.get("content") or ""),
                }
            )
            inserted = True
        else:
            flattened.append(item)
    if not inserted:
        flattened.insert(0, {"role": "user", "content": combined})
    return flattened


def chat(messages: list[dict[str, str]], timeout_seconds: int = 90) -> dict[str, Any]:
    base_url, api_key, model = _config()
    url = f"{base_url}/api/chat"

    response = _post_chat(url, api_key, model, messages, timeout_seconds)

    if not response.ok and response.status_code not in {401, 403}:
        flattened = _flatten_system_messages(messages)
        if flattened != messages:
            time.sleep(0.25)
            response = _post_chat(url, api_key, model, flattened, timeout_seconds)

    if not response.ok:
        text = response.text[:1500]
        raise LLMGatewayError(f"LLM gateway returned HTTP {response.status_code}: {text}")

    try:
        envelope = response.json()
    except ValueError as exc:
        raise LLMGatewayError("LLM gateway returned a non-JSON response.") from exc

    content = ((envelope.get("message") or {}).get("content") or "").strip()
    if not content:
        raise LLMGatewayError("LLM gateway response did not contain message.content.")

    return {
        "model": envelope.get("model", model),
        "content": content,
        "envelope": envelope,
    }


def _strip_markdown_fence(text: str) -> str:
    # Claude may return ```json ... ``` even when asked not to.
    full = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", text, flags=re.IGNORECASE | re.DOTALL)
    if full:
        return full.group(1).strip()

    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, flags=re.IGNORECASE | re.DOTALL)
    if fenced:
        return fenced.group(1).strip()
    return text


def parse_json_content(content: str) -> dict[str, Any]:
    """Parse a JSON object from common Claude/Ollama response shapes.

    Handles markdown fences, leading prose, a JSON object embedded later in the
    response, and a JSON object accidentally returned as a quoted JSON string.
    """
    text = (content or "").replace("\ufeff", "").replace("\u200b", "").strip()
    text = _strip_markdown_fence(text)

    if not text:
        raise LLMGatewayError("Claude returned an empty response instead of JSON.")

    # First try the entire response.
    try:
        parsed: Any = json.loads(text)
        # Occasionally a gateway/model returns the object as an encoded string.
        if isinstance(parsed, str):
            parsed = json.loads(parsed.strip())
        if isinstance(parsed, dict):
            return parsed
    except (json.JSONDecodeError, TypeError):
        pass

    # Then locate the first decodable object. This is safer than taking the text
    # from the first { to the last } when the answer contains extra braces.
    decoder = json.JSONDecoder()
    for match in re.finditer(r"\{", text):
        try:
            parsed, _ = decoder.raw_decode(text[match.start():])
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed

    preview = re.sub(r"\s+", " ", text)[:300]
    raise LLMGatewayError(f"Claude response did not contain a JSON object. Response preview: {preview!r}")


def chat_json(
    prompt: str,
    *,
    retry_label: str = "this task",
    timeout_seconds: int = 90,
) -> tuple[dict[str, Any], str]:
    """Ask the gateway for JSON, retrying once if Claude returns prose.

    The hackathon gateway was verified with a simple user-only /api/chat call.
    Keeping structured extraction as a compact user message has proven more
    reliable than one very large system+user prompt through this adapter.
    """
    first = chat([{"role": "user", "content": prompt}], timeout_seconds=timeout_seconds)
    try:
        return parse_json_content(first["content"]), first["model"]
    except LLMGatewayError as first_error:
        retry_prompt = (
            "STRICT JSON RETRY. Your previous answer was not machine-readable JSON.\n"
            "Return exactly ONE valid JSON object only. No markdown fences, no explanation, "
            "no introduction, no trailing text. Use double quotes for JSON keys and strings.\n\n"
            f"Task: {retry_label}\n\n"
            + prompt
        )
        second = chat([{"role": "user", "content": retry_prompt}], timeout_seconds=timeout_seconds)
        try:
            return parse_json_content(second["content"]), second["model"]
        except LLMGatewayError as second_error:
            raise LLMGatewayError(
                f"Claude did not return valid JSON after one retry. First error: {first_error}. "
                f"Retry error: {second_error}"
            ) from second_error


def test_connection() -> dict[str, Any]:
    result = chat(
        [
            {
                "role": "user",
                "content": 'Reply with JSON only: {"status":"ok"}',
            }
        ]
    )
    parsed = parse_json_content(result["content"])
    return {
        "ok": parsed.get("status") == "ok",
        "model": result["model"],
        "response": parsed,
    }
