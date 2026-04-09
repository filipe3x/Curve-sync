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
| Email HTML parser (cheerio) | `server/src/services/emailParser.js` | **Not started** |
| IMAP reader | `server/src/services/imapReader.js` | **Not started** |
| Sync orchestrator | `server/src/services/syncOrchestrator.js` | **Not started** |
| Scheduler (node-cron) | `server/src/services/scheduler.js` | **Not started** |
| `POST /api/curve/sync` | `server/src/routes/curve.js` | Placeholder only |
| `POST /api/curve/test-connection` | `server/src/routes/curve.js` | Placeholder only |
| `cheerio` dependency | `server/package.json` | **Not installed** |
| `imapflow` dependency | `server/package.json` | **Not installed** |

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

### Phase 0 — Standalone Validation Script (PRIORITY)

**Goal**: Before implementing the production parser, create a throwaway CLI script that reads the raw email fixtures, extracts `entity / amount / date / card` using the same logic as `curve.py`, and prints the results to the terminal. This gives us a **ground truth** to compare against once `emailParser.js` is written — we run both on the same fixtures and assert identical output.

- [ ] Create `server/scripts/validate-fixtures.js` (or `.mjs`)
- [ ] Accept a directory path argument (default: `server/test/fixtures/emails/`)
- [ ] Iterate over every file in the directory
- [ ] For each file: read raw content, find `<!doctype html>` marker, decode quoted-printable, parse with cheerio using the exact same selectors as `curve.py`
- [ ] Print a clean table to stdout: `filename | entity | amount | date | card | digest`
- [ ] Handle parse failures gracefully (print the filename + error, continue with next)
- [ ] Run it manually: `node server/scripts/validate-fixtures.js` → visually verify all values are correct
- [ ] Keep the script around as a regression tool — once `emailParser.js` exists, both should produce identical output for the same fixtures

**Note**: This script can also double as a `curve.py` verification tool — pipe an email through `python curve.py` and compare with the JS output to confirm the port is 1:1 accurate.

### Phase 1 — Email Parser (`emailParser.js`)

- [ ] Create `server/src/services/emailParser.js`
- [ ] Accept raw HTML string as input
- [ ] Load HTML with `cheerio.load(html)`
- [ ] Extract `entity`: first `td.u-bold`, trimmed text
- [ ] Extract `amount`: next sibling `td.u-bold`, strip `€` symbol
- [ ] Extract `date`: `td.u-greySmaller.u-padding__top--half`, trimmed text
- [ ] Extract `card`: penultimate `td.u-padding__top--half`, join stripped strings
- [ ] Add fallback selectors for resilience (Curve may update email templates)
- [ ] Return `{ entity, amount, date, card }` or throw with details
- [ ] Validate against real email fixtures (see Dev Strategy below)

### Phase 2 — IMAP Reader (`imapReader.js`)

- [ ] Create `server/src/services/imapReader.js`
- [ ] Connect using credentials from `CurveConfig` model
- [ ] Open configured IMAP folder (e.g., `Curve Receipts`)
- [ ] Fetch `UNSEEN` emails only
- [ ] Extract HTML body from each email (imapflow handles MIME decoding)
- [ ] Return array of `{ uid, html }` objects
- [ ] Mark emails as `\Seen` only after successful processing (not before)
- [ ] Handle connection errors, timeouts, auth failures gracefully
- [ ] Close connection properly in all code paths (try/finally)

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
