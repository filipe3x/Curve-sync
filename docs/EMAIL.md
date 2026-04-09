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
file into `curve.py`. But `offlineimap` itself did NOT talk OAuth —
investigation on the live brasume host revealed the actual topology:

```
curve.py  ←  cat  ←  offlineimap  →  127.0.0.1:1993  →  OAuth2/IMAP  →  outlook.com
             (Maildir)   (plain IMAP)    (email-oauth2-proxy,           (real Microsoft)
                                          Python, local loopback)
```

`~/.offlineimaprc` on brasume has `remotehost = 127.0.0.1`, `remoteport =
1993`, `ssl = no`, `auth_mechanisms = PLAIN` — offlineimap is blissfully
unaware of OAuth; it just talks trivial plain IMAP to a local bridge.
That bridge is [`email-oauth2-proxy`](https://github.com/simonrob/email-oauth2-proxy),
a single-file Python program that listens on a loopback port, accepts
plain IMAP/SMTP from dumb clients, and translates every command to
XOAUTH2 against Microsoft's endpoints (or Google's). Its config
(`emailproxy.config`) stores a Fernet-encrypted refresh token; the
decryption key is derived via PBKDF2 from a password the user types
interactively on first run (and then supplies as the "IMAP password"
from every client that connects).

The comment *"OAuth token expiry causes silent failures"* in this file
was the tell: when the refresh token inside `emailproxy.config` expired,
email-oauth2-proxy silently returned zero new messages, offlineimap
dutifully reported a successful sync of nothing, and expenses stopped
flowing without any log trace. That single silent failure mode is the
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

### Curve Sync's supported approaches — Caminho A and Caminho B

Curve Sync's IMAP reader (`server/src/services/imapReader.js`) is
deliberately dumb: it talks plain IMAP over a TCP socket with basic auth,
controlled by four `CurveConfig` fields (`imap_server`, `imap_port`,
`imap_username`, `imap_password`) and one toggle (`imap_tls`, default
`true`). That single client supports two very different authentication
topologies depending on what you put in those fields:

| | **Caminho A — App Password direto** | **Caminho B — email-oauth2-proxy localhost** |
|---|---|---|
| Server | `outlook.office365.com` | `127.0.0.1` |
| Port | `993` | `1993` |
| TLS | **on** (`imap_tls = true`) | **off** (`imap_tls = false`) — loopback only |
| Username | real email address | real email address |
| Password | **16-char App Password** generated in the MS account portal | **encryption password** for `emailproxy.config` (not an MS credential) |
| Network auth | TLS → basic auth → Microsoft IMAP servers | plain IMAP → `email-oauth2-proxy` → XOAUTH2 → Microsoft |
| Prereq on account | MFA must be enabled | None — uses an existing OAuth grant stored in `emailproxy.config` |
| External process | None | `email-oauth2-proxy` running on localhost (systemd unit) |
| Setup time | ~2 minutes in MS account UI | ~10 minutes: clone proxy, copy config, systemd unit |
| Schema / code impact | None beyond `imap_tls` (already landed) | None beyond `imap_tls` (already landed) |
| Silent failure mode | App password revoked → hard `535 AUTHENTICATIONFAILED`, visible | Refresh token expires → proxy returns zero rows silently (*the Embers failure mode*) — mitigated in Curve Sync by the orchestrator raising `last_sync_status = 'error'` when a sync that historically saw traffic suddenly sees none |
| Portability of consent | Per-user (MFA-enabled MS account) | `emailproxy.config` is file-portable — the refresh token that worked on brasume keeps working on the Pi with zero re-consent, as long as the encryption password matches |

**Both are supported at the same time** — they are literally different
values in the same four fields. You can flip between them by editing
`/curve/config` in the UI. No code change, no restart.

#### Which one for which situation?

- **Caminho A (App Password direto)**: use it if (a) MFA is already on
  and you don't mind generating a new 16-char code, (b) you don't have a
  working `email-oauth2-proxy` installation to inherit, or (c) you want
  the simplest possible ops story (zero extra processes).
- **Caminho B (email-oauth2-proxy localhost)**: use it if you already
  have a working proxy on another machine with a live refresh token
  (exactly the brasume → Pi migration this repo is doing), or if you
  want an auth flow that keeps working after Microsoft inevitably
  disables App Passwords too in some future "security improvement".

The production Curve Sync deployment on the Raspberry Pi uses
**Caminho B** — the `emailproxy.config` from brasume was copied to the
Pi, systemd unit launches the proxy at boot, and Curve Sync's
`CurveConfig` points at `127.0.0.1:1993` with `imap_tls = false`. See
the "Installing email-oauth2-proxy on the Raspberry Pi (Caminho B)"
section below for the exact steps.

Phase 6 (security) adds AES-256 encryption at rest for `imap_password`
regardless of which path is used — the field holds a secret either way
(App Password OR the proxy's encryption password).

### Installing email-oauth2-proxy on the Raspberry Pi (Caminho B)

Prereq: a working `emailproxy.config` (already containing the encrypted
refresh token) from another host, and the encryption password that was
used to create it.

```bash
# 1. Clone and set up a venv
cd ~
git clone https://github.com/simonrob/email-oauth2-proxy.git
cd email-oauth2-proxy
python3 -m venv .venv
.venv/bin/pip install -r requirements-core.txt

# 2. Copy the existing config from the old host (do NOT commit it anywhere).
#    The encrypted refresh token is portable — no re-consent needed as
#    long as the encryption password matches on the new host.
scp ember@brasume:~/Mail/email-oauth2-proxy/emailproxy.config .

# 3. Smoke test manually. The proxy starts listening immediately — it
#    does NOT prompt for a password at startup. You should see:
#      "Starting IMAP server at 127.0.0.1:1993 (unsecured) ..."
#      "Initialised Email OAuth 2.0 Proxy - listening for authentication requests"
#    That is enough to confirm the binary + config parse. Ctrl-C.
.venv/bin/python3 emailproxy.py --config-file=emailproxy.config --no-gui

# 4. Install as a systemd unit (template at docs/email-oauth2-proxy.service).
#    Replace <USER> and <HOME> with the real values, then:
sudo cp docs/email-oauth2-proxy.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now email-oauth2-proxy
systemctl status email-oauth2-proxy
journalctl -u email-oauth2-proxy -f   # watch it come up

# 5. In Curve Sync at /curve/config, set:
#      Servidor IMAP:    127.0.0.1
#      Porta:            1993
#      Utilizador:       your-email@outlook.pt
#      App Password:     <the encryption password of emailproxy.config>
#      Usar TLS:         unchecked
#      Pasta IMAP:       Curve Receipts
#    Save, then "Testar ligação" — you should see the folder list.
```

If the test connection comes back with `authentication failed`, the
most likely cause is a typo in the encryption password (Curve Sync
passes that through verbatim — the proxy then uses it as the PBKDF2
input to decrypt the stored tokens). Try decrypting manually via the
proxy CLI to confirm before blaming Curve Sync.

**Heads-up on first successful login**: email-oauth2-proxy may log
something like `Rotating stored secrets for account <email> to use new
cryptographic parameters` the first time you authenticate on the new
host. This is normal — the proxy is re-encrypting the refresh tokens
with fresh `token_salt` / `token_iterations` values. The password you
use stays the same, but the on-disk `emailproxy.config` is rewritten
in-place and will no longer be byte-identical to the brasume copy.
Take a backup (`cp emailproxy.config emailproxy.config.bak`) right
after that first successful sync.

### What happens later (own OAuth2 implementation, Phase 7+)

`email-oauth2-proxy` is a perfectly good bridge and we use it
deliberately — but it's still an external process we don't control. If
at some point we want to remove that dependency (e.g., for a simpler
single-container deployment), we can port the XOAUTH2 logic into
`imapReader.js` directly:

- `CurveConfig` gets new optional fields: `oauth_tenant_id`,
  `oauth_client_id`, `oauth_refresh_token`, `oauth_access_token`,
  `oauth_expires_at`
- `imapReader.js` gains a branch: if `oauth_refresh_token` is set,
  `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`
  to mint an access token, then authenticate IMAP with XOAUTH2
  (`imapflow` supports `auth: { user, accessToken }` natively)
- Frontend adds a third auth mode next to A and B
- A new route `GET /api/curve/oauth/callback` handles the consent flow
- The orchestrator's "historically saw traffic but suddenly sees none"
  heuristic remains as a silent-failure canary, because this failure
  mode is inherent to any long-lived refresh-token scheme

Do NOT add this until a concrete need exists. Caminho B already gives
us the benefits of OAuth2 with zero Azure AD setup work of our own, by
leveraging the existing proxy installation.

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
- **Basic auth only** (the reader speaks plain IMAP PLAIN / LOGIN, not
  XOAUTH2). This is deliberate — it lets the same client drive both
  Caminho A (App Password → Outlook directly over TLS:993) and Caminho
  B (encryption password → `email-oauth2-proxy` over plain:1993 on
  loopback). See the Outlook365 section above for the full topology.
- **`imap_tls` toggle** (default `true`): lets Caminho B turn off TLS
  for the localhost relay. Curve Sync logs a WARN on startup if TLS is
  off AND the host isn't a loopback address, because that combination
  would expose credentials over the network.
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
