# CurveLog — Audit & Sync Trail

This document is the **single source of truth** for the `curve_logs`
collection: what it stores, who writes to it, and how the
`/curve/logs` page should render each row.

If you are touching anything that writes to `curve_logs` (a new audit
event, a new sync error path, a new orchestrator branch), update this
file in the same PR.

## 1. What CurveLog is — and isn't

`curve_logs` is a **dual-purpose audit trail**:

1. **Sync events** — one row per email the orchestrator processes
   (`status: ok | duplicate | parse_error | error`, `action: null`).
   Carries the parsed `entity`, `amount`, `digest`, and the linked
   `expense_id` on success.
2. **Audit events** — one row per security/admin action
   (`action: login | oauth_completed | sync_manual | …`,
   `status: ok | error`). Carries `ip` and a free-text `error_detail`,
   never `entity`/`amount`/`digest`.

Both flavours share the same Mongoose model (`server/src/models/CurveLog.js`)
and the same TTL (90 days, auto-purged via `expireAfterSeconds` on
`created_at`). The discriminator is `action != null`.

**Out of scope.** CurveLog does NOT track:

- Folder picks or schedule changes (those would be CurveConfig change
  events — there's no canonical home for them yet, see EMAIL.md
  → "Audit trail scope")
- HTTP request access logs (that's the reverse proxy's job)
- Performance metrics (durations live on `summary.durationMs` and on
  `CurveConfig.last_sync_*`, never in CurveLog)

## 2. Schema reference

```js
{
  user_id:      ObjectId,                          // required
  config_id:    ObjectId,                          // sync events only
  status:       'ok' | 'duplicate' | 'parse_error' | 'error',  // required
  entity:       String,                            // sync events with parsed body
  amount:       Number,                            // sync events with parsed body
  digest:       String,                            // sync events with parsed body
  expense_id:   ObjectId,                          // sync events that inserted
  error_detail: String,                            // any failure / audit context
  dry_run:      Boolean,                           // sync events from dry runs
  action:       String | null,                     // audit events only — see §4
  ip:           String,                            // audit events from HTTP requests
  created_at:   Date,                              // automatic, TTL key
  updated_at:   Date,                              // automatic, never touched
}
```

The `action` enum is the union of every value in §4. Adding a new
audit event requires extending the enum AND this document.

## 3. Sync events (`action: null`)

Source: `server/src/services/syncOrchestrator.js → writeLog()`.

Every email the reader yields produces **exactly one** row, except in
the circuit-breaker branch which writes a second `error` row to mark
the abort. The orchestrator pipeline is:

```
fetchUnseen → parseEmail → assignCategory → Expense.create → markSeen
                  ↓             ↓                ↓
              parse_error     ok / dup        error / dup
```

| # | Branch | `status` | Entity / Amount / Digest | `expense_id` | `error_detail` | `dry_run` | Canonical message |
|---|---|---|---|---|---|---|---|
| 1 | Parse OK + new insert (`syncOrchestrator.js:436`) | `ok` | populated | populated | — | maybe | `"Despesa importada"` |
| 2 | Parse OK + duplicate digest from `Expense.create` (`:403`) | `duplicate` | populated | — | — | maybe | `"Já existia (duplicado)"` |
| 3 | Parse OK + dry-run found existing (`:357`) | `duplicate` | populated | — | — | **true** | `"Já existia (simulação)"` |
| 4 | Parse OK + dry-run found new (`:367`) | `ok` | populated | — | — | **true** | `"Importaria nova despesa (simulação)"` |
| 5 | Parse OK + `Expense.create` error other than dup (`:417`) | `error` | populated | — | populated | maybe | `"Falhou ao guardar: <error_detail>"` |
| 6 | Parse OK + dry-run `exists()` failed (`:344`) | `error` | populated | — | populated | **true** | `"Falhou verificação: <error_detail>"` |
| 7 | `parseEmail` threw (`:295`) | `parse_error` | — | — | populated | maybe | `"Email não reconhecido: <error_detail>"` |
| 8 | Circuit breaker tripped after N consecutive parse errors (`:316`) | `error` | — | — | `"circuit breaker: …"` | maybe | `"Sync abortada (parse errors em cadeia)"` |
| 9 | Whole-run failure — reader couldn't connect / fetch / auth (`:476`) | `error` | — | — | `"sync aborted: <msg> (code=AUTH/FOLDER/...)"` | maybe | `"Sync falhou: <error_detail>"` |

The `dry_run: maybe` column means the orchestrator passes through
whatever the caller set on `syncEmails({ dryRun })`. The dry-run
branches (#3, #4, #6) are the only ones that ALWAYS have `dry_run: true`
because they are unreachable from a real run.

### 3.1 Why some sync rows have empty entity/amount/digest

Rows #7, #8, and #9 are the legitimate cases:

- **#7 (`parse_error`)** — the parser threw before it could extract
  any field. We literally don't know what was in that email.
- **#8 (circuit breaker)** — meta-event, not tied to one email.
- **#9 (sync aborted)** — connect/auth/folder failed, the reader
  never yielded a single email, so there's nothing to parse.

These are **not** the rows the user is currently confused about on
`/curve/logs`. The empty rows visible there are §4 audit events,
which never had a parsed body to begin with.

## 4. Audit events (`action != null`)

Source: `server/src/services/audit.js → audit()` — fire-and-forget,
errors swallowed to stderr so audit logging can never break a request.
The helper auto-derives `status` from the action name:

```js
status: action.includes('failed') || action === 'session_expired' ? 'error' : 'ok'
```

| # | `action` | Source | `status` | `ip` | `error_detail` content | Canonical message |
|---|---|---|---|---|---|---|
| 10 | `login` | `routes/auth.js:35` | `ok` | yes | — | `"Login efectuado"` |
| 11 | `login_failed` | `routes/auth.js:22` | `error` | yes | — | `"Login falhou"` |
| 12 | `logout` | `routes/auth.js:51` | `ok` | yes | — | `"Sessão terminada"` |
| 13 | `session_expired` | `middleware/auth.js:28` | `error` | yes | — | `"Sessão expirou"` |
| 14 | `config_updated` | `routes/curve.js:101` | `ok` | yes | `"config updated"` | `"Configuração actualizada"` |
| 15 | `password_changed` | `routes/curve.js:101` | `ok` | yes | `"config + password updated"` | `"Password alterada"` |
| 16 | `sync_manual` | `routes/curve.js:135` | `ok` | yes | `"dry_run"` or null | `"Sincronização manual iniciada"` (+ `(simulação)` if `dry_run`) |
| 17 | `oauth_start` | `routes/curveOAuth.js:74` | `ok` | yes | `"email=foo@…"` | `"Início de autorização Microsoft"` |
| 18 | `oauth_failed` | `routes/curveOAuth.js:97`, `:129` | `error` | yes | error message | `"Autorização falhou: <error_detail>"` |
| 19 | `oauth_completed` | `routes/curveOAuth.js:115` | `ok` | yes | `"email=foo@…"` | `"Autorização concluída"` |
| 20 | `oauth_cancelled` | `routes/curveOAuth.js:151` | `ok` | yes | — | `"Autorização cancelada"` |
| 21 | `oauth_token_refreshed` | `services/oauthManager.js:191` | `ok` | **no** | `"provider=… accountId=… email=…"` | `"Token Microsoft renovado automaticamente"` |
| 22 | `first_sync_completed` | `services/syncOrchestrator.js:542` | `ok` | **no** | counts | `"Primeira sincronização concluída"` |

### 4.1 Why two events have no `ip`

Events #21 and #22 are written from inside the sync pipeline, NOT from
an HTTP route handler. There is no `req` to extract an IP from — the
sync may have been triggered by `node-cron`, by another user's manual
click that the scheduler queued, or by the wizard's first-sync hand-off.
Showing `ip: '—'` for these is correct, not a bug.

### 4.2 Why `audit()` derives status by string-match

The current heuristic in `audit.js:18`:

```js
status: action.includes('failed') || action === 'session_expired' ? 'error' : 'ok'
```

…is fragile by design — it works for every action in the table above
but anything new like `xyz_rejected` or `revoked` would silently land
as `ok`. **If you add a new action that represents a failure, either
rename it to include `failed` OR add an explicit case to this
heuristic.** Future PR may replace this with a per-action map.

### 4.3 Adding a new audit action — the 3-file footgun

Adding a new value to the `action` enum is **not** a one-file change.
The per-row-shape renderer on the frontend is enum-coupled to the
model, which means a new action that doesn't get every site updated
will silently fall through to a default branch and render with a
generic label.

Checklist for any new `action`:

1. **`server/src/models/CurveLog.js`** — add the value to the
   `action` enum (Mongoose will reject the write otherwise)
2. **`server/src/services/audit.js`** — if the action represents a
   failure, make sure the status heuristic picks it up (see §4.2)
   or add an explicit branch
3. **`client/src/pages/curveLogsUtils.js`** — add a `case` to the
   `describeLog` switch with the canonical pt-PT message; otherwise
   the row renders with the raw enum value as title
4. **This document (§4 table)** — add the row so the next person
   knows the action exists

The frontend coupling is the real cost of the per-row-shape
rendering — before the rewrite the table had no per-action knowledge
and missing actions degraded gracefully into empty rows. The new
renderer trades that graceful degradation for canonical messages.
Worth the trade, but worth knowing.

## 5. API contract

```
GET /api/curve/logs?page=1&limit=30&type=audit|sync
```

Returns `{ data: CurveLog[], meta: { total, page, limit } }`. The
`type` filter (`server/src/routes/curve.js:259`):

| `type` query | Mongo filter | What you get |
|---|---|---|
| (omitted) | `{ user_id }` | Everything mixed |
| `audit` | `{ user_id, action: { $ne: null } }` | §4 only |
| `sync` | `{ user_id, action: null }` | §3 only |

Logs are scoped to the authenticated user — there is no admin/global
view. A user with multiple `curve_configs` (not currently possible in
the wizard, but the schema allows it) sees rows from all of them.

## 6. Frontend rendering rules

`/curve/logs` uses a **per-row-shape** renderer split between two
files:

- `client/src/pages/curveLogsUtils.js` — pure helpers
  (`describeLog`, `groupSyncBatches`). No React, no I/O, safe to unit
  test in isolation.
- `client/src/pages/CurveLogsPage.jsx` — table, tabs, pagination,
  batch expand/collapse.

### 6.1 `describeLog(log)` → `{ type, title }`

Pure mapping from `(action, status, dry_run, entity, error_detail)`
to:

- **`type`** — one of `"despesa" | "sistema" | "auth"`, drives the
  badge colour in the "Tipo" column.
- **`title`** — the canonical user-facing string from the §3/§4
  "Canonical message" columns (already localised to pt-PT).

Type classification:

- `action == null && entity` → `despesa` (sync row with parsed body)
- `action == null && !entity` → `sistema` (sync row without body —
  parse_error, circuit breaker, sync aborted)
- `action ∈ {login, login_failed, logout, session_expired, password_changed}` → `auth`
- `action ∈ {oauth_*, config_updated, sync_manual, first_sync_completed}` → `sistema`

Adding a new branch in §3 or §4 means adding a `case` here, nothing
else.

### 6.2 `groupSyncBatches(logs)` — expense clustering

The orchestrator processes a backlog of receipts in one pass, so N
`despesa` rows land within milliseconds of each other. Rendering
them individually creates a wall of near-duplicate rows that drowns
the §4 audit events the user actually cares about.

`groupSyncBatches` walks the newest-first log stream and collapses
**adjacent** expense rows (action == null && entity != null) whose
`created_at` is within 5 s of the cluster anchor into a single
batch entry:

```
[{ kind: 'single', log }, { kind: 'batch', logs, summary, key }, …]
```

Adjacency in the sorted stream is the cheap proxy for "same
orchestrator pass" — a 4 s gap between two unrelated rows on
different days can't land next to each other because the sort is
strictly monotone.

The batch `summary` is `{ ok, duplicates, errors, totalAmount, count }`
and is rendered collapsed as `"N despesas processadas · X importadas
· Y duplicadas · €total"`. Clicking the row toggles local
`useState(false)` to reveal one compact sub-row per underlying log
with entity/amount/digest + `error_detail` when present.

### 6.3 Visual

```
┌──────────────┬──────────┬─────────────────────────────────────────┐
│ Data         │ Tipo     │ Detalhe                                 │
├──────────────┼──────────┼─────────────────────────────────────────┤
│ 13/04, 09:57 │ Sistema  │ Sincronização manual iniciada           │
│ 13/04, 09:56 │ Despesa  │ ▸ 5 despesas processadas                │
│              │          │   4 importadas · 1 duplicada · €124.50  │
│ 13/04, 09:55 │ Auth     │ Início de autorização Microsoft         │
└──────────────┴──────────┴─────────────────────────────────────────┘
```

Three visible columns. The "Estado" column from the old layout is
gone — status lives inside the title (e.g. "Já existia (duplicado)")
for single rows and inside the summary line for batches. Sub-rows
inside an expanded batch use a tiny coloured dot (emerald / amber /
curve) instead of a repeated badge to keep the nested level quiet.

### 6.4 Filter tabs

Three tabs at the top of the page: `Tudo · Sincronizações · Auditoria`,
mapped to the existing `?type=` query on `GET /api/curve/logs`:

| Tab            | `?type=` sent | Shows |
|---|---|---|
| Tudo           | (omitted)     | Everything mixed |
| Sincronizações | `sync`        | §3 only |
| Auditoria      | `audit`       | §4 only |

Switching tabs resets `page` to 1. This lets a user who just wants
to see "did my emails get imported" filter out the noise of
`session_expired` / `oauth_token_refreshed` rows.

### 6.5 Error detail

For single rows, `error_detail` is already folded into the `title`
when `describeLog` returns something like `"Falhou ao guardar:
<error_detail>"`. The renderer only prints it as a separate line
when the title didn't already include it (keeps the table from
double-printing the same string).

Inside an expanded batch sub-row, `error_detail` is printed on its
own line in `text-curve-700` monospace under the entity/amount so
the failure stands out without needing the old full-width sub-row
that the V1 table used.

### 6.6 Known limitations of the rewrite

The current `/curve/logs` page is intentionally minimal. The items
below are deliberate cuts, not bugs — but a future PR that wants to
grow the page should know they exist:

- **Hard-coded 5 s batch window.** `BATCH_WINDOW_MS` in
  `curveLogsUtils.js` is a constant. A sync run with IMAP latency
  spikes >5 s between successive receipts will produce two adjacent
  batches instead of one. Fine today because the orchestrator
  processes in tight bursts; revisit if real users see split batches
  in the wild. Tuning candidates: per-config setting, or anchor the
  window on `sync_started_at` if we ever stamp it on the rows.

- **Expand state is local to each `BatchRow`.** Built on
  `useState(false)` with no persistence. Switching pages, tabs, or
  refreshing the page collapses everything. OK for now; only a
  problem if we ever want to deep-link to a specific log
  (`/curve/logs#log-abc123`).

- **Active tab is not in the URL.** `tab` is component state, not a
  query string. Refreshing the page bounces the user back to "Tudo".
  Cheap fix when needed: swap to `useSearchParams`.

- **`ip` is fetched but never rendered.** The audit rows carry the
  client IP (see §4 table) but the renderer drops it to keep the
  table calm. For security investigations (e.g. inspecting a
  `login_failed` cluster) the IP is still visible via the API or a
  Mongo query, just not in the UI. Candidate places to surface it:
  hover tooltip on the date cell, or an "expand row" affordance on
  audit rows.

- **No keyboard handler on `BatchRow`.** Toggle is mouse-only —
  there's no `onKeyDown` for `Enter`/`Space`, and no `role="button"`
  / `tabIndex={0}` on the `<tr>`. A11y backlog item, blocking for
  full keyboard navigation.

- **Page-boundary batch splitting.** Pagination happens server-side
  (see §5) and grouping happens client-side after the page lands.
  If a 5-receipt cluster straddles the page-30 boundary, the user
  sees a 3-row batch on page 1 and a 2-row batch on page 2 instead
  of one 5-row batch. Fixing this properly means moving grouping
  server-side, which doubles complexity and forces the UI to deal
  with mixed shapes from the API. Not worth it unless real users
  complain.

## 7. Retention

90 days, enforced by Mongo's TTL monitor:

```js
curveLogSchema.index({ created_at: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
```

The TTL is uniform across both sync and audit events. If you ever
want to keep audit events longer than sync events, the cleanest
split is two collections, not a conditional TTL — Mongo doesn't
support partial TTL indexes by document shape.

## 8. Testing

There is currently no fixture-driven test for `describeLog` or
`groupSyncBatches`. The orchestrator-level coverage in
`server/scripts/test-sync-orchestrator.js` exercises every status
branch in §3 but only asserts on counters, not on the rendered text.
A `client/src/pages/curveLogsUtils.test.js` covering (a) every
`describeLog` case from §3/§4 and (b) the adjacency + 5 s window in
`groupSyncBatches` is the cheap follow-up.
