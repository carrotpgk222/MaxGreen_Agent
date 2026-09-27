from __future__ import annotations

import logging
import mimetypes
import re
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote

import uvicorn
from dotenv import load_dotenv
from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field
from starlette.datastructures import Headers
from starlette.types import ASGIApp

BASE_DIR = Path(__file__).resolve().parent
logger = logging.getLogger("maxgreen")
load_dotenv(BASE_DIR.parent / ".env")

from services import workflow_service  # noqa: E402
from services.classification_service import VALID_CATEGORIES, classify_message  # noqa: E402
from services.database_service import (  # noqa: E402
    DatabaseError,
    count_inbox_messages,
    count_messages,
    count_supplier_payable_messages,
    get_message,
    init_db,
    list_messages,
    list_supplier_payable_messages,
    list_unclassified_messages,
    set_message_category,
    update_message_classification,
)
from services.gmail_service import fetch_attachment, get_profile, is_connected  # noqa: E402
from services.llm_service import configured_model, test_connection  # noqa: E402
from services.llm_service import is_configured as llm_is_configured  # noqa: E402
from services.logging_config import (  # noqa: E402
    configure_logging,
    current_request_id,
    log_event,
    new_request_id,
    reset_request_id,
    set_request_id,
)
from services.scheduler_service import start_scheduler, stop_scheduler  # noqa: E402
from services.security_service import (  # noqa: E402
    MAX_ATTACHMENT_BYTES,
    ValidationError,
    clamp_int,
    sanitize_filename,
    truncate_for_log,
    validate_gmail_query,
    validate_opaque_id,
)
from services.sync_service import sync_gmail  # noqa: E402

# Installed as the first thing that happens so every module-level import below, and every
# log line from here on, is structured and correlated.
configure_logging()

#: Per-message lock so two simultaneous classify requests for the same email do not both
#: pay for a model call and race on the same UPDATE row.
_classify_locks: dict[str, threading.Lock] = {}
_classify_locks_guard = threading.Lock()

#: Attachment types the browser may render *inline* in the app's origin. Everything else
#: is served as a download with a sandboxed CSP, because a same-origin text/html or
#: image/svg+xml attachment could otherwise run script as the signed-in operator.
INLINE_RENDERABLE_TYPES = frozenset(
    {"application/pdf", "text/plain", "image/png", "image/jpeg", "image/gif", "image/webp"}
)


def _classify_lock(key: str) -> threading.Lock:
    with _classify_locks_guard:
        lock = _classify_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _classify_locks[key] = lock
        return lock


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Order matters: the schema and its additive migrations must exist before the
    background scheduler starts writing to the database."""
    init_db()
    log_event(logger, "app.starting", version=app.version)
    start_scheduler()
    try:
        yield
    finally:
        await stop_scheduler()
        log_event(logger, "app.stopped")


app = FastAPI(
    title="MaxGreen Agent Local Backend",
    version="0.6.0",
    description="Local backend for Gmail, Claude classification, and workflow routing.",
    lifespan=lifespan,
)

# Local development only: allow any localhost/127.0.0.1 port, including Live Server on :3000.
# In production the frontend is served same-origin through nginx, so no cross-origin
# request is legitimate at all - this stays as a development affordance only.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-Request-ID", "X-Actor"],
    expose_headers=["X-Request-ID"],
    max_age=600,
)


def _sanitize_request_id(value: str | None) -> str:
    """Accept a caller-supplied correlation id only if it is plainly safe.

    The id is echoed in a response header and written to every log line for the request,
    so an unvalidated value would be a header-injection and log-forging vector.
    """
    text = (value or "").strip()
    if not text or len(text) > 64:
        return ""
    if not all(char.isalnum() or char in "-_." for char in text):
        return ""
    return text


class RequestContextMiddleware:
    """Bind a correlation id to the request and log one line per completed request.

    A raw ASGI middleware rather than the decorator form so the contextvar is set before
    routing and survives into the endpoint's worker thread, and so the timing wraps the
    whole downstream chain rather than just the endpoint body.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request_id = _sanitize_request_id(Headers(scope=scope).get("x-request-id")) or new_request_id()
        token = set_request_id(request_id)
        started = time.perf_counter()
        status_code = 500
        client = scope.get("client")
        client_ip = client[0] if client else ""

        async def send_wrapper(message) -> None:
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message["status"]
                headers = message.setdefault("headers", [])
                headers.append((b"x-request-id", request_id.encode("ascii", "ignore")))
                headers.append((b"x-content-type-options", b"nosniff"))
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            duration_ms = round((time.perf_counter() - started) * 1000, 2)
            log_event(
                logger,
                "http.request",
                level="info" if status_code < 500 else "error",
                method=scope.get("method", ""),
                path=truncate_for_log(scope.get("path", ""), 120),
                status_code=status_code,
                duration_ms=duration_ms,
                client_ip=client_ip,
            )
            reset_request_id(token)


# Added last so it is the outermost middleware and therefore times everything.
app.add_middleware(RequestContextMiddleware)


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------


def _error(status_code: int, code: str, message: str, details: list[str] | None = None) -> JSONResponse:
    payload: dict[str, object] = {"detail": message, "code": code, "request_id": current_request_id()}
    if details:
        payload["details"] = details
    response = JSONResponse(status_code=status_code, content=payload)
    response.headers["x-request-id"] = current_request_id()
    return response



@app.exception_handler(ValidationError)
async def validation_error_handler(_request: Request, exc: ValidationError) -> JSONResponse:
    """A rejected input value, reported with the field name but never the value."""
    log_event(
        logger, "request.validation_failed", level="info", outcome="rejected",
        field=exc.field, error_code=exc.code, error=exc.message,
    )
    return _error(422, exc.code, exc.message)


@app.exception_handler(workflow_service.WorkflowError)
async def workflow_error_handler(_request: Request, exc: workflow_service.WorkflowError) -> JSONResponse:
    """A refused state transition. Already logged at the point of refusal."""
    return _error(exc.status_code, exc.code, exc.message, exc.details)


@app.exception_handler(DatabaseError)
async def database_error_handler(_request: Request, exc: DatabaseError) -> JSONResponse:
    log_event(logger, "request.database_failed", level="error", outcome="failed",
              error=truncate_for_log(exc), exc_info=True)
    return _error(
        503,
        "database_unavailable",
        "The local database is unavailable or busy. Nothing was changed. Try again in a moment.",
    )


@app.exception_handler(RequestValidationError)
async def request_validation_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
    """Shape a FastAPI validation failure without echoing the submitted body."""
    fields = sorted({str(item.get("loc", ["body"])[-1]) for item in exc.errors()})
    log_event(logger, "request.schema_invalid", level="info", outcome="rejected", fields=fields[:10])
    return _error(422, "invalid_request", "The request was not valid.", fields)


@app.exception_handler(Exception)
async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """Last resort: log everything, tell the browser nothing technical.

    A traceback can carry file paths, SQL, upstream response bodies and credentials, so
    the browser gets a correlation id and the operator gets the log.
    """
    log_event(logger, "request.unhandled_error", level="error", outcome="failed",
              error_type=type(exc).__name__, path=request.url.path, exc_info=True)
    return _error(
        500,
        "internal_error",
        "Something went wrong on the server. Nothing was changed. Check the backend logs.",
    )



def _upstream_failure(message: str, exc: Exception, status_code: int = 502) -> HTTPException:
    """Log the real upstream error and return a message that is safe to send to the browser.

    Upstream exceptions can carry the LLM gateway's response body, model output, Google API
    tokens and request URLs, so their text must never be echoed in an HTTP response.
    """
    logger.error("%s: %s", message, exc, exc_info=True)
    return HTTPException(status_code=status_code, detail=message)


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class SetCategoryRequest(BaseModel):
    """Manual category override. Unknown fields are rejected rather than ignored."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    category: str = Field(min_length=1, max_length=40)


class CreateDocumentRequest(BaseModel):
    """A new outbound document draft.

    recipient/subject/body may be omitted when gmail_message_id is supplied: they are then
    seeded from that message, which is the normal path.
    """

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    document_type: str = Field(min_length=1, max_length=40)
    gmail_message_id: str = Field(default="", max_length=128)
    recipient_email: str = Field(default="", max_length=254)
    recipient_name: str = Field(default="", max_length=200)
    subject: str = Field(default="", max_length=200)
    body: str = Field(default="")
    document_number: str = Field(default="", max_length=40)
    payload: dict = Field(default_factory=dict)
    actor: str = Field(min_length=1, max_length=80)


class ApprovalRequest(BaseModel):
    """Approval and rejection. The actor is mandatory so the decision is attributable."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    actor: str = Field(min_length=1, max_length=80)


class RejectionRequest(ApprovalRequest):
    reason: str = Field(min_length=1, max_length=300)


class SendRequest(ApprovalRequest):
    #: Set only after a reviewer has personally read a message flagged as an injection
    #: attempt. It is recorded in the audit trail.
    force_override: bool = False


# ---------------------------------------------------------------------------
# Health and status
# ---------------------------------------------------------------------------


@app.get("/")
def root() -> dict:
    return {
        "name": "MaxGreen Agent Local Backend",
        "status": "running",
        "docs": "http://127.0.0.1:8000/docs",
    }


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "gmail_connected": is_connected(), "stored_messages": count_messages()}


@app.get("/api/gmail/status")
def gmail_status() -> dict:
    if not is_connected():
        return {
            "connected": False,
            "message": "Run backend/connect_gmail.bat first.",
        }
    try:
        return {"connected": True, **get_profile()}
    except Exception as exc:
        logger.error("Gmail status check failed: %s", exc, exc_info=True)
        return {"connected": False, "message": "Could not read the Gmail profile. Check the backend logs."}


# ---------------------------------------------------------------------------
# Sync and AI
# ---------------------------------------------------------------------------


@app.post("/api/gmail/sync")
def gmail_sync(
    limit: int = Query(default=25, ge=1, le=100),
    query: str = Query(default="in:inbox", min_length=1),
) -> dict:
    if not is_connected():
        raise HTTPException(status_code=401, detail="Gmail is not connected. Run connect_gmail.bat first.")
    safe_query = validate_gmail_query(query)
    try:
        result = sync_gmail(limit=limit, query=safe_query)
        failures = result.get("fetch_failures") or []
        ai = result.get("ai") or {}
        return {
            "ok": not failures,
            "fetched": result["fetched"],
            "stored_messages": count_messages(),
            "query": result["query"],
            # A partial sync is reported as ok=False rather than looking complete.
            "fetch_failures": len(failures),
            "failed_message_ids": [item["gmail_message_id"] for item in failures[:20]],
            "ai": {
                key: ai.get(key)
                for key in ("enabled", "processed", "failed", "needs_human_review", "skipped_reason")
                if key in ai
            },
        }
    except Exception as exc:
        raise _upstream_failure("Gmail sync failed. Check the backend logs for details.", exc, status_code=500) from exc


@app.get("/api/llm/status")
def llm_status() -> dict:
    return {
        "configured": llm_is_configured(),
        "model": configured_model(),
    }


@app.post("/api/llm/test")
def llm_test() -> dict:
    try:
        return test_connection()
    except Exception as exc:
        raise _upstream_failure("Could not reach the LLM gateway. Check the backend logs for details.", exc) from exc


@app.post("/api/ai/classify/{gmail_message_id}")
def classify_gmail_message(gmail_message_id: str) -> dict:
    message_id = validate_opaque_id(gmail_message_id, field="gmail_message_id")
    message = get_message(message_id)
    if message is None:
        raise HTTPException(status_code=404, detail="Stored Gmail message not found.")
    # One classification at a time per message: a double click must not buy two model calls.
    with _classify_lock(message_id):
        try:
            result = classify_message(message)
            update_message_classification(message_id, result)
            log_event(
                logger, "classification.requested", gmail_message_id=message_id,
                document_type=result.get("category"), security_status=result.get("security_status"),
                confidence=result.get("confidence"), needs_human_review=result.get("needs_human_review"),
                trigger="manual",
            )
            return {"ok": True, "gmail_message_id": message_id, "classification": result}
        except Exception as exc:
            raise _upstream_failure(
                f"AI preparation failed for Gmail {message_id}. Check the backend logs for details.",
                exc,
            ) from exc


@app.post("/api/ai/classify-unclassified")
def classify_unclassified(limit: int = Query(default=10, ge=1, le=25)) -> dict:
    items = list_unclassified_messages(limit=limit)
    results = []
    for message in items:
        if not message:
            continue
        message_id = message["gmail_message_id"]
        try:
            with _classify_lock(message_id):
                result = classify_message(message)
                update_message_classification(message_id, result)
            results.append(
                {
                    "gmail_message_id": message_id,
                    "ok": True,
                    "classification": result,
                }
            )
        except Exception as exc:
            logger.error("AI classification failed for Gmail %s: %s", message_id, exc, exc_info=True)
            results.append(
                {
                    "gmail_message_id": message_id,
                    "ok": False,
                    "error": "Classification failed. See the backend logs for details.",
                }
            )
    failed = sum(1 for item in results if not item.get("ok"))
    log_event(logger, "classification.batch.completed", processed=len(results), failed=failed)
    # ok=False when anything failed, so a caller cannot mistake a partial sweep for a
    # completed one.
    return {"ok": failed == 0, "processed": len(results), "failed": failed, "results": results}


# ---------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------


@app.post("/api/gmail/messages/{gmail_message_id}/category")
def set_gmail_message_category(
    gmail_message_id: str,
    payload: SetCategoryRequest = Body(...),
) -> dict:
    """Manually override a message's category from the Inbox dropdown."""
    message_id = validate_opaque_id(gmail_message_id, field="gmail_message_id")
    category = payload.category
    allowed = VALID_CATEGORIES | {"Unclassified"}
    if category not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid category. Allowed: {sorted(allowed)}",
        )

    updated = set_message_category(message_id, category)
    if not updated:
        raise HTTPException(status_code=404, detail="Stored Gmail message not found.")

    log_event(logger, "message.category_overridden", gmail_message_id=message_id, category=category)
    message = get_message(message_id)
    return {"ok": True, "gmail_message_id": message_id, "message": message}


@app.get("/api/dashboard/counts")
def dashboard_counts() -> dict:
    return {
        "inbox": count_inbox_messages(),
        "supplier_payable": count_supplier_payable_messages(),
    }


@app.get("/api/supplier-payable/messages")
def supplier_payable_messages(limit: int = Query(default=200, ge=1, le=500)) -> dict:
    return {"messages": list_supplier_payable_messages(limit=limit)}


@app.get("/api/gmail/messages")
def gmail_messages(limit: int = Query(default=25, ge=1, le=100)) -> dict:
    return {"messages": list_messages(limit=limit)}


@app.get("/api/gmail/messages/{gmail_message_id}")
def gmail_message(gmail_message_id: str) -> dict:
    message_id = validate_opaque_id(gmail_message_id, field="gmail_message_id")
    record = get_message(message_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Stored Gmail message not found.")
    return {"message": record}


@app.get("/api/gmail/messages/{gmail_message_id}/attachments/{attachment_id}")
def gmail_attachment(
    gmail_message_id: str,
    attachment_id: str,
    # Empty by default so the name Gmail actually recorded is used; a supplied value
    # overrides it (the UI renames a download to the sanitised document name).
    filename: str = Query(default="", max_length=200),
) -> Response:
    message_id = validate_opaque_id(gmail_message_id, field="gmail_message_id")
    att_id = validate_opaque_id(attachment_id, field="attachment_id")

    message = get_message(message_id)
    if message is None:
        raise HTTPException(status_code=404, detail="Stored Gmail message not found.")

    attachment_meta = next(
        (
            item
            for item in message.get("attachments", [])
            if item.get("attachment_id") == att_id
        ),
        None,
    )
    if attachment_meta is None:
        raise HTTPException(status_code=404, detail="Attachment not found for this Gmail message.")

    try:
        data = fetch_attachment(message_id, att_id)
    except Exception as exc:
        raise _upstream_failure(
            "Could not fetch the Gmail attachment. Check the backend logs for details.",
            exc,
            status_code=500,
        ) from exc

    if len(data) > MAX_ATTACHMENT_BYTES:
        log_event(
            logger, "attachment.serve.rejected", level="warning", gmail_message_id=message_id,
            attachment_id=att_id, bytes=len(data), limit=MAX_ATTACHMENT_BYTES,
        )
        raise HTTPException(status_code=413, detail="This attachment is too large to open.")

    declared_size = attachment_meta.get("size") or 0
    try:
        declared_size = int(declared_size)
    except (TypeError, ValueError):
        declared_size = 0
    if declared_size and abs(declared_size - len(data)) > 1024:
        # Truncated or replaced since it was listed. Do not hand a corrupt file to a
        # document generator or render it as if it were the real thing.
        log_event(
            logger, "attachment.serve.size_mismatch", level="warning", gmail_message_id=message_id,
            attachment_id=att_id, declared_bytes=declared_size, actual_bytes=len(data),
        )
        raise HTTPException(
            status_code=502,
            detail="This attachment no longer matches the one that was listed. Reopen the email.",
        )

    # The filename comes from the query string, so it is attacker-controlled: sanitise it
    # before it reaches a header, and never let a supplied extension decide the media type.
    safe_filename = sanitize_filename(
        filename.strip() or attachment_meta.get("filename") or "attachment"
    )
    stored_mime = str(attachment_meta.get("mime_type") or "").split(";")[0].strip().lower()
    media_type = stored_mime or mimetypes.guess_type(safe_filename)[0] or "application/octet-stream"

    inline = media_type in INLINE_RENDERABLE_TYPES
    encoded = quote(safe_filename, safe="")

    headers = {
        "Content-Disposition": f"{'inline' if inline else 'attachment'}; filename*=UTF-8''{encoded}",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        # `sandbox` is the important one: an HTML or SVG attachment rendered at the app's
        # own origin would otherwise execute with the operator's authenticated session and
        # could call the approval/send endpoints. Sandbox gives it an opaque origin.
        "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        "Content-Length": str(len(data)),
    }
    log_event(
        logger, "attachment.served", gmail_message_id=message_id, attachment_id=att_id,
        mime_type=media_type, bytes=len(data), disposition="inline" if inline else "attachment",
    )
    return Response(content=data, media_type=media_type, headers=headers)


# ---------------------------------------------------------------------------
# Outbound documents: the human approval gate
# ---------------------------------------------------------------------------


def _document_summary(document: dict) -> dict:
    return {
        "document_id": document.get("document_id"),
        "document_type": document.get("document_type"),
        "document_number": document.get("document_number"),
        "state": document.get("state"),
        "gmail_message_id": document.get("gmail_message_id"),
        "needs_human_review": document.get("needs_human_review"),
        "created_at": document.get("created_at"),
        "updated_at": document.get("updated_at"),
    }


def _seed_from_message(message: dict) -> dict[str, object]:
    """Build draft content from a stored Gmail message.

    Reuses the classification and extraction that already ran: no extra model call, and the
    reviewer still sees the source alongside the draft.
    """
    quotation = message.get("ai_quotation_draft") or {}
    payload: dict[str, object] = dict(quotation) if isinstance(quotation, dict) else {}
    payload.setdefault("gmail_message_id", message.get("gmail_message_id"))
    if message.get("ai_confidence") is not None:
        payload.setdefault("source_confidence", message.get("ai_confidence"))
    if message.get("ai_security_status"):
        payload.setdefault("source_security_status", message.get("ai_security_status"))

    subject = str(message.get("subject") or "").strip()
    # Strip the Fwd:/Re: chain so the outbound subject reads like a real document subject.
    while True:
        stripped = re.sub(r"^\s*(?:re|fwd|fw)\s*(?:\[\d+\])?\s*:\s*", "", subject, flags=re.IGNORECASE)
        if stripped == subject:
            break
        subject = stripped

    return {
        "recipient_email": str(message.get("sender_email") or ""),
        "recipient_name": str(message.get("sender") or ""),
        "subject": subject[:200],
        "body": str(message.get("body_text") or message.get("snippet") or "")[:100_000],
        "payload": payload,
        "source_category": str(message.get("ai_category") or ""),
        "source_security_status": str(message.get("ai_security_status") or ""),
        "source_confidence": message.get("ai_confidence"),
    }


@app.post("/api/documents", status_code=201)
def create_document(payload: CreateDocumentRequest) -> dict:
    """Create a draft. A draft is never sendable, whatever the caller asks for."""
    seed: dict[str, object] = {}
    gmail_message_id = ""
    if payload.gmail_message_id:
        gmail_message_id = validate_opaque_id(payload.gmail_message_id, field="gmail_message_id")
        message = get_message(gmail_message_id)
        if message is None:
            raise HTTPException(status_code=404, detail="Stored Gmail message not found.")
        seed = _seed_from_message(message)

    recipient_email = payload.recipient_email or str(seed.get("recipient_email") or "")
    subject = payload.subject or str(seed.get("subject") or "")
    body = payload.body or str(seed.get("body") or "")
    document_payload = payload.payload or dict(seed.get("payload") or {})  # type: ignore[arg-type]

    document = workflow_service.create_document(
        document_type=payload.document_type,
        recipient_email=recipient_email,
        subject=subject,
        body=body,
        gmail_message_id=gmail_message_id,
        document_number=payload.document_number,
        recipient_name=payload.recipient_name or str(seed.get("recipient_name") or ""),
        payload=document_payload,
        source_category=str(seed.get("source_category") or ""),
        source_security_status=str(seed.get("source_security_status") or ""),
        source_confidence=seed.get("source_confidence"),  # type: ignore[arg-type]
        actor=payload.actor,
    )
    return {"ok": True, "document": _document_summary(document)}


@app.get("/api/documents")
def list_documents(
    state: str = Query(default="", max_length=40),
    gmail_message_id: str = Query(default="", max_length=128),
    limit: int = Query(default=100, ge=1, le=500),
) -> dict:
    if state and state not in workflow_service.ALL_STATES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid state. Allowed: {sorted(workflow_service.ALL_STATES)}",
        )
    # An omitted filter is not an error: only validate when the caller actually supplied
    # one, otherwise "list everything" (the default) would be rejected as a bad ID.
    resolved_message_id = (
        validate_opaque_id(gmail_message_id, field="gmail_message_id") if gmail_message_id.strip() else None
    )
    documents = workflow_service.list_documents(
        state=state or None,
        gmail_message_id=resolved_message_id,
        limit=clamp_int(limit, minimum=1, maximum=500, default=100),
    )
    return {"ok": True, "documents": [_document_summary(item) for item in documents]}


@app.get("/api/documents/{document_id}")
def get_document(document_id: str) -> dict:
    resolved = validate_opaque_id(document_id, field="document_id")
    record = workflow_service.get_document(resolved)
    if record is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    return {"ok": True, "document": record, "events": workflow_service.list_events(resolved)}



@app.get("/api/documents/{document_id}/events")
def get_document_events(document_id: str, limit: int = Query(default=100, ge=1, le=500)) -> dict:
    resolved = validate_opaque_id(document_id, field="document_id")
    if workflow_service.get_document(resolved) is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    return {"ok": True, "events": workflow_service.list_events(resolved, limit=limit)}


@app.post("/api/documents/{document_id}/submit")
def submit_document(document_id: str, payload: ApprovalRequest) -> dict:
    """Draft -> Pending Approval. Validates required business fields first."""
    record = workflow_service.submit_for_approval(
        validate_opaque_id(document_id, field="document_id"), actor=payload.actor
    )
    return {"ok": True, "document": _document_summary(record)}


@app.post("/api/documents/{document_id}/approve")
def approve_document(document_id: str, payload: ApprovalRequest) -> dict:
    """Pending Approval -> Approved. The human gate. Records who approved, and when."""
    record = workflow_service.approve_document(
        validate_opaque_id(document_id, field="document_id"), actor=payload.actor
    )
    return {"ok": True, "document": _document_summary(record)}


@app.post("/api/documents/{document_id}/reject")
def reject_document(document_id: str, payload: RejectionRequest) -> dict:
    """Pending Approval -> Rejected. A reason is required and is stored in the audit trail."""
    record = workflow_service.reject_document(
        validate_opaque_id(document_id, field="document_id"),
        actor=payload.actor,
        reason=payload.reason,
    )
    return {"ok": True, "document": _document_summary(record)}


@app.post("/api/documents/{document_id}/send")
def send_document(document_id: str, payload: SendRequest) -> dict:
    """Send an approved document.

    Refuses unless the stored state is Approved (or a retryable Send Failed), re-validates
    the fields, and never sends the same document twice.
    """
    record = workflow_service.send_document(
        validate_opaque_id(document_id, field="document_id"),
        actor=payload.actor,
        force_override=payload.force_override,
    )
    document = record.get("document") or {}
    return {
        "ok": True,
        "duplicate_suppressed": bool(record.get("duplicate_suppressed")),
        "document": _document_summary(document) if document else {},
        "sent_message_id": record.get("sent_message_id", ""),
        "sent_at": record.get("sent_at", ""),
    }


if __name__ == "__main__":
    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
