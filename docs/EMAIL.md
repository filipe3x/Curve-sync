# Email Pipeline — Setup & Implementation Guide

This document covers everything needed to implement the core feature of Curve Sync: pulling Curve Card receipt emails via IMAP and parsing their HTML content into expense records.

## Current State

### What's Done

| Component | Location | Status |
|-----------|----------|--------|
| Expense model (with digest unique index) | `server/src/models/Expense.js` | Done |
| CurveConfig model (IMAP credentials, sync settings) | `server/src/models/CurveConfig.js` | Done |
| CurveLog model (audit trail, TTL 90 days) | `server/src/models/CurveLog.js` | Done |
| `computeDigest()` — SHA-256 matching `curve.py` | `server/src/services/expense.js` | Done |
| `assignCategory()` — entity-based auto-categorization | `server/src/services/expense.js` | Done |
| `GET/PUT /api/curve/config` | `server/src/routes/curve.js` | Done |
| `GET /api/curve/logs` | `server/src/routes/curve.js` | Done |
| `POST /api/expenses` (with digest dedup + auto-category) | `server/src/routes/expenses.js` | Done |
| `node-cron` dependency | `server/package.json` | Installed (unused) |

### What's Missing

| Component | Target Location | Status |
|-----------|----------------|--------|
| Email HTML parser (cheerio) | `server/src/services/emailParser.js` | Done (Phase 1) |
| `cheerio` dependency | `server/package.json` | Installed |
| IMAP reader | `server/src/services/imapReader.js` | Done (Phase 2) |
| `imapflow` dependency | `server/package.json` | Installed |
| `POST /api/curve/test-connection` | `server/src/routes/curve.js` | Done (Phase 2) |
| Sync orchestrator | `server/src/services/syncOrchestrator.js` | **Not started** |
| Scheduler (node-cron) | `server/src/services/scheduler.js` | **Not started** |
| `POST /api/curve/sync` | `server/src/routes/curve.js` | Placeholder only |

---

## Reference Implementation: `curve.py`

Source: `docs/embers-reference/curve.py`

The original Python script reads a raw Curve Card email from stdin and extracts expense data using BeautifulSoup. Key details:

### Decoding

```python
# Find HTML start marker
start_index = encoded_content.find('<!doctype html>')
# Decode quoted-printable encoding
decoded_email_iso = quopri.decodestring(encoded_content[start_index:])
decoded_email_utf8 = decoded_email_iso.decode('utf-8')
```

### CSS Selectors (Critical)

| Field | Selector | Logic |
|-------|----------|-------|
| **entity** | `td.u-bold` | First `<td>` with class `u-bold` |
| **amount** | `td.u-bold` (next sibling) | `entity_tag.find_next_sibling('td', class_='u-bold')`, then strip `€` |
| **date** | `td.u-greySmaller.u-padding__top--half` | First match of both classes |
| **card** | `td.u-padding__top--half` | **Penultimate** element: `find_all(...)[-2]`, then join stripped strings |

### Digest Formula

```python
combined_data = entity + amount + date + name_and_card
unique_id = hashlib.sha256(combined_data.encode('utf-8')).hexdigest()
```

This is already replicated in `server/src/services/expense.js:computeDigest()`.

### Production Cronjob (Embers — for reference)

```bash
* * * * * offlineimap -o && \
  find "/home/ember/Mail/Outlook365/Curve Receipts/new" -type f -mmin -70 \
  -exec sh -c 'cat "$0" | timeout 30 python /var/www/embers/curve.py' {} \; || true
```

Known issues with this approach: no error recovery, no logging, offlineimap can block, concurrent processes accumulate, OAuth token expiry causes silent failures. The standalone version solves all of these.

---

## Outlook365 / Microsoft 365 Authentication

**This is the single biggest constraint on Phase 2.** The dev mailbox for
Curve receipts lives on Outlook / Microsoft 365, which no longer accepts
plain IMAP passwords for most accounts.

### What Embers did (and why it broke)

The legacy Embers pipeline used `offlineimap` (external tool, cron every
minute) to mirror the `Curve Receipts` folder to disk, then piped each
file into `curve.py`. The IMAP credentials lived in `~/.offlineimaprc`
outside the Embers repo — **no trace of them exists in the
`docs/embers-reference/` tree**, which is why grep for `oauth`, `client_id`,
`tenant_id`, etc. returns nothing.

The comment at `docs/EMAIL.md:78` — *"OAuth token expiry causes silent
failures"* — is the tell: offlineimap was configured with XOAUTH2 (refresh
token flow against Azure AD). When the refresh token expired, offlineimap
kept running silently, the cron kept piping zero new emails, and expenses
stopped flowing without any log trace. That single failure mode is the
main reason Curve Sync exists as a standalone service.

### Microsoft's current stance

- **Basic Authentication for IMAP/POP is disabled by default since
  October 2022** for almost every Microsoft 365 tenant. Personal
  outlook.com accounts had it disabled in September 2024.
- There are only two supported mechanisms for IMAP access today:
  1. **App Passwords** — a secondary 16-character credential that
     bypasses MFA for legacy protocols. Requires MFA / 2-step verification
     to be ENABLED on the account first (counterintuitively: no MFA → no
     app passwords). Generated at <https://account.microsoft.com/security>
     → Advanced security options → App passwords.
  2. **OAuth2 (XOAUTH2 / Modern Auth)** — requires registering an Azure AD
     application, obtaining `client_id` / `tenant_id`, running a one-time
     consent flow to get a refresh token, then exchanging that refresh
     token for short-lived access tokens on every IMAP connect.

### Curve Sync's chosen approach

**Phase 2 ships with App Password support only. OAuth2 is a later
upgrade.**

Rationale:

| Criterion | App Password | OAuth2 |
|---|---|---|
| Setup time | 2 minutes in MS account UI | Azure AD app registration, consent flow, token endpoint |
| Day-1 usability | Works immediately | Requires additional cloud setup the user doesn't need yet |
| Schema changes | None (reuse `imap_password`) | New fields: `oauth_tenant_id`, `oauth_client_id`, `oauth_refresh_token`, `oauth_access_token`, `oauth_expires_at` |
| Silent failure mode | App password revoked → hard 535 auth error (visible in logs) | Refresh token expires → silent, exactly what killed Embers |
| MFA requirement | Must be enabled (hard requirement) | Not required (app is the principal) |

The existing `CurveConfig` schema already stores a plain `imap_password`
string. For App Passwords this is sufficient — the user just pastes the
16-character generated password into that field instead of their real
account password. **No schema migration needed for Phase 2.**

Phase 6 (security) will add AES-256 encryption at rest for that field so
the app password isn't stored in plaintext in MongoDB.

### Frontend guidance

The `/curve/config` page must make this obvious to the user: the
"Password" field is NOT the Outlook account password, it is an App
Password. Current UX updates (committed alongside Phase 2 prep):

- Label changed to **"App Password"** (not "Password")
- Help text under the field explaining the two requirements:
  1. MFA / 2-step verification must be on
  2. Generate at account.microsoft.com → Security → App passwords
- Banner at the top of the form pointing Outlook/Microsoft 365 users to
  the App Password flow, with a note that Gmail users follow the same
  App Password flow at <https://myaccount.google.com/apppasswords>

### What happens later (OAuth2, Phase 7+)

When OAuth2 becomes necessary (e.g., if Microsoft disables App Passwords
too, or for multi-user deployments where each user shouldn't have to
enable MFA):

- `CurveConfig` schema gets new fields listed above
- `imapReader.js` gains a branch: if `oauth_refresh_token` set, perform
  `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` to
  mint an access token, then authenticate IMAP with XOAUTH2
- Frontend adds a toggle: "Auth mode: App Password | OAuth2"
- A new route `GET /api/curve/oauth/callback` handles the consent flow
- A background refresh job re-mints access tokens before they expire, and
  **loudly errors** if the refresh token is dead — no more silent-failure
  Embers repeat

Do NOT add this until a concrete need exists. Over-engineering the auth
layer before the rest of the pipeline works is exactly how Phase 2 ships
late.

---

## Dependencies to Install

```bash
cd server && npm install cheerio imapflow
```

| Package | Purpose | Notes |
|---------|---------|-------|
| `cheerio` | HTML parsing (replaces BeautifulSoup) | Use `load()` + CSS selectors |
| `imapflow` | IMAP client (replaces offlineimap) | Modern, Promise-based, handles MIME decoding |

> `quoted-printable` is likely unnecessary — `imapflow` decodes MIME content automatically when fetching with `source: true` or `bodyParts`.

---

## Implementation TODOs

### Phase 0 — Standalone Validation Script (DONE)

**Goal**: Ground-truth CLI tool to verify email parsing against real fixtures before (and after) implementing the production parser.

**Status**: Implemented at `server/scripts/validate-fixtures.js` — **zero dependencies** (pure Node.js stdlib: `fs`, `path`, `crypto`). No `npm install` needed.

**How to run**:

```bash
# Default path: server/test/fixtures/emails/
node server/scripts/validate-fixtures.js

# Or pass a custom directory
node server/scripts/validate-fixtures.js /path/to/emails
```

**Output format**: For each fixture, prints `entity / amount / date / card / digest` or a `[FAIL]` line with the error message. Exits with code 1 if any fixture fails.

**Implementation notes**:
- Mirrors `curve.py` exactly: finds `<!doctype html>` marker, decodes quoted-printable to UTF-8, applies identical CSS selector logic
- Uses regex + minimal HTML entity decoder instead of cheerio (sufficient for known Curve email templates)
- Will serve as regression tool once `emailParser.js` exists — both should produce identical output for the same inputs

### Phase 1 — Email Parser (`emailParser.js`) — DONE

Implemented at `server/src/services/emailParser.js`. Key design decisions:

- **Input tolerance**: accepts either raw MIME email (with headers +
  quoted-printable body) OR already-decoded HTML. Auto-detects via
  `<!doctype html>` marker (case-insensitive) with `<html>` fallback.
- **Required vs optional fields** (matches `Expense` mongoose schema):
  - REQUIRED: `entity`, `amount`, `date` — missing any → `ParseError`,
    orchestrator logs as `parse_error`, email left UNSEEN for retry.
  - OPTIONAL: `card` — missing → warning, expense still inserted (digest
    computed with empty card, so dedup is weaker for that row only).
- **Layered fallbacks** (future-proof against template changes):
  - `entity`: `td.u-bold` → `.u-bold` (any tag)
  - `amount`: `entity.nextSibling(td.u-bold)` → 2nd global `td.u-bold` →
    regex `/€\s*-?\d[\d.,]*/` on raw HTML
  - `date`: `td.u-greySmaller.u-padding__top--half` → `td.u-greySmaller` →
    regex `/\d{1,2}\s+[A-Za-z]+\s+\d{4}\s+\d{1,2}:\d{2}:\d{2}/`
  - `card`: penultimate `td.u-padding__top--half` (no fallback — optional)
- **Amount parsing** (`parseAmount`): tolerates `€X.XX`, `X,XX€`, `EUR X`,
  European thousands `1.234,56`, US thousands `1,234.56`, negatives for
  refunds. Returns a `Number`.
- **Digest** stays bit-for-bit compatible with `curve.py`: computed from
  the RAW amount STRING (`€` stripped) not the parsed Number, so
  `"1,234.56"` produces the same hash on both sides. Embers' parallel
  curve.py ingestion hits the same unique index and dedup works.
- **Never crashes**: `ParseError` is the only exception type thrown.
  Anything unexpected is a parser bug, not an email problem — the
  orchestrator's per-email try/catch catches both cases so one bad email
  cannot stop a sync run.
- **Smoke test**: `node server/scripts/test-parser.js` runs the parser
  over all fixtures in `server/test/fixtures/emails/`. Output must match
  `validate-fixtures.js` (the zero-dep ground truth). Both currently
  produce identical digests for the 5 real fixtures on disk.

### Phase 2 — IMAP Reader (`imapReader.js`) — DONE

Implemented at `server/src/services/imapReader.js`. Key points:

- **Class-based `ImapReader`** with explicit `connect()` → `openFolder()`
  → `fetchUnseen()` → `markSeen(uid)` → `close()` lifecycle. The
  orchestrator (Phase 3) drives this step-by-step so it can decide
  per-email whether to mark seen based on insert success.
- **Basic auth only** (App Password). User pastes a 16-char App Password
  into `CurveConfig.imap_password`. No XOAUTH2 yet — see Outlook365
  section above for why and for the future migration plan.
- **`ImapError` with `code`** — `CONFIG`, `AUTH`, `CONNECT`, `FOLDER`,
  `FETCH`, `FLAG`, `UNKNOWN`. The route layer maps these to HTTP status
  codes so the frontend can surface a useful hint (e.g., 401 for AUTH).
- **`fetchUnseen()` returns raw email source as a `latin1` string** —
  same byte-preserving convention as `validate-fixtures.js` uses for
  on-disk fixtures, so `emailParser.extractHtml()` can run its
  quoted-printable decoder on the result unchanged. The parser and
  reader share no state besides that string contract.
- **`markSeen(uid)` is only called by the orchestrator on success** (or
  confirmed duplicate). Parse errors leave the email UNSEEN, so the next
  sync retries it automatically — this is how one bad email fails
  gracefully without losing ground.
- **`close()` is best-effort** (swallows logout errors). Orchestrator
  wraps everything in `try/finally`.
- **`testConnection(config)` convenience function** — one-shot
  connect → list folders → disconnect, used by `POST /api/curve/test-connection`.

**Wired route:** `POST /api/curve/test-connection` now reads the stored
`CurveConfig`, attempts a connection via `testConnection()`, and returns
the folder list on success. The "Testar ligação" button in
`/curve/config` calls this end to end. Error responses map `ImapError.code`
to HTTP status so the UI shows distinct messages for wrong-host (503),
wrong-password (401), wrong-folder (404), and missing-config (400).

### Phase 3 — Sync Orchestrator (`syncOrchestrator.js`)

- [ ] Create `server/src/services/syncOrchestrator.js`
- [ ] Main function: `syncEmails(configId)` or `syncEmails(userId)`
- [ ] Pipeline per email: parse HTML -> compute digest -> check duplicate -> insert expense -> create log entry -> mark seen
- [ ] Per-email error handling (one failure doesn't block others)
- [ ] Create `CurveLog` entry for every email (status: `ok`, `duplicate`, `parse_error`, `error`)
- [ ] Update `CurveConfig.last_sync_at`, `last_sync_status`, `emails_processed_total`
- [ ] Return summary: `{ synced, duplicates, parseErrors, errors, total }`
- [ ] Support `dry_run` flag (logs everything but skips DB insert + mark seen)

### Phase 4 — Wire Up Routes

- [ ] Implement `POST /api/curve/sync` — calls orchestrator, returns summary
- [ ] Implement `POST /api/curve/test-connection` — IMAP connect + list folders + disconnect
- [ ] Add proper error responses (401 for auth fail, 503 for connection issues)

### Phase 5 — Scheduler (`scheduler.js`)

- [ ] Create `server/src/services/scheduler.js`
- [ ] Use `node-cron` to run sync at interval from `CurveConfig.sync_interval_minutes`
- [ ] Add concurrency lock (prevent overlapping executions)
- [ ] Initialize scheduler on server startup
- [ ] Re-schedule when config is updated via API
- [ ] Log scheduler start/stop/error events

### Phase 6 — Environment & Security

- [ ] Add new env vars to `server/.env.example`:
  - `IMAP_ENCRYPTION_KEY` — for AES-256 password encryption at rest
- [ ] Encrypt IMAP passwords before storing in `CurveConfig`
- [ ] Decrypt on read when connecting to IMAP

---

## Dev Environment Strategy

The main challenge for local development: **where do the test emails come from?**

### Layer 1 — Parser with Fixtures (no network needed)

**Goal**: Develop and validate `emailParser.js` in complete isolation.

1. Save 2-3 real Curve Card receipt HTML files in `server/test/fixtures/emails/`
   - Get these from the Outlook365 mailbox (view source / export `.eml`)
   - Sanitize any personal data if needed
2. Write the parser against these fixtures
3. Validate output matches what `curve.py` would produce for the same emails
4. Cross-check digest output with `computeDigest()` from `expense.js`

**This is the fastest path to progress** — zero network dependency, instant feedback loop.

### Layer 2 — IMAP Against Real or Test Account

**Option A** (recommended): Use the real Outlook365 account with the "Curve Receipts" folder. It already has historical emails. Set credentials in `server/.env`.

**Option B**: Create a test IMAP account (Gmail with app password, or a service like Mailtrap/Ethereal) and forward/copy some real Curve emails there.

```env
# server/.env (dev)
IMAP_SERVER=outlook.office365.com
IMAP_PORT=993
IMAP_USERNAME=your-email@outlook.com
IMAP_PASSWORD=your-app-password
IMAP_FOLDER=Curve Receipts
```

### Layer 3 — Orchestrator with Dry Run

1. Wire parser + IMAP reader in the orchestrator
2. Use `dry_run: true` flag — runs the full pipeline but:
   - Does NOT insert expenses into MongoDB
   - Does NOT mark emails as `\Seen`
   - DOES create log entries (for debugging)
3. Review logs to confirm everything works before going "live"
4. Flip off dry run, test with a single email, verify expense appears in DB

### Layer 4 — Scheduler (final step)

Only enable after the manual `POST /api/curve/sync` works reliably. Start with a long interval (e.g., 60 minutes) and reduce once stable.

---

## Architecture Diagram

```
┌─────────────┐     ┌──────────────┐     ┌───────────────┐
│  Scheduler   │────>│  Sync        │────>│  IMAP Reader  │
│ (node-cron)  │     │  Orchestrator│     │  (imapflow)   │
└─────────────┘     └──────┬───────┘     └───────┬───────┘
                           │                      │
       ┌───────────────────┤                      │ UNSEEN emails
       │                   │                      │
       v                   v                      v
┌─────────────┐     ┌──────────────┐     ┌───────────────┐
│  CurveLog   │     │  Expense     │     │  Email Parser │
│  (audit)    │     │  (insert +   │     │  (cheerio)    │
│             │     │   dedup)     │     │               │
└─────────────┘     └──────────────┘     └───────────────┘
                           │
                    ┌──────┴───────┐
                    │ computeDigest│
                    │ assignCategory│
                    └──────────────┘
```

**Manual trigger**: `POST /api/curve/sync` calls the orchestrator directly (bypasses scheduler).

**Test connection**: `POST /api/curve/test-connection` calls IMAP reader connect/disconnect only.

---

## Key Constraints

- **Deduplication**: The digest (SHA-256 of `entity+amount+date+card`) is a unique index on `expenses`. Duplicate inserts return 409 — this is expected and safe.
- **Expenses are INSERT-only**: Never update or delete existing expense records (owned by Embers).
- **Mongoose snake_case**: All timestamps use `created_at`/`updated_at` for Mongoid compatibility.
- **Mark Seen last**: Only mark an email as `\Seen` after the expense is successfully inserted (or confirmed as duplicate). If parsing fails, leave it UNSEEN for retry.
- **Single user (for now)**: Routes currently return the first `CurveConfig`. Multi-user scoping is Phase 2.
