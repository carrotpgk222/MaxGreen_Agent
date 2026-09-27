# MaxGreen Agent — Setup & Operations

> **Superseded sections removed.** Earlier revisions of this file stated that Claude, the LLM
> gateway and AWS Lightsail were *not* connected yet. All three are live. `TECH_STACK.md` is the
> authoritative description of the current architecture; this file covers how to run and operate it.

## What the app does

Gmail → Python backend → SQLite → browser. Inbox messages are pulled from Gmail on a timer, read
by Claude through the organizer's LLM gateway, classified into a fixed set of workflow categories,
and surfaced in the Inbox page for review. Quotation, Invoice and Delivery Order drafts are
pre-filled from the extracted data. Reading is the only Gmail path wired into the app; although the
OAuth consent now also asks for `gmail.send`, no endpoint calls the send function.

## Production (current deployment)

Ubuntu 24.04 on AWS Lightsail. nginx is the only public ingress; the backend is loopback-only.

```bash
# status
systemctl status maxgreen-backend.service
sudo nginx -t

# logs — upstream error detail is logged here, not returned to the browser
journalctl -u maxgreen-backend.service -f
sudo tail -f /var/log/nginx/maxgreen.error.log

# restart after a code change
sudo systemctl restart maxgreen-backend.service

# health, from inside the box (bypasses nginx and basic auth)
curl -s http://127.0.0.1:8000/api/health

# health, from outside (through TLS + basic auth)
curl -sk -u USER:PASS https://54-179-55-232.sslip.io/api/health
```

Confirm the backend is never publicly bound:

```bash
ss -ltnp | grep 8000     # must read 127.0.0.1:8000, never 0.0.0.0:8000
```

### Access

Every page and every `/api/` call sits behind HTTP Basic auth. Credentials are in
`/etc/nginx/auth/maxgreen.htpasswd` (mode `640 root:www-data`).

```bash
sudo htpasswd -B /etc/nginx/auth/maxgreen.htpasswd <username>   # add or change a user
```

### TLS

Let's Encrypt via `certbot.timer`, for `54-179-55-232.sslip.io`.

```bash
sudo certbot certificates
sudo systemctl status certbot.timer
sudo certbot renew --dry-run
```

If the hostname changes, update `server_name`, both `ssl_certificate` paths and the `return 301`
in `deploy/nginx-maxgreen.conf`, then reissue the certificate. See `deploy/README.md`.

## Local development

The backend runs identically on a laptop; only the frontend's dev server differs.

### 1. Python environment

```bash
cd backend
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m pip install -r requirements-dev.txt   # pytest + ruff
```

On Windows, `setup_windows.bat` does the same thing.

### 2. Configuration

```bash
cp .env.example .env
```

Then fill in the three LLM gateway values. Real values live only in `.env`, which is git-ignored:

| Variable | Purpose |
| --- | --- |
| `LLM_GATEWAY_URL` | Base URL of the organizer's Ollama-compatible gateway |
| `LLM_GATEWAY_API_KEY` | Sent as the `x-api-key` header |
| `LLM_MODEL` | Model name to request |

The Gmail tuning keys (`GMAIL_SYNC_QUERY`, `GMAIL_SYNC_LIMIT`, `GMAIL_AUTO_CLASSIFY`,
`GMAIL_AUTO_CLASSIFY_LIMIT`, `GMAIL_POLL_INTERVAL_SECONDS`, `GMAIL_POLL_LIMIT`) all have working
defaults and can be left alone.

### 3. Gmail OAuth (one time)

1. In the Google Cloud Console, enable the **Gmail API**.
2. Under Google Auth Platform → Branding, set the audience. If the account belongs to a Workspace
   organisation, **Internal** is the simplest option.
3. Create an OAuth client of type **Desktop app** and download the JSON.
4. Rename it to exactly `credentials.json` and place it at `backend/secrets/credentials.json`.
   (Watch out for Windows hiding the extension and producing `credentials.json.json`.)
5. Authorise:

```bash
cd backend
.venv/bin/python gmail_auth.py
```

A browser sign-in opens; approve the requested access. This writes `backend/secrets/token.json`,
which is also git-ignored. On Windows, double-click `connect_gmail.bat`.

The consent screen requests `gmail.readonly` **and** `gmail.send`. Only reading is used today — the
send function in `gmail_service.py` is not called by any endpoint — but Google will not let you
remove `gmail.send` from the consent screen without re-authorising, so decline it if you would
rather not grant it.

### 4. Run the backend

```bash
cd backend
.venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8000 --reload
```

Or double-click `start_backend.bat` on Windows. Interactive API docs are at
`http://127.0.0.1:8000/docs`.

**Keep the host on `127.0.0.1`.** The backend has no authentication of its own; on a public
interface it would be an unauthenticated Gmail and LLM gateway.

### 5. Run the frontend

There is no build step and no npm install. Serve `frontend/` with any static server — VS Code's
*Live Server* extension is what the project was built against:

```bash
cd frontend
python3 -m http.server 5500
```

Then open `http://localhost:5500/index.html`.

`core/api.js` detects the hostname at load time: on `localhost` it calls
`http://127.0.0.1:8000` directly (permitted by the backend's localhost-only CORS regex); on any
other host it uses same-origin `/api` through the nginx proxy. Both paths work with no code change.

## Tests and linting

```bash
cd backend
.venv/bin/python -m pytest          # 236 tests
.venv/bin/ruff check .              # lint
.venv/bin/ruff check . --fix        # autofix safe findings
```

Config lives in `pyproject.toml` at the repo root. Tests are in `backend/tests/` and use a
throwaway SQLite file, so the real database is never touched. Nothing in the suite makes a network
call or needs real credentials.

## Troubleshooting

**`Backend not reachable from the page`**
The backend is not running, or it is bound to something other than `127.0.0.1:8000`. Check the
terminal running Uvicorn and `ss -ltnp | grep 8000`.

**Live Server is on a different port**
Fine. The CORS regex allows any port on `localhost` / `127.0.0.1`.

**`Missing credentials.json`**
The file must be named exactly `credentials.json` inside `backend/secrets/`.

**Gmail says the app cannot be accessed**
Check the OAuth client's audience and test users in Google Auth Platform.

**Classification fails but sync succeeds**
This is by design — a model failure never fails a sync, and the row stays `Unclassified` for the
Inbox retry button. The real error is in `journalctl -u maxgreen-backend.service`; the browser only
receives a generic message, by design, because upstream errors can contain model output and tokens.

**Everything returns 404 from outside**
Expected for any path outside `/frontend/` and `/api/`. That catch-all is what keeps backend source
and `secrets/` private.

## Security rules

Never commit, paste into a chat, or log:

- `backend/secrets/credentials.json`
- `backend/secrets/token.json`
- `.env` (holds `LLM_GATEWAY_API_KEY`)
- any `*.pem`

The Gmail account's **password is never used by this application** — Google OAuth handles sign-in
on Google's own site.
