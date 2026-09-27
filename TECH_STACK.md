# MaxGreen Agent — Tech Stack

Verified against the working tree, `backend/requirements.txt`, the live `.venv`, the deployed
nginx/systemd units, and the on-disk SQLite schema.

---

## 🏗️ Core Architecture

- **Language & Runtime:** Python **3.12.3** (backend, in `backend/.venv`) and hand-written
  **ES2022+ JavaScript** (frontend, interpreted directly by the browser). Node **v24.21.0** exists
  on the host but the application does not use it. No transpilation, no compilation, no bundling.
- **Primary Framework:** **FastAPI 0.116.1** (on Starlette **0.47.3** / Pydantic **2.13.5**), served
  by **Uvicorn 0.35.0** bound to `127.0.0.1:8000` only. Uses the modern `lifespan` context manager
  (not the deprecated `on_event`). The frontend has **no framework** — 23 standalone HTML pages, 22
  of which load exactly one ES module.
- **Database & ORM/ODM:** **SQLite** via the Python standard library `sqlite3` driver. **No ORM, no
  migrations tool.** One file, `backend/data/maxgreen.db`; **four tables** — `gmail_messages`
  (24 columns, primary key `gmail_message_id`, 16 rows), `outbound_documents` (26),
  `workflow_events` (10) and `document_attachments` (7). Schema evolution is additive `ALTER TABLE`
  in `_ensure_ai_columns()` (`backend/services/database_service.py:20`). Client-side state is
  `localStorage`, seeded from `frontend/assets/data/demo-data.json` and written almost entirely
  through the `core/*Storage.js` modules.
- **Deployment topology:** Ubuntu 24.04.5 LTS on AWS Lightsail. `nginx 1.24.0` is the sole public
  ingress (TLS + HTTP Basic auth + static files + `/api/` reverse proxy); the FastAPI process runs
  under systemd as `maxgreen-backend.service` on loopback only.

### Runtime request path

```text
Browser (ES modules, localStorage)
  │  HTTPS :443
  ▼
nginx 1.24  ── TLS (Let's Encrypt) · auth_basic · static /frontend/ · 404 catch-all
  │  HTTP → 127.0.0.1:8000   (only reachable path)
  ▼
FastAPI 0.116 / Uvicorn 0.35  ── 23 routes, CORS limited to localhost regex
  ▼
backend/services/  ── 10 synchronous modules
  ├─► SQLite            backend/data/maxgreen.db (4 tables)
  ├─► Gmail API         OAuth 2.0, gmail.readonly + gmail.send
  └─► LLM gateway       POST {LLM_GATEWAY_URL}/api/chat, x-api-key → Claude Sonnet 4.5
```

---

## 📦 Complete Dependency Breakdown

Source of truth is `backend/requirements.txt` (8 direct runtime pins) plus
`backend/requirements-dev.txt` (3 dev pins); the full installed set is **51 packages**. There is
**no `package.json`**, no `Cargo.toml`, and no `go.mod`. A `pyproject.toml` exists at the root but
carries **only** ruff and pytest configuration — no build-system table, so the project is not
packaged or installable.

### Direct dependencies (`backend/requirements.txt`)

```text
fastapi==0.116.1
uvicorn[standard]==0.35.0
google-api-python-client==2.181.0
google-auth-httplib2==0.2.0
google-auth-oauthlib==1.2.2
python-dotenv==1.1.1
requests>=2.32.0,<3.0.0
pypdf>=5.0.0,<7.0.0
```

### Frontend/UI Libraries

**None. Zero.** Verified: no `package.json`; `frontend/package-lock.json` exists but is an empty
placeholder (`name: frontend`, empty `packages` map); no `<script src="http...">`, no CDN, no
unpkg/jsdelivr reference in any of the 23 HTML files; every `<script>` tag is either a relative
`type="module"` path or, on `attachment-viewer.html` only, a 4-line inline classic script.

- 23 pages (~23 500 lines of HTML), 21 page modules and 26 shared modules (~10 300 lines of JS).
- **Styling is split between two mechanisms, and the split is uneven.** `assets/css/base.css` is
  the shared shell, linked by 21 pages. Beyond that, most page styling was inlined into the HTML:
  18 pages carry their own `<style>` block totalling ~17 500 lines, some over 1 500 lines, while 10
  of the 21 stylesheets are linked by no page at all (`completed.css`, `customer-receivable.css`,
  `customers.css`, `gmail-message.css`, `invoice-do.css`, `invoice-edit.css`,
  `invoice-receivable.css`, `pending.css`, `quotation-edit.css`, `supplier-payable.css`). Those
  files are dead weight, not a live code path.
- **No PDF rendering exists.** There is no `window.print`, no `@media print` in any HTML or CSS
  file, and no PDF library. The app maintains document metadata only — a `documentId` and a
  filename like `QUOTATION.pdf` — and never produces a PDF file.

### State Management & Data Fetching

Also hand-rolled, no library:

| Concern | Implementation |
| --- | --- |
| Server state / fetch | `assets/js/core/api.js` — one `fetch` wrapper, `apiJson()`, throws `Error(payload.detail)` |
| Persistence | `assets/js/core/*Storage.js` — one `localStorage` module per entity |
| Document IDs | `assets/js/core/documentIds.js` — `ensureDocumentIds()` backfills and re-saves |
| Seed data | `assets/js/data/mockData.js` + `assets/data/demo-data.json`, versioned to reset stale state |
| Outbound documents | `assets/js/core/documentPreview.js`, `documentSend.js` — talk to `/api/documents/*` and `POST /api/gmail/send` |
| Gmail ⇄ workflow | `assets/js/core/gmailWorkflowBridge.js` — bridges inbox messages to the document lifecycle |

`api.js` selects its base URL at load time from `window.location.hostname`: `localhost` /
`127.0.0.1` / `[::1]` → `http://127.0.0.1:8000` (Live Server dev, CORS-backed); anything else →
empty string, so calls become same-origin `/api` and traverse the nginx proxy.

### Backend/API Utilities

| Package | Version | Role |
| --- | --- | --- |
| fastapi | 0.116.1 | HTTP layer, routing, OpenAPI at `/docs` |
| starlette | 0.47.3 | ASGI app, CORS middleware |
| pydantic / pydantic_core | 2.13.5 / 2.46.5 | Request validation (`Body`, `Query`) |
| uvicorn[standard] | 0.35.0 | ASGI server, `httptools` + `uvloop` + `websockets` |
| google-api-python-client | 2.181.0 | Gmail API (`google-api-core` 2.39.0) |
| google-auth / google-auth-oauthlib / google-auth-httplib2 | 2.58.1 / 1.2.2 / 0.2.0 | OAuth 2.0 installed-app flow, token refresh |
| requests | 2.34.2 | Direct HTTP to the LLM gateway |
| pypdf | 6.19.0 | PDF attachment text extraction |
| python-dotenv | 1.1.1 | Loads repo-root `.env` at import |

Transitives present in `.venv`: `anyio` 4.15.1, `h11` 0.16.0, `idna` 3.20, `certifi` 2026.7.22,
`charset-normalizer` 3.5.1, `urllib3` 2.8.0,
`httplib2` 0.32.0, `oauthlib` 3.3.1, `requests-oauthlib` 2.0.0, `protobuf` 7.36.2, `proto-plus`
1.28.4, `googleapis-common-protos` 1.75.4, `uritemplate` 4.2.0, `cffi` 2.1.1, `pycparser` 3.0,
`cryptography` 50.0.1, `pyasn1` 0.6.4, `pyasn1_modules` 0.4.2, `pyparsing` 3.3.3, `click` 8.5.0,
`PyYAML` 6.0.3, `annotated-types` 0.8.0, `typing-inspection` 0.4.4, `typing_extensions` 4.16.0,
`httptools` 0.8.0, `uvloop` 0.22.1, `watchfiles` 1.3.0, `websockets` 17.1,
`opentelemetry-api` 1.45.0.

Dev-only, from `backend/requirements-dev.txt`: `pytest` 9.1.1 (+ `iniconfig` 2.3.0, `pluggy` 1.6.0,
`packaging` 26.3, `Pygments` 2.21.0), `httpx` 0.28.1 (+ `httpcore` 1.0.9), and `ruff` 0.16.9. These
eight are installed in the same `.venv` as the runtime and are therefore present in production, but
nothing imports them at runtime.

### Testing Frameworks

**pytest 9.1.1**, with **httpx 0.28.1** for `fastapi.testclient.TestClient`. Declared separately in
`backend/requirements-dev.txt` so the runtime image does not carry test code. Configured in
`pyproject.toml` (`testpaths`, `pythonpath = ["backend"]`), **236 tests** in `backend/tests/`.

| File | Tests | Covers |
| --- | --- | --- |
| `conftest.py` | — | `sys.path` setup, throwaway-SQLite `temp_db` fixture, `sample_message` fixture |
| `test_classification_service.py` | 71 | AI-output normalisers, confidence clamping, Quote Ref extraction, scope-line cleanup |
| `test_workflow_service.py` | 59 | Document lifecycle, document numbering, approval gate, event log |
| `test_api_hardening.py` | 40 | Route contract, input validation, 422-vs-500 behaviour, approval gate over HTTP |
| `test_llm_and_scheduler.py` | 30 | Markdown-fence/JSON parsing, gateway config validation, env parsing and clamping |
| `test_database_service.py` | 23 | Schema and additive migrations, upsert semantics, classification writes, category routing |
| `test_app.py` | 13 | FastAPI app wiring through `TestClient`, and the **no-upstream-leak** regression tests |

No test touches the network or the real `backend/data/maxgreen.db`. Two **manual smoke scripts**
remain for things a unit test cannot reach:

- `backend/test_gmail.py` — `main()` + `if __name__ == "__main__"`; prints the connected profile
  and 10 latest messages.
- `backend/test_llm_gateway.py` — module-level script that raises on missing `.env` config and posts
  one request to the gateway.

Windows wrappers: `backend/test_gmail.bat`, `connect_gmail.bat`, `start_backend.bat`,
`setup_windows.bat`.

### Linters, Formatters, & Build Tools

**ruff 0.16.9**, configured in `pyproject.toml`. Rules `E`, `F`, `I`, `UP`, `B`; `B008` is
ignored because FastAPI's `Depends()`/`Query()`/`Body()` callables-in-defaults is the framework's own
idiom. Style-only rules are deliberately not selected, so the gate never demands churn in working
code. `known-first-party = ["app", "services"]`.

Three per-file exemptions, all deliberate:

- `backend/tests/*` — `S101`/`SLF001` are not enforced because tests may use bare asserts and reach
  into private helpers on purpose.
- `backend/services/classification_service.py` — `E501` is not enforced because the LLM prompt
  strings are long by nature and reflowing them would change the exact text sent to the model.
- `backend/app.py` — `E402` is not enforced because `load_dotenv()` must run before the `services.*`
  imports, which read environment variables at import time.

Still absent: no `pyproject.toml` build-system table (the project is not packaged), no ESLint or
Prettier for the frontend, no `tsconfig.json`, no `Makefile`, no `Dockerfile`/`docker-compose.yml`,
no CI workflow.

There is **no build step at all** — the frontend is served as-is from disk, and the backend is run
straight from the venv.

Deployment configuration is version-controlled under `deploy/`, with a `deploy/install.sh` that
provisions a new host. It does **not** commit the credential file; only its mode and ownership are
recorded.

| Artifact | Repo path | Live path on the host |
| --- | --- | --- |
| nginx site | `deploy/nginx-maxgreen.conf` | `/etc/nginx/sites-enabled/maxgreen` |
| systemd unit | `deploy/maxgreen-backend.service` | `/etc/systemd/system/maxgreen-backend.service` |
| credentials | *(never committed)* | `/etc/nginx/auth/maxgreen.htpasswd`, mode `640 root:www-data` |
| ACME webroot | *(host state)* | `/var/www/certbot` |
| logs | *(host state)* | `/var/log/nginx/maxgreen.{access,error}.log` |
| TLS | *(host state)* | Let's Encrypt via `certbot.timer` (certbot 2.9.0) for `54-179-55-232.sslip.io` |

---

## 🔄 Architectural Conventions & Data Flow

**Shape:** a two-folder layered monolith — `frontend/` (static client) + `backend/` (Python API).
Not a package-manager monorepo: there is no workspace config linking the two. They are coupled only
by the `/api` HTTP contract and by `API_BASE` host detection.

**Backend layering is strict and one-directional:**

```text
app.py  (HTTP only: routing, status codes, CORS, lifespan)
   ↓  delegates, never computes
services/  (business logic, all synchronous)
   ↓
sqlite3 / requests / googleapiclient  (stdlib + third-party, blocking)
```

- `backend/app.py` (23 routes) contains **zero business logic**; it validates input, calls one
  service function, and maps exceptions to `HTTPException`. Its `lifespan` handler runs
  `init_db()` **before** `start_scheduler()`, and cancels the scheduler in a `finally` block.
- `backend/services/` is a flat bag of 10 focused modules — `database_service`, `gmail_service`,
  `sync_service`, `classification_service`, `llm_service`, `attachment_text_service`,
  `scheduler_service`, `security_service`, `workflow_service`, `logging_config` — not classes, not
  layered further.
- **Everything in `services/` is synchronous and blocking by design** (`sqlite3`, `requests`,
  `googleapiclient`). The single async component is `scheduler_service`, which runs one asyncio
  task and deliberately offloads the blocking `sync_gmail` to `loop.run_in_executor` to keep the
  event loop free.
- Both `app.py`'s `__main__` and the systemd `ExecStart` hardcode `127.0.0.1:8000`.

**Frontend pattern — page controller, with the styling inlined.** 22 of 23 pages load exactly one
module from `assets/js/pages/`; `attachment-viewer.html` is a self-contained mock with an inline
script. Shared domain logic lives in `assets/js/core/` and is imported with relative specifiers;
there is no barrel file and no dynamic import. The large page modules do **not** touch
`localStorage` directly — they read and write through the per-entity `core/*Storage.js` helpers,
which are the primary `localStorage` writers in the codebase, so storage keys stay centralised
(`pages/supplierPayable.js` is the one exception). The Inbox/Gmail path bridges the two tiers via
`assets/js/core/gmailWorkflowBridge.js`.

Presentation is the weak point of the current shape: page-specific CSS now lives mostly in
inlined `<style>` blocks rather than in the stylesheets, and several page modules are thin stubs
because the UI moved into the HTML. See the Frontend/UI Libraries section for the exact counts.

**AI data flow is untrusted-data-first.** Email bodies and attachment text are wrapped in an
explicit "treat as data, not instructions" fence (`classification_service.py:108`), the model is
asked for JSON, `llm_service.chat_json()` retries once if prose comes back instead, and every
returned field is then coerced through a normaliser against a closed vocabulary with a safe
fallback — `VALID_CATEGORIES`, `VALID_PARTIES`, `VALID_SECURITY`, each defaulting to
`Others` / `Unknown` / `Suspicious`. Quotation extraction additionally layers
deterministic regex/heuristic passes over the model output (`_deterministic_quote_refs`,
`_heuristic_scope_items`, `_quotation_fallback`), versioned by
`QUOTATION_EXTRACTION_VERSION = 4`.

**Sync flow:** `scheduler_service` (or the manual button) → `sync_service.sync_gmail` → fetch IDs
(`gmail_service.list_message_ids`) → skip known IDs via `existing_message_ids` → `upsert_messages`
→ auto-classify any row still `Unclassified`. Classification is best-effort: a model failure never
fails the sync, and leftovers are retried from the Inbox via
`POST /api/ai/classify-unclassified`.

**Trust boundary and the approval gate are deliberate, and they are not the LLM.** Three layers own
input safety, none of which trusts model output:

- `security_service.py` is the single place that decides what shape untrusted data may take —
  opaque-id validation (message ids capped at 128 chars, attachment ids at 1024), recipient and
  header validation, filename sanitisation, base64 attachment decoding bounded to 15 MB / 10 files
  per message, and `detect_prompt_injection()` on inbound text. `is_low_confidence()` (0.60),
  `blocks_automation()` (`Spam`, `Prompt Injection`) and `REQUIRES_OVERRIDE` decide what the
  classification result is allowed to trigger.
- `workflow_service.py` owns the outbound document lifecycle: create draft → `submit` → `approve` or
  `reject` → `send`, with `allocate_document_number()` and an append-only `workflow_events` trail.
  The rule the module states at the top: **model output can describe an action, it can never
  authorise one** — nothing derived from a prompt ever satisfies the approval gate, and
  `POST /api/documents/{id}/send` on an unapproved draft is rejected over HTTP.
- `gmail_service.send` is the last hop, reachable only through that gate or the direct
  `POST /api/gmail/send` route, with recipients, subject and body re-validated by
  `security_service` before anything is handed to the Gmail API.

**Logging is structured and redacted by construction.** `logging_config.py` ships a `JsonFormatter`,
a per-request id (`X-Request-ID` is generated, stored in a contextvar, set on the response and
echoed to the browser), and `redact()`, which scrubs both the literal current values of the
configured secrets and any field whose *name* looks like key material. Content is never logged —
only identifiers, counts, states and durations.

---

## ⚠️ Architectural Constraints & Rules

**Network / ingress**

1. **Never bind Uvicorn to `0.0.0.0`.** It must stay on `127.0.0.1:8000`. The socket is the only
   thing keeping the API, `backend/app.py` source, and `backend/secrets/` off the internet.
2. **Do not expose a new public path by editing FastAPI.** nginx is the sole ingress: it terminates
   TLS, enforces `auth_basic` on every page and every `/api/` call, and 404s everything outside
   `/frontend/` and `/api/`. A route that lives under `/api/` is already proxied by the single
   prefix `location /api/` block, so the 23 current routes need no per-route nginx config — but a
   route *outside* that prefix (or a new `location`) is unreachable until nginx is changed.
3. `proxy_read_timeout` / `proxy_send_timeout` are **300 s** to accommodate slow LLM calls. Do not
   lower them, and keep `chat()`'s 90 s timeout well under that ceiling.

**Frontend**

4. **Add no CDN, npm, or remote asset.** The CSP is `default-src 'self'` with `connect-src 'self'`
   and `img-src 'self' data: blob:` — an external script or font will be blocked. If a library is
   genuinely needed, vendor the file into `frontend/assets/` and re-check the CSP.
5. Keep asset paths **relative** and add pages as standalone HTML with exactly one
   `<script type="module">`. nginx rewrites `/frontend/<path>` and serves from `frontend/`; absolute
   `/assets/...` paths break under the deployed prefix.
6. Keep the frontend dependency-free. `frontend/package-lock.json` is an **empty placeholder** —
   `npm install` there does nothing and should not be treated as a build step.
7. Route all HTTP through `core/api.js` so the dev-vs-proxy base URL switch stays in one place.
   Do not hardcode `http://127.0.0.1:8000` in a page module.

**Backend**

8. **Keep `services/` synchronous.** If new work must run from async code, wrap it in
   `run_in_executor` exactly as `scheduler_service` does. Never `await` a service function.
9. **`app.py` stays HTTP-only.** Business logic belongs in `services/`; a route that computes domain
   rules is a regression.
10. Background loops must stay best-effort — catch, log via `logger = logging.getLogger("maxgreen")`,
    and continue. Never let an exception escape into the scheduler task.
11. **Treat all model output as hostile.** Every new AI-derived field needs a normaliser against a
    `VALID_*` set with a safe default. Do not pass `chat_json()` output straight into the database
    or the DOM.
12. `gmail.send` is in `SCOPES`, and the send path is now **live**: `POST /api/gmail/send` plus
    `core/documentSend.js` call `gmail_service.send`. Sending a generated document is still gated
    by `workflow_service` (draft → submit → approve → send). Do not add a route that sends without
    that gate, and do not add `gmail.modify` — anything beyond send deletes or alters real mail.
13. **Schema changes must be additive** — a new column in `_ensure_ai_columns()` as
    `ALTER TABLE ... ADD COLUMN`. No destructive migration, no ORM, no migration framework.
    `gmail_messages` is keyed on `gmail_message_id`; keep it that way. New tables
    (`outbound_documents`, `workflow_events`, `document_attachments`) are created with `CREATE TABLE
    IF NOT EXISTS` at the same point.
14. **Route untrusted input through `security_service`, not inline checks.** Opaque ids
    (message 128 chars, attachment 1024 — they are *not* the same size), recipient addresses,
    headers, filenames, attachment bytes (15 MB / 10 files / 40 PDF pages), and the Gmail query all
    have a validator there already. Do not re-implement one at a call site.
15. **Never let model output authorise an action.** A classification result may *describe* what a
    document should be, but the approval gate in `workflow_service` is satisfied only by an explicit
    human `approve` transition recorded in `workflow_events`. Do not add a path that auto-approves,
    auto-submits, or auto-sends off a confidence score or a `security_status` value.

**Secrets & configuration**

16. **Never commit `.env`, `backend/secrets/*`, or any `*.pem`.** `.gitignore` covers
    `backend/secrets/*` (with a `!README.txt` exception) and `.env`. Do not add
    `git add -f` exceptions.
17. **Never log, echo, or return `LLM_GATEWAY_API_KEY`, `credentials.json`, or `token.json`** — not in
    exception messages, not in `/api` responses, not in tracebacks. Upstream exceptions must go
    through `app._upstream_failure()`, which logs the traceback and returns a fixed safe message;
    never interpolate `{exc}` into a `detail` string. `backend/tests/test_app.py::TestNoUpstreamLeak`
    enforces this — it asserts a sentinel secret never appears in a response body. The reason this
    matters: `llm_service` puts the gateway's raw response body and a model-output preview into its
    exception messages, so those strings are sensitive. `logging_config.redact()` is the second
    line of defence for anything that reaches a log record.
18. `.env.example` is the documented key surface and matches the code for 9 of the 10 keys the
    backend reads (6 Gmail, 3 LLM). The gap: `logging_config.configure_logging()` also reads
    **`LOG_LEVEL`** (default `INFO`), which is **not** listed in `.env.example`. Add it there when
    you touch config, and never put a real value in that file.
19. Upload size is capped at `client_max_body_size 25m` in nginx, attachment text extraction is
    capped at 12 000 chars per attachment / 24 000 per message, and inbound attachment bytes are
    capped at 15 MB / 10 files per message. Respect all three limits.

**Known drift — do not trust these docs or the live host blindly**

20. **The live `.env` contains two dead keys.** It sets `GMAIL_AUTO_SYNC=false` and
    `GMAIL_SYNC_INTERVAL_SECONDS=60`, but no code reads either. The real switches are
    `GMAIL_AUTO_CLASSIFY` and `GMAIL_POLL_INTERVAL_SECONDS`. So auto-classify is **currently ON**
    (default `true`) despite an operator having set `GMAIL_AUTO_SYNC=false`, and the poll interval is
    the 30 s default rather than the 60 s intended. `.env.example` is corrected; the live `.env` is a
    secrets file and was left untouched. Reconcile it deliberately.
21. `assets/templates/*.pdf` (4 files) are **not referenced** by any HTML page, JS module or
    stylesheet, and there is no PDF rendering code anywhere in the frontend. Do not assume a
    template-loading or document-generation pipeline exists; documents are metadata only.
22. `frontend/package-lock.json` is an empty placeholder with no `package.json` beside it. It is a
    leftover from the Live Server prototype, not a dependency manifest.
23. **10 of the 21 stylesheets are orphaned** and 18 pages carry large inlined `<style>` blocks.
    Editing an orphaned file has no effect; the live rule lives in the page's own `<style>`. This
    is the most likely source of "I changed the CSS and nothing happened".
24. **The stored Gmail OAuth token is dead.** `backend/secrets/token.json` grants only
    `gmail.readonly` and now fails to refresh with `invalid_grant: Token has been expired or
    revoked.` — it fails the same way when loaded with the original readonly scope, so widening
    `SCOPES` did not cause it. `/api/health` therefore reports `gmail_connected: false` and
    background sync is a no-op until someone re-runs `python gmail_auth.py`. Re-consent will grant
    whatever `SCOPES` contains at that moment, which now includes `gmail.send`.
25. **The three document tables are empty.** `outbound_documents`, `workflow_events` and
    `document_attachments` exist and are wired to `/api/documents/*`, but hold 0 rows against the
    16 rows in `gmail_messages` — the outbound approval workflow has never been exercised against
    real data. Treat it as the least battle-tested part of the backend.
