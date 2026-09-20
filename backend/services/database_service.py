from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Iterable

BASE_DIR = Path(__file__).resolve().parents[1]
DB_PATH = BASE_DIR / "data" / "maxgreen.db"


def get_connection() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with get_connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS gmail_messages (
                gmail_message_id TEXT PRIMARY KEY,
                thread_id TEXT,
                sender TEXT,
                sender_email TEXT,
                subject TEXT,
                received_at TEXT,
                snippet TEXT,
                body_text TEXT,
                has_attachments INTEGER NOT NULL DEFAULT 0,
                attachments_json TEXT NOT NULL DEFAULT '[]',
                label_ids_json TEXT NOT NULL DEFAULT '[]',
                synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_gmail_received_at ON gmail_messages(received_at DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_gmail_thread_id ON gmail_messages(thread_id)"
        )


def upsert_messages(messages: Iterable[dict[str, Any]]) -> int:
    init_db()
    changed = 0
    with get_connection() as conn:
        for msg in messages:
            cursor = conn.execute(
                """
                INSERT INTO gmail_messages (
                    gmail_message_id, thread_id, sender, sender_email, subject,
                    received_at, snippet, body_text, has_attachments,
                    attachments_json, label_ids_json, synced_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(gmail_message_id) DO UPDATE SET
                    thread_id=excluded.thread_id,
                    sender=excluded.sender,
                    sender_email=excluded.sender_email,
                    subject=excluded.subject,
                    received_at=excluded.received_at,
                    snippet=excluded.snippet,
                    body_text=excluded.body_text,
                    has_attachments=excluded.has_attachments,
                    attachments_json=excluded.attachments_json,
                    label_ids_json=excluded.label_ids_json,
                    synced_at=CURRENT_TIMESTAMP
                """,
                (
                    msg.get("gmail_message_id"),
                    msg.get("thread_id"),
                    msg.get("sender"),
                    msg.get("sender_email"),
                    msg.get("subject"),
                    msg.get("received_at"),
                    msg.get("snippet"),
                    msg.get("body_text"),
                    1 if msg.get("attachments") else 0,
                    json.dumps(msg.get("attachments", []), ensure_ascii=False),
                    json.dumps(msg.get("label_ids", []), ensure_ascii=False),
                ),
            )
            changed += max(cursor.rowcount, 0)
    return changed


def list_messages(limit: int = 25) -> list[dict[str, Any]]:
    init_db()
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT * FROM gmail_messages
            ORDER BY received_at DESC, synced_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    result: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        item["has_attachments"] = bool(item["has_attachments"])
        item["attachments"] = json.loads(item.pop("attachments_json") or "[]")
        item["label_ids"] = json.loads(item.pop("label_ids_json") or "[]")
        result.append(item)
    return result


def count_messages() -> int:
    init_db()
    with get_connection() as conn:
        row = conn.execute("SELECT COUNT(*) AS n FROM gmail_messages").fetchone()
        return int(row["n"])
