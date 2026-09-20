from __future__ import annotations

import os

from services.database_service import upsert_messages
from services.gmail_service import fetch_latest_messages


def sync_gmail(limit: int | None = None, query: str | None = None) -> dict:
    effective_limit = limit or int(os.getenv("GMAIL_SYNC_LIMIT", "25"))
    effective_query = query or os.getenv("GMAIL_SYNC_QUERY", "in:inbox")
    messages = fetch_latest_messages(limit=effective_limit, query=effective_query)
    upsert_messages(messages)
    return {
        "fetched": len(messages),
        "query": effective_query,
        "messages": messages,
    }
