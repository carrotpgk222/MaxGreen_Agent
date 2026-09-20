# MaxGreen Agent — Local Gmail Setup (Windows)

This version keeps the existing website in `frontend/` and adds a Python/FastAPI backend in `backend/`.

## What this version does

For now we are ONLY proving this flow:

`Gmail -> Python backend -> local SQLite database -> Gmail test webpage`

Claude / AWS LLM Gateway is NOT connected yet.
AWS Lightsail is NOT used yet.
Sending email is NOT enabled yet.

---

## 1. Install Python

Install Python 3.11 or 3.12 from https://www.python.org/downloads/

During the Windows installer, tick:

`Add python.exe to PATH`

After installation, open a new PowerShell and run:

`py --version`

or:

`python --version`

You should see Python 3.10.7 or newer. Python 3.11/3.12 is recommended.

---

## 2. Install the backend packages

Open this project folder in Kiro.

In Windows File Explorer, open:

`project/backend/`

Double-click:

`setup_windows.bat`

It creates a private Python virtual environment at `backend/.venv/` and installs all required packages.

You only need to do this once unless requirements change.

---

## 3. Create Google Gmail OAuth credentials

Go to Google Cloud Console: https://console.cloud.google.com/

### A. Create or select a Google Cloud project

Example name:

`MaxGreen Agent Local`

### B. Enable Gmail API

Open the API Library and enable:

`Gmail API`

### C. Configure Google Auth Platform

Open:

`Google Auth platform -> Branding`

Configure the app. If your account is part of a Google Workspace organisation and `Internal` is available, you can use Internal for organisation-only testing. If you are using a normal Gmail account, use External and add your own Gmail address as a test user if Google asks for test users.

### D. Create OAuth Client

Open:

`Google Auth platform -> Clients -> Create Client`

Choose:

`Application type: Desktop app`

Name example:

`MaxGreen Local Gmail`

Create it and download the JSON file.

Rename the downloaded file exactly to:

`credentials.json`

Put it here:

`project/backend/secrets/credentials.json`

DO NOT send this file to ChatGPT.
DO NOT upload it to GitHub.

---

## 4. Connect your Gmail account

Inside `project/backend/`, double-click:

`connect_gmail.bat`

A Google sign-in page should open in your browser.

Choose the Gmail account that MaxGreen Agent should read.

Google will ask for permission. Approve the requested read-only Gmail access.

When successful, the terminal should show:

`Gmail connected successfully!`

Google will create this private file automatically:

`project/backend/secrets/token.json`

Keep it private. It is already ignored by `.gitignore`.

---

## 5. Test Gmail in the terminal

Double-click:

`backend/test_gmail.bat`

You should see your latest Gmail Inbox messages printed in the terminal with sender, subject and attachment count.

If this works, Gmail API connection is successful.

---

## 6. Start the Python backend

Double-click:

`backend/start_backend.bat`

Keep this terminal window OPEN.

You should see something similar to:

`Uvicorn running on http://127.0.0.1:8000`

Test in your browser:

`http://127.0.0.1:8000/api/health`

You can also open the FastAPI testing page:

`http://127.0.0.1:8000/docs`

---

## 7. Start the frontend

In Kiro, open the `frontend/` folder or open `frontend/index.html`.

Use your existing extension:

`Live Server by Ritwick Dey`

Right-click `frontend/index.html` -> `Open with Live Server`.

Your existing MaxGreen website should still run normally.

---

## 8. Open the Gmail test page

With Live Server running, open:

`http://127.0.0.1:5500/gmail-test.html`

If your Live Server uses another port, keep that port and open `/gmail-test.html`.

The page has:

- Gmail connection status
- Sync Gmail button
- Load stored messages button
- Real Gmail messages stored in the local SQLite database

Click:

`Sync Gmail`

The backend will fetch your latest Inbox messages and save them in:

`project/backend/data/maxgreen.db`

---

## Important privacy/security rules

Never share or commit:

- `backend/secrets/credentials.json`
- `backend/secrets/token.json`
- Gmail passwords
- LLM Gateway API keys

Your Gmail PASSWORD is never used by this application. Google OAuth handles login directly on Google's website.

---

## Troubleshooting

### `Python was not found`

Install Python from python.org, tick `Add python.exe to PATH`, then completely close and reopen Kiro/PowerShell.

### Google says the app cannot be accessed

Check your Google Auth Platform Audience/Test Users and make sure the Gmail account you are logging in with is permitted.

### `Missing credentials.json`

Make sure the file is exactly:

`project/backend/secrets/credentials.json`

Windows can hide extensions, so avoid accidentally naming it `credentials.json.json`.

### Backend not reachable from gmail-test.html

Make sure `backend/start_backend.bat` is still running and shows port `8000`.

### Live Server is on port 5501 instead of 5500

That is okay; the backend already allows both 5500 and 5501 for local testing.

---

## What we do after this works

Do NOT move to AWS yet.

Once Gmail is confirmed working locally, the next steps are:

1. Wire the real Gmail messages into the real `Inbox` page.
2. Download/open real Gmail attachments.
3. Add deduplication using Gmail Message ID / Thread ID.
4. Add security screening.
5. Connect the organiser's LLM Gateway -> AWS Bedrock -> Claude Sonnet 4.5.
6. Let Claude classify the six categories.
7. Automate periodic Gmail checking.
8. Finally deploy frontend + backend + SQLite to AWS Lightsail for 24/7 operation.
