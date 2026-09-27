"""Outbound document workflow: the backend's approval gate for customer-facing actions.

Why this module exists
----------------------
`services.gmail_service.send_email` was present but not called by anything. The OAuth
consent grants `gmail.send`, so the moment any endpoint wires it up, a quotation or
invoice can leave the building with nothing between it and a request body. This module is
that missing guardrail, and it is the *only* path to `send_email`.

The invariants it enforces, in one place so they can be tested:

1. **Nothing customer-facing or financial is sent without a recorded human approval.**
   `send_document` re-reads the stored state and refuses unless it is exactly ``Approved``.
   The approval is a row written by `approve_document`, recording who approved and when.
2. **AI output can never authorise a send.** No field derived from a model decides a
   state. `source_confidence` and `source_security_status` are recorded for the reviewer
   and can *force* review, but they can never move a document to ``Approved``.
3. **A send happens at most once.** Sending claims the row with a conditional UPDATE, so
   two concurrent requests cannot both proceed; a request that arrives after success
   returns the recorded result without touching Gmail.
4. **Every state change is audited.** Each transition writes a `workflow_events` row with
   the request id, so a document can be traced from creation to send.
5. **Validation happens at the boundary, again at send.** Field completeness is checked on
   submit *and* re-checked immediately before the send, because the document may have been
   edited in between.
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
import uuid
from datetime import UTC, datetime
from functools import partial
from typing import Any

from services.database_service import DatabaseError, get_connection, init_db
from services.logging_config import current_request_id, log_event, timed
from services.security_service import (
    ValidationError,
    decode_attachment_payload,
    is_low_confidence,
    requires_send_override,
    sanitize_filename,
    validate_body,
    validate_email_address,
    validate_header_value,
    validate_outbound_mime,
)

logger = logging.getLogger("maxgreen.workflow")

# ---------------------------------------------------------------------------
# States
# ---------------------------------------------------------------------------

STATE_DRAFT = "Draft"
STATE_PENDING = "Pending Approval"
STATE_APPROVED = "Approved"
STATE_REJECTED = "Rejected"
STATE_SENDING = "Sending"
STATE_SENT = "Sent"
STATE_SEND_FAILED = "Send Failed"

ALL_STATES = frozenset(
    {STATE_DRAFT, STATE_PENDING, STATE_APPROVED, STATE_REJECTED, STATE_SENDING, STATE_SENT, STATE_SEND_FAILED}
)

#: States from which a send may be attempted. ``Send Failed`` is retryable without a new
#: approval, because the approval already covers this exact content.
SENDABLE_STATES = frozenset({STATE_APPROVED, STATE_SEND_FAILED})

#: States that are terminal: the document can no longer change without a new draft.
TERMINAL_STATES = frozenset({STATE_SENT, STATE_REJECTED})

DOCUMENT_TYPES = ("Quotation", "Delivery Order", "Invoice", "Statement of Account")

#: Document-number prefix per type. Mirrors the frontend's DOCUMENT_PREFIXES so a number
#: allocated here is shaped like one the UI already recognises.
DOCUMENT_PREFIXES = {
    "Quotation": "MGQ",
    "Delivery Order": "DO",
    "Invoice": "INV",
    "Statement of Account": "SOA",
}

#: Fields that must be present before a document may be submitted for approval, per type.
#: Deliberately minimal: these are the fields that make a document unusable if wrong or
#: absent, not a wish list. Anything softer is surfaced to the reviewer, not enforced.
REQUIRED_FIELDS: dict[str, tuple[tuple[str, ...], ...]] = {
    "Quotation": (("company",), ("items",)),
    "Delivery Order": (("document_number",), ("items",)),
    "Invoice": (("document_number",), ("items",)),
    "Statement of Account": (("document_number",),),
}

MAX_ACTOR_LENGTH = 80
MAX_NUMBER_LENGTH = 40

#: Attachments per outbound document. Matches the inbound limit so a generated document
#: cannot be used to build a larger outbound message than we are willing to receive.
MAX_ATTACHMENTS_PER_DOCUMENT = 10

#: How many times a create will re-read and re-allocate a document number after losing a
#: race on the unique index. Two is enough in practice; five is a generous ceiling.
_NUMBER_ALLOCATION_ATTEMPTS = 5



class WorkflowError(RuntimeError):
    """A workflow transition is not allowed.

    ``status_code`` lets the API layer map domain failures onto HTTP without inspecting
    exception text, and ``code`` is a stable machine-readable reason for the client.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: int = 409,
        code: str = "invalid_state",
        details: list[str] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code
        self.details = details or []


class SendFailed(RuntimeError):
    """Gmail rejected or could not complete the send.

    ``retryable`` distinguishes a transient failure (safe to try again) from a permanent
    one, so the caller and the operator are told whether a retry is sensible.
    """

    def __init__(self, message: str, *, retryable: bool, code: str = "send_failed") -> None:
        super().__init__(message)
        self.message = message
        self.retryable = retryable
        self.code = code


# ---------------------------------------------------------------------------
# Serialisation
# ---------------------------------------------------------------------------


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _row_to_document(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    item = dict(row)
    try:
        payload = json.loads(item.get("payload_json") or "{}")
    except (TypeError, ValueError):
        payload = {}
    item["payload"] = payload if isinstance(payload, dict) else {}
    item["needs_human_review"] = bool(item.get("needs_human_review"))
    item["send_attempts"] = int(item.get("send_attempts") or 0)
    item["attachments"] = _outbound_attachments(item["payload"])
    return item


def _prepare_stored_attachments(
    attachments: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    """Decode inline attachment bodies and write them to ``document_attachments``.

    Validation happens before the insert so a bad payload never creates a document row
    that cannot be sent. The returned descriptors are what the payload should reference;
    the bytes themselves live only in the database and are re-read at send time.
    """
    if not attachments:
        return []
    if not isinstance(attachments, list):
        raise ValidationError("Attachments must be a list.", field="attachments", code="invalid_type")
    if len(attachments) > MAX_ATTACHMENTS_PER_DOCUMENT:
        raise ValidationError(
            f"A document can carry at most {MAX_ATTACHMENTS_PER_DOCUMENT} attachments.",
            field="attachments",
            code="too_many",
        )

    prepared: list[dict[str, Any]] = []
    for index, item in enumerate(attachments):
        if not isinstance(item, dict):
            raise ValidationError(
                f"Attachment {index + 1} is not valid.", field="attachments", code="invalid_type"
            )
        filename = sanitize_filename(item.get("filename"))
        mime_type = validate_outbound_mime(item.get("mime_type"))
        data = decode_attachment_payload(item.get("data"), field=f"attachments[{index}].data")
        attachment_id = uuid.uuid4().hex
        prepared.append(
            {
                "attachment_id": attachment_id,
                "filename": filename,
                "mime_type": mime_type,
                "data": data,
                "descriptor": {
                    "filename": filename,
                    "mime_type": mime_type,
                    "attachment_id": attachment_id,
                    "gmail_message_id": "",
                },
            }
        )
    return prepared


def _outbound_attachments(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Describe any attachments queued for a document, without their bytes.

    Two kinds, and the difference matters at send time:

    * A **Gmail reference** (``gmail_message_id`` + ``attachment_id``) names an attachment
      that already exists in the supplier's email. The bytes are re-read from Gmail when
      the document is sent, so nothing is duplicated into our database.
    * A **generated file** (the PDF the operator rendered in the browser) has no upstream
      source, so its bytes are stored in ``document_attachments`` and referenced by
      ``attachment_id`` alone.

    The filename is attacker-controlled, so it is sanitised here rather than trusted back
    out of the database later.
    """
    raw = payload.get("attachments")
    if not isinstance(raw, list):
        return []
    described: list[dict[str, Any]] = []
    for item in raw[:MAX_ATTACHMENTS_PER_DOCUMENT]:
        if not isinstance(item, dict):
            continue
        described.append(
            {
                "filename": sanitize_filename(item.get("filename")),
                "mime_type": str(item.get("mime_type") or "application/octet-stream"),
                "gmail_message_id": str(item.get("gmail_message_id") or ""),
                "attachment_id": str(item.get("attachment_id") or ""),
            }
        )
    return described



def _db_call(operation: str, fn):
    """Run a database operation, logging and re-wrapping SQLite failures."""
    try:
        return fn()
    except DatabaseError:
        raise
    except sqlite3.IntegrityError as exc:
        log_event(logger, f"document.{operation}.integrity_error", level="warning",
                  error_type=type(exc).__name__, error=str(exc))
        raise DatabaseError(str(exc)) from exc
    except sqlite3.Error as exc:
        log_event(logger, f"document.{operation}.db_failed", level="error",
                  error_type=type(exc).__name__, error=str(exc), exc_info=True)
        raise DatabaseError(f"Could not {operation} the document: {exc}") from exc


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


def get_document(document_id: str) -> dict[str, Any] | None:
    init_db()
    rows = _db_call(
        "read",
        lambda: _fetch_one("SELECT * FROM outbound_documents WHERE document_id = ?", (document_id,)),
    )
    return _row_to_document(rows) if rows else None


def _fetch_one(query: str, params: tuple[Any, ...] = ()) -> sqlite3.Row | None:
    with get_connection() as conn:
        return conn.execute(query, params).fetchone()


def _fetch_all(query: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
    with get_connection() as conn:
        return conn.execute(query, params).fetchall()


def list_documents(
    *, state: str | None = None, gmail_message_id: str | None = None, limit: int = 100
) -> list[dict[str, Any]]:
    init_db()
    clauses: list[str] = []
    params: list[Any] = []
    if state:
        clauses.append("state = ?")
        params.append(state)
    if gmail_message_id:
        clauses.append("gmail_message_id = ?")
        params.append(gmail_message_id)
    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""
    params.append(limit)
    rows = _db_call(
        "list",
        lambda: _fetch_all(
            f"SELECT * FROM outbound_documents{where} ORDER BY created_at DESC, document_id DESC LIMIT ?",
            tuple(params),
        ),
    )
    return [_row_to_document(row) for row in rows]


def list_events(document_id: str, limit: int = 100) -> list[dict[str, Any]]:
    """The audit trail for one document, oldest first."""
    init_db()
    rows = _db_call(
        "read",
        lambda: _fetch_all(
            "SELECT * FROM workflow_events WHERE document_id = ? ORDER BY event_id ASC LIMIT ?",
            (document_id, limit),
        ),
    )
    return [dict(row) for row in rows]


# ---------------------------------------------------------------------------
# Audit
# ---------------------------------------------------------------------------


def _record_event(
    conn: sqlite3.Connection,
    document_id: str,
    event: str,
    *,
    from_state: str = "",
    to_state: str = "",
    outcome: str = "",
    detail: str = "",
    actor: str = "",
) -> None:
    """Append one audit row.

    `detail` must be a short, safe string - a state name, a field name, a validation code.
    Never document content and never an exception message from upstream.
    """
    conn.execute(
        """
        INSERT INTO workflow_events (
            document_id, request_id, event, from_state, to_state, outcome, detail, actor
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (document_id, current_request_id(), event, from_state, to_state, outcome, detail[:300], actor[:80]),
    )


def _record_standalone_event(
    document_id: str, event: str, *, from_state: str = "", to_state: str = "", outcome: str = "",
    detail: str = "", actor: str = "",
) -> None:
    def run() -> None:
        with get_connection() as conn:
            _record_event(
                conn, document_id, event, from_state=from_state, to_state=to_state,
                outcome=outcome, detail=detail, actor=actor,
            )

    _db_call("audit", run)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def _validate_actor(actor: Any) -> str:
    text = str(actor or "").strip()
    if not text:
        raise ValidationError(
            "An approver name is required so the approval can be attributed.", field="actor", code="missing"
        )
    return validate_header_value(text, field="actor", max_length=MAX_ACTOR_LENGTH)


def _validate_document_number(value: Any, *, field: str = "document_number") -> str:
    """Validate a document number's shape.

    Applied at creation *and* at submit/send. A number containing SQL punctuation or spaces
    is refused up front rather than stored and discovered later.
    """
    text = validate_header_value(value, field=field, max_length=MAX_NUMBER_LENGTH)
    if text and not re.fullmatch(r"[A-Za-z0-9._/\-]+", text):
        raise ValidationError(
            f"{field.replace('_', ' ').capitalize()} may only contain letters, digits, "
            "dot, dash, slash and underscore.",
            field=field,
            code="invalid_characters",
        )
    return text


def validate_document_fields(document_type: str, payload: dict[str, Any], document_number: str) -> list[str]:
    """Return a list of human-readable problems with a document's business fields.

    An empty list means the document may be submitted for approval. This is called on
    submit and again immediately before send, because an editor may have changed the
    content in between.
    """
    problems: list[str] = []

    if not document_number:
        problems.append("The document number is missing.")
    elif not re.fullmatch(r"[A-Za-z0-9._/\-]+", document_number):
        problems.append("The document number may only contain letters, digits, dot, dash, slash and underscore.")

    for group in REQUIRED_FIELDS.get(document_type, ()):
        if all(not _has_value(payload.get(key)) for key in group):
            label = " and ".join(key.replace("_", " ") for key in group)
            problems.append(f"{label.capitalize()} is missing or empty.")

    items = payload.get("items")
    if isinstance(items, list) and items:
        for index, item in enumerate(items[:50], start=1):
            if not isinstance(item, dict):
                problems.append(f"Line {index} is not a valid line item.")
                continue
            if not str(item.get("description") or "").strip():
                problems.append(f"Line {index} has no description.")
            unit_price = item.get("unit_price")
            qty = item.get("qty")
            if document_type in {"Invoice", "Delivery Order"}:
                # Money and quantity are the two fields that make an invoice wrong rather
                # than merely incomplete, so they are enforced for billing documents.
                if unit_price in (None, "") and document_type == "Invoice":
                    problems.append(f"Line {index} has no unit price.")
                if qty in (None, ""):
                    problems.append(f"Line {index} has no quantity.")

    return problems


def _has_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, list | dict | tuple | set):
        return bool(value)
    return True


# ---------------------------------------------------------------------------
# Document numbers
# ---------------------------------------------------------------------------


def allocate_document_number(document_type: str, issue_date: str | None = None) -> str:
    """Return the next unused number for a document type.

    The read runs inside an immediate transaction, so two concurrent callers cannot read
    the same maximum. The number is only *reserved* when it is inserted: a caller that
    allocates and then never creates a document leaves a gap, which is correct, whereas
    handing the same number to two live documents would not be. `create_document` closes
    that race by re-allocating and retrying on the unique index.
    """
    init_db()
    prefix = DOCUMENT_PREFIXES.get(document_type)
    if not prefix:
        raise ValidationError(f"Unsupported document type: {document_type}", field="document_type",
                              code="unsupported_type")

    stamp = issue_date or datetime.now(UTC).strftime("%Y.%m.%d")
    base = f"{prefix}.{stamp}"

    def run() -> str:
        # BEGIN IMMEDIATE takes the write lock up front, so the MAX() read below is not
        # invalidated by a competing allocation before we return.
        with get_connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                rows = conn.execute(
                    """
                    SELECT document_number FROM outbound_documents
                    WHERE document_type = ? AND document_number LIKE ?
                    """,
                    (document_type, f"{base}.%"),
                ).fetchall()
                highest = 0
                for row in rows:
                    tail = str(row["document_number"] or "").rsplit(".", 1)[-1]
                    if tail.isdigit():
                        highest = max(highest, int(tail))
                return f"{base}.{highest + 1}"
            except sqlite3.Error:
                conn.rollback()
                raise

    number = _db_call("allocate a document number for", run)
    log_event(logger, "document.number.allocated", document_type=document_type, document_number=number)
    return number


def _number_is_taken(document_type: str, document_number: str, *, exclude_id: str = "") -> bool:
    rows = _db_call(
        "check",
        lambda: _fetch_all(
            """
            SELECT document_id FROM outbound_documents
            WHERE document_type = ? AND document_number = ? AND document_id != ?
            """,
            (document_type, document_number, exclude_id),
        ),
    )
    return bool(rows)


# ---------------------------------------------------------------------------
# Transitions
# ---------------------------------------------------------------------------


def create_document(
    *,
    document_type: str,
    recipient_email: str,
    subject: str,
    body: str,
    gmail_message_id: str = "",
    document_number: str = "",
    recipient_name: str = "",
    payload: dict[str, Any] | None = None,
    source_category: str = "",
    source_security_status: str = "",
    source_confidence: float | None = None,
    actor: str = "",
    attachments: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Create a draft. A draft is never sendable, whatever the caller asks for.

    ``attachments`` may carry inline base64 content for a file generated in the browser
    (the rendered quotation PDF). The bytes are decoded, size-checked and stored against
    the document; the descriptor that goes into the payload references them by
    ``attachment_id`` only, so the payload never holds a base64 blob.
    """
    init_db()
    if document_type not in DOCUMENT_TYPES:
        raise ValidationError(
            f"Unsupported document type. Allowed: {list(DOCUMENT_TYPES)}",
            field="document_type",
            code="unsupported_type",
        )

    recipient = validate_email_address(recipient_email)
    safe_subject = validate_header_value(subject, field="subject", max_length=200)
    safe_body = validate_body(body)
    safe_recipient_name = validate_header_value(
        recipient_name, field="recipient_name", max_length=200, required=False
    )
    safe_actor = _validate_actor(actor)

    payload = dict(payload or {})
    stored = _prepare_stored_attachments(attachments)
    if stored:
        # Inline descriptors are replaced by their stored references: the payload is
        # returned in API responses and written to the audit trail's neighbourhood, and a
        # base64 PDF in there would bloat both.
        described = [item["descriptor"] for item in stored]
        payload["attachments"] = described + [
            item
            for item in (payload.get("attachments") or [])
            if isinstance(item, dict) and not item.get("data")
        ][:MAX_ATTACHMENTS_PER_DOCUMENT]
    low_confidence = is_low_confidence(source_confidence)
    needs_review = 1 if (low_confidence or source_security_status in {"Spam", "Prompt Injection"}) else 0

    if document_number:
        number = _validate_document_number(document_number)
        if _number_is_taken(document_type, number):
            log_event(logger, "document.duplicate_number", level="warning",
                      document_type=document_type, document_number=number, outcome="rejected")
            raise WorkflowError(
                f"Document number {number} already exists for {document_type}.",
                status_code=409,
                code="duplicate_document_number",
            )
        auto_numbered = False
    else:
        number = ""
        auto_numbered = True

    document_id = uuid.uuid4().hex
    timestamp = _now()
    issue_date = payload.get("issue_date") if isinstance(payload.get("issue_date"), str) else None

    def insert(number: str) -> None:
        with get_connection() as conn:
            for item in stored:
                conn.execute(
                    """
                    INSERT INTO document_attachments (
                        attachment_id, document_id, filename, mime_type, byte_size, content, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        item["attachment_id"],
                        document_id,
                        item["filename"],
                        item["mime_type"],
                        len(item["data"]),
                        item["data"],
                        timestamp,
                    ),
                )
            conn.execute(
                """
                INSERT INTO outbound_documents (
                    document_id, gmail_message_id, document_type, document_number,
                    recipient_email, recipient_name, subject, body, payload_json, state,
                    source_category, source_security_status, source_confidence,
                    needs_human_review, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    document_id,
                    gmail_message_id or None,
                    document_type,
                    number,
                    recipient,
                    safe_recipient_name,
                    safe_subject,
                    safe_body,
                    json.dumps(payload, ensure_ascii=False),
                    STATE_DRAFT,
                    source_category,
                    source_security_status,
                    source_confidence,
                    needs_review,
                    timestamp,
                    timestamp,
                ),
            )
            _record_event(
                conn, document_id, "document.created", to_state=STATE_DRAFT, outcome="ok",
                detail=document_type, actor=safe_actor,
            )

    if auto_numbered:
        # The number is reserved by the INSERT itself, under the unique index. Two
        # concurrent creates can both read the same "next" number; the loser re-reads and
        # tries again rather than surfacing a raw integrity error to the user.
        for attempt in range(1, _NUMBER_ALLOCATION_ATTEMPTS + 1):
            candidate = allocate_document_number(document_type, issue_date)
            try:
                # functools.partial binds the candidate now rather than letting the closure
                # read the loop variable later, so a retry can never reuse a stale number.
                _db_call("create", partial(insert, candidate))
                number = candidate
                break
            except DatabaseError as exc:
                if "UNIQUE" not in str(exc).upper() or attempt == _NUMBER_ALLOCATION_ATTEMPTS:
                    raise
                log_event(
                    logger, "document.number.collision", level="info", attempt=attempt,
                    document_type=document_type, outcome="reallocating",
                )
        else:  # pragma: no cover - the loop always breaks or raises
            raise DatabaseError("Could not allocate a unique document number.")
    else:
        _db_call("create", lambda: insert(number))

    log_event(
        logger, "document.created", document_id=document_id, document_type=document_type,
        document_number=number, gmail_message_id=gmail_message_id or None,
        needs_human_review=bool(needs_review), source_confidence=source_confidence,
    )
    return get_document(document_id)  # type: ignore[return-value]


def _transition(
    document_id: str,
    *,
    expected_states: frozenset[str] | set[str],
    to_state: str,
    event: str,
    set_columns: dict[str, Any],
    actor: str,
    detail: str = "",
) -> dict[str, Any]:
    """Apply a conditional state change and audit it, or refuse.

    The UPDATE carries the state precondition, so this is a compare-and-swap: a concurrent
    request that already moved the row loses and gets a clear 409 instead of silently
    overwriting the other transition.
    """
    if not expected_states:
        raise WorkflowError("No expected state was supplied for this transition.", code="invalid_state")

    assignments = ", ".join(f"{column} = ?" for column in set_columns)
    values = list(set_columns.values())
    values.extend([to_state, _now(), document_id, *sorted(expected_states)])
    placeholders = ", ".join("?" for _ in expected_states)

    def run() -> tuple[int, str]:
        with get_connection() as conn:
            current = conn.execute(
                "SELECT state FROM outbound_documents WHERE document_id = ?", (document_id,)
            ).fetchone()
            if current is None:
                return 0, ""
            from_state = str(current["state"])
            cursor = conn.execute(
                f"""
                UPDATE outbound_documents
                SET {assignments}, state = ?, updated_at = ?
                WHERE document_id = ? AND state IN ({placeholders})
                """,
                tuple(values),
            )
            if cursor.rowcount:
                _record_event(
                    conn, document_id, event, from_state=from_state, to_state=to_state,
                    outcome="ok", detail=detail, actor=actor,
                )
                return cursor.rowcount, from_state
            return 0, from_state

    changed, from_state = _db_call(event, run)

    if not changed:
        if not from_state:
            log_event(logger, f"{event}.missing", level="warning", document_id=document_id)
            raise WorkflowError("Document not found.", status_code=404, code="not_found")
        log_event(
            logger, f"{event}.rejected", level="warning", document_id=document_id,
            from_state=from_state, to_state=to_state, outcome="rejected",
        )
        raise WorkflowError(
            f"This document is '{from_state}' and cannot move to '{to_state}'. "
            "Reload the document to see its current state.",
            status_code=409,
            code="invalid_state",
            details=[f"current_state={from_state}"],
        )

    log_event(logger, event, document_id=document_id, from_state=from_state, to_state=to_state)
    return get_document(document_id)  # type: ignore[return-value]


def submit_for_approval(document_id: str, *, actor: str) -> dict[str, Any]:
    """Draft -> Pending Approval. Validates business fields first."""
    safe_actor = _validate_actor(actor)
    document = get_document(document_id)
    if document is None:
        raise WorkflowError("Document not found.", status_code=404, code="not_found")

    problems = validate_document_fields(
        document["document_type"], document.get("payload") or {}, document.get("document_number") or ""
    )
    if problems:
        _record_standalone_event(
            document_id, "document.submit.blocked", from_state=document["state"],
            to_state=STATE_PENDING, outcome="rejected",
            detail=f"{len(problems)} field problem(s)", actor=safe_actor,
        )
        log_event(
            logger, "document.submit.blocked", level="warning", document_id=document_id,
            from_state=document["state"], to_state=STATE_PENDING, outcome="rejected",
            problem_count=len(problems),
        )
        raise WorkflowError(
            "This document is not complete enough to send for approval.",
            status_code=422,
            code="incomplete_document",
            details=problems,
        )

    return _transition(
        document_id,
        expected_states={STATE_DRAFT, STATE_REJECTED},
        to_state=STATE_PENDING,
        event="document.submitted",
        set_columns={"needs_human_review": int(document.get("needs_human_review") or 0)},
        actor=safe_actor,
        detail=document["document_type"],
    )


def approve_document(document_id: str, *, actor: str) -> dict[str, Any]:
    """Pending Approval -> Approved.

    This is the human gate. It is reachable only from ``Pending Approval``, requires a named
    approver, and records the approver and the time. No automated step calls it, and no
    model output can supply the actor.
    """
    safe_actor = _validate_actor(actor)
    return _transition(
        document_id,
        expected_states={STATE_PENDING},
        to_state=STATE_APPROVED,
        event="document.approved",
        set_columns={"approved_by": safe_actor, "approved_at": _now()},
        actor=safe_actor,
        detail="human_approval",
    )


def reject_document(document_id: str, *, actor: str, reason: str) -> dict[str, Any]:
    """Pending Approval -> Rejected. A reason is mandatory so the audit trail is useful."""
    safe_actor = _validate_actor(actor)
    safe_reason = validate_header_value(reason, field="reason", max_length=300)
    return _transition(
        document_id,
        expected_states={STATE_PENDING, STATE_SEND_FAILED},
        to_state=STATE_REJECTED,
        event="document.rejected",
        set_columns={"rejected_by": safe_actor, "rejected_at": _now(), "rejection_reason": safe_reason},
        actor=safe_actor,
        detail=safe_reason[:80],
    )


# ---------------------------------------------------------------------------
# Send
# ---------------------------------------------------------------------------


def _read_stored_attachment(attachment_id: str) -> tuple[str, str, bytes] | None:
    """Read a generated attachment's bytes back out of the database."""
    init_db()

    def run() -> tuple[str, str, bytes] | None:
        with get_connection() as conn:
            row = conn.execute(
                "SELECT filename, mime_type, content FROM document_attachments WHERE attachment_id = ?",
                (attachment_id,),
            ).fetchone()
        if row is None:
            return None
        return (
            str(row["filename"] or "attachment"),
            str(row["mime_type"] or "application/pdf"),
            bytes(row["content"] or b""),
        )

    return _db_call("read an attachment", run)


def _gather_attachments(document: dict[str, Any]) -> list[dict[str, Any]]:
    """Resolve every attachment descriptor to bytes at the moment of sending.

    A descriptor that names a Gmail attachment is re-read from Gmail, so a supplier who
    later edits or deletes the file cannot have the sent copy silently differ from the
    approved one - a mismatch is a failure, not a send. A descriptor with no Gmail source
    is a file we generated and stored, read back from the database.

    Filenames and media types are re-sanitised here rather than trusted from the payload,
    because this is the last point before they reach a mail header.
    """
    from services.attachment_text_service import read_attachment_bytes

    resolved: list[dict[str, Any]] = []
    for item in document.get("attachments") or []:
        if not isinstance(item, dict):
            continue
        message_id = item.get("gmail_message_id") or document.get("gmail_message_id") or ""
        attachment_id = item.get("attachment_id") or ""
        filename = sanitize_filename(item.get("filename"))

        if not attachment_id:
            raise SendFailed(
                "An attachment on this document could not be matched to its source.",
                retryable=False,
                code="attachment_unresolved",
            )

        if message_id:
            data = read_attachment_bytes(message_id, attachment_id)
            if not data:
                raise SendFailed(
                    "An attachment on this document is no longer available in the source email.",
                    retryable=False,
                    code="attachment_missing",
                )
            resolved.append(
                {
                    "filename": filename,
                    "mime_type": str(item.get("mime_type") or "application/octet-stream"),
                    "data": data,
                }
            )
            continue

        stored = _read_stored_attachment(attachment_id)
        if stored is None:
            raise SendFailed(
                "An attachment on this document is no longer available.",
                retryable=False,
                code="attachment_missing",
            )
        stored_name, stored_mime, data = stored
        if not data:
            raise SendFailed(
                "An attachment on this document is empty.",
                retryable=False,
                code="attachment_missing",
            )
        resolved.append(
            {
                "filename": stored_name or filename,
                "mime_type": stored_mime or "application/octet-stream",
                "data": data,
            }
        )
    return resolved


def send_document(document_id: str, *, actor: str, force_override: bool = False) -> dict[str, Any]:
    """Send an approved document. The only path from the app to Gmail's send API.

    Order matters: cheap rejections first, the atomic claim immediately before the network
    call, and the audit write in the same transaction as each state change.
    """
    from services.gmail_service import GmailSendError, send_email

    safe_actor = _validate_actor(actor)
    init_db()

    document = get_document(document_id)
    if document is None:
        log_event(logger, "document.send.missing", level="warning", document_id=document_id)
        raise WorkflowError("Document not found.", status_code=404, code="not_found")

    state = str(document.get("state") or "")

    # 1. Already sent. Return the recorded result; do not call Gmail again. This is the
    #    duplicate-request case (double click, retried fetch, replayed job).
    if state == STATE_SENT:
        log_event(
            logger, "document.send.duplicate_suppressed", document_id=document_id,
            state=state, outcome="suppressed",
        )
        return {
            "ok": True,
            "duplicate_suppressed": True,
            "document": document,
            "sent_message_id": document.get("sent_message_id") or "",
            "sent_at": document.get("sent_at") or "",
        }

    # 2. Not approved. This is the guardrail: no state other than Approved/Send Failed can
    #    reach the network, no matter what the caller believes the state to be.
    if state not in SENDABLE_STATES:
        _record_standalone_event(
            document_id, "document.send.blocked", from_state=state, to_state=STATE_SENDING,
            outcome="rejected", detail=f"state={state}", actor=safe_actor,
        )
        log_event(
            logger, "document.send.blocked", level="warning", document_id=document_id,
            from_state=state, to_state=STATE_SENDING, outcome="rejected",
            reason="not_approved" if state != STATE_DRAFT else "not_submitted",
        )
        raise WorkflowError(
            "This document has not been approved for sending. A human must review and approve it first.",
            status_code=409,
            code="not_approved",
            details=[f"current_state={state}"],
        )

    # 3. Re-validate the business fields. The document may have been edited after approval.
    problems = validate_document_fields(
        document["document_type"], document.get("payload") or {}, document.get("document_number") or ""
    )
    if problems:
        _record_standalone_event(
            document_id, "document.send.blocked", from_state=state, to_state=STATE_SENDING,
            outcome="rejected", detail=f"{len(problems)} field problem(s)", actor=safe_actor,
        )
        log_event(
            logger, "document.send.blocked", level="warning", document_id=document_id,
            from_state=state, problem_count=len(problems), reason="incomplete_document",
        )
        raise WorkflowError(
            "This document is incomplete and cannot be sent. Reopen it and complete the missing fields.",
            status_code=422,
            code="incomplete_document",
            details=problems,
        )

    # 4. A prompt-injection verdict on the source email needs an explicit, logged override.
    source_status = str(document.get("source_security_status") or "")
    if requires_send_override(source_status) and not force_override:
        _record_standalone_event(
            document_id, "document.send.blocked", from_state=state, to_state=STATE_SENDING,
            outcome="rejected", detail="override_required", actor=safe_actor,
        )
        log_event(
            logger, "document.send.blocked", level="warning", document_id=document_id,
            from_state=state, reason="override_required", source_security_status=source_status,
        )
        raise WorkflowError(
            "The source email was flagged as a prompt-injection attempt. Sending requires an "
            "explicit override once you have read it yourself.",
            status_code=403,
            code="override_required",
        )

    # 5. Re-validate the header/body just before use, so a value written by any other
    #    code path still cannot inject a header or carry an unbounded payload.
    recipient = validate_email_address(document.get("recipient_email"))
    subject = validate_header_value(document.get("subject"), field="subject", max_length=200)
    body = validate_body(document.get("body"))

    # 6. Atomic claim. Only one caller can move Approved -> Sending.
    claimed = _transition(
        document_id,
        expected_states={STATE_APPROVED, STATE_SEND_FAILED},
        to_state=STATE_SENDING,
        event="document.send.started",
        set_columns={"send_attempts": int(document.get("send_attempts") or 0) + 1},
        actor=safe_actor,
        detail=f"attempt={int(document.get('send_attempts') or 0) + 1}",
    )
    document_id_confirmed = str(claimed.get("document_id") or document_id)

    def _abort(
        *,
        error_code: str,
        message: str,
        status: int,
        retryable: bool,
        cause: BaseException,
        level: str = "error",
    ) -> WorkflowError:
        """Release the claim and turn ``cause`` into a safe, actionable error.

        Every exit from the claimed region must go through here, otherwise a single
        unexpected exception (a Google client error, a socket timeout, a bug in
        attachment handling) would strand the document in ``Sending``, which no client can
        retry because the state machine only leaves ``Sending`` explicitly.
        """
        _fail_send(document_id_confirmed, state, error_code, safe_actor, retryable=retryable)
        log_event(
            logger, "document.send.failed", level=level, document_id=document_id_confirmed,
            from_state=state, to_state=STATE_SEND_FAILED, outcome="failed",
            error_code=error_code, retryable=retryable, error=type(cause).__name__,
            exc_info=level == "error",
        )
        return WorkflowError(message, status_code=status, code=error_code)

    try:
        try:
            attachments = _gather_attachments(claimed)
        except SendFailed as exc:
            raise _abort(
                error_code=exc.code,
                message="This document could not be sent because an attachment is unavailable.",
                status=422,
                retryable=exc.retryable,
                cause=exc,
            ) from exc

        with timed("gmail.send", logger, document_id=document_id_confirmed,
                   document_type=claimed.get("document_type"), attempt=claimed.get("send_attempts")):
            result = send_email(
                to=recipient,
                subject=subject,
                body=body,
                attachments=attachments,
            )
    except WorkflowError:
        # Already translated and audited by _abort inside the inner block. Re-raised
        # untouched, or the catch-all below would relabel a precise failure code (for
        # example attachment_missing) as the generic send_error.
        raise
    except GmailSendError as exc:
        raise _abort(
            error_code=exc.code,
            message=(
                "The email could not be sent. No copy was sent; you can safely try again."
                if exc.retryable
                else "The email was rejected by Gmail. The document is unchanged and nothing was sent."
            ),
            status=502 if exc.retryable else 422,
            retryable=exc.retryable,
            cause=exc,
        ) from exc
    except ValidationError as exc:
        # A value the validators accepted once but that the transport refused (for example
        # an address Gmail rejects as undeliverable) must not leave the row in-flight.
        raise _abort(
            error_code=exc.code,
            message="The email could not be sent because its address or formatting was refused.",
            status=422,
            retryable=False,
            cause=exc,
        ) from exc
    except Exception as exc:  # noqa: BLE001 - the claim must never be left in flight
        raise _abort(
            error_code="send_error",
            message="The email could not be sent because of an internal error. "
                    "No copy was sent; you can safely try again.",
            status=502,
            retryable=True,
            cause=exc,
        ) from exc

    sent_message_id = str((result or {}).get("id") or "")

    def mark_sent() -> None:
        with get_connection() as conn:
            conn.execute(
                """
                UPDATE outbound_documents
                SET state = ?, sent_at = ?, sent_message_id = ?, last_error_code = '', updated_at = ?
                WHERE document_id = ?
                """,
                (STATE_SENT, _now(), sent_message_id, _now(), document_id_confirmed),
            )
            _record_event(
                conn, document_id_confirmed, "document.send.succeeded", from_state=STATE_SENDING,
                to_state=STATE_SENT, outcome="ok", detail=f"gmail_message_id={sent_message_id or 'none'}",
                actor=safe_actor,
            )

    try:
        _db_call("record the send", mark_sent)
    except DatabaseError as exc:
        # The email HAS gone out but we failed to record it. Say so loudly: a blind retry
        # here would send a duplicate, so the operator has to reconcile.
        log_event(
            logger, "document.send.unrecorded", level="error", document_id=document_id_confirmed,
            gmail_message_id=sent_message_id or None, exc_info=True,
        )
        raise WorkflowError(
            "The email was sent but the result could not be recorded. Do not resend - "
            "check the Sent folder and contact support.",
            status_code=500,
            code="send_state_unrecorded",
        ) from exc

    log_event(
        logger, "document.send.succeeded", document_id=document_id_confirmed,
        from_state=STATE_SENDING, to_state=STATE_SENT, outcome="ok",
        gmail_message_id=sent_message_id or None, attempt=claimed.get("send_attempts"),
    )
    return {
        "ok": True,
        "duplicate_suppressed": False,
        "document": get_document(document_id_confirmed),
        "sent_message_id": sent_message_id,
        "sent_at": _now(),
    }


def _fail_send(document_id: str, previous_state: str, code: str, actor: str, *, retryable: bool) -> None:
    """Move a claimed document to Send Failed and audit it. Never to Sent."""

    def run() -> None:
        with get_connection() as conn:
            conn.execute(
                """
                UPDATE outbound_documents
                SET state = ?, last_error_code = ?, updated_at = ?
                WHERE document_id = ?
                """,
                (STATE_SEND_FAILED, code, _now(), document_id),
            )
            _record_event(
                conn, document_id, "document.send.failed", from_state=previous_state,
                to_state=STATE_SEND_FAILED, outcome="failed", detail=f"code={code}", actor=actor,
            )

    _db_call("record the send failure", run)
