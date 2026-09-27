"""Background Gmail sync scheduler.

Runs sync_gmail on a fixed interval inside the FastAPI process so the local
database is kept fresh regardless of whether any browser tab is open. The
frontend then only reads messages from the database (plus one sync when the
Inbox opens).

Design:
- A single asyncio task loops until cancelled.
- sync_gmail is synchronous and does blocking network I/O, so it runs in a
  thread pool executor to avoid blocking the event loop.
- Each run is best-effort: exceptions are logged and the loop continues.
- Skips work when Gmail is not connected.
"""

from __future__ import annotations

import asyncio
import logging
import os

from services.gmail_service import is_connected
from services.sync_service import sync_gmail

logger = logging.getLogger("maxgreen.scheduler")

_task: asyncio.Task | None = None
_stop_event: asyncio.Event | None = None


def _interval_seconds() -> int:
    try:
        return max(5, int(os.getenv("GMAIL_POLL_INTERVAL_SECONDS", "30")))
    except ValueError:
        return 30


def _sync_limit() -> int:
    try:
        return max(1, min(int(os.getenv("GMAIL_POLL_LIMIT", "10")), 100))
    except ValueError:
        return 10


def _sync_query() -> str:
    return os.getenv("GMAIL_SYNC_QUERY", "in:inbox")


async def _run_once() -> None:
    """Run a single sync in a worker thread; never raise into the loop."""
    if not is_connected():
        logger.debug("Skipping scheduled sync: Gmail not connected.")
        return
    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            None, lambda: sync_gmail(limit=_sync_limit(), query=_sync_query())
        )
        fetched = result.get("fetched", 0)
        if fetched:
            logger.info("Scheduled Gmail sync fetched %s new message(s).", fetched)
    except Exception as exc:  # keep the scheduler alive
        logger.warning("Scheduled Gmail sync failed: %s", exc)


async def _loop() -> None:
    interval = _interval_seconds()
    logger.info("Gmail sync scheduler started (every %ss).", interval)
    assert _stop_event is not None
    # Run one sync shortly after startup, then on the interval.
    try:
        while not _stop_event.is_set():
            await _run_once()
            try:
                await asyncio.wait_for(_stop_event.wait(), timeout=interval)
            except TimeoutError:
                pass  # normal: interval elapsed, run again
    except asyncio.CancelledError:
        pass
    finally:
        logger.info("Gmail sync scheduler stopped.")


def start_scheduler() -> None:
    global _task, _stop_event
    if _task is not None and not _task.done():
        return
    _stop_event = asyncio.Event()
    _task = asyncio.create_task(_loop())


async def stop_scheduler() -> None:
    global _task, _stop_event
    if _stop_event is not None:
        _stop_event.set()
    if _task is not None:
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:
            pass
        _task = None
    _stop_event = None
