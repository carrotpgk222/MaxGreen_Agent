from __future__ import annotations

from io import BytesIO
from typing import Any

from pypdf import PdfReader

from services.gmail_service import fetch_attachment


MAX_ATTACHMENT_CHARS = 12000
MAX_TOTAL_CHARS = 24000


def _pdf_text(data: bytes) -> str:
    reader = PdfReader(BytesIO(data))
    parts: list[str] = []
    for page in reader.pages:
        text = page.extract_text() or ""
        if text.strip():
            parts.append(text.strip())
        if sum(len(part) for part in parts) >= MAX_ATTACHMENT_CHARS:
            break
    return "\n".join(parts)[:MAX_ATTACHMENT_CHARS]


def _plain_text(data: bytes) -> str:
    return data.decode("utf-8", errors="replace")[:MAX_ATTACHMENT_CHARS]


def extract_attachment_texts(message: dict[str, Any]) -> list[dict[str, str]]:
    """Fetch text from supported Gmail attachments for classification only.

    Unsupported/binary attachments are represented by filename and MIME type without content.
    """
    results: list[dict[str, str]] = []
    total_chars = 0

    for attachment in message.get("attachments", []) or []:
        filename = attachment.get("filename") or "attachment"
        mime_type = (attachment.get("mime_type") or "").lower()
        attachment_id = attachment.get("attachment_id")
        text = ""

        if attachment_id and total_chars < MAX_TOTAL_CHARS:
            try:
                data = fetch_attachment(message["gmail_message_id"], attachment_id)
                if mime_type == "application/pdf" or filename.lower().endswith(".pdf"):
                    text = _pdf_text(data)
                elif mime_type.startswith("text/") or filename.lower().endswith((".txt", ".csv")):
                    text = _plain_text(data)
            except Exception as exc:
                text = f"[Could not extract attachment text: {exc}]"

        remaining = max(MAX_TOTAL_CHARS - total_chars, 0)
        text = text[:remaining]
        total_chars += len(text)

        results.append(
            {
                "filename": filename,
                "mime_type": mime_type or "application/octet-stream",
                "text": text,
            }
        )

    return results
