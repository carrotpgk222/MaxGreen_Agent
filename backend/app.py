from __future__ import annotations

from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR.parent / ".env")

from services.database_service import count_messages, init_db, list_messages
from services.gmail_service import get_profile, is_connected
from services.sync_service import sync_gmail

app = FastAPI(
    title="MaxGreen Agent Local Backend",
    version="0.1.0",
    description="Local backend for Gmail integration before AWS/Claude integration.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5500",
        "http://localhost:5500",
        "http://127.0.0.1:5501",
        "http://localhost:5501",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup() -> None:
    init_db()


@app.get("/")
def root() -> dict:
    return {
        "name": "MaxGreen Agent Local Backend",
        "status": "running",
        "docs": "http://127.0.0.1:8000/docs",
    }


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "gmail_connected": is_connected(), "stored_messages": count_messages()}


@app.get("/api/gmail/status")
def gmail_status() -> dict:
    if not is_connected():
        return {
            "connected": False,
            "message": "Run backend/connect_gmail.bat first.",
        }
    try:
        return {"connected": True, **get_profile()}
    except Exception as exc:
        return {"connected": False, "message": str(exc)}


@app.post("/api/gmail/sync")
def gmail_sync(
    limit: int = Query(default=25, ge=1, le=100),
    query: str = Query(default="in:inbox", min_length=1),
) -> dict:
    if not is_connected():
        raise HTTPException(status_code=401, detail="Gmail is not connected. Run connect_gmail.bat first.")
    try:
        result = sync_gmail(limit=limit, query=query)
        return {
            "ok": True,
            "fetched": result["fetched"],
            "stored_messages": count_messages(),
            "query": result["query"],
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/gmail/messages")
def gmail_messages(limit: int = Query(default=25, ge=1, le=100)) -> dict:
    return {"messages": list_messages(limit=limit)}


if __name__ == "__main__":
    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=True)
