# v24 — Real Gmail Inbox

This version changes `frontend/inbox.html` from mock JSON records to Gmail messages stored in the local SQLite database.

## Important if upgrading from v23

The ZIP intentionally does **not** include your private Google files.

Keep/copy these from your existing project into the new project:

```text
backend/secrets/credentials.json
backend/secrets/token.json
```

Do not upload those files to GitHub and do not share them.

Your existing SQLite file can also be copied if you want to keep the messages you already synced:

```text
backend/data/maxgreen.db
```

If you do not copy `maxgreen.db`, just start the backend and press **Sync Gmail** in the Inbox to rebuild it from Gmail.

## Run locally

1. Open a terminal in `backend/`.
2. Activate the venv:

```powershell
.\.venv\Scripts\Activate.ps1
```

3. Start FastAPI:

```powershell
python -m uvicorn app:app --reload --host 127.0.0.1 --port 8000
```

4. Start the frontend with Live Server.
5. Open `frontend/inbox.html`.
6. Press **Sync Gmail** if you want to fetch the latest Gmail Inbox messages.

## What is real now

- Inbox rows come from SQLite (`backend/data/maxgreen.db`).
- SQLite rows come from the connected Gmail account.
- Received time is displayed in Singapore Time as `DD/MM/YYYY HH:mm`.
- From and View open a real Gmail message detail page.
- Real Gmail attachments can be opened in a new browser tab.

## Not connected yet

Claude classification is the next stage, so all real Gmail messages currently display:

```text
Unclassified
```
