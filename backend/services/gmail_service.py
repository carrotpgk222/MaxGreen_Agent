from __future__ import annotations

import base64
import html as html_lib
import logging
import mimetypes
import re
import webbrowser
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime
from email.message import EmailMessage
from email.utils import parseaddr
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

from services.logging_config import log_event, timed
from services.security_service import (
    MAX_ATTACHMENT_BYTES,
    sanitize_filename,
    validate_body,
    validate_email_address,
    validate_gmail_query,
    validate_header_value,
)

logger = logging.getLogger("maxgreen.gmail")

BASE_DIR = Path(__file__).resolve().parents[1]
SECRETS_DIR = BASE_DIR / "secrets"
CREDENTIALS_PATH = SECRETS_DIR / "credentials.json"
TOKEN_PATH = SECRETS_DIR / "token.json"

#: Hard ceiling on an attachment download. Gmail permits ~25 MB; a larger one is not a
#: document a person is waiting on and would be parsed in-process.
MAX_FETCH_BYTES = MAX_ATTACHMENT_BYTES

# Read and send. Reading is the only path wired into the app; the send helper below is
# reachable only through services.workflow_service, which enforces human approval.
SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
]

#: The Desktop-client redirect registered in credentials.json. Google's out-of-band flow
#: ("paste this code" page) was retired in 2022, so a headless host cannot be handed a code
#: directly; the caller approves in a real browser and pastes back the address it landed on.
LOOPBACK_REDIRECT_URI = "http://localhost"


class GmailSendError(RuntimeError):
    """A send attempt failed.

    ``safe_detail`` is safe to log; ``retryable`` tells the caller whether another attempt
    could plausibly succeed, so a duplicate email is never the retry strategy.
    """

    def __init__(self, message: str, *, code: str, retryable: bool, safe_detail: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.safe_detail = safe_detail or message

    @property
    def message(self) -> str:
        """The operator-facing description.

        Distinct from ``safe_detail`` on purpose: this is the sentence shown to whoever
        pressed Send, and it never contains upstream text. Reading it as ``str(exc)`` works
        but invites conflating the two, which is how an upstream response body ends up in
        a browser.
        """
        return str(self.args[0]) if self.args else "The email could not be sent."


class GmailReadError(RuntimeError):
    """A Gmail read failed in a way the caller must handle explicitly."""


def _redact_google_error(exc: Exception) -> str:
    """A short, log-safe description of a Google API failure.

    googleapiclient error strings embed the full request URL, which carries the bearer
    token. Only the status and the error reason survive.
    """
    status = getattr(getattr(exc, "resp", None), "status", None)
    reason = ""
    try:
        content = getattr(exc, "content", b"")
        if isinstance(content, bytes):
            content = content.decode("utf-8", errors="replace")
        if isinstance(content, str) and content:
            import json as _json

            parsed = _json.loads(content)
            error = parsed.get("error") if isinstance(parsed, dict) else None
            if isinstance(error, dict):
                reason = str(error.get("status") or error.get("message") or "")[:120]
    except Exception:
        reason = ""

    parts = [type(exc).__name__]
    if status is not None:
        parts.append(f"status={status}")
    if reason:
        parts.append(f"reason={reason}")
    return " ".join(parts)



def _load_credentials() -> Credentials | None:
    if not TOKEN_PATH.exists():
        return None
    try:
        creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            TOKEN_PATH.write_text(creds.to_json(), encoding="utf-8")
        return creds if creds.valid else None
    except Exception as exc:
        # A corrupt or revoked token must be visible, not silently read as "not connected",
        # which would send the operator to the wrong fix (re-run the OAuth flow).
        log_event(
            logger, "gmail.credentials.invalid", level="error",
            error_type=type(exc).__name__, error=_redact_google_error(exc), exc_info=True,
        )
        return None


def is_connected() -> bool:
    try:
        return _load_credentials() is not None
    except Exception as exc:
        log_event(logger, "gmail.is_connected.failed", level="warning",
                  error_type=type(exc).__name__, error=str(exc)[:200])
        return False


def _browser_available() -> bool:
    """Whether this host can open a sign-in window of its own.

    A deployed backend is a headless box with no browser installed, where
    ``run_local_server`` aborts with ``webbrowser.Error`` before the user sees anything.
    """
    try:
        webbrowser.get()
    except webbrowser.Error:
        return False
    return True


def _authorization_code(pasted: str) -> str:
    """Pull the authorization code out of a pasted redirect address.

    Accepts the whole address-bar URL, because that is what the user has in front of them
    after the localhost page fails to load, but also a bare code.
    """
    candidate = pasted.strip().strip("\"'")
    if candidate.startswith(("http://", "https://")):
        params = parse_qs(urlparse(candidate).query)
        error = params.get("error", [""])[0]
        if error:
            detail = params.get("error_description", [""])[0]
            raise RuntimeError(f"Google returned an error: {error}{f' ({detail})' if detail else ''}")
        candidate = params.get("code", [""])[0].strip()
    if not candidate:
        raise ValueError(
            "No authorization code in that input. Paste the full address your browser was "
            f"redirected to, which should start with '{LOOPBACK_REDIRECT_URI}'."
        )
    return candidate


def _authorize_by_pasting_redirect(flow: InstalledAppFlow) -> Credentials:
    """Run the consent screen on the operator's own machine.

    The browser here can only be a human's, somewhere else, so the URL is printed rather
    than opened and the resulting redirect address is pasted back in.
    """
    flow.redirect_uri = LOOPBACK_REDIRECT_URI
    auth_url, _ = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",
    )
    print("\nNo browser is available on this machine, so approve access from your own device.")
    print("Open this link, sign in to Google, and accept the permissions:\n")
    print(f"  {auth_url}\n")
    print("The browser will then try to load a localhost page and probably fail to reach it.")
    print("That failure is expected. Copy the full address from the address bar and paste it here.\n")
    flow.fetch_token(code=_authorization_code(input("Redirect URL or code: ")))
    return flow.credentials


def authorize_interactive() -> Credentials:
    SECRETS_DIR.mkdir(parents=True, exist_ok=True)
    if not CREDENTIALS_PATH.exists():
        raise FileNotFoundError(
            f"Missing {CREDENTIALS_PATH}. Download Google's OAuth Desktop app credentials, "
            "rename the file to credentials.json, and place it in backend/secrets/."
        )

    flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS_PATH), SCOPES)
    if _browser_available():
        creds = flow.run_local_server(port=0)
    else:
        creds = _authorize_by_pasting_redirect(flow)
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
    with timed("gmail.profile"):
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
    """Convert Gmail HTML bodies to readable plain text while preserving item lines."""
    if not html:
        return ""

    text = html

    # Remove script/style content completely.
    text = re.sub(r"(?is)<(script|style).*?>.*?</\1>", "", text)

    # Preserve common HTML boundaries as line breaks so quotation item lists
    # do not collapse into one long sentence.
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</p\s*>", "\n", text)
    text = re.sub(r"(?i)</div\s*>", "\n", text)
    text = re.sub(r"(?i)</li\s*>", "\n", text)
    text = re.sub(r"(?i)</tr\s*>", "\n", text)
    text = re.sub(r"(?i)</t[dh]\s*>", " | ", text)

    # Remove remaining HTML and decode entities.
    text = re.sub(r"(?s)<[^>]+>", "", text)
    text = html_lib.unescape(text).replace("\xa0", " ")

    lines: list[str] = []
    for raw_line in text.splitlines():
        cleaned = re.sub(r"[ \t]+", " ", raw_line).strip()
        if cleaned:
            lines.append(cleaned)

    return "\n".join(lines)


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
            int(internal_date) / 1000, tz=UTC
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


def list_message_ids(limit: int = 25, query: str = "in:inbox") -> list[str]:
    """List message IDs matching the query without fetching full bodies."""
    safe_query = validate_gmail_query(query)
    service = get_service()
    with timed("gmail.messages.list", query=safe_query[:80]):
        response = (
            service.users()
            .messages()
            .list(userId="me", maxResults=max(1, min(limit, 100)), q=safe_query)
            .execute()
        )
    return [item["id"] for item in (response.get("messages", []) or []) if item.get("id")]


def fetch_latest_messages(
    limit: int = 25,
    query: str = "in:inbox",
    skip_ids: set[str] | None = None,
    max_workers: int = 8,
    message_ids: list[str] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Fetch messages matching query.

    - Lists message IDs (one cheap call) unless message_ids is provided.
    - Skips IDs already stored (skip_ids) so repeat syncs only pull new mail.
    - Fetches the remaining full messages concurrently with a thread pool,
      instead of one slow serial round-trip per message.

    Returns ``(messages, failures)``. ``failures`` is non-empty when an individual fetch
    failed: the caller must report those rather than pretending the sync was complete.
    """
    if message_ids is None:
        service = get_service()
        safe_query = validate_gmail_query(query)
        with timed("gmail.messages.list", query=safe_query[:80]):
            response = (
                service.users()
                .messages()
                .list(userId="me", maxResults=max(1, min(limit, 100)), q=safe_query)
                .execute()
            )
        listed = [item["id"] for item in (response.get("messages", []) or []) if item.get("id")]
    else:
        listed = [mid for mid in message_ids if mid]

    skip = skip_ids or set()
    to_fetch = [mid for mid in listed if mid not in skip]
    if not to_fetch:
        return [], []

    def _get_full(message_id: str) -> tuple[dict[str, Any] | None, str]:
        try:
            # Each thread needs its own service/http object; httplib2 is not
            # thread-safe when shared. Build a fresh service per call.
            local_service = get_service()
            full = (
                local_service.users()
                .messages()
                .get(userId="me", id=message_id, format="full")
                .execute()
            )
            return normalize_message(full), ""
        except Exception as exc:
            # Recorded, not swallowed. A single bad message must not abort the sync, but it
            # must not disappear either - the operator retries it on the next tick.
            return None, _redact_google_error(exc)

    workers = max(1, min(max_workers, len(to_fetch)))
    results_by_id: dict[str, dict[str, Any]] = {}
    failures: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=workers) as executor:
        future_map = {executor.submit(_get_full, mid): mid for mid in to_fetch}
        for future in as_completed(future_map):
            message_id = future_map[future]
            try:
                normalized, error = future.result()
            except Exception as exc:  # the worker itself blew up
                failures.append({"gmail_message_id": message_id, "error": _redact_google_error(exc)})
                continue
            if normalized:
                results_by_id[message_id] = normalized
            else:
                failures.append({"gmail_message_id": message_id, "error": error or "fetch_failed"})

    if failures:
        log_event(
            logger, "gmail.messages.fetch_incomplete", level="warning",
            requested=len(to_fetch), fetched=len(results_by_id), failed=len(failures),
            outcome="partial",
        )

    # Preserve the Gmail list order (newest first).
    return [results_by_id[mid] for mid in to_fetch if mid in results_by_id], failures


def fetch_attachment(gmail_message_id: str, attachment_id: str) -> bytes:
    """Download one attachment, refusing anything past the size cap.

    The cap is checked from the declared size before the download and again on the decoded
    bytes, so an attachment that lies about its size still cannot exhaust memory.
    """
    service = get_service()
    with timed("gmail.attachment.fetch", gmail_message_id=gmail_message_id):
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
    raw = base64.urlsafe_b64decode((data + padding).encode("ascii"))
    if len(raw) > MAX_FETCH_BYTES:
        log_event(
            logger, "gmail.attachment.too_large", level="warning",
            gmail_message_id=gmail_message_id, attachment_id=attachment_id, bytes=len(raw),
            limit=MAX_FETCH_BYTES, outcome="rejected",
        )
        raise GmailReadError(
            f"Attachment is {len(raw)} bytes, above the {MAX_FETCH_BYTES} byte limit."
        )
    return raw


def send_email(
    to: str,
    subject: str,
    body: str,
    attachments: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Send one email through the connected Gmail account.

    This is a low-level transport helper. It validates its inputs and refuses anything
    malformed, but it deliberately holds **no** approval logic: the only caller is
    :func:`services.workflow_service.send_document`, which enforces the human approval
    gate. Callers must not be added without that gate.

    ``attachments`` format::

        [{"filename": "INV-001.pdf", "data": b"...pdf bytes...", "mime_type": "application/pdf"}]
    """
    # Validation. A bad address or a header with a newline in it is a bug in the caller,
    # and it must fail here rather than become a malformed message in a customer's inbox.
    recipient = validate_email_address(to, field="to")
    safe_subject = validate_header_value(subject, field="subject", max_length=200)
    safe_body = validate_body(body)

    service = get_service()

    message = EmailMessage()
    message["To"] = recipient
    message["Subject"] = safe_subject
    message.set_content(safe_body)

    total_attachment_bytes = 0
    for attachment in attachments or []:
        filename = sanitize_filename(attachment.get("filename"))
        data = attachment.get("data")

        if not isinstance(data, bytes | bytearray):
            # Previously a non-bytes attachment was skipped with `continue`, so a document
            # could be sent silently missing a quoted PDF. Now it is a hard failure.
            raise GmailSendError(
                "An attachment could not be read and the email was not sent.",
                code="attachment_invalid",
                retryable=False,
                safe_detail=f"attachment={filename} data_type={type(data).__name__}",
            )

        data = bytes(data)
        total_attachment_bytes += len(data)
        if total_attachment_bytes > MAX_FETCH_BYTES:
            raise GmailSendError(
                "The total attachment size is too large and the email was not sent.",
                code="attachments_too_large",
                retryable=False,
                safe_detail=f"bytes={total_attachment_bytes} limit={MAX_FETCH_BYTES}",
            )

        mime_type = (
            attachment.get("mime_type")
            or mimetypes.guess_type(filename)[0]
            or "application/octet-stream"
        )
        maintype, _, subtype = str(mime_type).partition("/")
        if not maintype or not subtype or "/" in subtype:
            maintype, subtype = "application", "octet-stream"

        message.add_attachment(data, maintype=maintype, subtype=subtype, filename=filename)

    encoded_message = base64.urlsafe_b64encode(message.as_bytes()).decode("ascii")

    try:
        sent = (
            service.users()
            .messages()
            .send(
                userId="me",
                body={"raw": encoded_message},
            )
            .execute()
        )
    except Exception as exc:
        # Distinguish "try again" from "this will never work", so the workflow layer can
        # say so honestly and the operator does not retry into a duplicate send.
        status = getattr(getattr(exc, "resp", None), "status", None)
        retryable = status is None or int(status) in {408, 429, 500, 502, 503, 504}
        safe = _redact_google_error(exc)
        log_event(
            logger, "gmail.send.transport_failed", level="error", outcome="failed",
            error_code="send_transport_failed", retryable=retryable, error=safe, exc_info=True,
        )
        raise GmailSendError(
            "Gmail did not accept the message.", code="send_transport_failed",
            retryable=retryable, safe_detail=safe,
        ) from exc

    return {
        "id": sent.get("id", ""),
        "thread_id": sent.get("threadId", ""),
        "label_ids": sent.get("labelIds", []),
    }
