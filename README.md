# MaxGreen Agent — Local Integration Build v23

Start with **START_HERE.md**.

Folder layout:

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

Current milestone: Gmail read-only connection locally. Claude and AWS deployment come later.

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
