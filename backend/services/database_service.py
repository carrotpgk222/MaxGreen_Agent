from __future__ import annotations

import json
import logging
import sqlite3
import threading
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from services.logging_config import log_event

BASE_DIR = Path(__file__).resolve().parents[1]
DB_PATH = BASE_DIR / "data" / "maxgreen.db"

logger = logging.getLogger("maxgreen.db")

# Guards concurrent first-call schema setup. Keyed on the resolved DB_PATH (not a bare
# flag) so the test fixture that repoints DB_PATH at a temp file still gets a fresh schema.
_schema_lock = threading.Lock()
_schema_ready: Path | None = None

# Busy timeout (ms) for SQLite's own lock. The background scheduler thread and request
# handlers both write; without this they raise "database is locked" under load.
_BUSY_TIMEOUT_MS = 5000

_BASE_SCHEMA: tuple[str, ...] = (
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
    """,
    # Outbound customer-facing documents and their approval trail. Owned by
    # services.workflow_service; the DDL lives here so all schema stays in one place.
    """
    CREATE TABLE IF NOT EXISTS outbound_documents (
        document_id TEXT PRIMARY KEY,
        gmail_message_id TEXT,
        document_type TEXT NOT NULL,
        document_number TEXT,
        recipient_email TEXT NOT NULL,
        recipient_name TEXT NOT NULL DEFAULT '',
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        state TEXT NOT NULL DEFAULT 'Draft',
        source_category TEXT NOT NULL DEFAULT '',
        source_security_status TEXT NOT NULL DEFAULT '',
        source_confidence REAL,
        needs_human_review INTEGER NOT NULL DEFAULT 1,
        approved_by TEXT NOT NULL DEFAULT '',
        approved_at TEXT,
        rejected_by TEXT NOT NULL DEFAULT '',
        rejected_at TEXT,
        rejection_reason TEXT NOT NULL DEFAULT '',
        send_attempts INTEGER NOT NULL DEFAULT 0,
        sent_at TEXT,
        sent_message_id TEXT NOT NULL DEFAULT '',
        last_error_code TEXT NOT NULL DEFAULT '',
        idempotency_key TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS workflow_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL,
        request_id TEXT NOT NULL DEFAULT '',
        event TEXT NOT NULL,
        from_state TEXT NOT NULL DEFAULT '',
        to_state TEXT NOT NULL DEFAULT '',
        outcome TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT '',
        actor TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
)

_INDEXES: tuple[str, ...] = (
    "CREATE INDEX IF NOT EXISTS idx_gmail_received_at ON gmail_messages(received_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_gmail_thread_id ON gmail_messages(thread_id)",
    # Dashboard counts and the scheduler's unclassified sweep both filter on ai_category.
    "CREATE INDEX IF NOT EXISTS idx_gmail_category ON gmail_messages(ai_category)",
    "CREATE INDEX IF NOT EXISTS idx_documents_state ON outbound_documents(state)",
    "CREATE INDEX IF NOT EXISTS idx_documents_gmail_message ON outbound_documents(gmail_message_id)",
    "CREATE INDEX IF NOT EXISTS idx_workflow_events_document ON workflow_events(document_id, event_id)",
)


class DatabaseError(RuntimeError):
    """A SQLite operation failed.

    Raised instead of letting ``sqlite3.Error`` escape, so the API layer can return a
    clear message while the technical detail stays in the log.
    """


def get_connection() -> sqlite3.Connection:
    """Open a tuned connection. Callers are expected to use it as a context manager."""
    try:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, timeout=_BUSY_TIMEOUT_MS / 1000)
        conn.row_factory = sqlite3.Row
        # busy_timeout first: switching journal mode needs a brief exclusive lock, and we
        # would rather wait for the scheduler's write than fail the request.
        conn.execute(f"PRAGMA busy_timeout={_BUSY_TIMEOUT_MS}")
        # WAL lets the scheduler's reader and a request's writer proceed concurrently.
        # This is a no-op on filesystems that do not support WAL.
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn
    except sqlite3.Error as exc:
        log_event(logger, "db.connection.failed", level="error", error_type=type(exc).__name__,
                  error=str(exc), exc_info=True)
        raise DatabaseError(f"Could not open the local database: {exc}") from exc


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


def _ensure_workflow_columns(conn: sqlite3.Connection) -> None:
    """Additive migration for outbound_documents on databases created before this release."""
    existing = {row["name"] for row in conn.execute("PRAGMA table_info(outbound_documents)").fetchall()}
    if not existing:
        return  # Table was just created with the full column set.
    columns = {
        "idempotency_key": "TEXT",
        "source_security_status": "TEXT NOT NULL DEFAULT ''",
        "source_confidence": "REAL",
        "needs_human_review": "INTEGER NOT NULL DEFAULT 1",
        "send_attempts": "INTEGER NOT NULL DEFAULT 0",
        "sent_message_id": "TEXT NOT NULL DEFAULT ''",
        "last_error_code": "TEXT NOT NULL DEFAULT ''",
        "updated_at": "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
    }
    for name, declaration in columns.items():
        if name not in existing:
            conn.execute(f"ALTER TABLE outbound_documents ADD COLUMN {name} {declaration}")


def init_db() -> None:
    """Create or migrate the schema. Runs the DDL once per database file per process.

    Previously every read and write re-ran two table-wide UPDATEs, which made every
    endpoint pay for a full scan. The work is now idempotent and memoised, so the call
    sites are unchanged for callers but the hot path is not.
    """
    global _schema_ready

    target = Path(DB_PATH)
    if _schema_ready == target:
        return

    with _schema_lock:
        if _schema_ready == target:
            return
        try:
            with get_connection() as conn:
                for statement in _BASE_SCHEMA:
                    conn.execute(statement)
                _ensure_ai_columns(conn)
                _ensure_workflow_columns(conn)
                for statement in _INDEXES:
                    conn.execute(statement)
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
                # One document number per document type. Partial index so drafts without a
                # number (the common case before allocation) are unconstrained.
                conn.execute(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_number_unique
                    ON outbound_documents(document_type, document_number)
                    WHERE document_number IS NOT NULL AND document_number != ''
                    """
                )
                conn.execute(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_idempotency
                    ON outbound_documents(idempotency_key)
                    WHERE idempotency_key IS NOT NULL AND idempotency_key != ''
                    """
                )
        except sqlite3.Error as exc:
            log_event(logger, "db.init_db.failed", level="error", error_type=type(exc).__name__,
                      error=str(exc), exc_info=True)
            raise DatabaseError(f"Could not initialise the local database: {exc}") from exc

        _schema_ready = target
        log_event(logger, "db.schema.ready")


def _run_read(query: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
    """Run a read and translate SQLite failures into DatabaseError."""
    try:
        with get_connection() as conn:
            return conn.execute(query, tuple(params)).fetchall()
    except sqlite3.Error as exc:
        log_event(logger, "db.query.failed", level="error", error_type=type(exc).__name__,
                  error=str(exc), query=query.strip().split("\n", 1)[0][:120], exc_info=True)
        raise DatabaseError(f"Database read failed: {exc}") from exc


def _row_to_item(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    """Decode one gmail_messages row, unpacking the JSON columns.

    Shared by get/list so the three list helpers cannot drift apart.
    """
    item = dict(row)
    item["has_attachments"] = bool(item["has_attachments"])
    item["attachments"] = _load_json(item.pop("attachments_json", "[]"), default=[])
    item["label_ids"] = _load_json(item.pop("label_ids_json", "[]"), default=[])
    item["ai_quotation_references"] = _load_json(item.pop("ai_quotation_refs_json", "[]"), default=[])
    item["ai_quotation_draft"] = _load_json(item.pop("ai_quotation_draft_json", "{}"), default={})
    return item


def _load_json(raw: Any, *, default: Any) -> Any:
    """Parse a stored JSON column, falling back to ``default`` instead of raising.

    A single unreadable row must not take out a whole list endpoint; the value is simply
    reported as absent.
    """
    try:
        parsed = json.loads(raw or "null")
    except (TypeError, ValueError):
        return default
    if parsed is None:
        return default
    return parsed


def upsert_messages(messages: Iterable[dict[str, Any]]) -> int:
    init_db()
    changed = 0
    try:
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
    except sqlite3.Error as exc:
        log_event(logger, "db.upsert.failed", level="error", error_type=type(exc).__name__,
                  error=str(exc), message_count=len(messages), exc_info=True)
        raise DatabaseError(f"Could not store the synced messages: {exc}") from exc
    return changed


def list_messages(limit: int = 25) -> list[dict[str, Any]]:
    init_db()
    rows = _run_read(
        """
        SELECT * FROM gmail_messages
        ORDER BY received_at DESC, synced_at DESC
        LIMIT ?
        """,
        (limit,),
    )
    return [_row_to_item(row) for row in rows]


def get_message(gmail_message_id: str) -> dict[str, Any] | None:
    init_db()
    rows = _run_read("SELECT * FROM gmail_messages WHERE gmail_message_id = ?", (gmail_message_id,))
    if not rows:
        return None
    return _row_to_item(rows[0])


def count_messages() -> int:
    init_db()
    rows = _run_read("SELECT COUNT(*) AS n FROM gmail_messages")
    return int(rows[0]["n"]) if rows else 0


def update_message_classification(gmail_message_id: str, result: dict[str, Any]) -> None:
    init_db()
    try:
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
    except sqlite3.Error as exc:
        log_event(logger, "db.update_classification.failed", level="error",
                  error_type=type(exc).__name__, error=str(exc),
                  gmail_message_id=gmail_message_id, exc_info=True)
        raise DatabaseError(f"Could not save the classification result: {exc}") from exc


def existing_message_ids(candidate_ids: Iterable[str]) -> set[str]:
    """Return the subset of candidate_ids already stored in the database.

    Used to skip re-fetching full message bodies for mail we already have.
    """
    ids = [mid for mid in candidate_ids if mid]
    if not ids:
        return set()
    init_db()
    found: set[str] = set()
    # Chunk to stay well under SQLite's variable limit.
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        placeholders = ",".join("?" for _ in chunk)
        for row in _run_read(
            f"SELECT gmail_message_id FROM gmail_messages WHERE gmail_message_id IN ({placeholders})",
            chunk,
        ):
            found.add(row["gmail_message_id"])
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

    try:
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
    except sqlite3.Error as exc:
        log_event(logger, "db.set_category.failed", level="error", error_type=type(exc).__name__,
                  error=str(exc), gmail_message_id=gmail_message_id, exc_info=True)
        raise DatabaseError(f"Could not update the message category: {exc}") from exc


def list_unclassified_messages(limit: int = 10) -> list[dict[str, Any]]:
    """Unclassified messages, newest first.

    One query rather than N: the previous version called get_message() per id, which
    meant one connection (and one schema check) per row.
    """
    init_db()
    rows = _run_read(
        """
        SELECT * FROM gmail_messages
        WHERE ai_category = 'Unclassified'
        ORDER BY received_at DESC, synced_at DESC
        LIMIT ?
        """,
        (limit,),
    )
    return [_row_to_item(row) for row in rows]


def count_inbox_messages() -> int:
    """Count messages routed to the normal Inbox (everything except Supplier Payable)."""
    init_db()
    rows = _run_read("SELECT COUNT(*) AS n FROM gmail_messages WHERE ai_category != 'Supplier Payable'")
    return int(rows[0]["n"]) if rows else 0


def count_supplier_payable_messages() -> int:
    init_db()
    rows = _run_read("SELECT COUNT(*) AS n FROM gmail_messages WHERE ai_category = 'Supplier Payable'")
    return int(rows[0]["n"]) if rows else 0


def list_supplier_payable_messages(limit: int = 200) -> list[dict[str, Any]]:
    init_db()
    rows = _run_read(
        """
        SELECT * FROM gmail_messages
        WHERE ai_category = 'Supplier Payable'
        ORDER BY received_at ASC, synced_at ASC
        LIMIT ?
        """,
        (limit,),
    )
    return [_row_to_item(row) for row in rows]
