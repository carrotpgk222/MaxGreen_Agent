# MaxGreen Agent

Start with **START_HERE.md** to run it, or **TECH_STACK.md** for the full architecture,
dependency inventory and the rules that constrain changes. Deployment config lives in
**deploy/**.

## Tech stack

Listed **top to bottom** — the order a request actually travels, from the browser down to disk and
out to third-party APIs.

```text
1. Browser (vanilla ES modules, localStorage)
        │  HTTPS
2. Let's Encrypt TLS  ── terminated by nginx
        ▼
3. nginx 1.24  ── basic auth · static files · /api/ reverse proxy
        │  HTTP, loopback only
4. FastAPI 0.116 / Uvicorn 0.35  on 127.0.0.1:8000  (14 REST routes)
        ▼
5. Service layer  (backend/services/ — 7 modules)
        ├──────────────► 6. SQLite  (backend/data/maxgreen.db, stdlib sqlite3)
        └──────────────► 7. Google Gmail API  (OAuth 2.0, gmail.readonly)
                         8. LLM gateway → Claude Sonnet 4.5  (HTTPS + x-api-key)
```

### 1. Browser — vanilla HTML, CSS, JavaScript

No framework, no bundler, no build step, and no runtime npm dependency. The browser loads the same
files that sit on disk.

| Piece | Count | Location |
| --- | --- | --- |
| Pages | 23 | `frontend/*.html` |
| Page controllers | 21 | `frontend/assets/js/pages/*.js` |
| Shared modules | 23 | `frontend/assets/js/core/*.js` |
| Stylesheets | 21 | `frontend/assets/css/*.css` |
| Document templates | 4 | `frontend/assets/templates/*.pdf` |

- Every page is a standalone HTML document that loads exactly one ES module via
  `<script type="module" src="./assets/js/pages/<page>.js">`. All asset paths are relative, so the
  app works from any prefix.
- `core/` holds the shared domain layer: document storage per entity (`quotationStorage.js`,
  `invoiceStorage.js`, `deliveryOrderStorage.js`, `soaStorage.js`, `receivableStorage.js`,
  `customerStorage.js`), workflow transitions (`*Workflow.js`, `workflowCategory.js`), Gmail
  integration (`gmailWorkflowBridge.js`), and helpers.
- `core/api.js` is the single HTTP seam. `API_BASE` is chosen at load time from
  `window.location.hostname`: on `localhost` / `127.0.0.1` / `[::1]` it points straight at
  `http://127.0.0.1:8000` for Live Server development; on any real host it stays empty so calls go
  to same-origin `/api` through the nginx proxy. `apiJson()` unwraps `detail` into a thrown `Error`.
- Document state lives in `localStorage` (seeded from `assets/data/demo-data.json`). PDFs are
  produced in-browser from HTML via print; `assets/templates/` holds the reference templates for
  the quotation, invoice, delivery order and SOA documents.

### 2. TLS — Let's Encrypt

- Certificate for `54-179-55-232.sslip.io`, issued by Let's Encrypt via certbot 2.9.0 and renewed
  automatically by `certbot.timer` (enabled).
- `TLSv1.2` and `TLSv1.3` only, server cipher preference off, 10 MB session cache, 1-day session
  timeout, session tickets disabled.
- Security headers set on every response: HSTS `max-age=31536000`, `X-Content-Type-Options:
  nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a Content-Security-Policy
  that defaults to `'self'` (inline script/style allowed, `img-src` `self data: blob:`,
  `connect-src 'self'`, `frame-ancestors 'none'`, `base-uri`/`form-action` `'self'`).

### 3. nginx 1.24 — edge, static host, reverse proxy

Three server blocks:

- **`:80 default_server`** — a catch-all that returns `444` (connection dropped) for the raw IP or
  any unknown `Host`, so the only way in is the named vhost.
- **`:80` named vhost** — serves `/.well-known/acme-challenge/` from `/var/www/certbot` so
  certificates keep renewing, and 301-redirects everything else to HTTPS.
- **`:443` named vhost** — the real app:
  - `root` is `frontend/`, `autoindex off`, uploads capped at `25m`.
  - `gzip` on for text/CSS/JS/JSON/SVG with a 1024-byte floor and `gzip_vary`.
  - Logs to `/var/log/nginx/maxgreen.access.log` and `maxgreen.error.log`.
  - `/` 302s to `/frontend/index.html`; `/frontend/` 302s to the index; `/frontend/<path>` rewrites
  the prefix away and serves the static file.
  - `/api/` proxies to `http://127.0.0.1:8000` over HTTP/1.1, forwarding `Host`, `X-Real-IP`,
    `X-Forwarded-For`, `X-Forwarded-Proto` and WebSocket `Upgrade` headers, with 300 s read/send
    timeouts to allow slow LLM calls.
  - Anything outside `/frontend/` and `/api/` returns 404, which keeps backend source and
    `secrets/` unreachable over HTTP.

### 4. Authentication — nginx HTTP Basic

`auth_basic` guards every page and every `/api/` call in the `:443` block, against
`/etc/nginx/auth/maxgreen.htpasswd` (mode `640`, `root:www-data`). There is no per-route auth in
FastAPI — the backend simply is not reachable except through nginx.

### 5. FastAPI 0.116 on Uvicorn 0.35 — application server

- Python 3.12.3 in `backend/.venv`, dependencies pinned in `backend/requirements.txt`; FastAPI pulls
  in Starlette 0.47 and Pydantic 2.13.
- Bound to `127.0.0.1:8000` and nothing else, so the API is only reachable via the proxy.
- Configuration is read from the repo-root `.env` through `python-dotenv` at import time.
- 14 routes: `/` and `/api/health`, `/api/gmail/status`, `POST /api/gmail/sync`,
  `/api/llm/status`, `POST /api/llm/test`, `POST /api/ai/classify/{id}`,
  `POST /api/ai/classify-unclassified`, `POST /api/gmail/messages/{id}/category`,
  `/api/dashboard/counts`, `/api/supplier-payable/messages`, `/api/gmail/messages`,
  `/api/gmail/messages/{id}`, and `/api/gmail/messages/{id}/attachments/{attachment_id}` (streams
  the attachment inline with `Cache-Control: no-store`).
- Lifespan hooks: `startup` runs `init_db()` then `start_scheduler()`; `shutdown` cancels the
  scheduler. Interactive OpenAPI docs are available on loopback at `/docs`.
- CORS is scoped by `allow_origin_regex` to `localhost` / `127.0.0.1` on any port, for Live Server
  development only — the same-origin nginx path needs no CORS.
- Runs as the systemd unit `maxgreen-backend.service` (`Restart=always`, 5 s backoff,
  `WorkingDirectory=backend/`, `ExecStart=.venv/bin/python -m uvicorn app:app`).

### 6. Service layer — `backend/services/`

Thin, synchronous modules; `app.py` only does HTTP concerns and delegates here.

| Module | Responsibility |
| --- | --- |
| `database_service.py` | SQLite access, schema creation and additive migrations |
| `gmail_service.py` | Gmail API client, OAuth credentials, message and attachment fetching |
| `sync_service.py` | Upserts fetched messages, then auto-classifies new `Unclassified` rows |
| `classification_service.py` | Prompts, response normalisation, category/party/security validation |
| `llm_service.py` | Gateway client: config, chat, JSON parsing, retry |
| `attachment_text_service.py` | Pulls text out of PDF and text attachments for context |
| `scheduler_service.py` | Background poll loop driving `sync_service` |

### 7. Storage — SQLite

- One file, `backend/data/maxgreen.db`, through the stdlib `sqlite3` driver (no ORM), opened with
  `row_factory = sqlite3.Row`.
- A single `gmail_messages` table keyed by `gmail_message_id`, holding envelope fields, body text,
  attachment/label JSON, plus **12 `ai_*` columns** for the classification result
  (`ai_category`, `ai_party_type`, `ai_security_status`, `ai_confidence`, `ai_reason`,
  `ai_quotation_refs_json`, `ai_model`, `ai_classified_at`, `ai_supplier_reference`, `ai_amount`,
  `ai_due_date`, `ai_quotation_draft_json`).
- Schema evolution is done at startup by `_ensure_ai_columns()`, which `ALTER TABLE`s in any missing
  column, so upgrades need no migration tooling.
- Structured values are stored as JSON text in `TEXT` columns rather than normalised child tables.

### 8. Google Gmail API — OAuth 2.0, read-only

- `google-api-python-client` 2.181, `google-auth-oauthlib` 1.2, `google-auth-httplib2` 0.2.
- The only scope requested is `https://www.googleapis.com/auth/gmail.readonly` — the app never
  sends mail.
- `InstalledAppFlow` performs the one-time consent; `credentials.json` and the refresh
  `token.json` live in `backend/secrets/`, which is git-ignored. Expired tokens are refreshed
  transparently and written back.
- Message bodies are parsed from the Gmail API payload; attachment downloads run in a
  `ThreadPoolExecutor` so a message with many files does not serialise the sync.

### 9. AI — Claude via the organizer-provided LLM gateway

- `llm_service.py` posts OpenAI-style chat completions to `LLM_GATEWAY_URL` over HTTPS with the
  key in an `x-api-key` header, 90 s timeout, all three settings coming from `.env`
  (`LLM_GATEWAY_URL`, `LLM_GATEWAY_API_KEY`, `LLM_MODEL`).
- `chat_json()` asks for JSON, and if the model replies with prose it retries once with a
  reformatting prompt. Responses are stripped of markdown fences and validated before use.
- `classification_service.py` constrains every field to a fixed vocabulary —
  category `Quotation | Invoice & DO | Supplier Payable | Others`, party
  `Customer | Supplier | Unknown`, security `Safe | Spam | Prompt Injection | Suspicious` — and
  falls back to the safe value when the model returns something unexpected. Attachment text is
  passed as clearly marked untrusted context.
- Automatic classification after each sync is on by default and bounded by
  `GMAIL_AUTO_CLASSIFY_LIMIT` (default 25). It is best-effort: a failed classification never fails
  the sync, and leftovers are retried from the Inbox.
- `attachment_text_service.py` uses `pypdf` 6.x for PDFs and plain decoding for text files, capped
  at 12 000 characters per attachment and 24 000 per message.

### Background sync

`scheduler_service.py` starts one asyncio task with the app. Each tick runs the blocking
`sync_gmail` in a thread-pool executor so the event loop stays free, and every run is best-effort:
exceptions are logged and the loop continues, and ticks are skipped entirely when Gmail is not
connected. Tuned by `GMAIL_POLL_INTERVAL_SECONDS` (default 30, floor 5), `GMAIL_POLL_LIMIT`
(default 10) and `GMAIL_SYNC_QUERY` (default `in:inbox`).

### Hosting

Ubuntu 24.04 LTS on AWS Lightsail. nginx fronts the app, `maxgreen-backend.service` runs the
backend, `certbot.timer` keeps TLS alive, and every layer above the loopback socket is closed to
the public internet except 80/443.

### Not used at runtime

No npm packages, no CDN links, no CSS framework, no ORM, no message queue, and no cache server.
The frontend is plain files served from disk, and `frontend/package-lock.json` is an empty
placeholder left over from the Live Server prototype.

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

## Development

```bash
cd backend
.venv/bin/python -m pip install -r requirements-dev.txt   # pytest, ruff, httpx
.venv/bin/python -m pytest        # 137 tests
.venv/bin/ruff check .            # lint
```

Linter and test configuration lives in `pyproject.toml` at the repo root. Tests live in
`backend/tests/`, run against a throwaway SQLite file, and make no network calls and need no real
credentials.

Two manual smoke scripts remain for things a unit test cannot reach: `backend/test_gmail.py`
(confirms live Gmail read access) and `backend/test_llm_gateway.py` (confirms the gateway answers).

