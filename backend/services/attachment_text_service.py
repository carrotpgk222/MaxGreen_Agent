"""Attachment text extraction for classification and document pre-fill.

Every attachment in this module is untrusted input fetched over the network and parsed by
a third-party library. Three things follow from that:

* **Bounded.** Downloads, page counts, per-file characters and total characters all have
  hard caps, so a hostile or merely enormous file cannot exhaust memory or CPU.
* **Never silent.** Each attachment comes back with a ``status`` describing what happened.
  Previously a corrupt PDF, an unsupported type and a genuinely empty file were all
  indistinguishable from "no attachment", so a missing scope of work looked like a
  classified email with an empty scope.
* **Never leaky.** A parse failure used to be written into the prompt as
  ``[Could not extract attachment text: <exception>]``, which fed Google API URLs and
  token fragments to the model provider. Failures now produce a fixed, non-revealing
  status string; the technical detail goes to the log.
"""

from __future__ import annotations

import logging
from io import BytesIO
from typing import Any

from pypdf import PdfReader
from pypdf.errors import PdfReadError

from services.gmail_service import GmailReadError, fetch_attachment
from services.logging_config import log_event, timed
from services.security_service import (
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENTS_PER_MESSAGE,
    MAX_PDF_PAGES,
    sanitize_filename,
)

logger = logging.getLogger("maxgreen.attachments")

MAX_ATTACHMENT_CHARS = 12000
MAX_TOTAL_CHARS = 24000

# Per-attachment outcomes. These strings are shown to reviewers and sent to the model, so
# they are deliberately vague about internals.
STATUS_OK = "ok"
STATUS_UNSUPPORTED = "unsupported_type"
STATUS_EMPTY = "empty"
STATUS_UNREADABLE = "unreadable"
STATUS_TOO_LARGE = "too_large"
STATUS_FETCH_FAILED = "fetch_failed"
STATUS_SKIPPED = "skipped"

#: Statuses that mean "we have no text for this file". A reviewer must be told which.
NO_TEXT_STATUSES = frozenset(
    {STATUS_UNSUPPORTED, STATUS_EMPTY, STATUS_UNREADABLE, STATUS_TOO_LARGE, STATUS_FETCH_FAILED}
)

_PDF_EXTENSIONS = (".pdf",)
_TEXT_EXTENSIONS = (".txt", ".csv", ".md", ".log")


def read_attachment_bytes(gmail_message_id: str, attachment_id: str) -> bytes:
    """Download one attachment's bytes, refusing anything over the size cap.

    Shared with the send path so a document's attachment is bounded by the same limit that
    protects classification.
    """
    if len(gmail_message_id) > 128 or len(attachment_id) > 128:
        raise GmailReadError("Attachment identifiers are not valid.")
    data = fetch_attachment(gmail_message_id, attachment_id)
    if len(data) > MAX_ATTACHMENT_BYTES:
        log_event(
            logger, "attachment.too_large", level="warning", gmail_message_id=gmail_message_id,
            bytes=len(data), limit=MAX_ATTACHMENT_BYTES, outcome="rejected",
        )
        raise GmailReadError(
            f"Attachment is {len(data)} bytes, above the {MAX_ATTACHMENT_BYTES} byte limit."
        )
    return data


def _is_pdf(mime_type: str, filename: str) -> bool:
    return mime_type == "application/pdf" or filename.lower().endswith(_PDF_EXTENSIONS)


def _is_plain_text(mime_type: str, filename: str) -> bool:
    return mime_type.startswith("text/") or filename.lower().endswith(_TEXT_EXTENSIONS)


def _pdf_text(data: bytes) -> tuple[str, str]:
    """Return ``(text, status)`` for a PDF, honouring the page and character caps."""
    try:
        reader = PdfReader(BytesIO(data))
        # A malformed page tree can make len(reader.pages) raise; treat that as unreadable
        # rather than letting it escape as an unrelated error.
        page_count = len(reader.pages)
        if page_count == 0:
            return "", STATUS_EMPTY

        parts: list[str] = []
        budget = MAX_ATTACHMENT_CHARS
        for page in reader.pages[:MAX_PDF_PAGES]:
            try:
                text = page.extract_text() or ""
            except Exception as exc:
                # One unreadable page (a corrupt image-only page) must not lose the rest.
                log_event(
                    logger, "attachment.page_failed", level="debug",
                    error_type=type(exc).__name__, page_count=page_count,
                )
                continue
            if text.strip():
                parts.append(text.strip())
                budget -= len(text)
                if budget <= 0:
                    break
    except (PdfReadError, ValueError, OSError, MemoryError, RecursionError) as exc:
        log_event(
            logger, "attachment.pdf_unreadable", level="warning",
            error_type=type(exc).__name__, error=str(exc)[:200], outcome=STATUS_UNREADABLE,
        )
        return "", STATUS_UNREADABLE

    text = "\n".join(parts)[:MAX_ATTACHMENT_CHARS]
    if not text.strip():
        # Parsed fine but produced nothing: a scanned image, not a broken file.
        return "", STATUS_EMPTY
    return text, STATUS_OK


def _plain_text(data: bytes) -> tuple[str, str]:
    text = data.decode("utf-8", errors="replace")[:MAX_ATTACHMENT_CHARS]
    if not text.strip():
        return "", STATUS_EMPTY
    return text, STATUS_OK


def extract_attachment_texts(message: dict[str, Any]) -> list[dict[str, str]]:
    """Fetch text from supported Gmail attachments for classification only.

    Unsupported and binary attachments are represented by filename, MIME type and a
    ``status``, without content. One attachment's failure never removes the others.

    Each result is ``{filename, mime_type, text, status, note}`` where ``note`` is a
    human-readable, non-revealing explanation shown to the reviewer when ``text`` is empty.
    """
    results: list[dict[str, str]] = []
    total_chars = 0
    attachments = list(message.get("attachments") or [])

    if len(attachments) > MAX_ATTACHMENTS_PER_MESSAGE:
        log_event(
            logger, "attachment.count_capped", level="info",
            provided=len(attachments), cap=MAX_ATTACHMENTS_PER_MESSAGE,
        )

    for index, attachment in enumerate(attachments[:MAX_ATTACHMENTS_PER_MESSAGE]):
        raw_name = attachment.get("filename") or "attachment"
        filename = sanitize_filename(raw_name)
        mime_type = str(attachment.get("mime_type") or "").lower()
        attachment_id = str(attachment.get("attachment_id") or "")
        text = ""
        status = STATUS_OK
        note = ""

        if not attachment_id:
            status = STATUS_SKIPPED
            note = "This attachment has no download reference and was not read."
        elif not _is_pdf(mime_type, filename) and not _is_plain_text(mime_type, filename):
            status = STATUS_UNSUPPORTED
            note = "This file type is not read for AI preparation; open it to review the content."
        elif total_chars >= MAX_TOTAL_CHARS:
            status = STATUS_SKIPPED
            note = "Skipped: the AI text budget for this email was already used."
        else:
            try:
                with timed(
                    "attachment.fetch", logger,
                    gmail_message_id=message.get("gmail_message_id"), mime_type=mime_type,
                ):
                    data = read_attachment_bytes(str(message.get("gmail_message_id") or ""), attachment_id)

                if not data:
                    status = STATUS_EMPTY
                    note = "This attachment is empty."
                elif len(data) > MAX_ATTACHMENT_BYTES:
                    status = STATUS_TOO_LARGE
                    note = "This attachment is too large to read automatically."
                elif _is_pdf(mime_type, filename):
                    text, status = _pdf_text(data)
                    note = "" if status == STATUS_OK else "This PDF could not be read; it may be scanned or damaged."
                else:
                    text, status = _plain_text(data)
                    note = "" if status == STATUS_OK else "This text file is empty."
            except GmailReadError as exc:
                # Fixed status, no upstream text. The detail is already logged inside.
                status = STATUS_FETCH_FAILED
                note = "This attachment could not be downloaded from Gmail."
                log_event(
                    logger, "attachment.fetch_failed", level="warning",
                    gmail_message_id=message.get("gmail_message_id"),
                    error_type=type(exc).__name__, error=str(exc)[:200],
                )
            except Exception as exc:
                status = STATUS_UNREADABLE
                note = "This attachment could not be read."
                log_event(
                    logger, "attachment.unreadable", level="warning",
                    gmail_message_id=message.get("gmail_message_id"), mime_type=mime_type,
                    error_type=type(exc).__name__, error=str(exc)[:200],
                )

        remaining = max(MAX_TOTAL_CHARS - total_chars, 0)
        text = text[:remaining]
        total_chars += len(text)

        results.append(
            {
                "filename": filename,
                "mime_type": mime_type or "application/octet-stream",
                "text": text,
                "status": status,
                "note": note,
                "index": str(index),
            }
        )

    statuses = [item["status"] for item in results]
    log_event(
        logger, "attachment.extraction.completed", gmail_message_id=message.get("gmail_message_id"),
        attachment_count=len(results), chars=total_chars,
        ok=statuses.count(STATUS_OK),
        without_text=sum(1 for item in results if item["status"] in NO_TEXT_STATUSES),
    )
    return results
