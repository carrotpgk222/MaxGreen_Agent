from __future__ import annotations

import base64
import re
from datetime import datetime, timezone
from email.utils import parseaddr
from pathlib import Path
from typing import Any

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

BASE_DIR = Path(__file__).resolve().parents[1]
SECRETS_DIR = BASE_DIR / "secrets"
CREDENTIALS_PATH = SECRETS_DIR / "credentials.json"
TOKEN_PATH = SECRETS_DIR / "token.json"

# Read-only first. We will add gmail.send later when the app's sending flow is ready.
SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]


def _load_credentials() -> Credentials | None:
    if not TOKEN_PATH.exists():
        return None
    creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        TOKEN_PATH.write_text(creds.to_json(), encoding="utf-8")
    return creds if creds.valid else None


def is_connected() -> bool:
    try:
        return _load_credentials() is not None
    except Exception:
        return False


def authorize_interactive() -> Credentials:
    SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    if not CREDENTIALS_PATH.exists():
        raise FileNotFoundError(
            f"Missing {CREDENTIALS_PATH}. Download Google's OAuth Desktop app credentials, "
            "rename the file to credentials.json, and place it in backend/secrets/."
        )

    flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS_PATH), SCOPES)
    creds = flow.run_local_server(port=0)
    TOKEN_PATH.write_text(creds.to_json(), encoding="utf-8")
    return creds


def get_service():
    creds = _load_credentials()
    if creds is None:
        raise RuntimeError(
            "Gmail is not connected yet. Run connect_gmail.bat (or python gmail_auth.py) first."
        )
    return build("gmail", "v1", credentials=creds, cache_discovery=False)


def get_profile() -> dict[str, Any]:
    profile = get_service().users().getProfile(userId="me").execute()
    return {
        "email": profile.get("emailAddress", ""),
        "messages_total": profile.get("messagesTotal", 0),
        "threads_total": profile.get("threadsTotal", 0),
    }


def _header(headers: list[dict[str, str]], name: str) -> str:
    for header in headers:
        if header.get("name", "").lower() == name.lower():
            return header.get("value", "")
    return ""


def _decode_b64url(data: str | None) -> str:
    if not data:
        return ""
    padding = "=" * (-len(data) % 4)
    raw = base64.urlsafe_b64decode((data + padding).encode("ascii"))
    return raw.decode("utf-8", errors="replace")


def _strip_html(html: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?>.*?</\\1>", " ", html)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    return re.sub(r"\\s+", " ", text).strip()


def _walk_parts(part: dict[str, Any], attachments: list[dict[str, Any]]) -> tuple[str, str]:
    mime_type = part.get("mimeType", "")
    filename = part.get("filename", "")
    body = part.get("body", {}) or {}

    if filename and body.get("attachmentId"):
        attachments.append(
            {
                "filename": filename,
                "mime_type": mime_type,
                "attachment_id": body.get("attachmentId"),
                "size": body.get("size", 0),
            }
        )

    plain = ""
    html = ""
    data = body.get("data")
    if data:
        decoded = _decode_b64url(data)
        if mime_type == "text/plain":
            plain = decoded
        elif mime_type == "text/html":
            html = decoded

    for child in part.get("parts", []) or []:
        child_plain, child_html = _walk_parts(child, attachments)
        if child_plain:
            plain = f"{plain}\n{child_plain}".strip()
        if child_html:
            html = f"{html}\n{child_html}".strip()

    return plain.strip(), html.strip()


def normalize_message(message: dict[str, Any]) -> dict[str, Any]:
    payload = message.get("payload", {}) or {}
    headers = payload.get("headers", []) or []
    sender_raw = _header(headers, "From")
    sender_name, sender_email = parseaddr(sender_raw)

    attachments: list[dict[str, Any]] = []
    plain, html = _walk_parts(payload, attachments)
    body_text = plain or _strip_html(html) or message.get("snippet", "")

    internal_date = message.get("internalDate")
    received_at = ""
    if internal_date:
        received_at = datetime.fromtimestamp(
            int(internal_date) / 1000, tz=timezone.utc
        ).isoformat()

    return {
        "gmail_message_id": message.get("id", ""),
        "thread_id": message.get("threadId", ""),
        "sender": sender_name or sender_raw,
        "sender_email": sender_email,
        "subject": _header(headers, "Subject") or "(No subject)",
        "received_at": received_at,
        "snippet": message.get("snippet", ""),
        "body_text": body_text,
        "attachments": attachments,
        "label_ids": message.get("labelIds", []) or [],
    }


def fetch_latest_messages(limit: int = 25, query: str = "in:inbox") -> list[dict[str, Any]]:
    service = get_service()
    response = (
        service.users()
        .messages()
        .list(userId="me", maxResults=max(1, min(limit, 100)), q=query)
        .execute()
    )

    messages: list[dict[str, Any]] = []
    for item in response.get("messages", []) or []:
        full = (
            service.users()
            .messages()
            .get(userId="me", id=item["id"], format="full")
            .execute()
        )
        messages.append(normalize_message(full))
    return messages


def fetch_attachment(gmail_message_id: str, attachment_id: str) -> bytes:
    service = get_service()
    payload = (
        service.users()
        .messages()
        .attachments()
        .get(userId="me", messageId=gmail_message_id, id=attachment_id)
        .execute()
    )
    data = payload.get("data", "")
    if not data:
        return b""
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode((data + padding).encode("ascii"))
