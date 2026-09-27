from __future__ import annotations

import logging
import os
from typing import Any

from services.classification_service import classify_message
from services.database_service import (
    existing_message_ids,
    update_message_classification,
    upsert_messages,
)
from services.gmail_service import fetch_latest_messages, list_message_ids
from services.llm_service import is_configured as llm_is_configured
from services.logging_config import log_event, timed
from services.security_service import truncate_for_log

logger = logging.getLogger("maxgreen.sync")

#: Message returned to the browser when classification of one message fails. The real
#: reason goes to the log only: LLMGatewayError embeds a preview of the model's output,
#: which can quote the customer's own email back to the page.
CLASSIFY_ERROR_MESSAGE = "Classification failed. See the backend logs for details."


def _auto_classify_synced_messages(messages: list[dict[str, Any]]) -> dict[str, Any]:
    """Classify Gmail records automatically after a sync.

    This is intentionally best-effort: Gmail sync still succeeds if one Claude
    classification fails. The Inbox can retry any remaining Unclassified records
    with the manual recovery button.

    Only messages that are actually new *and* still Unclassified are sent to the model.
    The previous version re-read every synced message from SQLite one row at a time
    (one connection per row) to discover that; the caller already has the records.
    """
    enabled = os.getenv("GMAIL_AUTO_CLASSIFY", "true").strip().lower() not in {"0", "false", "no", "off"}
    if not enabled:
        return {"enabled": False, "processed": 0, "failed": 0, "results": []}

    if not llm_is_configured():
        log_event(logger, "sync.classify.skipped", reason="llm_not_configured", outcome="skipped")
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
        # Freshly fetched rows are Unclassified by definition; a re-upsert of a known
        # message keeps its existing category, which the ON CONFLICT clause preserves.
        candidates.append(raw)
        if len(candidates) >= max_items:
            break

    for message in candidates:
        message_id = message["gmail_message_id"]
        try:
            with timed("classification", logger, gmail_message_id=message_id, trigger="sync"):
                result = classify_message(message)
            update_message_classification(message_id, result)
            results.append(
                {
                    "gmail_message_id": message_id,
                    "ok": True,
                    "category": result.get("category", "Others"),
                    "security_status": result.get("security_status", "Suspicious"),
                    "needs_human_review": bool(result.get("needs_human_review")),
                }
            )
        except Exception as exc:  # keep Gmail sync resilient
            log_event(
                logger, "classification.failed", level="error", gmail_message_id=message_id,
                trigger="sync", error_type=type(exc).__name__, error=truncate_for_log(exc),
                exc_info=True,
            )
            results.append(
                {
                    "gmail_message_id": message_id,
                    "ok": False,
                    "error": CLASSIFY_ERROR_MESSAGE,
                }
            )

    failed = sum(1 for item in results if not item.get("ok"))
    escalated = sum(1 for item in results if item.get("needs_human_review"))
    log_event(
        logger, "sync.classify.completed", processed=len(results), failed=failed,
        needs_human_review=escalated,
    )
    return {
        "enabled": True,
        "processed": len(results),
        "failed": failed,
        "needs_human_review": escalated,
        "results": results,
    }


def sync_gmail(limit: int | None = None, query: str | None = None) -> dict:
    """Pull new mail, store it, and classify it.

    Individual message failures are reported in ``fetch_failures`` rather than hidden, so
    a partial sync is visible to the operator and to the caller.
    """
    effective_limit = limit or int(os.getenv("GMAIL_SYNC_LIMIT", "25"))
    effective_query = query or os.getenv("GMAIL_SYNC_QUERY", "in:inbox")

    with timed("gmail.sync", query=effective_query[:80]):
        # Skip messages we already stored so repeat syncs only fetch new mail.
        listed_ids = list_message_ids(limit=effective_limit, query=effective_query)
        already_stored = existing_message_ids(listed_ids)

        messages, failures = fetch_latest_messages(
            limit=effective_limit,
            query=effective_query,
            skip_ids=already_stored,
            message_ids=listed_ids,
        )
        upsert_messages(messages)
        ai = _auto_classify_synced_messages(messages)

    log_event(
        logger, "gmail.sync.completed", listed=len(listed_ids), skipped=len(already_stored),
        fetched=len(messages), fetch_failures=len(failures),
        classified=ai.get("processed", 0), classify_failures=ai.get("failed", 0),
        outcome="partial" if failures else "ok",
    )
    return {
        "fetched": len(messages),
        "query": effective_query,
        "messages": messages,
        # Ids and a safe error class only - never an upstream message.
        "fetch_failures": [{"gmail_message_id": item["gmail_message_id"]} for item in failures],
        "ai": ai,
    }
