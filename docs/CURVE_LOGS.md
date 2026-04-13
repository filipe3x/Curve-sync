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

The current `client/src/pages/CurveLogsPage.jsx` renders a single
table with five columns: `Data | Estado | Entidade | Montante | Digest`.
This works for §3 sync rows but produces the empty rows the user is
seeing for §4 audit rows, where `entity`/`amount`/`digest` are always
null.

### 6.1 Required fix

Replace the rigid five-column table with a **per-row-shape**
renderer. Pseudo-code:

```jsx
function renderRow(log) {
  const message = canonicalMessage(log);   // see §3 + §4 tables
  const date    = new Date(log.created_at).toLocaleString('pt-PT');

  if (log.action) {
    // Audit row — show the action label + canonical message
    return <AuditRow date={date} action={log.action} status={log.status}
                     message={message} ip={log.ip} detail={log.error_detail} />;
  }
  // Sync row — show entity/amount/digest as today, but always with
  // canonicalMessage as the leading description so empty-body rows
  // (parse_error, circuit breaker, sync aborted) still convey what
  // happened.
  return <SyncRow date={date} status={log.status} message={message}
                  entity={log.entity} amount={log.amount}
                  digest={log.digest} dryRun={log.dry_run}
                  detail={log.error_detail} />;
}
```

`canonicalMessage(log)` is a pure mapping from `(status, action, dry_run, error_detail)`
to the strings in the §3/§4 "Canonical message" columns. Keep it in
`client/src/pages/curveLogsMessage.js` so it's testable in isolation.

### 6.2 Suggested visual

```
┌──────────────┬──────────┬─────────────────────────────────────────┐
│ Data         │ Tipo     │ Detalhe                                 │
├──────────────┼──────────┼─────────────────────────────────────────┤
│ 13/04, 09:57 │ Sistema  │ Sincronização manual iniciada · 192.0.2.1 │
│ 13/04, 09:57 │ Auth     │ Token Microsoft renovado automaticamente │
│ 13/04, 09:56 │ Despesa  │ FNAC · €23.40 · ok · digest abc123…     │
│ 13/04, 09:56 │ Despesa  │ Email não reconhecido: missing entity    │
│ 13/04, 09:55 │ Auth     │ Início de autorização Microsoft · 192.0.2.1 │
└──────────────┴──────────┴─────────────────────────────────────────┘
```

Three visible columns (`Data`, `Tipo`, `Detalhe`), with type derived
from `action != null`:

- `action == null && entity` → `"Despesa"` (sync row with parsed body)
- `action == null && !entity` → `"Sistema"` (sync row without body —
  parse_error, circuit breaker, sync aborted)
- `action ∈ {login, login_failed, logout, session_expired, password_changed}` → `"Auth"`
- `action ∈ {oauth_*, config_updated, sync_manual, first_sync_completed}` → `"Sistema"`

### 6.3 Filter UI

The `?type=` query parameter already exists server-side but the page
doesn't expose it. Add three tabs at the top: `Tudo · Sincronizações · Auditoria`,
mapped to `?type=` omitted, `sync`, `audit`. This lets a user who
just wants to see "did my emails get imported" filter out the noise
of session_expired / oauth_token_refreshed rows.

### 6.4 Error detail expansion

For any row with `error_detail`, render a collapsed sub-row (or a
hover tooltip) with the raw detail in monospace. The current page
already does this for `error`/`parse_error` sync rows
(`CurveLogsPage.jsx:108`); extend it to also fire when the row is an
audit event with non-null `error_detail` (e.g. an `oauth_failed`).

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

There is currently no fixture-driven test for canonical message
mapping. The orchestrator-level coverage in
`server/scripts/test-sync-orchestrator.js` exercises every status
branch in §3 but only asserts on counters, not on the rendered text.
Adding a `client/src/pages/curveLogsMessage.test.js` once the message
function lands is the cheap follow-up.
