from __future__ import annotations

import os
from typing import Any

from services.classification_service import classify_message
from services.database_service import (
    get_message,
    update_message_classification,
    upsert_messages,
)
from services.gmail_service import fetch_latest_messages
from services.llm_service import is_configured as llm_is_configured


def _auto_classify_synced_messages(messages: list[dict[str, Any]]) -> dict[str, Any]:
    """Classify Gmail records automatically after a sync.

    This is intentionally best-effort: Gmail sync still succeeds if one Claude
    classification fails. The Inbox can retry any remaining Unclassified records
    with the manual recovery button.
    """
    enabled = os.getenv("GMAIL_AUTO_CLASSIFY", "true").strip().lower() not in {"0", "false", "no", "off"}
    if not enabled:
        return {"enabled": False, "processed": 0, "failed": 0, "results": []}

    if not llm_is_configured():
        return {
            "enabled": True,
            "processed": 0,
            "failed": 0,
            "results": [],
            "skipped_reason": "LLM gateway is not configured",
        }

    try:
        max_items = max(1, min(int(os.getenv("GMAIL_AUTO_CLASSIFY_LIMIT", "25")), 100))
    except ValueError:
        max_items = 25

    results: list[dict[str, Any]] = []
    candidates = []
    for raw in messages:
        message_id = raw.get("gmail_message_id")
        if not message_id:
            continue
        stored = get_message(message_id)
        if not stored or stored.get("ai_category") != "Unclassified":
            continue
        candidates.append(stored)
        if len(candidates) >= max_items:
            break

    for message in candidates:
        message_id = message["gmail_message_id"]
        try:
            result = classify_message(message)
            update_message_classification(message_id, result)
            results.append(
                {
                    "gmail_message_id": message_id,
                    "ok": True,
                    "category": result.get("category", "Others"),
                    "security_status": result.get("security_status", "Suspicious"),
                }
            )
        except Exception as exc:  # keep Gmail sync resilient
            results.append(
                {
                    "gmail_message_id": message_id,
                    "ok": False,
                    "error": str(exc),
                }
            )

    failed = sum(1 for item in results if not item.get("ok"))
    return {
        "enabled": True,
        "processed": len(results),
        "failed": failed,
        "results": results,
    }


def sync_gmail(limit: int | None = None, query: str | None = None) -> dict:
    effective_limit = limit or int(os.getenv("GMAIL_SYNC_LIMIT", "25"))
    effective_query = query or os.getenv("GMAIL_SYNC_QUERY", "in:inbox")
    messages = fetch_latest_messages(limit=effective_limit, query=effective_query)
    upsert_messages(messages)
    ai = _auto_classify_synced_messages(messages)
    return {
        "fetched": len(messages),
        "query": effective_query,
        "messages": messages,
        "ai": ai,
    }
