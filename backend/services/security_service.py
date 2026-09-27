"""Trust-boundary helpers: input validation and untrusted-content policy.

Everything in this module treats its input as hostile. Email bodies, attachment text and
user-supplied form fields are *data*; this is the single place that decides what shape
that data is allowed to take before it reaches the database, the LLM prompt or Gmail.

The rule the whole app leans on: **model output can describe an action, it can never
authorise one.** Nothing derived from a prompt is ever used to satisfy the approval gate
in :mod:`services.workflow_service`.
"""

from __future__ import annotations

import re
from typing import Any

# ---------------------------------------------------------------------------
# Limits
# ---------------------------------------------------------------------------

#: Gmail message/attachment ids are opaque tokens. We only need to know they cannot carry
#: separators, quotes or newlines, because they end up in upstream request URLs.
MAX_ID_LENGTH = 128
_ID_RE = re.compile(r"^[A-Za-z0-9_.\-]+$")

#: Largest attachment we will download and parse. Gmail itself allows ~25 MB; anything
#: larger is a scanning/zip-bomb risk, not a document a human is waiting on.
MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024

#: Cap on how many attachments one message may contribute to a prompt.
MAX_ATTACHMENTS_PER_MESSAGE = 10

#: Cap on PDF pages parsed per attachment (a 10,000 page PDF is a CPU denial of service).
MAX_PDF_PAGES = 40

MAX_RECIPIENTS = 20
MAX_EMAIL_ADDRESS_LENGTH = 254
MAX_SUBJECT_LENGTH = 200
MAX_BODY_BYTES = 200 * 1024
MAX_FILENAME_LENGTH = 120
MAX_QUERY_LENGTH = 200

#: Below this classification confidence a document is forced into human review and can
#: never be auto-routed or auto-sent.
LOW_CONFIDENCE_THRESHOLD = 0.60

#: Security verdicts that must never be handled automatically.
BLOCKED_FOR_AUTOMATION = frozenset({"Spam", "Prompt Injection"})

#: Verdicts that require an explicit, logged human override before sending.
REQUIRES_OVERRIDE = frozenset({"Prompt Injection"})

_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?"
                       r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?)+$")

#: Control characters that must never appear in a header value or a filename.
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

# Heuristic injection signals. These escalate to human review; they never silently block a
# legitimate human action, because a false positive must not cost a real quotation.
_INJECTION_SIGNALS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("instruction_override", re.compile(
        r"(?i)\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b"
        r"(previous|prior|above|all|any|earlier)\b[^.\n]{0,20}\b(instruction|prompt|rule|direction)s?\b")),
    ("role_reassignment", re.compile(
        r"(?i)\byou\s+are\s+now\b|\bact\s+as\s+(?:a|an|the)\s+(?:admin|root|system|developer)\b|"
        r"\bnew\s+instructions?\b|\bsystem\s*(?:prompt|message)\s*[:>]", re.IGNORECASE)),
    ("secret_exfiltration", re.compile(
        r"(?i)\b(api[ _-]?key|access[ _-]?token|password|credential|private[ _-]?key|\.env)\b"
        r"[^.\n]{0,30}\b(send|reply|email|forward|reveal|disclose|print|show|paste|export)\w*", re.IGNORECASE)),
    ("approval_bypass", re.compile(
        r"(?i)\b(auto[ _-]?approve|approve\s+(?:this|it)\s+automatically|skip\s+(?:the\s+)?approval|"
        r"no\s+(?:human\s+)?(?:approval|review)\s+needed|mark\s+as\s+approved)\b")),
    ("tool_directive", re.compile(
        r"(?i)\b(call|invoke|execute|run)\s+(?:the\s+)?(?:send_email|sendmail|gmail\.send|smtp)\b|"
        r"\bemail\s+this\s+to\b")),
    ("hidden_channel", re.compile(
        r"(?i)<\s*(system|assistant)\s*>|\[\s*(?:system|important|admin)\s*\]|"
        r"###\s*(?:system|instruction)s?\s*###", re.IGNORECASE)),
)


class ValidationError(ValueError):
    """A caller-supplied value failed validation.

    ``field`` names the offending input so the API layer can point the user at it without
    echoing the value back.
    """

    def __init__(self, message: str, *, field: str = "value", code: str = "invalid") -> None:
        super().__init__(message)
        self.message = message
        self.field = field
        self.code = code


def validate_opaque_id(value: Any, *, field: str) -> str:
    """Validate an opaque upstream id (Gmail message id, attachment id)."""
    text = str(value or "").strip()
    if not text:
        raise ValidationError(f"{field} is required.", field=field, code="missing")
    if len(text) > MAX_ID_LENGTH:
        raise ValidationError(
            f"{field} is longer than {MAX_ID_LENGTH} characters.", field=field, code="too_long"
        )
    if not _ID_RE.match(text):
        raise ValidationError(
            f"{field} contains characters that are not valid in an identifier.",
            field=field,
            code="invalid_characters",
        )
    return text


def validate_email_address(value: Any, *, field: str = "recipient") -> str:
    """Validate a single address suitable for a ``To:`` header.

    Rejects header-injection attempts (``\\r``/``\\n``), display-name syntax and
    comma-separated lists: this endpoint sends to one reviewed recipient.
    """
    text = str(value or "").strip()
    if not text:
        raise ValidationError("A recipient email address is required.", field=field, code="missing")
    if "\n" in text or "\r" in text or "<" in text or ">" in text or "," in text or ";" in text:
        raise ValidationError(
            "Enter a single email address with no display name or header characters.",
            field=field,
            code="invalid_address",
        )
    if _CONTROL_CHARS_RE.search(text):
        raise ValidationError(
            "The email address contains unsupported control characters.", field=field, code="invalid_address"
        )
    if len(text) > MAX_EMAIL_ADDRESS_LENGTH:
        raise ValidationError(
            f"The email address is longer than {MAX_EMAIL_ADDRESS_LENGTH} characters.",
            field=field,
            code="too_long",
        )
    if not _EMAIL_RE.match(text):
        raise ValidationError("Enter a valid email address.", field=field, code="invalid_address")
    return text


def validate_header_value(value: Any, *, field: str, max_length: int, required: bool = True) -> str:
    """Validate a value that becomes an email header or a log field."""
    text = str(value or "").strip()
    if not text:
        if required:
            raise ValidationError(f"{field} is required.", field=field, code="missing")
        return ""
    if "\n" in text or "\r" in text:
        raise ValidationError(
            f"{field} must not contain line breaks.", field=field, code="invalid_characters"
        )
    if _CONTROL_CHARS_RE.search(text):
        raise ValidationError(
            f"{field} contains unsupported control characters.", field=field, code="invalid_characters"
        )
    if len(text) > max_length:
        raise ValidationError(
            f"{field} is longer than {max_length} characters.", field=field, code="too_long"
        )
    return text


def validate_body(value: Any, *, field: str = "body", required: bool = True) -> str:
    """Validate an outbound body: bounded size, no NUL, CRLF allowed (it is a body)."""
    if value is None:
        text = ""
    elif isinstance(value, bytes | bytearray):
        text = bytes(value).decode("utf-8", errors="replace")
    else:
        text = str(value)

    if not text.strip() and required:
        raise ValidationError("The email body is empty.", field=field, code="missing")
    if len(text.encode("utf-8", errors="ignore")) > MAX_BODY_BYTES:
        raise ValidationError(
            f"The email body is larger than {MAX_BODY_BYTES // 1024} KB.", field=field, code="too_large"
        )
    return text


def sanitize_filename(value: Any, *, fallback: str = "attachment") -> str:
    """Make an attachment filename safe to store and to echo in a header.

    Strips directory components, control characters and NUL bytes, bounds the length and
    refuses names that reduce to nothing or to a traversal token. The result is safe to
    place in ``Content-Disposition``.
    """
    raw = str(value or "")
    # Drop any directory component, on both separators, before anything else.
    candidate = re.split(r"[\\/]", raw)[-1]
    candidate = _CONTROL_CHARS_RE.sub("", candidate).replace("\x00", "")
    candidate = candidate.replace('"', "").strip().strip(".")

    if not candidate or candidate in {".", ".."}:
        candidate = fallback
    if len(candidate) > MAX_FILENAME_LENGTH:
        stem, dot, ext = candidate.rpartition(".")
        keep = MAX_FILENAME_LENGTH - (len(ext) + 1 if dot else 0)
        candidate = (stem[:keep] + ("." + ext if dot and ext else "")) if keep > 0 else candidate[:MAX_FILENAME_LENGTH]
    return candidate or fallback


def validate_gmail_query(value: Any) -> str:
    """Validate the Gmail search string passed to the Gmail API.

    Bounded and character-restricted so it cannot be used to smuggle newlines or a very
    expensive query into the upstream API.
    """
    text = str(value or "").strip()
    if not text:
        return "in:inbox"
    if len(text) > MAX_QUERY_LENGTH:
        raise ValidationError(
            f"The Gmail query is longer than {MAX_QUERY_LENGTH} characters.", field="query", code="too_long"
        )
    if "\n" in text or "\r" in text or "\x00" in text:
        raise ValidationError(
            "The Gmail query contains unsupported control characters.", field="query", code="invalid_characters"
        )
    return text


def detect_prompt_injection(*texts: str | None) -> list[str]:
    """Return the names of prompt-injection signals found in untrusted text.

    Purely advisory: callers use the result to force human review and to log a
    ``security.escalated`` event. It never authorises or blocks an action on its own,
    because a heuristic false positive must not stop a legitimate quotation.
    """
    blob = "\n".join(str(item) for item in texts if item)
    if not blob:
        return []
    found = [name for name, pattern in _INJECTION_SIGNALS if pattern.search(blob)]
    return sorted(set(found))


def is_low_confidence(confidence: Any) -> bool:
    """True when a confidence value is missing or below the review threshold.

    A missing value is treated as low confidence: absent evidence must not become
    automatic approval.
    """
    try:
        value = float(confidence)
    except (TypeError, ValueError):
        return True
    if value != value:  # NaN
        return True
    return value < LOW_CONFIDENCE_THRESHOLD


def blocks_automation(security_status: Any) -> bool:
    """True when a message's security verdict forbids unattended handling."""
    return str(security_status or "").strip() in BLOCKED_FOR_AUTOMATION


def requires_send_override(security_status: Any) -> bool:
    """True when sending needs an explicit, logged human override."""
    return str(security_status or "").strip() in REQUIRES_OVERRIDE


def clamp_int(value: Any, *, minimum: int, maximum: int, default: int) -> int:
    """Parse a bounded integer, falling back to ``default`` instead of raising."""
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(parsed, maximum))


def truncate_for_log(value: Any, limit: int = 120) -> str:
    """A short, redacted, length-capped representation safe to put in a log field."""
    from services.logging_config import redact  # local import: avoids an import cycle

    text = re.sub(r"\s+", " ", str(value or "")).strip()
    text = redact(text)
    return text[:limit] + "..." if len(text) > limit else text
