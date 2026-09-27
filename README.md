# MaxGreen Agent

Start with **START_HERE.md**.

## Tech stack

| Layer | Technology | Notes |
| --- | --- | --- |
| Frontend | Vanilla HTML, CSS, JavaScript (ES modules) | No framework, no bundler, no build step |
| Backend | Python 3.12, FastAPI 0.116 | REST API served by Uvicorn 0.35 |
| Database | SQLite | `backend/data/maxgreen.db` via the stdlib `sqlite3` driver |
| Gmail | Google Gmail API with OAuth 2.0 | `google-api-python-client`, read-only |
| AI | Claude Sonnet 4.5 | Called over HTTPS through the organizer-provided LLM gateway |
| Document parsing | pypdf | Extracts text from PDF attachments for classification |
| Web server | nginx 1.24 | Serves the static frontend and reverse-proxies `/api/` to FastAPI |
| TLS | Let's Encrypt | Certificate renews automatically through `certbot.timer` |
| Access control | nginx HTTP Basic auth | Required for every page and every `/api/` call |
| Hosting | Ubuntu 24.04 on AWS Lightsail | Backend runs as a systemd service |

Nothing from npm is used at runtime: the frontend is plain files served straight from disk, and
`frontend/assets/templates/` carries the PDF templates behind the quotation, invoice and delivery
order output.

Request flow:

```text
Browser → nginx (HTTPS + basic auth) → /api/ reverse proxy
        → FastAPI on 127.0.0.1:8000 → SQLite · Gmail API · Claude gateway
```

The backend is bound to loopback only, so it is reachable exclusively through nginx.

## Folder layout

```text
project/
├── START_HERE.md
├── .gitignore
├── .env.example
│
├── frontend/      # Existing HTML/CSS/JavaScript app
│   ├── index.html
│   ├── inbox.html
│   ├── gmail-test.html
│   └── assets/
│
└── backend/       # New Python/FastAPI Gmail backend
    ├── app.py
    ├── gmail_auth.py
    ├── test_gmail.py
    ├── requirements.txt
    ├── setup_windows.bat
    ├── connect_gmail.bat
    ├── test_gmail.bat
    ├── start_backend.bat
    ├── services/
    ├── data/
    └── secrets/
```

Currently running on an AWS Lightsail instance behind nginx, with Gmail sync, Claude
classification and AI document pre-fill enabled.

## v24 real Gmail Inbox

`frontend/inbox.html` now reads stored Gmail messages from FastAPI/SQLite instead of `demo-data.json`.
See `UPGRADE_TO_REAL_INBOX.md` for upgrade/run instructions.


## Claude classification (v25)

This version adds a local Claude classification stage through the organizer-provided Ollama-compatible gateway.

1. Put `LLM_GATEWAY_URL`, `LLM_GATEWAY_API_KEY`, and `LLM_MODEL` in the root `.env`.
2. With `.venv` active, run `python -m pip install -r requirements.txt` again (adds `requests` and `pypdf`).
3. Restart Uvicorn.
4. Open Inbox and click **Classify Unclassified**. The first test processes up to 10 messages.
5. PDF/text Gmail attachments are extracted and included as untrusted context for classification.

Classification is deliberately manual in this version. After you validate the results, the next version can classify automatically after every Gmail sync.

## v28 AI document pre-fill
- Quotation emails: Claude extracts supported customer/job/item details and pre-fills the existing quotation PDF review before the user edits it.
- Invoice & DO emails: PO attachment text is checked for an explicit `Quote Ref:` (for example `MGQ.26/05/111`). The matching Completed Quotation is then used as the source for both generated documents.
- Existing older classified messages are refreshed once when first opened so they receive the new structured extraction.
