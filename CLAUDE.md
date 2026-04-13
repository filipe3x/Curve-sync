# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Curve Sync is a standalone service (Vite + React frontend, Express/Fastify backend, MongoDB) that automates expense tracking by parsing Curve Card email receipts. It shares the same MongoDB instance as the Embers platform but runs independently.

First-time setup is driven by a wizard at `/curve/setup` that authorizes access to the user's mailbox via OAuth2 Device Authorization Grant directly from the Node backend — no proxies, no App Passwords, no terminal. Tokens live in MongoDB encrypted with AES-256-GCM. See [`docs/EMAIL_AUTH.md`](docs/EMAIL_AUTH.md) for the full architecture and [`docs/EMAIL_AUTH_MVP.md`](docs/EMAIL_AUTH_MVP.md) for the MVP scope.

## Commands

```bash
npm run install:all    # Install all deps (root + client + server)
npm run dev            # Start both client (Vite :5173) and server (Express :3001)
npm run dev:client     # Frontend only
npm run dev:server     # Backend only
npm run build          # Production build (client)
npm run start          # Start server in production mode
```

Server env: copy `server/.env.example` to `server/.env` and set `MONGODB_URI`.

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vite + React + Tailwind CSS |
| Backend | Express (Node.js) |
| Database | MongoDB (shared with Embers) |
| ODM | Mongoose |
| IMAP client | `imapflow` (speaks XOAUTH2 directly, no proxy) |
| OAuth | `@azure/msal-node` (Microsoft only in MVP — see §Email Authentication) |
| Token encryption | AES-256-GCM via Node `crypto` — key in `IMAP_ENCRYPTION_KEY` |
| Email parsing | cheerio (port of Python BeautifulSoup logic) |
| Scheduler | node-cron |
| Wizard UI | `motion/react` + `lucide-react` + `qrcode.react` |
| Hashing | Node.js native `crypto` (SHA-256) |
| CSS | Tailwind with custom `curve` (red-brown) and `sand` (warm grey) palettes |

## Architecture

### MongoDB Collection Access Rules

- **`users`** — READ-ONLY (owned by Embers)
- **`categories`** — READ-ONLY (owned by Embers)
- **`expenses`** — READ + INSERT only (never UPDATE/DELETE existing records)
- **`curve_configs`** — Full CRUD (owned by this service, per-user IMAP settings)
- **`curve_logs`** — INSERT + READ (audit trail, TTL 90 days)

### Mongoose Compatibility with Embers (Mongoid)

These rules are critical to avoid breaking the shared database:

- Use `{ timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }` (snake_case, not camelCase)
- Set explicit collection names to prevent Mongoose auto-pluralization
- Store relationships as `<name>_id` ObjectId fields (e.g., `user_id`, `category_id`, `config_id`)
- Never modify the schema of existing `users`, `categories`, or `expenses` collections

### Expense Deduplication

Expenses use a SHA-256 digest of `entity + amount + date + card` as a unique index. This prevents duplicate inserts when reprocessing the same emails. The same logic exists in the original `curve.py` and must be replicated exactly.

### Custom Monthly Cycle

The expense system uses day 22 as the month start (aligned with bank pay cycles), not day 1. All monthly reports and filters must respect this: if `date.day >= 22`, the cycle started on the 22nd of that month; otherwise it started on the 22nd of the previous month.

### Savings Score

Weekly budget = EUR 295/4. Score formula: `score = (log(weekly_savings + 1) / log(budget + 1)) * 10`, returning a 0-10 scale.

### Email Parsing Pipeline

The original `curve.py` (in `docs/embers-reference/`) extracts fields from Curve Card HTML emails using CSS selectors: `entity` from `td.u-bold`, `amount` (EUR) from second `td.u-bold`, `date` from `td.u-greySmaller.u-padding__top--half`, `card` from penultimate `td.u-padding__top--half`. The standalone version should port this to cheerio with fallback selectors for resilience.

### Email Authentication (OAuth2 — no proxies)

The V1 implementation used Simon Robinson's `email-oauth2-proxy` (Python) as a localhost bridge that translated plain IMAP LOGIN into XOAUTH2 against Microsoft. That entire path has been retired — the proxy, its systemd unit, its INI-style `emailproxy.config`, and the `EMAIL_AUTH_V1_PROXY.md` design doc are all gone. `imapflow` now speaks XOAUTH2 directly against `outlook.office365.com:993`, and `@azure/msal-node` owns the full token lifecycle.

**Wizard flow** (`client/src/pages/CurveSetupPage.jsx` → `server/src/routes/curveOAuth.js`):

1. User types email → frontend calls `/api/curve/oauth/check-email` → backend classifies the domain
2. User consents → frontend calls `/api/curve/oauth/start` → backend kicks off MSAL's `acquireTokenByDeviceCode` and returns the user code + verification URL
3. Frontend polls `/api/curve/oauth/poll` every ~3 s while displaying the code + a QR code for phones
4. On success, MSAL writes the token cache (access + refresh tokens) to `CurveConfig.oauth_token_cache`, encrypted with AES-256-GCM
5. Frontend prefetches the folder list in parallel with the success screen, then the user confirms which IMAP folder holds the Curve receipts
6. User picks a sync interval and the wizard hands off to `/curve/config`

Every subsequent sync pulls a fresh access token via `oauthManager.getOAuthToken()` — MSAL's `acquireTokenSilent` returns a cache hit (~ms) when the access token is still valid or transparently exchanges the refresh token when it isn't. Refresh events are audited as `oauth_token_refreshed` in `curve_logs`. If the refresh path dies (90-day inactivity, revoked consent, corrupt cache), the orchestrator catches `OAuthReAuthRequired`, flips `last_sync_status` to `error`, and the Dashboard renders a re-auth banner pointing back to `/curve/setup`.

**Provider support — temporary Microsoft-only limitation**:

The MVP only supports **personal Microsoft accounts** (`outlook.com`, `hotmail.com`, `live.com`, `msn.com`, and their country-specific variants — see `MICROSOFT_DOMAINS` in `server/src/services/oauthWizard.js`). This is a deliberate scope cut, not a design limit:

- Work/school accounts (O365) *may* work if the tenant admin hasn't disabled IMAP or public-client DAG, but they are untested and not officially supported
- **Gmail is not yet supported by the wizard**. The architecture already reserves `oauth_provider: 'google'` in the `CurveConfig` schema and documents the external-auth branch needed to plug Google in (see `docs/EMAIL_AUTH.md` §2.2 and §3.5). Expanding to Gmail is the primary fase 2 goal — it requires adding Google's OAuth DAG path to `oauthManager.js` and `oauthWizard.js`, plus the `https://mail.google.com/` scope. Most of the plumbing (cache plugin, `OAuthReAuthRequired`, re-auth banner, folder picker) is already provider-agnostic and should work unchanged.
- Gmail users today have no wizard path — they're blocked until fase 2 ships

Non-Microsoft / non-Gmail domains fall through `providerForEmail()` as `null` and the wizard's step 1 blocks progress with an "unsupported domain" message.

**`CurveConfig` OAuth fields** (see `server/src/models/CurveConfig.js`): `oauth_provider`, `oauth_token_cache` (encrypted MSAL blob), `oauth_account_id` (MSAL `homeAccountId`), `oauth_client_id`, `oauth_tenant_id`. All nullable — when `oauth_provider` is `null` the reader falls back to the legacy `imap_password` branch for App Password holdouts.

**Required env**: `AZURE_CLIENT_ID` (mandatory for any Microsoft OAuth config), `AZURE_TENANT_ID` (defaults to `common`), `IMAP_ENCRYPTION_KEY` (reused from V1 to protect `oauth_token_cache`). No `AZURE_CLIENT_SECRET` — public client + DAG.

## Project Structure

```
client/                 # Vite + React + Tailwind frontend
  src/
    components/layout/  # Shell, Sidebar, Icons
    components/common/  # PageHeader, StatCard, EmptyState
    components/setup/   # Wizard shell — WizardLayout, Screen, CurveSyncLogo
      steps/            # 6 wizard steps: Hero, Email, Trust, DeviceCode,
                        #   PickFolder, Schedule, Success + folderHeuristic
    pages/              # LoginPage, DashboardPage, ExpensesPage,
                        #   CurveSetupPage (wizard entry), CurveConfigPage,
                        #   CurveLogsPage
    services/api.js     # All API calls (fetch wrapper)
server/                 # Express backend
  src/
    models/             # Mongoose: Expense, Category, User (RO), Session,
                        #   CurveConfig, CurveLog
    routes/             # auth, expenses, categories, curve, curveOAuth,
                        #   autocomplete
    services/
      expense.js        # dedup digest, auto-category
      emailParser.js    # cheerio port of curve.py
      imapReader.js     # imapflow XOAUTH2 client
      oauthWizard.js    # MSAL DAG session manager (in-memory pending flows)
      oauthManager.js   # MSAL token lifecycle — silent refresh + re-auth
      oauthCachePlugin.js # AES-256-GCM encrypted MSAL cache on CurveConfig
      syncOrchestrator.js # run-sync entry point (manual + scheduled)
      scheduler.js      # node-cron wiring
      audit.js          # fire-and-forget curve_logs writer
      auth.js           # session token validation (Embers-compatible)
      crypto.js         # AES-256-GCM helpers for token cache
    config/db.js        # MongoDB connection
docs/                   # Architecture docs + read-only Embers reference
```

## Reference Files

All files under `docs/embers-reference/` are **read-only references** from the Embers platform. Do not modify them — they exist to document the original implementation:

- `curve.py` — Original email parser (Python/BeautifulSoup)
- `models/*.rb` — Mongoid schemas (source of truth for field names and types)
- `controllers/*.rb` — API logic for expenses and categories
- `frontend/` — React components and API service layer from Embers

Key documentation:
- `docs/EMAIL_AUTH.md` — **OAuth2 architecture** (canonical): wizard flow, token cache, refresh path, re-auth, provider fan-out, env vars. Start here when touching anything auth-related.
- `docs/EMAIL_AUTH_MVP.md` — **MVP scope & acceptance criteria** (§8): the living punch list for "is the wizard done?". Check this before asking "what's next" on the OAuth track.
- `docs/WIZARD_POLISH_BACKLOG.md` — Deferred UX polish items for `CurveSetupPage` (animations, copy, edge-case screens). Only deferred niceties, not blockers.
- `docs/EMAIL.md` — **Email pipeline implementation guide**: current state, TODOs, dev strategy, reference selectors, architecture diagram
- `docs/MONGODB_SCHEMA.md` — Complete schema with Mongoose equivalents, relationships, indexes, and consistency rules
- `docs/CURVE_LOGS.md` — **CurveLog audit & sync trail** (canonical): every write site, the dual sync-vs-audit shape, the canonical user-facing message for each row type, and the `/curve/logs` rendering rules. Read this before touching `audit()`, the orchestrator's `writeLog()`, or the `CurveLogsPage` table layout.
- `docs/expense-tracking.md` — Full system documentation including savings score, monthly cycle logic, TODOs, and proposed standalone architecture
- `docs/CRON.md` — Scheduler design (node-cron, per-user intervals)
- `docs/AUTH.md` — Session-cookie login flow compatible with Embers' Devise+Mongoid users
- `docs/UIX_DESIGN.md` — Design system (curve/sand palettes, card layout, motion rules)

## Dev Database

A full MongoDB dump of the shared Embers database can be placed at `dev/db/embers-dump.tar.gz` for local development. The data is bogus/test accounts — safe to commit.

### Setup

```bash
# 1. Export (on the server running MongoDB)
mongodump --db=embers_db_dev --out=/tmp/mongodump
tar czf embers-dump.tar.gz -C /tmp/mongodump embers_db_dev

# 2. Place the file
cp embers-dump.tar.gz dev/db/

# 3. Import into local MongoDB
tar xzf dev/db/embers-dump.tar.gz -C /tmp
mongorestore --db=embers_db_dev /tmp/embers_db_dev --drop
```

### What it contains

| Collection | Used by | Dev relevance |
|------------|---------|---------------|
| `users` | Embers (owner) | `email`, `encrypted_password`, `salt` — needed to test auth (MU-1) |
| `categories` | Embers (owner) | Category list for auto-assignment |
| `expenses` | Both | Existing expenses for testing queries and dedup |
| `sessions` | Embers (owner) | Session tokens — needed to test session validation |
| `curve_configs` | Curve Sync | IMAP config per user |
| `curve_logs` | Curve Sync | Audit trail |

### Inspecting BSON files without MongoDB

When `mongorestore` is not available, inspect `.bson` files directly via the `bson` npm package:

```bash
npm install --no-save bson
tar xzf dev/db/embers-dump.tar.gz -C /tmp
```

```javascript
const fs = require('fs');
const { BSON } = require('bson');

function readBson(file) {
  const buf = fs.readFileSync(file);
  const docs = [];
  let offset = 0;
  while (offset < buf.length) {
    const size = buf.readInt32LE(offset);
    docs.push(BSON.deserialize(buf.slice(offset, offset + size)));
    offset += size;
  }
  return docs;
}

const users = readBson('/tmp/embers_db_dev/users.bson');
console.log(users);
```

### Important

- The data is test/bogus accounts — safe to track in git
- The `MONGODB_URI` in `server/.env` should point to the local instance where the dump was restored
- The `users` collection contains `encrypted_password` and `salt` fields using the Embers custom SHA-256 hash: `SHA256("password--salt")` — this is what MU-1 auth will validate against

## API Endpoints

Auth + data:
- `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` — session-cookie login against Embers users
- `GET/POST /api/expenses` — List and create expenses
- `GET /api/categories` — Read-only category listing
- `GET /api/autocomplete/:field` — Distinct values for card/entity/category

Curve sync:
- `GET/PUT /api/curve/config` — Per-user config (folder, schedule, stats). Legacy `imap_*` fields accepted for App Password holdouts; new users never write them.
- `POST /api/curve/sync` — Trigger manual sync (used by dashboard's "Sincronizar agora")
- `GET /api/curve/sync/status` — Lightweight `last_sync_*` snapshot consumed by the dashboard re-auth banner
- `POST /api/curve/test-connection` — Opens IMAP, returns the folder list (used by both the wizard's folder step and the config page)
- `GET /api/curve/logs` — Audit trail (backed by `curve_logs`)

OAuth wizard (`server/src/routes/curveOAuth.js`):
- `POST /api/curve/oauth/check-email` — Classifies an email domain → `{ provider: 'microsoft' | 'google' | null }`
- `POST /api/curve/oauth/start` — Kicks off MSAL `acquireTokenByDeviceCode`, returns `{ userCode, verificationUri, expiresAt }`
- `GET /api/curve/oauth/poll` — Polled ~every 3 s by the frontend during the DAG; resolves to `pending | completed | failed | cancelled`
- `POST /api/curve/oauth/cancel` — Aborts the pending DAG session (user backed out)
- `GET /api/curve/oauth/status` — Returns `{ connected, provider, email }` for the current user (feeds the dashboard banner gate and the config page's Ligação card)
