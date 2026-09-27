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
  (not the deprecated `on_event`). The frontend has **no framework** — 23 standalone HTML pages each
  loading exactly one ES module.
- **Database & ORM/ODM:** **SQLite** via the Python standard library `sqlite3` driver. **No ORM, no
  migrations tool.** One file, `backend/data/maxgreen.db`; one table, `gmail_messages` (23 columns,
  primary key `gmail_message_id`), currently 10 rows. Schema evolution is additive `ALTER TABLE`
  in `_ensure_ai_columns()` (`backend/services/database_service.py:20`). Client-side state is
  `localStorage`, seeded from `frontend/assets/data/demo-data.json`.
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
FastAPI 0.116 / Uvicorn 0.35  ── 14 routes, CORS limited to localhost regex
  ▼
backend/services/  ── 7 synchronous modules
  ├─► SQLite            backend/data/maxgreen.db
  ├─► Gmail API         OAuth 2.0, gmail.readonly only
  └─► LLM gateway       POST {LLM_GATEWAY_URL}/api/chat, x-api-key → Claude Sonnet 4.5
```

---

## 📦 Complete Dependency Breakdown

Source of truth is `backend/requirements.txt` (8 direct pins); the full installed set is 42
packages. There is **no `package.json`**, no `pyproject.toml`, no `Cargo.toml`, and no `go.mod`.

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
unpkg/jsdelivr reference in any of the 23 HTML files; every `<script>` tag is a relative
`type="module"` path.

- 21 hand-written stylesheets: `assets/css/base.css` (shared shell) + one per page.
- HTML is plain semantic markup; no templating engine, no JSX, no component runtime.

### State Management & Data Fetching

Also hand-rolled, no library:

| Concern | Implementation |
| --- | --- |
| Server state / fetch | `assets/js/core/api.js` — one `fetch` wrapper, `apiJson()`, throws `Error(payload.detail)` |
| Persistence | `assets/js/core/*Storage.js` — one `localStorage` module per entity |
| Document IDs | `assets/js/core/documentIds.js` — `ensureDocumentIds()` backfills and re-saves |
| Seed data | `assets/js/data/mockData.js` + `assets/data/demo-data.json`, versioned to reset stale state |

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

### Testing Frameworks

**pytest 9.1.1**, with **httpx 0.28.1** for `fastapi.testclient.TestClient`. Declared separately in
`backend/requirements-dev.txt` so the runtime image does not carry test code. Configured in
`pyproject.toml` (`testpaths`, `pythonpath = ["backend"]`), 137 tests in `backend/tests/`.

| File | Covers |
| --- | --- |
| `conftest.py` | `sys.path` setup, throwaway-SQLite `temp_db` fixture, `sample_message` fixture |
| `test_classification_service.py` | AI-output normalisers, confidence clamping, Quote Ref extraction, scope-line cleanup |
| `test_database_service.py` | Schema and additive migrations, upsert semantics, classification writes, category routing |
| `test_app.py` | Route contract, input validation, and the **no-upstream-leak** regression tests |
| `test_llm_and_scheduler.py` | Markdown-fence/JSON parsing, gateway config validation, env parsing and clamping |

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

Two per-file exemptions, both deliberate:

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

- `backend/app.py` (14 routes) contains **zero business logic**; it validates input, calls one
  service function, and maps exceptions to `HTTPException`. Its `lifespan` handler runs
  `init_db()` **before** `start_scheduler()`, and cancels the scheduler in a `finally` block.
- `backend/services/` is a flat bag of 7 focused modules — `database_service`,
  `gmail_service`, `sync_service`, `classification_service`, `llm_service`,
  `attachment_text_service`, `scheduler_service` — not classes, not layered further.
- **Everything in `services/` is synchronous and blocking by design** (`sqlite3`, `requests`,
  `googleapiclient`). The single async component is `scheduler_service`, which runs one asyncio
  task and deliberately offloads the blocking `sync_gmail` to `loop.run_in_executor` to keep the
  event loop free.
- Both `app.py`'s `__main__` and the systemd `ExecStart` hardcode `127.0.0.1:8000`.

**Frontend pattern — page controller:** one HTML page ↔ one module in `assets/js/pages/`. Shared
domain logic lives in `assets/js/core/` and is imported with relative specifiers; there is no
barrel file and no dynamic import. Cross-page state flows through the per-entity `*Storage.js`
`localStorage` modules; the Inbox/Gmail path bridges the two tiers via
`assets/js/core/gmailWorkflowBridge.js`.

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

---

## ⚠️ Architectural Constraints & Rules

**Network / ingress**

1. **Never bind Uvicorn to `0.0.0.0`.** It must stay on `127.0.0.1:8000`. The socket is the only
   thing keeping the API, `backend/app.py` source, and `backend/secrets/` off the internet.
2. **Do not expose a new public path by editing FastAPI.** nginx is the sole ingress: it terminates
   TLS, enforces `auth_basic` on every page and every `/api/` call, and 404s everything outside
   `/frontend/` and `/api/`. A new route needs a matching `location` block or it is unreachable.
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
12. Keep Gmail **read-only**. The single scope is `gmail.readonly`; adding `gmail.send` or
    `gmail.modify` is a deliberate product decision, not a refactor.
13. **Schema changes must be additive** — a new column in `_ensure_ai_columns()` as
    `ALTER TABLE ... ADD COLUMN`. No destructive migration, no ORM, no migration framework. The
    table is keyed on `gmail_message_id`; keep it that way.

**Secrets & configuration**

14. **Never commit `.env`, `backend/secrets/*`, or any `*.pem`.** `.gitignore` covers
    `backend/secrets/*` (with a `!README.txt` exception) and `.env`. Do not add
    `git add -f` exceptions.
15. **Never log, echo, or return `LLM_GATEWAY_API_KEY`, `credentials.json`, or `token.json`** — not in
    exception messages, not in `/api` responses, not in tracebacks. Upstream exceptions must go
    through `app._upstream_failure()`, which logs the traceback and returns a fixed safe message;
    never interpolate `{exc}` into a `detail` string. `backend/tests/test_app.py::TestNoUpstreamLeak`
    enforces this — it asserts a sentinel secret never appears in a response body. The reason this
    matters: `llm_service` puts the gateway's raw response body and a model-output preview into its
    exception messages, so those strings are sensitive.
16. `.env.example` is the documented key surface and is verified to match the code exactly (9 keys:
    6 Gmail, 3 LLM). Keep it in sync when adding configuration, and never put a real value in it.
17. Upload size is capped at `client_max_body_size 25m`, and attachment text extraction is capped at
    12 000 chars per attachment / 24 000 per message. Respect both limits.

**Known drift — do not trust these docs or the live host blindly**

18. **The live `.env` contains two dead keys.** It sets `GMAIL_AUTO_SYNC=false` and
    `GMAIL_SYNC_INTERVAL_SECONDS=60`, but no code reads either. The real switches are
    `GMAIL_AUTO_CLASSIFY` and `GMAIL_POLL_INTERVAL_SECONDS`. So auto-classify is **currently ON**
    (default `true`) despite an operator having set `GMAIL_AUTO_SYNC=false`, and the poll interval is
    the 30 s default rather than the 60 s intended. `.env.example` is corrected; the live `.env` is a
    secrets file and was left untouched. Reconcile it deliberately.
19. `assets/templates/*.pdf` (4 files) are **not referenced** by any HTML page or JS module; document
    output is produced in-browser from HTML via print. Do not assume a template-loading pipeline
    exists.
20. `frontend/package-lock.json` is an empty placeholder with no `package.json` beside it. It is a
    leftover from the Live Server prototype, not a dependency manifest.
