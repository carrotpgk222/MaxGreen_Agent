from __future__ import annotations

import json
import logging
import os
import re
import time
from typing import Any

import requests

from services.logging_config import log_event, redact, timed

logger = logging.getLogger("maxgreen.llm")

#: Total attempts (not extra retries) for a single gateway call.
MAX_ATTEMPTS = 3

#: Backoff base in seconds; attempt N waits BASE * 2**(N-1).
_RETRY_BACKOFF_BASE = 0.6
_RETRY_BACKOFF_CAP = 5.0

#: Upstream statuses worth retrying. 401/403 are deliberately excluded: they mean the API
#: key is wrong, and retrying a credential failure just burns time and money.
_RETRYABLE_STATUS = frozenset({408, 409, 425, 429, 500, 502, 503, 504})


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


def _backoff_seconds(attempt: int) -> float:
    return min(_RETRY_BACKOFF_BASE * (2 ** (attempt - 1)), _RETRY_BACKOFF_CAP)


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
    except requests.Timeout as exc:
        # A timeout is worth one more try; the message must not embed the URL or headers.
        log_event(
            logger, "llm.request.timeout", level="warning", model=model,
            timeout_seconds=timeout_seconds, outcome="retryable",
        )
        raise LLMGatewayError(f"LLM gateway timed out after {timeout_seconds}s.") from exc
    except requests.RequestException as exc:
        raise LLMGatewayError(f"Could not reach the LLM gateway: {redact(str(exc))}") from exc


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


class LLMHTTPError(LLMGatewayError):
    """A non-2xx response from the gateway, carrying the status for retry decisions."""

    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


def _is_retryable(exc: Exception) -> bool:
    if isinstance(exc, LLMHTTPError):
        return exc.status_code in _RETRYABLE_STATUS
    if isinstance(exc, LLMGatewayError | requests.RequestException):
        return True
    return False


def chat(messages: list[dict[str, str]], timeout_seconds: int = 90) -> dict[str, Any]:
    """Call the gateway, retrying transient failures with exponential backoff.

    Retries apply to timeouts, connection errors, 429 and 5xx only. A 401/403 fails
    immediately: the operator has to fix the key, and a retry cannot help.
    """
    base_url, api_key, model = _config()
    url = f"{base_url}/api/chat"

    payload = messages
    last_error: Exception | None = None

    with timed("llm.chat", model=model):
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                response = _post_chat(url, api_key, model, payload, timeout_seconds)

                if not response.ok and response.status_code not in {401, 403}:
                    flattened = _flatten_system_messages(payload)
                    if flattened != payload:
                        time.sleep(0.25)
                        response = _post_chat(url, api_key, model, flattened, timeout_seconds)

                if response.ok:
                    if attempt > 1:
                        log_event(logger, "llm.request.recovered", model=model, attempt=attempt)
                    return _parse_chat_response(response, model)

                # Redacted: a gateway error body can echo the API key we just sent.
                text = redact(response.text[:1500])
                raise LLMHTTPError(
                    f"LLM gateway returned HTTP {response.status_code}: {text}",
                    response.status_code,
                )
            except Exception as exc:
                last_error = exc
                if attempt >= MAX_ATTEMPTS or not _is_retryable(exc):
                    break
                delay = _backoff_seconds(attempt)
                log_event(
                    logger, "llm.request.retry", level="warning", model=model, attempt=attempt,
                    max_attempts=MAX_ATTEMPTS, delay_seconds=delay,
                    error_type=type(exc).__name__, error=type(exc).__name__,
                )
                time.sleep(delay)

    log_event(
        logger, "llm.request.failed", level="error", model=model,
        attempts=MAX_ATTEMPTS, error_type=type(last_error).__name__, outcome="failed",
    )
    assert last_error is not None
    raise last_error


def _parse_chat_response(response: requests.Response, model: str) -> dict[str, Any]:
    try:
        envelope = response.json()
    except ValueError as exc:
        raise LLMGatewayError("LLM gateway returned a non-JSON response.") from exc
    if not isinstance(envelope, dict):
        raise LLMGatewayError("LLM gateway returned a JSON value that was not an object.")

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

    preview = redact(re.sub(r"\s+", " ", text)[:300])
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

    Two independent retries live here: `chat` already retries transport and 5xx failures
    with backoff, and this adds one re-prompt when the model answers in prose instead of
    JSON. The second is a *format* retry, not a transport retry, and it costs one extra
    call, so it happens at most once.
    """
    first = chat([{"role": "user", "content": prompt}], timeout_seconds=timeout_seconds)
    try:
        return parse_json_content(first["content"]), first["model"]
    except LLMGatewayError as first_error:
        log_event(
            logger, "llm.json_retry", level="warning", retry_label=retry_label,
            model=first.get("model"), reason=type(first_error).__name__, outcome="retrying",
        )
        retry_prompt = (
            "STRICT JSON RETRY. Your previous answer was not machine-readable JSON.\n"
            "Return exactly ONE valid JSON object only. No markdown fences, no explanation, "
            "no introduction, no trailing text. Use double quotes for JSON keys and strings.\n"
            "Copy only values present in the EMAIL DATA. If a value is absent, use an empty "
            "string or null. Do not invent prices, references, addresses or dates.\n\n"
            f"Task: {retry_label}\n\n"
            + prompt
        )
        second = chat([{"role": "user", "content": retry_prompt}], timeout_seconds=timeout_seconds)
        try:
            return parse_json_content(second["content"]), second["model"]
        except LLMGatewayError as second_error:
            log_event(
                logger, "llm.json_failed", level="error", retry_label=retry_label,
                attempts=2, outcome="failed",
            )
            raise LLMGatewayError(
                f"Claude did not return valid JSON after one retry. First error: {redact(str(first_error))}. "
                f"Retry error: {redact(str(second_error))}"
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
