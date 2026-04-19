# Email Pipeline — Setup & Implementation Guide

This document covers everything needed to implement the core feature of Curve Sync: pulling Curve Card receipt emails via IMAP and parsing their HTML content into expense records.

## Current State

All components of the email pipeline are shipped. The table below
maps each piece to its code location — see the phase-by-phase sections
further down for the design rationale behind each one.

| Component | Location |
|-----------|----------|
| Expense model (with `(digest, user_id)` compound unique index) | `server/src/models/Expense.js` |
| CurveConfig model (IMAP credentials, sync settings, OAuth fields) | `server/src/models/CurveConfig.js` |
| CurveLog model (audit trail, TTL 90 days) | `server/src/models/CurveLog.js` |
| `computeDigest()` — SHA-256 matching `curve.py` | `server/src/services/expense.js` |
| `assignCategoryFromList()` — entity-based auto-categorization | `server/src/services/expense.js` |
| Email HTML parser (cheerio, with regex fallbacks) | `server/src/services/emailParser.js` |
| IMAP reader — dual auth: App Password + XOAUTH2 via `createImapReader()` | `server/src/services/imapReader.js` |
| Sync orchestrator — parse → dedup → insert → log pipeline | `server/src/services/syncOrchestrator.js` |
| Scheduler (node-cron, iterates per-config) | `server/src/services/scheduler.js` |
| `GET/PUT /api/curve/config` | `server/src/routes/curve.js` |
| `POST /api/curve/sync` (manual trigger + `?dry_run=1`) | `server/src/routes/curve.js` |
| `POST /api/curve/test-connection` (IMAP smoke test + folder list) | `server/src/routes/curve.js` |
| `GET /api/curve/logs` | `server/src/routes/curve.js` |
| `POST /api/expenses` (with digest dedup + auto-category) | `server/src/routes/expenses.js` |
| OAuth wizard routes (`/api/curve/oauth/*`) | `server/src/routes/curveOAuth.js` |

Authentication lives in a sibling doc: see
[`EMAIL_AUTH.md`](./EMAIL_AUTH.md) for the OAuth wizard + token
lifecycle and [`EMAIL_AUTH_MVP.md`](./EMAIL_AUTH_MVP.md) for the V2
rollout history (direct XOAUTH2 via `@azure/msal-node`, replacing the
V1 `email-oauth2-proxy` bridge that shipped in the original Embers
pipeline).

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

## IMAP Authentication — see [`EMAIL_AUTH.md`](./EMAIL_AUTH.md)

Curve Sync uses direct XOAUTH2 against `outlook.office365.com:993` via
`@azure/msal-node`. The full architecture — OAuth wizard, MSAL token
cache, encrypted persistence, silent refresh, re-auth banner — lives
in `EMAIL_AUTH.md`. The MVP rollout and acceptance criteria live in
`EMAIL_AUTH_MVP.md`. This section only captures what the email
pipeline (this doc) needs to know about the auth layer, plus the
historical context that motivates the whole project.

### Historical context: the silent-failure mode

The legacy Embers pipeline used `offlineimap` (cron every minute) to
mirror the `Curve Receipts` folder to disk, then piped each new file
into `curve.py`. `offlineimap` itself did NOT talk OAuth — it connected
to a loopback `email-oauth2-proxy` (Simon Robinson's Python bridge),
which held a Fernet-encrypted refresh token and translated plain IMAP
into XOAUTH2 against Microsoft.

```
curve.py  ←  cat  ←  offlineimap  →  127.0.0.1:1993  →  OAuth2/IMAP  →  outlook.com
             (Maildir)   (plain IMAP)    (email-oauth2-proxy)           (real Microsoft)
```

When the refresh token inside `emailproxy.config` expired, the proxy
silently returned zero new messages, `offlineimap` dutifully reported a
successful sync of nothing, and expenses stopped flowing without any
log trace. That single silent-failure mode is the main reason Curve
Sync exists as a standalone service — and why the orchestrator still
raises `last_sync_status = 'error'` when a sync that historically saw
traffic suddenly sees none. The V1 proxy topology (including its
systemd unit and the Pi installation runbook) has been retired — V2
speaks XOAUTH2 directly from Node and owns the token lifecycle in
MongoDB.

### What this means for `imapReader.js`

The IMAP reader is constructed via an async factory,
`createImapReader(config)`, which picks one of two auth branches based
on whether `config.oauth_provider` is set:

| Branch | `oauth_provider` | How `imapflow` connects |
|---|---|---|
| **OAuth (XOAUTH2)** — default for new users | `'microsoft'` | MSAL `acquireTokenSilent` returns a fresh access token from the encrypted cache on `CurveConfig`; `imapflow` opens a TLS session to `outlook.office365.com:993` with `auth: { user, accessToken }`. Refresh is transparent; corrupt / revoked caches raise `OAuthReAuthRequired`, which the orchestrator maps to `ImapError('AUTH')`. |
| **Legacy App Password** — holdout | `null` | The stored `imap_password` (AES-256-GCM encrypted in Mongo, decrypted at read) is passed as `auth: { user, pass }`. The fields `imap_server` / `imap_port` / `imap_tls` drive the connection. New users never write these — the wizard only produces OAuth configs. |

Both branches land on the same `imapflow` client, so everything
downstream in `syncOrchestrator.js` is auth-agnostic. Future provider
support (Gmail is the next target — see `EMAIL_AUTH.md` §2.2 for the
fan-out plan) will add a third value to `oauth_provider` without
disturbing the parser, the dedup path, or the scheduler.

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
- **Dual auth via `createImapReader(config)` factory**. The factory
  inspects `config.oauth_provider`:
    - `null` → legacy App Password branch: `imapflow` opens TLS to
      `outlook.office365.com:993` (or whatever `imap_server` says) with
      `auth: { user, pass }` using the decrypted `imap_password`.
    - `'microsoft'` → OAuth branch: `oauthManager.getOAuthToken(config)`
      returns a fresh XOAUTH2 access token from the encrypted MSAL
      cache, which `imapflow` consumes as `auth: { user, accessToken }`.
      A missing / revoked / expired refresh token raises
      `OAuthReAuthRequired`, classified by the orchestrator as
      `ImapError('AUTH')` and surfaced in the dashboard re-auth banner.

  Both branches land on the same `ImapReader` instance, so the
  orchestrator, dedup path, and scheduler are auth-agnostic. See
  `EMAIL_AUTH.md` for the full OAuth token lifecycle.
- **`imap_tls` toggle** (default `true`): retained for the legacy
  branch, which historically needed to disable TLS for loopback relays.
  OAuth configs always connect over TLS to `outlook.office365.com:993`.
- **`ImapError` with `code`** — `CONFIG`, `AUTH`, `CONNECT`, `FOLDER`,
  `FETCH`, `FLAG`, `UNKNOWN`. The route layer maps these to HTTP status
  codes so the frontend can surface a useful hint. Note: `AUTH` maps to
  **502** (Bad Gateway), not 401 — a 401 on `/api/curve/*` would collide
  with the session-expiry dispatch in the frontend's API wrapper.
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

### Phase 3 — Sync Orchestrator (`syncOrchestrator.js`) — DONE

Coordinates parser + IMAP reader + Mongo inserts + logging. The bullet
list at the bottom of this section is the original implementation
punch list (now all shipped); everything above it is design rationale
captured during pre-implementation analysis so a future reader can
understand *why* the orchestrator is shaped the way it is — all the
tripwires we hit on paper before writing any code.

#### Signature and multi-user scoping (decided: day 1)

```js
syncEmails({ config, reader, dryRun = false }) → Promise<Summary>
```

- Takes a full `CurveConfig` document, NOT a `configId` or `userId`.
  The orchestrator does zero `findOne()` calls — the caller (route
  handler, scheduler) is responsible for picking the right config.
  This makes multi-user scoping a non-event: just pick a different
  config in the caller.
- Every write to `Expense` and `CurveLog` uses `config.user_id`
  directly — both schemas require it.
- Also takes a `reader` (see next section) — dependency injection, not
  constructed internally.

#### Reader abstraction (decided: dev-mode safety)

The orchestrator does NOT construct an `ImapReader` itself. It accepts
a reader object implementing this contract:

```js
interface EmailReader {
  connect(): Promise<void>
  fetchUnseen(): AsyncIterable<{uid, source}>   // async generator
  markSeen(uid): Promise<void>
  close(): Promise<void>
}
```

Two implementations ship in Phase 3:

1. **`ImapReader`** (existing, Phase 2) — talks to real IMAP. Used in
   production sync and for realistic end-to-end tests.
2. **`FixtureReader`** (new, Phase 3) — reads raw `.eml`-style files
   from `server/test/fixtures/emails/`, yields them as
   `{uid: <index>, source: <latin1 string>}`, and `markSeen` is a
   no-op. Zero IMAP traffic.

This DI pattern is the clean answer to *"dev on the Pi must not touch
production emails"*. There is no `dev_mode` flag, no environment
branching inside the orchestrator — the same function runs everywhere;
only the reader changes.

**Dev workflows (all risk-free against production mailbox):**

- **Primary: fixtures loop.** Caller instantiates
  `FixtureReader('server/test/fixtures/emails/')` and passes it to
  `syncEmails()`. Zero IMAP traffic. First run inserts the fixtures
  as real expenses in Mongo; subsequent runs hit the digest unique
  index and fall into the `duplicate` path. This exercises parser +
  digest + dedup + insert + log + summary contract in a deterministic
  loop. No production emails touched because there's no connection to
  Outlook at all.
- **Secondary: Outlook sandbox folder.** When you genuinely need to
  test `ImapReader` itself (auth, folder open, streaming fetch,
  markSeen round-trip), create a subfolder `Curve Receipts/dev-sandbox`
  in Outlook, copy a handful of historical Curve emails into it, mark
  them unread. Create a second `CurveConfig` row with
  `imap_folder = 'Curve Receipts/dev-sandbox'` and
  `sync_enabled: false` (so the scheduler ignores it). Trigger the run
  manually with `POST /api/curve/sync?config_id=<devConfigId>`.
  `markSeen` only touches the sandbox subfolder — production
  `Curve Receipts` is never opened by that run.
- **Tertiary: `dry_run` against production.** Read-only pass through
  the real mailbox. Never writes to Mongo, never marks anything seen.
  Useful as a sanity check right before enabling the scheduler for the
  first time.

#### Per-email pipeline (in order)

For each `{uid, source}` yielded by the reader:

1. `parseEmail(source)` — may throw `ParseError`. Caught → log
   `parse_error`, increment the in-run consecutive-parse-error counter,
   **do not markSeen** (so next sync retries automatically once the
   parser is fixed). See "Circuit breaker" below for the escape hatch.
2. `computeDigest({entity, amount, date, card})` — operates on raw
   strings (with `€` stripped from amount) to match `curve.py`
   bit-for-bit. Embers and Curve Sync inserting the same email produce
   the same digest, so the unique index de-dupes across both ingestion
   paths.
3. `assignCategoryFromList(entity, categoriesCache)` — uses an
   in-memory array of categories loaded **once** at sync start.
4. `Expense.create({ ..., user_id: config.user_id, category_id })` —
   may throw `MongoServerError` with `code: 11000`.
5. **Duplicate detection trap**: if `err.code === 11000`, check
   `err.keyPattern?.digest` is set before classifying as duplicate.
   A collision on any *other* future unique index must NOT be silently
   treated as a duplicate. If it's the digest index → log `duplicate`,
   markSeen, continue. If it's another index → log `error`, do NOT
   markSeen.
6. On unexpected error (not 11000): log `error` with truncated
   `error_detail`, do NOT markSeen. Next sync retries.
7. On successful insert: log `ok` with the `expense_id`, update the
   in-run "saw an OK" flag (resets the parse-error streak), then
   `reader.markSeen(uid)`. **Critical recovery invariant**: if
   markSeen itself fails, the email stays UNSEEN → next sync
   reprocesses it → the insert hits the digest unique index → the
   duplicate path (step 5) retries markSeen. This is the mechanism
   that heals half-applied writes. Do NOT "optimize" the duplicate
   path to skip markSeen — that would break recovery.

#### Circuit breaker for parse errors (decided: A+C)

If the orchestrator sees **≥10 consecutive `parse_error` with 0 `ok`**
in the same run, it halts immediately:

- Writes `CurveConfig.last_sync_status = 'error'`
- Writes a summary `CurveLog` entry with
  `error_detail: 'circuit breaker: 10 consecutive parse errors without
  a successful parse — halting to avoid retry storm'`
- Returns a partial summary with `halted: true`

No persistent state — the counter is per-run, reset every invocation.
Next sync tries again from scratch, which is the right behaviour if
the parser was just fixed between runs. The dashboard shows
`last_sync_status = 'error'` loudly, which is the user-visible signal
to investigate. The streak counter resets to zero on any `ok`, so a
single good email mid-run keeps the sync going.

#### Silent-failure canary (decided: `last_email_at` + 3-day red)

The failure mode we're guarding against: sync runs look healthy
(`last_sync_status = 'ok'`), but the mailbox is returning zero new
emails because of an upstream problem (OAuth refresh token revoked but
`acquireTokenSilent` still returning a stale hit somehow; the Curve
Receipts folder rule broke; Microsoft changed something). This is the
Embers failure mode that motivates Curve Sync's existence.

**Schema addition (`CurveConfig`):**

```js
last_email_at: { type: Date },
```

Updated whenever a sync produces a `status: 'ok'` log entry (i.e. a
genuinely new expense). Duplicates do NOT update it — they do not
represent new traffic.

**Dashboard rule (frontend):**

- Green / normal if `last_email_at` is within the last 3 days.
- **Red / warning** if `last_email_at` is older than 3 days AND
  `last_sync_at` is recent (≤1 day). This is the tell: syncs are
  happening but they're not finding anything, which is exactly the
  silent-failure mode.
- Neutral if both are stale (sync is off) or both are fresh (healthy).

The 3-day threshold is a frontend constant (`STALE_EMAIL_DAYS = 3`) so
it can be tuned without a backend change. Tests that run against
fixtures will not update `last_email_at` because `FixtureReader`-driven
syncs should not poison the canary — the orchestrator only updates
`last_email_at` when the reader is an `ImapReader`. (Alternative:
update it always, document that the dev config is expected to show a
misleading-recent value. I prefer the first: `FixtureReader` is
side-effect-free in every direction, including stats.)

#### `dry_run` mode

Disables all side effects but preserves full pipeline visibility:

- Parser runs normally.
- Digest is computed normally.
- Duplicate check runs as a read-only query (`Expense.exists({ digest })`),
  no insert.
- **No `Expense.create`** — nothing written to `expenses`.
- **No `reader.markSeen`** — emails stay UNSEEN.
- `CurveLog` entries ARE created, with a new `dry_run: Boolean` field
  on the schema, so dry-run logs are auditable but filterable in the
  UI.
- `CurveConfig` stats (`last_sync_at`, `last_sync_status`,
  `emails_processed_total`, `last_email_at`, `is_syncing`) are NOT
  updated. Dry runs are invisible to the dashboard except via the
  filtered log view.

Response summary from `POST /api/curve/sync` carries `dryRun: true` so
the frontend can render a "simulated" badge on the result.

#### Concurrency lock (interim, pre-Phase 5)

Single-process in-memory lock:

```js
let running = false
export function isSyncing() { return running }
export async function syncEmails(args) {
  if (running) throw new SyncConflictError('sync already in progress')
  running = true
  try { /* ... */ } finally { running = false }
}
```

The route handler catches `SyncConflictError` and returns **409
Conflict** with a helpful message. Phase 5 either promotes this to a
Mongo-level lock (for multi-process deployments) or leans on node-cron's
single-process guarantee if we stay single-process. Either way, this
in-memory flag has to exist now so that `POST /api/curve/sync` while
the scheduler is mid-run can't accidentally open a second IMAP session.

#### New schema fields landing in Phase 3

**`CurveConfig`** gains:

- `last_email_at: { type: Date }` — silent-failure canary (see above).
- `is_syncing: { type: Boolean, default: false }` — UI hint for "a
  sincronizar agora" badge. NOT the authoritative lock (the in-memory
  flag is). Kept as a separate field instead of adding `'running'` to
  the `last_sync_status` enum, because `last_sync_status` is about the
  outcome of the *last completed* sync, not the current one.

**`CurveLog`** gains:

- `dry_run: { type: Boolean, default: false }` — filter flag for
  audit UI.

#### Performance / resource pitfalls addressed

- **Reader streaming (required change to `imapReader.js`):**
  `fetchUnseen()` must become an `async *fetchUnseen()` generator,
  yielding `{uid, source}` one at a time instead of returning an
  array. Current implementation collects every message into an array
  before returning → a first sync against a mailbox with 5000 unseen
  emails holds ~250 MB of latin1 strings in memory on the Pi (more
  than half its RAM). Generator-style means the parser + insert +
  markSeen runs fully on message N before message N+1 is fetched.
- **Category cache:** `assignCategory(entity)` today does a full
  `Category.find()` per call. The orchestrator loads categories once
  at the start of a run and passes the array to a new
  `assignCategoryFromList(entity, categories)`. Reduces N queries to
  1 per sync. The existing `assignCategory()` stays as-is (it's used
  by the one-off `POST /api/expenses` route).
- **`emails_processed_total`:** cumulative counter, must be updated
  with `$inc: { emails_processed_total: syncedCount }`, not `set`.
  Trivial but easy to get wrong with `findOneAndUpdate`.
- **`close()` timeout:** `imapReader.close()` currently awaits
  `logout()` best-effort with no timeout. If the server doesn't
  respond, the orchestrator hangs indefinitely in the `finally` block.
  Wrap in `Promise.race([logout(), setTimeout(5000)])` so the
  orchestrator always returns.
- **`error_detail` truncation:** truncate to 2000 chars before writing
  to `CurveLog`. A verbose stack trace with `cause` chains can easily
  be 5 KB; multiplied over the 90-day TTL and a flaky week, the
  collection bloats. Utility helper in the orchestrator module.
- **Per-email parse timeout:** wrap `parseEmail()` in
  `Promise.race([parseEmail(source), timeout(10_000)])`. Defence
  against a pathological input triggering a catastrophic regex
  backtrack in cheerio or the fallback regexes. Over-engineering
  today, cheap insurance for later.

#### Deliberately deferred

- **`Expense.date` is a `String`, not a `Date`** — bit-for-bit
  compatibility with `curve.py`, which never parsed the date. This
  means lexicographic ordering over `"22 Mar 2026 14:03:21"` does NOT
  produce chronological order (Apr < Mar alphabetically). The
  orchestrator does not solve this; the dashboard will need its own
  parser once it does month-by-month rendering. **Do NOT change the
  schema** — Embers' parallel ingestion inserts with the same format.
- **Multi-process sync lock** — deferred to Phase 5. In-memory flag
  is enough while Curve Sync runs as a single Node process.
- **Canary enforcement beyond dashboard colouring** — the Phase 3
  orchestrator only writes `last_email_at` and the frontend only
  colours it. Any stronger action (email alert, auto-disable sync
  after N days, SMS) is deferred.
- **Poison-pill persistence** — the circuit breaker is per-run. If a
  persistently broken email keeps re-triggering the breaker on every
  run, that's still visible in the dashboard (`last_sync_status =
  'error'` every sync, `parseErrors` counter growing in logs). We
  accept the noise in exchange for not tracking per-UID state on
  disk.

#### Summary contract

The orchestrator returns:

```js
{
  total: number,              // emails fetched by the reader
  ok: number,                 // new expenses inserted (or would-insert if dryRun)
  duplicates: number,         // dedup hits (not errors)
  parseErrors: number,
  errors: number,             // everything else
  halted: boolean,            // true if circuit breaker fired
  dryRun: boolean,
  durationMs: number,
}
```

The route serializes this verbatim. The dashboard renders a
per-category breakdown; if `halted === true`, it switches to a warning
style and links to the latest CurveLog entries for triage.

#### Implementation checklist (historical punch list — all shipped)

Schema groundwork first (small, safe diffs):

- [x] Add `last_email_at: Date` and `is_syncing: Boolean` to
      `CurveConfig.js`
- [x] Add `dry_run: Boolean` to `CurveLog.js`
- [x] Convert `imapReader.fetchUnseen()` to an `async *` generator
- [x] Add 5-second timeout to `imapReader.close()`
- [x] Extract `assignCategoryFromList(entity, categories)` in
      `services/expense.js` alongside the existing `assignCategory`

Then the orchestrator module itself:

- [x] Create `server/src/services/syncOrchestrator.js`
- [x] Define and document the `EmailReader` contract
- [x] Implement `FixtureReader` for dev / tests
- [x] Implement `syncEmails({ config, reader, dryRun })`
- [x] Per-email pipeline with duplicate 11000 + `keyPattern.digest`
      check
- [x] Circuit breaker (≥10 consecutive parse_errors with 0 ok)
- [x] In-memory sync lock + exported `isSyncing()`
- [x] Category cache loaded once per run
- [x] `error_detail` truncation helper
- [x] Per-email `parseEmail` timeout wrapper
- [x] Canary update (`last_email_at`) only when reader is `ImapReader`

And the glue (overlaps with Phase 4):

- [x] Wire `POST /api/curve/sync` to the orchestrator, handling
      `SyncConflictError` → 409
- [x] Dev test: run `syncEmails()` with `FixtureReader` against a
      clean Mongo, then again, and assert the second run is all
      `duplicates`

### Phase 4 — Wire Up Routes — DONE

`POST /api/curve/sync` (manual trigger, with `?dry_run=1`) and
`POST /api/curve/test-connection` (IMAP smoke test + folder list) live
in `server/src/routes/curve.js` and map `ImapError.code` → HTTP status
via `{ CONFIG: 400, AUTH: 502, CONNECT: 503, FOLDER: 404 }[err.code]`.
The `AUTH → 502` mapping is deliberate: a 401 on `/api/curve/*` would
collide with the frontend `api.request()` wrapper's session-expiry
dispatch and bounce the user to `/login`, which is the wrong UX when
the upstream IMAP/Azure auth is what actually failed. See the comment
block at `server/src/routes/curve.js:215-223` for the full rationale.

### Phase 5 — Scheduler (`scheduler.js`) — DONE

`server/src/services/scheduler.js` runs on `node-cron` with a single
global interval (`startScheduler(intervalMinutes = 5)`). On each tick
it loads `CurveConfig.find({ sync_enabled: true })` fresh, skips any
config whose sync is already in flight (`isSyncing(config._id)` —
in-memory lock from the orchestrator), decrypts the `imap_password`
if present, builds a reader via `createImapReader()`, and calls
`syncEmails()` sequentially for each remaining config. It auto-starts
on boot from `index.js` when any config has `sync_enabled: true`.
Re-reading the config set every tick means `sync_enabled` toggles
made via `PUT /api/curve/config` take effect without a restart. Note:
`sync_interval_minutes` on individual configs is not currently honoured
by the scheduler — every enabled config runs at the same cadence. The
scheduler's own lifecycle events (`started`, `stopped`, per-config
failures) go to `stdout` / `stderr`; per-sync `ok` / `error` rows in
`/curve/logs` come from `syncEmails()` inside the orchestrator.

### Phase 6 — Environment & Security — DONE

`IMAP_ENCRYPTION_KEY` ships in `server/.env.example` and protects both
the legacy `imap_password` field and the OAuth token cache blob via
AES-256-GCM (`server/src/services/crypto.js`). Passwords are encrypted
on `PUT /api/curve/config` and decrypted by `toPlainConfig()` before
`createImapReader()` runs. The same key encrypts the MSAL cache via
`oauthCachePlugin.js`.

---

## Config UX — Folder Picker

### Problem statement

The first real run of `POST /api/curve/sync` against Outlook failed
with:

```
"INBOX/Curve Receipts" doesn't exist. (code=UNKNOWN)
```

Root cause: `CurveConfigPage.jsx` exposes `imap_folder` as a free-text
input. The user typed `INBOX/Curve Receipts`, but the actual folder on
Outlook365 is `Curve Receipts` at root level (confirmed via
`POST /api/curve/test-connection`, which returned 14 folders including
`INBOX`, `Sent`, `Arquivo`, `Continente`, `Curve Receipts`, `FlixBus`,
`Formações`, `Notes`, ...).

Free-text entry is a footgun for this field:

- Any typo, wrong separator (`/` vs `\` vs `.`), or wrong case gives a
  runtime failure invisible until the next sync.
- Different IMAP servers expose the folder hierarchy differently: some
  put everything under `INBOX.*`, others at root, others use quoted
  paths with spaces.
- The user has no way to discover the correct path without reading
  server logs or shelling into mongosh.

### Design constraints

1. **No hardcoding beyond `INBOX` as the universal starting default.**
   The picker must NOT know about provider-specific folder names
   (`Curve Receipts`, `[Gmail]/All Mail`, etc.) — that's user data, not
   configuration.
2. **The user MUST pick a folder from their own server's folder list.**
   Free-text entry is disallowed. The list comes exclusively from the
   live `testConnection` response.
3. **Seamless and natural.** No multi-step wizards, no separate forms
   for credentials vs folder, no modal dialogs. A single page with a
   state-aware dropdown.
4. **Resilient to credential changes.** If the user updates the
   server/password/port, the cached folder list is stale and must be
   reloaded before a new pick is valid.
5. **Backend trusts the client.** No server-side IMAP validation on
   `PUT /api/curve/config` — see rationale below.

### UX flow — first-time setup

1. User opens `/curve/config` with no existing config.
2. Form shows all credential fields plus `imap_folder` as a **disabled
   `<select>`** with a single option `INBOX` selected. Sub-label:
   *"Guarda as credenciais, depois clica **Testar ligação** para
   carregares a lista de pastas."*
3. User fills email + credentials, clicks **Guardar**.
4. `PUT /api/curve/config` succeeds (`user_id` resolved from email),
   config upserted with `imap_folder: 'INBOX'` and
   `imap_folder_confirmed_at: null`.
5. A prominent banner appears below the form:
   > *"Credenciais guardadas. Clica **Testar ligação** para
   > carregar a lista de pastas e escolheres a pasta correcta."*
6. User clicks **Testar ligação** (the existing button, which already
   returns `folders[]` from `POST /api/curve/test-connection` — we
   reuse it as the single entry point for loading the folder list).
7. On success, dropdown transitions to `loaded`:
   - Enables and populates with the `folders[]` array.
   - Banner morphs to:
     > *"Escolhe agora a pasta onde estão os recibos Curve (actualmente
     > a ler de `INBOX`). Ou clica **Manter INBOX** se é mesmo essa que
     > queres."*
8. User picks `Curve Receipts` from the dropdown (or clicks
   **Manter INBOX**).
9. Change auto-saves via `PUT /config`, writing both `imap_folder`
   and `imap_folder_confirmed_at: Date.now()` (see the "Persistent
   confirmation" section below).
10. Brief toast: *"Pasta confirmada: «Curve Receipts»."*
11. Banner disappears (`imap_folder_confirmed_at` is now set). Config
    is complete — user can trigger a sync.

### UX flow — returning user (existing config)

1. User opens `/curve/config`.
2. Form loads from `GET /config`. Dropdown state: `stale`, options =
   `[storedFolder]` (single-item list, pre-selected). No banner if
   `imap_folder_confirmed_at` is set — happy path for a returning
   user whose folder is already confirmed.
3. **No background IMAP traffic on mount.** If the user just wants to
   toggle `sync_enabled` or read the current settings, we don't open
   an IMAP connection to Outlook on every page load — that's extra
   load on the proxy, extra OAuth2 token cycling, and a visible
   2-5 second delay for no reason. The user must click
   **Testar ligação** explicitly if they want to re-pick a folder.
4. When the user clicks **Testar ligação**:
   - State transitions `stale → loading → loaded` (or `error`).
   - Dropdown options replace with the live list.
   - Stored folder stays selected if still present on the server.
     Otherwise the sync-failure flow takes over (section below).
5. With a loaded list, the user can freely open the dropdown and pick
   a different folder. Auto-save handles the rest (writes a fresh
   `imap_folder_confirmed_at` alongside the new `imap_folder`).
6. On `testConnection` failure: inline warning + Retry button under
   the dropdown. The user can still save unrelated field changes via
   the main **Guardar** button; they just can't re-pick the folder
   until a new `testConnection` attempt succeeds.

### UX flow — credentials changed mid-session

1. User edits any of `imap_server`, `imap_port`, `imap_username`,
   `imap_password`, `imap_tls`.
2. `useEffect` on those fields fires and resets the picker:
   - `folderListState` → `stale`
   - `folderOptions` → `[form.imap_folder]` (whatever's currently in
     form state, even if still unsaved)
   - Dropdown sub-label becomes *"Credenciais alteradas — guarda e
     clica **Testar ligação** para recarregar as pastas."*
3. User clicks **Guardar** (to persist the new credentials), then
   **Testar ligação** (to refresh the folder list against the new
   server). Two explicit clicks, zero background traffic.
4. Normal flow resumes once `testConnection` succeeds.

### UX flow — sync failure with FOLDER error

1. `syncEmails()` catches an `ImapError` with `code === 'FOLDER'`.
2. **The orchestrator resets `imap_folder_confirmed_at` to `null`**
   as part of the same `updateOne` that writes
   `last_sync_status='error'`. The previous confirmation is no
   longer trustworthy because the folder it points to is gone.
3. `POST /api/curve/sync` response includes `summary.error` with the
   classified message (e.g. *"folder not found on server: «Curve
   Receipts» doesn't exist"*).
4. `DashboardPage` shows a red card: *"A sincronização falhou: a
   pasta configurada já não existe no servidor. Actualiza a
   configuração."* with a link to `/curve/config`.
5. On arrival at the config page, the folder dropdown gets a red
   border (`aria-invalid`). The banner reappears automatically —
   no special logic needed because `imap_folder_confirmed_at` is
   null again. The user clicks **Testar ligação** to reload the
   list and pick a replacement folder.

### State machine

States:

```
idle    — no credentials saved yet; Testar ligação disabled
stale   — credentials present but folder list not yet loaded
          (returning user on first visit, or credentials just changed)
loading — testConnection call in flight
loaded  — folder list populated; user can pick from the dropdown
error   — last testConnection failed; Retry button visible
```

Transitions (ALL explicit — zero background fetches):

```
idle    →  stale    : user fills credentials and clicks Guardar
stale   →  loading  : user clicks Testar ligação
loading →  loaded   : testConnection succeeds
loading →  error    : testConnection fails
loaded  →  stale    : user edits any credential field
loaded  →  (loaded) : user picks a folder (auto-save; no state change)
error   →  loading  : user clicks Retry (re-triggers Testar ligação)
```

Implemented as three coupled React state slots:

- `folderListState: 'idle' | 'stale' | 'loading' | 'loaded' | 'error'`
- `folderOptions: string[]`
- `folderListError: string | null`

### Auto-save semantics (folder dropdown ONLY)

When the dropdown's value changes AND `folderListState === 'loaded'`:

1. Optimistic UI: update `form.imap_folder` immediately.
2. Debounce 300 ms to collapse rapid toggles.
3. Fire `PUT /api/curve/config` with the full form payload.
4. On success: toast *"Pasta actualizada para «X»"*.
5. On error: revert to the previous value + error toast.

The main **Guardar** button still saves all fields in one shot —
auto-save is a convenience layered on top of the dropdown specifically,
not a replacement for the explicit button. All other fields continue
to require an explicit Save click.

Rationale: the user's mental model of picking a folder from a dropdown
is "click and it's done", not "click and then click Save again". The
explicit Save is reserved for the credentials/password flow, where
optimistic saves would be dangerous.

### Persistent confirmation of the folder pick

The banner must disappear after the user makes an explicit choice
(pick a folder OR confirm the `INBOX` default) AND must stay hidden
across page reloads — otherwise a user who legitimately wants
`INBOX` as their Curve folder would see the same prompt every time.

The state is stored in a new `CurveConfig` field:

```js
imap_folder_confirmed_at: { type: Date, default: null }
```

Lifecycle:

- **`null`** (default for new configs) → banner visible when the list
  is `loaded` AND `folderOptions.length > 1`.
- **Set to `Date.now()`** by any of:
  1. User picks a new folder from the dropdown. Auto-save writes
     `{ imap_folder, imap_folder_confirmed_at: Date.now() }` in a
     single `PUT /config`.
  2. User clicks the **Manter INBOX** dismiss button on the banner.
     This writes only `{ imap_folder_confirmed_at: Date.now() }` to
     `PUT /config` — no folder change.
- **Reset to `null`** by `syncEmails()` when it catches a run-level
  error with `err?.code === 'FOLDER'`. The existing confirmation is
  now stale because the folder it trusted is gone, so the user has
  to re-confirm after re-picking.

This design pattern (confirmed-at timestamp + auto-invalidation on
failure) is cleaner than a plain boolean because:

- Timestamp gives us a debugging datapoint ("when was this last
  confirmed?") at zero extra cost.
- A plain boolean would need an extra "I dismissed this already"
  field — one column does both jobs.
- Auto-invalidation on FOLDER failure means we never have to track
  "did the user dismiss the banner for a folder that no longer
  exists" — the next sync failure implicitly re-arms the prompt.

### Audit trail scope — why config changes don't land in `curve_logs`

`CurveLog` is strictly an **email-level audit trail**. Every entry
either describes a specific email being processed (`ok`, `duplicate`,
`parse_error`) or a run-level abort during fetch/parse (`error`).
Config changes — including the user picking a new folder — do NOT
fit this schema: there's no email, no digest, no entity, no amount.
Pushing them in would pollute the per-email signal the dashboard
relies on (counters, failure rates, stale-email canary).

Config-level observability is handled elsewhere:

- **`CurveConfig.updated_at`** (already maintained by Mongoose via
  `timestamps`) answers "when did the user last change config?".
- **stdout / journalctl** via `console.log('[config] imap_folder
  changed from X to Y')` inside `PUT /config` can be added if we
  ever need more granular visibility — 2 lines of code, zero
  schema change, visible in `journalctl -u curve-sync -f`.
- **A dedicated `curve_config_audit` collection** is only worth
  building when this service goes multi-user AND we need to answer
  questions like "which admin changed my sync schedule?". Until
  then it's overkill.

### Why client-side validation only

We considered having `PUT /api/curve/config` open an IMAP connection
and verify the folder exists on save. Rejected:

1. **Latency.** A cold IMAP connect + login + folder list takes 2-5
   seconds against Outlook. That penalty applies to every config save,
   even ones that don't touch the folder (e.g. toggling `sync_enabled`).
2. **Availability coupling.** A transient Microsoft outage (or a
   silent-refresh failure inside MSAL) would block unrelated config
   updates.
3. **Redundancy.** The client ALREADY has the authoritative list from
   the most recent `testConnection` call. Saving any folder outside
   that list requires bypassing the UI, at which point the user has
   bigger problems.
4. **Sync is the source of truth anyway.** If the folder disappears
   between save and sync, the run fails gracefully with `code=FOLDER`
   and the dashboard surfaces it (see flow 4 above). The recovery UX
   is the same whether we validated on save or not.

### Migration — existing configs from before the dropdown

The rollout is deliberately **zero-migration**. No backfill script,
no one-off mongosh command, no data surgery.

1. **Schema change is purely additive.** `imap_folder_confirmed_at`
   lands with `default: null`. Every existing `CurveConfig` document
   implicitly gets `imap_folder_confirmed_at = null` on the next read
   — Mongoose inserts the default transparently, the server restart
   does NOT need to touch the collection.

2. **All pre-existing configs land in the needs-re-confirmation
   state.** Because `imap_folder_confirmed_at === null`, the banner
   fires on the next visit to `/curve/config` regardless of what the
   stored `imap_folder` value is (even if it's literally `INBOX`).
   The user clicks **Testar ligação**, the dropdown appears, they
   either keep INBOX (dismiss button writes `confirmed_at = now`) or
   pick a new folder (auto-save writes `confirmed_at = now` as a side
   effect of the same PUT). Either way the config leaves the
   unconfirmed state through the user's explicit action, not via a
   silent migration.

3. **Stored value not in the loaded list.** This is the
   `INBOX/Curve Receipts` case that started this whole thread — the
   stored folder literally doesn't exist on the server. When the
   dropdown is populated from a successful `testConnection`, we
   compute `const isStale = !folderOptions.includes(form.imap_folder)`
   and, if true, inject a **pinned synthetic disabled `<option>`** at
   the top:

   ```jsx
   {isStale && (
     <option value={form.imap_folder} disabled className="text-red-600">
       {form.imap_folder} (não existe — escolha outra)
     </option>
   )}
   {folderOptions.map((f) => (
     <option key={f} value={f}>{f}</option>
   ))}
   ```

   The banner text also flips from amber ("confirme a pasta") to red
   ("a pasta actualmente configurada («INBOX/Curve Receipts») não
   existe no servidor — escolha outra"). No extra state needed — the
   staleness is derived from `form.imap_folder` + `folderOptions` on
   every render.

4. **Recovery path is the same as the happy path.** The user picks a
   valid folder from the list, auto-save fires, the PUT writes both
   `imap_folder` and `imap_folder_confirmed_at = new Date()`, the
   synthetic option disappears on the next render because the stored
   value is now in the list. Zero-touch cleanup.

5. **Silent-failure-free fallback.** If the user ignores the banner
   entirely and triggers a sync, the orchestrator hits the now-fixed
   `classifyError` regex, emits `code=FOLDER`, the finally block
   resets `imap_folder_confirmed_at = null` (which is already null
   anyway in this state), and the frontend banner stays red on the
   next visit. The only way out of the state is to pick a valid
   folder — which is what we want.

No timestamps are forged, no defaults are guessed, no folders are
renamed. The migration is the user clicking one button.

### Why `INBOX` as the single hardcoded default

- It's the **only** universal folder across every IMAP provider
  (Gmail, Outlook365, Fastmail, Fastmail, Yahoo, ProtonBridge, ...).
  The IMAP spec guarantees it exists.
- Safe fallback semantics: if the user somehow skips the picker flow
  and runs a sync against `INBOX`, the parser rejects non-Curve emails
  as `parse_error`. Noisy in `curve_logs`, but not broken — the
  circuit breaker (10 consecutive parse errors) halts the run before
  real damage accumulates.
- Keeps the codebase free of provider-specific logic. We never ship
  a list like `['Curve Receipts', 'Curve', 'Receipts/Curve']` — that's
  user data.

### Anti-patterns rejected

- ❌ **Auto-detect the Curve folder by name heuristic.** Fails for
  localized installs (`Recibos Curve`), fails for renamed folders,
  fails for users who keep Curve emails under a parent like
  `Finance/Curve`. Hardcoded heuristics are brittle.
- ❌ **Two-step wizard (credentials page → folder page).** Over-
  engineered for a 6-field form, doubles the save friction.
- ❌ **Free-text input with `<datalist>` hints.** Still permits typos,
  which is the whole bug we're fixing.
- ❌ **Blocking the first Save until a non-default folder is picked.**
  Chicken-and-egg: can't list folders without saved credentials.
- ❌ **Server-side `mailboxOpen` check on every save.** Latency, see
  above.
- ❌ **A separate `/api/curve/folders` endpoint.** `POST /test-connection`
  already returns the list; a dedicated endpoint adds surface area
  for nothing.
- ❌ **Auto-fetch the folder list on page mount.** Every visit to
  `/curve/config` would open an IMAP connection to Outlook via the
  proxy, even when the user is just toggling `sync_enabled` or
  reading the current value. That's unnecessary load on the proxy,
  unnecessary OAuth2 token cycling, and a visible 2-5 second delay
  on every page load. Explicit click on **Testar ligação** only.
- ❌ **Log folder changes to `curve_logs`.** `CurveLog` is the
  email-level audit trail; config changes belong in `updated_at` or
  `console.log`, not in the table the dashboard uses to count
  `ok` / `duplicate` / `parse_error` outcomes.
- ❌ **A plain boolean `folder_confirmed` flag.** A timestamp gives
  the same UX for free plus a debugging datapoint ("last confirmed
  at") plus a clean auto-invalidation pattern on FOLDER failure.
  One column does the job of two.

### Implementation checklist (frontend)

- [ ] Convert `imap_folder` input → standalone `<select>` component
      (has custom state, doesn't fit the existing `FIELDS` array loop)
- [ ] Add state slots: `folderListState`, `folderOptions`,
      `folderListError`
- [ ] `loadFolders()` helper calling `api.testConnection()` with
      transitions `loading → loaded | error`; reuse the existing
      `handleTest` handler as the single entry point (double duty:
      connectivity smoke-test AND populate the dropdown)
- [ ] `useEffect` on credential fields (`imap_server`, `imap_port`,
      `imap_username`, `imap_password`, `imap_tls`) → reset picker
      to `stale`
- [ ] **NO auto-fetch on mount.** Only on explicit button click.
- [ ] After a successful first `handleSave` (transition `idle → stale`),
      show the banner prompting the user to click **Testar ligação**
- [ ] Banner component rendered when `folderListState === 'loaded'`
      AND `form.imap_folder_confirmed_at == null` AND
      `folderOptions.length > 1`
- [ ] Banner has two CTAs:
  - Dropdown value change → auto-save writes both `imap_folder` and
    `imap_folder_confirmed_at: new Date().toISOString()`
  - **Manter INBOX** button → calls `api.updateCurveConfig({ ...form,
    imap_folder_confirmed_at: new Date().toISOString() })` with no
    folder change
- [ ] Debounced auto-save (300 ms) when dropdown value changes while
      `folderListState === 'loaded'`
- [ ] Red-bordered error state when arriving at config after a sync
      failure (read `imap_folder_confirmed_at == null` combined with
      `last_sync_status === 'error'` as the "just failed" signal)

### Implementation checklist (backend)

- [ ] Add `imap_folder_confirmed_at: { type: Date, default: null }`
      to `CurveConfig` schema (`server/src/models/CurveConfig.js`)
- [ ] Allow `PUT /api/curve/config` to accept and persist
      `imap_folder_confirmed_at` (pass-through — no validation; the
      frontend owns the timing semantics)
- [ ] The `GET /api/curve/config` response already includes any
      schema field via `.lean()`, so no changes needed there beyond
      verifying the new field is present on the returned object
- [ ] In `syncEmails()` (`server/src/services/syncOrchestrator.js`),
      when the finally-block writes `last_sync_status`, also reset
      `imap_folder_confirmed_at: null` iff `runError?.code === 'FOLDER'`.
      Same `updateOne` — no extra round trip
- [ ] `POST /api/curve/test-connection` already returns
      `{ folders: string[] }` — no changes needed there

### Sync scope — cycle-start SINCE + `max_emails_per_run`

Every sync run anchors to the **start of the user's current custom
cycle** (see CLAUDE.md → Custom Monthly Cycle). The IMAP query is
`SEARCH UNSEEN SINCE <cycle_start>`, so emails older than the cycle
boundary are invisible to the reader server-side.

Why cycle-only (and not "all UNSEEN ever"):

- **Embers/curve.py never marked SEEN.** Every historical Curve
  receipt in the mailbox is still UNSEEN. A broader window would
  re-ingest thousands of rows on the first sync.
- **Older Curve templates drift.** `scripts/dryrun-date-schema.js`'s
  Check C shows ~6-month cycles where digests from today's parser
  don't match what was stored historically. A re-ingest of an
  old-template email produces a different digest → unique index
  accepts it → duplicate row. Scoping to the current cycle keeps
  the digest universe to "templates the current parser handles".
- **No UX surface reads across cycles anyway.** Dashboard,
  `/categories/stats`, `/curve/stats/uncategorised` all scope to the
  current cycle, so ingesting outside that window creates rows no
  one ever sees.

The user cannot override this date — there is no `imap_since` field
on the config. The only user control is `sync_cycle_day` (1-28, default
22), which changes the boundary itself. Changing the cycle day also
changes which emails the next sync will pull.

| Guard | Value | Where enforced |
|-------|-------|----------------|
| SINCE = cycle start | derived from `sync_cycle_day` | IMAP server via `SEARCH UNSEEN SINCE <date>` |
| `max_emails_per_run` | `500` (default) | Client-side in `ImapReader.fetchUnseen()` |

**`max_emails_per_run`** is a belt-and-suspenders cap. Even within a
single cycle, a mailbox could in theory carry more than the budget
allows (very large family account, many sub-cards). After yielding
500 messages the generator stops and sets `reader.capped = true`. The
orchestrator surfaces `summary.capped = true` and the route appends
`(limitado a 500 — há mais emails por processar)`. Remaining emails
stay UNSEEN for the next run — no data is lost, just deferred.

**Legacy note.** A `CurveConfig.imap_since` field existed in earlier
builds to allow a user-supplied override. It was removed in the
`drop date_at` release: the override was the only way to reach
outside the current cycle, and every reason to do so traced back to
the template-drift risk above. Existing rows on disk with a populated
`imap_since` are ignored by the reader and can be `$unset` at leisure.

### Related unrelated fixes shipping alongside

These are needed before the dropdown work can land cleanly but are
independent of the picker itself:

- **`classifyError` regex miss** (`server/src/services/imapReader.js`):
  the current pattern `/Mailbox doesn't exist|does not exist|folder/i`
  doesn't match Outlook's `"foo" doesn't exist.` — the error fell
  through to `UNKNOWN` instead of `FOLDER`. Extend to match
  `doesn't exist` without a `Mailbox` prefix, plus `TRYCREATE` and
  `no such (mailbox|folder)`.
- **Surface `runError.message` in the `POST /sync` response.**
  Currently `summary` only has numeric counters, so the curl output
  shows `errors: 1` with no context. Add `summary.error: string|null`,
  populate from the catch block in `syncEmails()`, and expose it in
  the JSON response + the toast `message` field.
- **Show `error_detail` in `CurveLogsPage.jsx`.** Rows with
  `status === 'error' | 'parse_error'` currently render `—` in the
  entity/amount/digest cells and hide the actual message. Add an
  expandable sub-row (or inline text) showing `log.error_detail`
  for those statuses so the user can diagnose without mongosh.

---

## Dev Environment Strategy

The main challenge for local development: **where do the test emails come from?**

### Testing workflow — current state

> **Scope warning:** The workflow below covers the **happy path** and
> **duplicate handling** only. Edge cases like parse errors, circuit
> breaker, concurrent 409, and capped runs are NOT exercised by these
> scripts. See the "Untested branches" table at the end of this
> section.

All commands assume `cd ~/Curve-sync` and `server/.env` pointing at
`embers_db_dev`.

#### Step 0 — Parser validation (zero Mongo, zero IMAP)

Verifies the cheerio parser against saved fixture files. No network,
no database — fastest feedback loop.

```bash
# Ground-truth (regex-based, mirrors curve.py logic)
node server/scripts/validate-fixtures.js

# Production parser (cheerio) — output must match validate-fixtures
node server/scripts/test-parser.js
```

Expected: 5 fixtures, 0 parse_error, 0 fatal, identical digests.

#### Step 1 — Orchestrator with FixtureReader (Mongo real, IMAP zero)

Exercises the full parse → digest → dedup → insert → log pipeline
against real MongoDB but with zero IMAP traffic. Uses a dedicated
`__fixture_test__` CurveConfig so production data is never touched.

```bash
# Clean up artefacts from previous fixture runs
node server/scripts/cleanup-test-orchestrator.js

# Three passes: dry run → real insert → re-run (all duplicates)
node server/scripts/test-orchestrator.js
```

Expected output:
```
== dry run ==
  total=5  ok=5  dup=0  parseErrors=0  errors=0  halted=false  dryRun=true

== real insert (first run) ==
  total=5  ok=5  dup=0  parseErrors=0  errors=0  halted=false  dryRun=false

== real insert (re-run) ==
  total=5  ok=0  dup=5  parseErrors=0  errors=0  halted=false  dryRun=false

PASSED
```

What this proves:
- Dry run path: parser runs, `Expense.exists()` check, zero writes
- Real insert: `Expense.create()` succeeds, CurveLog with status=ok
- Duplicate handling: digest unique index → status=duplicate, no new rows
- FixtureReader canary: `last_email_at` stays null (fixtures don't
  count as real email for the silent-failure canary)
- Config stats: `last_sync_status=ok`, `is_syncing=false`

#### Step 2 — IMAP dry run (real connection, zero writes)

Tests the full IMAP pipeline (connect → fetch → parse → digest check)
but without inserting Expenses or marking emails as `\Seen`.

```bash
# Verify config: folder, confirmed_at, cap, cycle day (drives SINCE)
curl -s http://localhost:3001/api/curve/config \
  | jq '{folder: .data.imap_folder, confirmed: .data.imap_folder_confirmed_at, cycle_day: .data.sync_cycle_day, cap: .data.max_emails_per_run}'

# Test IMAP connection + list available folders
curl -s http://localhost:3001/api/curve/test-connection -X POST | jq

# Dry run — counts emails, zero side effects
curl -s 'http://localhost:3001/api/curve/sync?dry_run=1' -X POST | jq '{message, summary}'
```

Expected: `parseErrors=0`, `errors=0`, `total` = number of UNSEEN
emails within the current cycle window (derived from `sync_cycle_day`).
`capped` should be `false` unless there are >500 emails in that window.

#### Step 3 — Real sync

```bash
# First run: inserts Expenses + marks emails \Seen
curl -s http://localhost:3001/api/curve/sync -X POST | jq '{message, summary}'

# Second run: must return total=0 (everything is \Seen)
curl -s http://localhost:3001/api/curve/sync -X POST | jq '{message, summary}'
```

Expected first run: `ok + duplicates = total`, `errors=0`.
Expected second run: `total=0`, everything else zero.

The frontend "Sincronizar agora" button on the Dashboard does the
same thing as the first curl (POST /sync without dry_run).

#### Step 4 — Full reset (re-test from scratch)

Two scripts undo everything from step 3 so the sync can be re-run
cleanly. Always run in this order:

```bash
# 1. Wipe Mongo data (Expenses + CurveLogs + config stats)
#    Shows a briefing with counts and sample data before asking y/N
node server/scripts/cleanup-sync.js

# 2. Unmark emails on IMAP (Seen → Unseen)
#    Shows count of SEEN vs UNSEEN before asking y/N
node server/scripts/reset-seen.js

# 3. Verify clean state
curl -s 'http://localhost:3001/api/curve/sync?dry_run=1' -X POST | jq '.summary.total'
```

After this, steps 2-3 can be re-run as if it were a first-time sync.

**Important:** `cleanup-sync.js` only deletes Expenses that are
linked via `CurveLog.expense_id` — it never touches expenses created
by other means (manual entries, Embers Python pipeline). The
`__fixture_test__` config artefacts are NOT cleaned by this script —
use `cleanup-test-orchestrator.js` for those.

#### Scripts summary

| Script | Touches Mongo | Touches IMAP | Needs confirmation |
|--------|:---:|:---:|:---:|
| `validate-fixtures.js` | — | — | — |
| `test-parser.js` | — | — | — |
| `test-orchestrator.js` | writes | — | — |
| `cleanup-test-orchestrator.js` | deletes | — | — |
| `cleanup-sync.js` | deletes | — | y/N |
| `reset-seen.js` | reads | writes | y/N |

#### Untested branches

These edge cases are NOT covered by the scripts above. They can be
triggered manually but there are no automated test scripts for them
yet.

| Branch | How to trigger manually | Risk if untested |
|--------|------------------------|------------------|
| Parse error | Add a corrupt file to `test/fixtures/emails/` and run `test-orchestrator.js` | Low — leaves UNSEEN for retry |
| Circuit breaker (10 parse errors) | Add 10+ corrupt fixtures | Low — only fires on template change |
| `capped = true` | Set `max_emails_per_run: 3` via mongosh, run sync | Low — verified by code review |
| SyncConflictError 409 | Two simultaneous `curl POST /sync` | Low — in-memory lock, trivial |
| FOLDER error + auto-invalidation | Set `imap_folder` to a non-existent folder, run sync | Tested manually (was the original bug) |
| Socket timeout recovery | Drop the IMAP connection mid-sync (e.g. `iptables` block of `outlook.office365.com:993` while a fetch is in flight) | Medium — fixed by error handler + batch markSeen |
| Auth failure | Set wrong password, run sync | Low — classifyError regex covers it |

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
- **Multi-user scoped**: Every route, orchestrator call, and scheduler tick keys off `user_id`. Configs, expenses, logs, and the in-memory sync/OAuth locks are namespaced per user — see `docs/EMAIL_AUTH_MVP.md` §8 for the multi-user acceptance criteria.
