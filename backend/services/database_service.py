from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterable
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parents[1]
DB_PATH = BASE_DIR / "data" / "maxgreen.db"


def get_connection() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn



def _ensure_ai_columns(conn: sqlite3.Connection) -> None:
    existing = {row["name"] for row in conn.execute("PRAGMA table_info(gmail_messages)").fetchall()}
    columns = {
        "ai_category": "TEXT NOT NULL DEFAULT 'Unclassified'",
        "ai_party_type": "TEXT NOT NULL DEFAULT 'Unknown'",
        "ai_security_status": "TEXT NOT NULL DEFAULT 'Pending'",
        "ai_confidence": "REAL",
        "ai_reason": "TEXT",
        "ai_quotation_refs_json": "TEXT NOT NULL DEFAULT '[]'",
        "ai_model": "TEXT",
        "ai_classified_at": "TEXT",
        "ai_supplier_reference": "TEXT",
        "ai_amount": "TEXT",
        "ai_due_date": "TEXT",
        "ai_quotation_draft_json": "TEXT NOT NULL DEFAULT '{}'",
    }
    for name, declaration in columns.items():
        if name not in existing:
            conn.execute(f"ALTER TABLE gmail_messages ADD COLUMN {name} {declaration}")


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
                ai_category TEXT NOT NULL DEFAULT 'Unclassified',
                ai_party_type TEXT NOT NULL DEFAULT 'Unknown',
                ai_security_status TEXT NOT NULL DEFAULT 'Pending',
                ai_confidence REAL,
                ai_reason TEXT,
                ai_quotation_refs_json TEXT NOT NULL DEFAULT '[]',
                ai_model TEXT,
                ai_classified_at TEXT,
                ai_supplier_reference TEXT,
                ai_amount TEXT,
                ai_due_date TEXT,
                ai_quotation_draft_json TEXT NOT NULL DEFAULT '{}',
                synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        _ensure_ai_columns(conn)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_gmail_received_at ON gmail_messages(received_at DESC)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_gmail_thread_id ON gmail_messages(thread_id)"
        )
        # v26 category migration: only four categories are valid for incoming Gmail.
        conn.execute("UPDATE gmail_messages SET ai_category = 'Others' WHERE ai_category = 'Other'")
        conn.execute(
            """
            UPDATE gmail_messages
            SET ai_category = 'Unclassified',
                ai_classified_at = NULL
            WHERE ai_category NOT IN ('Unclassified', 'Quotation', 'Invoice & DO', 'Supplier Payable', 'Others')
            """
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
        item["ai_quotation_references"] = json.loads(item.pop("ai_quotation_refs_json", "[]") or "[]")
        item["ai_quotation_draft"] = json.loads(item.pop("ai_quotation_draft_json", "{}") or "{}")
        result.append(item)
    return result


def get_message(gmail_message_id: str) -> dict[str, Any] | None:
    init_db()
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM gmail_messages WHERE gmail_message_id = ?",
            (gmail_message_id,),
        ).fetchone()

    if row is None:
        return None

    item = dict(row)
    item["has_attachments"] = bool(item["has_attachments"])
    item["attachments"] = json.loads(item.pop("attachments_json") or "[]")
    item["label_ids"] = json.loads(item.pop("label_ids_json") or "[]")
    item["ai_quotation_references"] = json.loads(item.pop("ai_quotation_refs_json", "[]") or "[]")
    item["ai_quotation_draft"] = json.loads(item.pop("ai_quotation_draft_json", "{}") or "{}")
    return item


def count_messages() -> int:
    init_db()
    with get_connection() as conn:
        row = conn.execute("SELECT COUNT(*) AS n FROM gmail_messages").fetchone()
        return int(row["n"])


def update_message_classification(gmail_message_id: str, result: dict[str, Any]) -> None:
    init_db()
    with get_connection() as conn:
        conn.execute(
            """
            UPDATE gmail_messages
            SET ai_category = ?,
                ai_party_type = ?,
                ai_security_status = ?,
                ai_confidence = ?,
                ai_reason = ?,
                ai_quotation_refs_json = ?,
                ai_model = ?,
                ai_supplier_reference = ?,
                ai_amount = ?,
                ai_due_date = ?,
                ai_quotation_draft_json = ?,
                ai_classified_at = CURRENT_TIMESTAMP
            WHERE gmail_message_id = ?
            """,
            (
                result.get("category", "Others"),
                result.get("party_type", "Unknown"),
                result.get("security_status", "Suspicious"),
                result.get("confidence"),
                result.get("reason", ""),
                json.dumps(result.get("quotation_references", []), ensure_ascii=False),
                result.get("model", ""),
                result.get("supplier_reference", ""),
                result.get("amount", ""),
                result.get("due_date", ""),
                json.dumps(result.get("quotation_details", {}), ensure_ascii=False),
                gmail_message_id,
            ),
        )


def existing_message_ids(candidate_ids: Iterable[str]) -> set[str]:
    """Return the subset of candidate_ids already stored in the database.

    Used to skip re-fetching full message bodies for mail we already have.
    """
    ids = [mid for mid in candidate_ids if mid]
    if not ids:
        return set()
    init_db()
    found: set[str] = set()
    with get_connection() as conn:
        # Chunk to stay well under SQLite's variable limit.
        for start in range(0, len(ids), 500):
            chunk = ids[start:start + 500]
            placeholders = ",".join("?" for _ in chunk)
            rows = conn.execute(
                f"SELECT gmail_message_id FROM gmail_messages WHERE gmail_message_id IN ({placeholders})",
                chunk,
            ).fetchall()
            found.update(row["gmail_message_id"] for row in rows)
    return found


def set_message_category(gmail_message_id: str, category: str) -> bool:
    """Manually override the category for a single message.

    Marks the message as manually classified. Party type is inferred from the
    category so routing stays consistent (Supplier Payable -> Supplier).
    Returns False if no row matched the id.
    """
    init_db()
    party_type = "Supplier" if category == "Supplier Payable" else "Customer"
    if category == "Unclassified":
        party_type = "Unknown"

    with get_connection() as conn:
        cursor = conn.execute(
            """
            UPDATE gmail_messages
            SET ai_category = ?,
                ai_party_type = ?,
                ai_reason = 'Manually classified by user',
                ai_model = 'manual',
                ai_classified_at = CASE WHEN ? = 'Unclassified' THEN NULL ELSE CURRENT_TIMESTAMP END
            WHERE gmail_message_id = ?
            """,
            (category, party_type, category, gmail_message_id),
        )
        return cursor.rowcount > 0


def list_unclassified_messages(limit: int = 10) -> list[dict[str, Any]]:
    init_db()
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT gmail_message_id
            FROM gmail_messages
            WHERE ai_category = 'Unclassified'
            ORDER BY received_at DESC, synced_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [get_message(row["gmail_message_id"]) for row in rows if row["gmail_message_id"]]


def count_inbox_messages() -> int:
    """Count messages routed to the normal Inbox (everything except Supplier Payable)."""
    init_db()
    with get_connection() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM gmail_messages WHERE ai_category != 'Supplier Payable'"
        ).fetchone()
        return int(row["n"])


def count_supplier_payable_messages() -> int:
    init_db()
    with get_connection() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM gmail_messages WHERE ai_category = 'Supplier Payable'"
        ).fetchone()
        return int(row["n"])


def list_supplier_payable_messages(limit: int = 200) -> list[dict[str, Any]]:
    init_db()
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT * FROM gmail_messages
            WHERE ai_category = 'Supplier Payable'
            ORDER BY received_at ASC, synced_at ASC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    result = []
    for row in rows:
        item = dict(row)
        item["has_attachments"] = bool(item["has_attachments"])
        item["attachments"] = json.loads(item.pop("attachments_json") or "[]")
        item["label_ids"] = json.loads(item.pop("label_ids_json") or "[]")
        item["ai_quotation_references"] = json.loads(item.pop("ai_quotation_refs_json", "[]") or "[]")
        item["ai_quotation_draft"] = json.loads(item.pop("ai_quotation_draft_json", "{}") or "{}")
        result.append(item)
    return result
