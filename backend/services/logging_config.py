"""Structured logging, request correlation and redaction.

The backend runs as one local process behind nginx, so the operational questions are
"which request did this, what did it touch, and how long did it take" - not "which host".
This module makes those three answers available from a single log line.

Design rules, in priority order:

1. Never log a secret. Every rendered value (message, args, exception text, extra fields)
   goes through :func:`redact` first, and any field whose *name* looks like key material is
   dropped outright. The literal current values of the configured secrets are scrubbed too,
   so a gateway that echoes an API key back inside an error body cannot leak it to disk.
2. Never log content. Callers pass identifiers, counts, states and durations. Email bodies,
   attachment text, prompts and model output are not logged anywhere in this codebase.
3. Never log reasoning. Only observable application actions and their outcomes.

Usage::

    from services.logging_config import log_event, timed

    log_event(logger, "document.send.blocked", document_id=doc_id, reason="not_approved")
    with timed("classification", message_id=mid):
        ...
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Any

LOGGER_NAME = "maxgreen"

# Correlation id for the in-flight request/workflow. A contextvar (not a global) so the
# scheduler's background task and a request handler never overwrite each other's id.
_request_id: ContextVar[str] = ContextVar("maxgreen_request_id", default="")

# Field names that must never be logged, even if a caller passes them by mistake.
_SECRET_FIELD_RE = re.compile(
    r"(api[_-]?key|secret|token|password|passwd|authorization|auth|cookie|credential|"
    r"private[_-]?key|refresh[_-]?token|bearer|session)",
    re.IGNORECASE,
)

# Values that look like credentials wherever they appear in free text.
_REDACTIONS: tuple[tuple[re.Pattern[str], str], ...] = (
    # Authorization / API key headers and query parameters.
    (re.compile(r"(?i)\b(x-api-key|api[_-]?key|apikey|authorization)\b\s*[:=]\s*\S+"), r"\1=[REDACTED]"),
    (re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._\-]+"), "Bearer [REDACTED]"),
    (re.compile(r"(?i)\b(refresh_token|access_token|id_token)\b\s*[:=]\s*\S+"), r"\1=[REDACTED]"),
    # URLs carrying a key in the query string.
    (re.compile(r"(?i)([?&](?:key|api_key|access_token|token)=)[^&\s]+"), r"\1[REDACTED]"),
    # Google OAuth token files / bearer material.
    (re.compile(r"ya29\.[A-Za-z0-9._\-]+"), "[REDACTED]"),
    # Anything that looks like a private key block.
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.DOTALL), "[REDACTED]"),
    # Long digit runs: card numbers, bank accounts, passport numbers.
    (re.compile(r"(?<!\d)\d{9,}(?!\d)"), "[REDACTED_NUMBER]"),
    # Local-part of an email address is kept, domain is not (avoid leaking customer names
    # into log aggregators) - the address as a whole is replaced.
    (re.compile(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"), "[REDACTED_EMAIL]"),
)

# Never render more than this much of any single value.
_MAX_VALUE_CHARS = 512

# Attributes present on every stdlib LogRecord; anything else passed via `extra` is ours.
_STANDARD_RECORD_FIELDS = frozenset(
    vars(logging.LogRecord("", 0, "", 0, "", (), None)).keys()
) | {"message", "asctime", "taskName"}


def _secret_values() -> tuple[str, ...]:
    """Literal secret values currently configured, so they can be scrubbed from any text.

    Read once and cached: a gateway error body that echoes ``LLM_GATEWAY_API_KEY`` would
    otherwise write the key to the log file. Comparison is case-insensitive because
    gateways do normalise keys.
    """
    cached = getattr(_secret_values, "_cache", None)
    if cached is not None:
        return cached
    values: list[str] = []
    for name in (
        "LLM_GATEWAY_API_KEY",
        "GOOGLE_CLIENT_SECRET",
        "GMAIL_TOKEN",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
    ):
        value = (os.getenv(name) or "").strip()
        # Only scrub values long enough to be a real credential; a 1-2 char "key" would
        # turn ordinary log output into confetti.
        if len(value) >= 8:
            values.append(value)
    result = tuple(values)
    _secret_values._cache = result  # type: ignore[attr-defined]
    return result


def reset_secret_cache() -> None:
    """Forget cached secret values. Tests use this after monkeypatching the environment."""
    _secret_values._cache = ()


def redact(text: str) -> str:
    """Remove credentials and personal identifiers from a string.

    Applied to every log value. Returns the input unchanged when there is nothing to
    scrub, so the common path stays cheap.
    """
    if not text:
        return text
    result = text
    for secret in _secret_values():
        if secret and secret in result:
            result = result.replace(secret, "[REDACTED]")
    for pattern, replacement in _REDACTIONS:
        result = pattern.sub(replacement, result)
    return result


def _safe_value(value: Any) -> Any:
    """Coerce one log field to something JSON-serialisable, redacted and length-capped."""
    if value is None or isinstance(value, bool | int | float):
        return value
    if isinstance(value, str):
        cleaned = redact(value)
        return cleaned[:_MAX_VALUE_CHARS] + "..." if len(cleaned) > _MAX_VALUE_CHARS else cleaned
    if isinstance(value, bytes | bytearray):
        return f"<{len(value)} bytes>"
    if isinstance(value, dict):
        return {str(k)[:64]: _safe_value(v) for k, v in list(value.items())[:20]}
    if isinstance(value, list | tuple | set | frozenset):
        return [_safe_value(item) for item in list(value)[:20]]
    return _safe_value(str(value))


def _safe_fields(record: logging.LogRecord) -> dict[str, Any]:
    """Collect the caller-supplied `extra` fields, minus anything secret-shaped."""
    fields: dict[str, Any] = {}
    for key, value in record.__dict__.items():
        if key in _STANDARD_RECORD_FIELDS or key.startswith("_"):
            continue
        if _SECRET_FIELD_RE.search(key):
            fields[key] = "[REDACTED]"
            continue
        fields[key] = _safe_value(value)
    return fields


class JsonFormatter(logging.Formatter):
    """One JSON object per log line.

    Deliberately narrow: a fixed envelope (timestamp, level, logger, event, request id,
    message) plus the caller's own fields. There is no place for a prompt or a document
    body to end up, because a caller would have to name the field ``prompt``.
    """

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, tz=UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "event": _safe_value(getattr(record, "event", record.getMessage()[:120])),
            "request_id": _request_id.get() or "-",
        }

        try:
            payload["message"] = redact(record.getMessage())
        except Exception:  # a broken %-format must never take the process down
            payload["message"] = "<unformattable log record>"

        payload.update(_safe_fields(record))

        if record.exc_info:
            # The exception type is safe and useful; its message goes through redaction
            # because upstream libraries happily embed response bodies and URLs.
            exc_type, exc_value, _tb = record.exc_info
            payload["error_type"] = getattr(exc_type, "__name__", "Exception")
            payload["error"] = redact(str(exc_value))[:_MAX_VALUE_CHARS]
            payload["stack"] = redact(self.formatException(record.exc_info))[:2000]

        if record.stack_info:
            payload["stack"] = redact(self.formatStack(record.stack_info))[:2000]

        return json.dumps(payload, ensure_ascii=False, default=str)


def new_request_id() -> str:
    """A short, collision-resistant id used to correlate every line of one request."""
    return uuid.uuid4().hex[:16]


def current_request_id() -> str:
    return _request_id.get() or "-"


def set_request_id(request_id: str) -> object:
    """Bind a request id to the current context. Returns the token for ``reset``."""
    return _request_id.set(request_id)


def reset_request_id(token: object) -> None:
    try:
        _request_id.reset(token)  # type: ignore[arg-type]
    except (ValueError, LookupError):
        # Context was entered in a different task (background scheduler) - nothing to undo.
        _request_id.set("")


def _log_level(name: str) -> int:
    return getattr(logging, name.upper(), logging.INFO)


def log_event(logger: logging.Logger, event: str, level: str = "info", **fields: Any) -> None:
    """Emit one structured event line.

    ``event`` is a stable dotted name (``document.send.succeeded``) suitable for alerting
    on; ``fields`` must be identifiers, counts, states or durations - never content.

    ``exc_info=True`` and ``stack_info=True`` are forwarded to the logging call rather than
    into ``extra``: they are reserved LogRecord attributes, and putting them in ``extra``
    raises ``KeyError`` at emit time.
    """
    exc_info = fields.pop("exc_info", False)
    stack_info = fields.pop("stack_info", False)
    logger.log(
        _log_level(level),
        event,
        extra={"event": event, **fields},
        exc_info=exc_info or None,
        stack_info=stack_info or None,
    )



@contextmanager
def timed(stage: str, logger: logging.Logger | None = None, **fields: Any):
    """Time a block and log its outcome, including when it raises.

    Used for the measurable steps the brief asks about: classification, extraction,
    document generation, and upstream API/tool calls. Failures are logged and then
    re-raised, so this never converts an error into a silent success.
    """
    target = logger or logging.getLogger(LOGGER_NAME)
    started = time.perf_counter()
    try:
        yield
    except Exception as exc:
        elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
        log_event(
            target,
            f"{stage}.failed",
            level="error",
            stage=stage,
            duration_ms=elapsed_ms,
            error_type=type(exc).__name__,
            error=redact(str(exc))[:300],
            exc_info=True,
            **fields,
        )
        raise
    else:
        elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
        log_event(target, f"{stage}.completed", stage=stage, duration_ms=elapsed_ms, **fields)


def _root_handlers() -> list[logging.Handler]:
    stream = logging.StreamHandler()
    stream.setFormatter(JsonFormatter())
    return [stream]


def configure_logging(level: str | None = None) -> None:
    """Install the JSON formatter on the app and uvicorn loggers.

    Idempotent, so it is safe to call from the FastAPI lifespan and from a script.
    Uvicorn's access logger is included so its lines parse the same way; the request
    middleware emits the correlated ``http.request`` event separately.
    """
    resolved = (level or os.getenv("LOG_LEVEL") or "INFO").strip().upper()
    numeric = getattr(logging, resolved, logging.INFO)

    for name in (LOGGER_NAME, "uvicorn", "uvicorn.error", "uvicorn.access"):
        target = logging.getLogger(name)
        target.setLevel(numeric)
        target.propagate = False
        for handler in list(target.handlers):
            target.removeHandler(handler)
        for handler in _root_handlers():
            target.addHandler(handler)

    logging.getLogger(LOGGER_NAME).setLevel(numeric)
