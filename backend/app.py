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
import uvicorn

BASE_DIR = Path(__file__).resolve().parent

logger = logging.getLogger("maxgreen")

load_dotenv(BASE_DIR.parent / ".env")


# ============================================================
# DATABASE SERVICES
# ============================================================

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
from services.sync_service import sync_gmail
from services.classification_service import classify_message, VALID_CATEGORIES
from services.llm_service import configured_model, is_configured as llm_is_configured, test_connection
from services.scheduler_service import start_scheduler, stop_scheduler

app = FastAPI(
    title="MaxGreen Agent Local Backend",
    version="0.5.0",
    description="Local backend for Gmail, Claude classification, and workflow routing.",
)


# ============================================================
# CORS
# ============================================================
#
# Local development only.
#
# Allows:
#
# http://localhost:3000
# http://127.0.0.1:3000
# localhost Live Server ports
# etc.
#
# ============================================================

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=(
        r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$"
    ),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# STARTUP
# ============================================================

@app.on_event("startup")
async def startup() -> None:
    init_db()
    start_scheduler()


@app.on_event("shutdown")
async def shutdown() -> None:
    await stop_scheduler()


# ============================================================
# ROOT
# ============================================================

@app.get("/")
def root() -> dict:

    return {
        "name": "MaxGreen Agent Local Backend",
        "status": "running",
        "docs": "http://127.0.0.1:8000/docs",
    }


# ============================================================
# HEALTH
# ============================================================

@app.get("/api/health")
def health() -> dict:

    return {
        "ok": True,
        "gmail_connected": is_connected(),
        "stored_messages": count_messages(),
    }


# ============================================================
# GMAIL STATUS
# ============================================================

@app.get("/api/gmail/status")
def gmail_status() -> dict:

    if not is_connected():

        return {
            "connected": False,
            "message": (
                "Run backend/connect_gmail.bat first."
            ),
        }

    try:

        return {
            "connected": True,
            **get_profile(),
        }

    except Exception as exc:
        return {"connected": False, "message": str(exc)}


# ============================================================
# GMAIL SYNC
# ============================================================

@app.post("/api/gmail/sync")
def gmail_sync(
    limit: int = Query(
        default=25,
        ge=1,
        le=100,
    ),
    query: str = Query(
        default="in:inbox",
        min_length=1,
    ),
) -> dict:

    if not is_connected():

        raise HTTPException(
            status_code=401,
            detail=(
                "Gmail is not connected. "
                "Run connect_gmail.bat first."
            ),
        )

    try:

        result = sync_gmail(
            limit=limit,
            query=query,
        )

        return {
            "ok": True,
            "fetched": result["fetched"],
            "stored_messages": count_messages(),
            "query": result["query"],
            "ai": result.get("ai", {}),
        }

    except Exception as exc:

        raise HTTPException(
            status_code=500,
            detail=str(exc),
        ) from exc


# ============================================================
# GMAIL SEND
# ============================================================
#
# NEW:
#
# Sends a real email through the Gmail account connected
# through services/gmail_service.py.
#
# For now this endpoint sends:
#
#   - recipient
#   - subject
#   - plain-text body
#
# PDF attachments can be connected afterwards once the
# generated PDF bytes are available to the backend.
#
# ============================================================

@app.post("/api/gmail/send")
def gmail_send(
    payload: dict = Body(...),
) -> dict:

    # --------------------------------------------------------
    # CHECK GMAIL CONNECTION
    # --------------------------------------------------------

    if not is_connected():

        raise HTTPException(
            status_code=401,
            detail=(
                "Gmail is not connected. "
                "Run connect_gmail.bat first."
            ),
        )


    # --------------------------------------------------------
    # READ REQUEST
    # --------------------------------------------------------

    to = str(
        payload.get("to") or ""
    ).strip()


    subject = str(
        payload.get("subject") or ""
    ).strip()


    body = str(
        payload.get("body") or ""
    )


    # --------------------------------------------------------
    # VALIDATION
    # --------------------------------------------------------

    if not to:

        raise HTTPException(
            status_code=400,
            detail=(
                "Recipient email is required."
            ),
        )


    if not subject:

        raise HTTPException(
            status_code=400,
            detail=(
                "Email subject is required."
            ),
        )


    # --------------------------------------------------------
    # SEND EMAIL
    # --------------------------------------------------------

    try:

        result = send_email(
            to=to,
            subject=subject,
            body=body,
        )


        logger.info(
            "Gmail sent successfully to %s "
            "(message_id=%s)",
            to,
            result.get("id", ""),
        )


        return {
            "ok": True,
            "message": "Email sent successfully.",
            "message_id": result.get(
                "id",
                "",
            ),
            "thread_id": result.get(
                "thread_id",
                "",
            ),
        }


    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/llm/status")
def llm_status() -> dict:

    return {
        "configured": llm_is_configured(),
        "model": configured_model(),
    }


# ============================================================
# LLM TEST
# ============================================================

@app.post("/api/llm/test")
def llm_test() -> dict:

    try:

        return test_connection()

    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


# ============================================================
# CLASSIFY ONE GMAIL MESSAGE
# ============================================================

@app.post(
    "/api/ai/classify/{gmail_message_id}"
)
def classify_gmail_message(
    gmail_message_id: str,
) -> dict:

    message = get_message(
        gmail_message_id
    )


    if message is None:

        raise HTTPException(
            status_code=404,
            detail=(
                "Stored Gmail message not found."
            ),
        )


    try:

        result = classify_message(
            message
        )


        update_message_classification(
            gmail_message_id,
            result,
        )


        return {
            "ok": True,
            "gmail_message_id": (
                gmail_message_id
            ),
            "classification": result,
        }


    except Exception as exc:
        logger.error("AI classification failed for Gmail %s: %s\n%s", gmail_message_id, exc, traceback.format_exc())
        raise HTTPException(status_code=502, detail=f"AI preparation failed: {exc}") from exc


@app.post("/api/ai/classify-unclassified")
def classify_unclassified(limit: int = Query(default=10, ge=1, le=25)) -> dict:
    items = list_unclassified_messages(limit=limit)
    results = []


    for message in items:

        if not message:
            continue


        message_id = (
            message["gmail_message_id"]
        )


        try:

            result = classify_message(
                message
            )


            update_message_classification(
                message_id,
                result,
            )


            results.append(
                {
                    "gmail_message_id": (
                        message_id
                    ),
                    "ok": True,
                    "classification": result,
                }
            )


        except Exception as exc:
            results.append({"gmail_message_id": message_id, "ok": False, "error": str(exc)})
    return {"ok": True, "processed": len(results), "results": results}


# ============================================================
# MANUALLY SET GMAIL MESSAGE CATEGORY
# ============================================================

@app.post(
    "/api/gmail/messages/"
    "{gmail_message_id}/category"
)
def set_gmail_message_category(
    gmail_message_id: str,
    category: str = Body(
        ...,
        embed=True,
    ),
) -> dict:

    """
    Manually override a message's category
    from the Inbox dropdown.
    """

    allowed = (
        VALID_CATEGORIES |
        {"Unclassified"}
    )


    if category not in allowed:

        raise HTTPException(
            status_code=400,
            detail=(
                "Invalid category. "
                f"Allowed: {sorted(allowed)}"
            ),
        )


    updated = set_message_category(
        gmail_message_id,
        category,
    )


    if not updated:

        raise HTTPException(
            status_code=404,
            detail=(
                "Stored Gmail message not found."
            ),
        )


    message = get_message(
        gmail_message_id
    )


    return {
        "ok": True,
        "gmail_message_id": (
            gmail_message_id
        ),
        "message": message,
    }


# ============================================================
# DASHBOARD COUNTS
# ============================================================

@app.get("/api/dashboard/counts")
def dashboard_counts() -> dict:

    return {
        "inbox": (
            count_inbox_messages()
        ),
        "supplier_payable": (
            count_supplier_payable_messages()
        ),
    }


# ============================================================
# SUPPLIER PAYABLE
# ============================================================

@app.get(
    "/api/supplier-payable/messages"
)
def supplier_payable_messages(
    limit: int = Query(
        default=200,
        ge=1,
        le=500,
    ),
) -> dict:

    return {
        "messages": (
            list_supplier_payable_messages(
                limit=limit
            )
        )
    }


# ============================================================
# GMAIL MESSAGES
# ============================================================

@app.get("/api/gmail/messages")
def gmail_messages(
    limit: int = Query(
        default=25,
        ge=1,
        le=100,
    ),
) -> dict:

    return {
        "messages": list_messages(
            limit=limit
        )
    }


# ============================================================
# SINGLE GMAIL MESSAGE
# ============================================================

@app.get(
    "/api/gmail/messages/"
    "{gmail_message_id}"
)
def gmail_message(
    gmail_message_id: str,
) -> dict:

    message = get_message(
        gmail_message_id
    )


    if message is None:

        raise HTTPException(
            status_code=404,
            detail=(
                "Stored Gmail message not found."
            ),
        )


    return {
        "message": message
    }


# ============================================================
# GMAIL ATTACHMENT
# ============================================================

@app.get(
    "/api/gmail/messages/"
    "{gmail_message_id}/"
    "attachments/{attachment_id}"
)
def gmail_attachment(
    gmail_message_id: str,
    attachment_id: str,
    filename: str = Query(
        default="attachment"
    ),
) -> Response:

    message = get_message(
        gmail_message_id
    )


    if message is None:

        raise HTTPException(
            status_code=404,
            detail=(
                "Stored Gmail message not found."
            ),
        )


    attachment_meta = next(
        (
            item

            for item in message.get(
                "attachments",
                []
            )

            if item.get(
                "attachment_id"
            ) == attachment_id
        ),
        None,
    )


    if attachment_meta is None:

        raise HTTPException(
            status_code=404,
            detail=(
                "Attachment not found "
                "for this Gmail message."
            ),
        )


    try:

        data = fetch_attachment(
            gmail_message_id,
            attachment_id,
        )


    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not fetch Gmail attachment: {exc}") from exc

    safe_filename = filename or attachment_meta.get("filename") or "attachment"
    media_type = attachment_meta.get("mime_type") or mimetypes.guess_type(safe_filename)[0] or "application/octet-stream"
    encoded = quote(safe_filename)

    return Response(
        content=data,
        media_type=media_type,
        headers={
            "Content-Disposition": (
                "inline; "
                "filename*=UTF-8''"
                f"{encoded}"
            ),
            "Cache-Control": "no-store",
        },
    )


# ============================================================
# RUN
# ============================================================

if __name__ == "__main__":

    uvicorn.run(
        "app:app",
        host="127.0.0.1",
        port=8000,
        reload=True,
    )