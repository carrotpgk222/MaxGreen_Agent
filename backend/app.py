from __future__ import annotations

import logging
import mimetypes
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote

import uvicorn
from dotenv import load_dotenv
from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

BASE_DIR = Path(__file__).resolve().parent
logger = logging.getLogger("maxgreen")
load_dotenv(BASE_DIR.parent / ".env")

from services.classification_service import VALID_CATEGORIES, classify_message
from services.database_service import (
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
from services.gmail_service import fetch_attachment, get_profile, is_connected
from services.llm_service import configured_model, test_connection
from services.llm_service import is_configured as llm_is_configured
from services.scheduler_service import start_scheduler, stop_scheduler
from services.sync_service import sync_gmail


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Order matters: the schema and its additive migrations must exist before the
    background scheduler starts writing to the database."""
    init_db()
    start_scheduler()
    try:
        yield
    finally:
        await stop_scheduler()


app = FastAPI(
    title="MaxGreen Agent Local Backend",
    version="0.5.0",
    description="Local backend for Gmail, Claude classification, and workflow routing.",
    lifespan=lifespan,
)

# Local development only: allow any localhost/127.0.0.1 port, including Live Server on :3000.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _upstream_failure(message: str, exc: Exception, status_code: int = 502) -> HTTPException:
    """Log the real upstream error and return a message that is safe to send to the browser.

    Upstream exceptions can carry the LLM gateway's response body, model output, Google API
    tokens and request URLs, so their text must never be echoed in an HTTP response.
    """
    logger.error("%s: %s", message, exc, exc_info=True)
    return HTTPException(status_code=status_code, detail=message)


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


@app.post("/api/gmail/sync")
def gmail_sync(
    limit: int = Query(default=25, ge=1, le=100),
    query: str = Query(default="in:inbox", min_length=1),
) -> dict:
    if not is_connected():
        raise HTTPException(status_code=401, detail="Gmail is not connected. Run connect_gmail.bat first.")
    try:
        result = sync_gmail(limit=limit, query=query)
        return {
            "ok": True,
            "fetched": result["fetched"],
            "stored_messages": count_messages(),
            "query": result["query"],
            "ai": result.get("ai", {}),
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
    message = get_message(gmail_message_id)
    if message is None:
        raise HTTPException(status_code=404, detail="Stored Gmail message not found.")
    try:
        result = classify_message(message)
        update_message_classification(gmail_message_id, result)
        return {"ok": True, "gmail_message_id": gmail_message_id, "classification": result}
    except Exception as exc:
        raise _upstream_failure(
            f"AI preparation failed for Gmail {gmail_message_id}. Check the backend logs for details.",
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
            result = classify_message(message)
            update_message_classification(message_id, result)
            results.append({"gmail_message_id": message_id, "ok": True, "classification": result})
        except Exception as exc:
            logger.error("AI classification failed for Gmail %s: %s", message_id, exc, exc_info=True)
            results.append(
                {
                    "gmail_message_id": message_id,
                    "ok": False,
                    "error": "Classification failed. See the backend logs for details.",
                }
            )
    return {"ok": True, "processed": len(results), "results": results}


@app.post("/api/gmail/messages/{gmail_message_id}/category")
def set_gmail_message_category(
    gmail_message_id: str,
    category: str = Body(..., embed=True),
) -> dict:
    """Manually override a message's category from the Inbox dropdown."""
    allowed = VALID_CATEGORIES | {"Unclassified"}
    if category not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid category. Allowed: {sorted(allowed)}",
        )

    updated = set_message_category(gmail_message_id, category)
    if not updated:
        raise HTTPException(status_code=404, detail="Stored Gmail message not found.")

    message = get_message(gmail_message_id)
    return {"ok": True, "gmail_message_id": gmail_message_id, "message": message}




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
    message = get_message(gmail_message_id)
    if message is None:
        raise HTTPException(status_code=404, detail="Stored Gmail message not found.")
    return {"message": message}


@app.get("/api/gmail/messages/{gmail_message_id}/attachments/{attachment_id}")
def gmail_attachment(
    gmail_message_id: str,
    attachment_id: str,
    filename: str = Query(default="attachment"),
) -> Response:
    message = get_message(gmail_message_id)
    if message is None:
        raise HTTPException(status_code=404, detail="Stored Gmail message not found.")

    attachment_meta = next(
        (
            item
            for item in message.get("attachments", [])
            if item.get("attachment_id") == attachment_id
        ),
        None,
    )
    if attachment_meta is None:
        raise HTTPException(status_code=404, detail="Attachment not found for this Gmail message.")

    try:
        data = fetch_attachment(gmail_message_id, attachment_id)
    except Exception as exc:
        raise _upstream_failure(
            "Could not fetch the Gmail attachment. Check the backend logs for details.",
            exc,
            status_code=500,
        ) from exc

    safe_filename = filename or attachment_meta.get("filename") or "attachment"
    media_type = (
        attachment_meta.get("mime_type")
        or mimetypes.guess_type(safe_filename)[0]
        or "application/octet-stream"
    )
    encoded = quote(safe_filename)

    return Response(
        content=data,
        media_type=media_type,
        headers={
            "Content-Disposition": f"inline; filename*=UTF-8''{encoded}",
            "Cache-Control": "no-store",
        },
    )


if __name__ == "__main__":
    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
