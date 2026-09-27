"""Shared fixtures.

`backend/` is put on sys.path so tests can import `services.*` and `app` exactly the way
Uvicorn does, and every database test runs against a throwaway SQLite file rather than
`backend/data/maxgreen.db`.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from services import database_service  # noqa: E402


@pytest.fixture
def temp_db(tmp_path, monkeypatch):
    """Point database_service at a fresh SQLite file for the duration of one test."""
    db_path = tmp_path / "test-maxgreen.db"
    monkeypatch.setattr(database_service, "DB_PATH", db_path)
    database_service.init_db()
    return db_path


@pytest.fixture
def sample_message() -> dict:
    return {
        "gmail_message_id": "msg-001",
        "thread_id": "thread-001",
        "sender": "Alice Example",
        "sender_email": "alice@example.com",
        "subject": "Quotation Request - Level 1 Cleaning",
        "received_at": "2026-09-18T09:15:00+00:00",
        "snippet": "Please quote for cleaning.",
        "body_text": "Note to Supplier: Quote Ref: MGQ.26/05/111",
        "attachments": [
            {"filename": "po.pdf", "mime_type": "application/pdf", "attachment_id": "att-1"},
        ],
        "label_ids": ["INBOX", "UNREAD"],
    }
