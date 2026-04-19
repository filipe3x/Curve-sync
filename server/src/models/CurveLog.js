import mongoose from 'mongoose';

const curveLogSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    config_id: { type: mongoose.Schema.Types.ObjectId, ref: 'CurveConfig' },
    status: { type: String, enum: ['ok', 'duplicate', 'parse_error', 'error'], required: true },
    entity: String,
    amount: Number,
    digest: String,
    expense_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Expense' },
    // Bulk toggle audit trail (ROADMAP §2.10.1). When a single audit
    // row covers N > 1 expenses — today only the
    // `expense_excluded_from_cycle` / `expense_included_in_cycle`
    // bulk branches — we persist the full ownedIds list so the
    // `/curve/logs` page can expand the row into a drill-down of the
    // affected receipts. Capped at 100 server-side to keep the doc
    // size bounded (beyond that the expansion falls back to
    // `count=<N>` alone). Stays empty/undefined for single-row audits
    // (those already carry `expense_id` + `entity` at the top level)
    // and for every other audit action.
    affected_expense_ids: [
      { type: mongoose.Schema.Types.ObjectId, ref: 'Expense' },
    ],
    error_detail: String,
    // Distinguishes entries produced by a dry run (syncEmails({..., dryRun:true}))
    // from real syncs. Dry runs still write CurveLog entries for visibility, but
    // the audit UI should filter them out of normal views by default.
    dry_run: { type: Boolean, default: false },
    // Structured mirror of the "uncategorised" signal that the
    // orchestrator also writes as the literal string
    // `error_detail = "uncategorised"` on sync `ok` rows where no
    // tier matched (see services/syncOrchestrator.js ::
    // formatResolutionDetail). Having a dedicated indexed boolean
    // — rather than relying on a string-equality check over
    // error_detail — lets downstream consumers answer "how many
    // uncategorised this cycle?" with a covered count query
    // instead of a full-collection scan, and keeps the filter path
    // forward-compatible if we ever change the free-text detail
    // wording (the boolean stays stable).
    //
    // Only ever true on `status: 'ok'` sync rows. All other rows
    // (duplicates, errors, parse_errors, audit entries) leave it
    // false by default. The string in error_detail is the source of
    // truth for the /curve/logs pill renderer (§13.5); this field is
    // the source of truth for the dashboard stat card + filter
    // endpoint (§11.3 Fase 7).
    uncategorised: { type: Boolean, default: false },
    // Audit logging fields (MU-5). When `action` is set, the entry represents
    // a security/admin event rather than a sync result.
    action: { type: String, enum: [
      'login', 'login_failed', 'logout', 'session_expired',
      // Self-service registration on /api/auth/register (MU follow-up).
      // `register`        — new user row inserted in the shared `users`
      //                     collection (Embers-compatible) and a
      //                     session was opened immediately (auto-login).
      // `register_failed` — registration was rejected. Today this only
      //                     fires on the email-already-taken collision
      //                     branch; the `userId` field carries the id
      //                     of the existing row, the `error_detail`
      //                     carries `email_taken=<lowercased email>`.
      'register', 'register_failed',
      'config_updated', 'sync_manual', 'password_changed',
      // OAuth wizard (V2, see docs/EMAIL_AUTH_MVP.md):
      //   oauth_start            — user kicked off the Device Authorization Grant
      //   oauth_completed        — DAG finished, refresh token now in cache
      //   oauth_cancelled        — user aborted the DAG before completion
      //   oauth_failed           — DAG returned an error (denied, timed out, ...)
      //   oauth_token_refreshed  — MSAL silently refreshed an expired access
      //                            token during a regular sync run. Signals
      //                            that the refresh-token path is alive and
      //                            is the main acceptance criterion for
      //                            §8 item "sync >1h dispara refresh".
      //   first_sync_completed   — first sync after wizard completion
      //                            ingested at least one expense. Marks the
      //                            end-to-end happy path for new users.
      'oauth_start', 'oauth_completed', 'oauth_cancelled', 'oauth_failed',
      'oauth_token_refreshed', 'first_sync_completed',
      // Category management (docs/Categories.md §13.2). PR #1 of the
      // roadmap only ships the single-expense quick-edit path; the other
      // 12 action values (category_created, override_*, apply_to_all, …)
      // are added in later phases when their routes land.
      //   expense_category_changed — user clicked the chip in the
      //     `/expenses` or `/` table and reassigned a single expense to
      //     a different category via PUT /api/expenses/:id/category
      //     (§12.7). Carries `expense_id`, `entity`, and
      //     `error_detail = "from=<name> to=<name>"`.
      //   override_created / override_updated / override_deleted —
      //     personal matching rules (CategoryOverride). Landed with
      //     PR #2 even though the UI to create them arrives later;
      //     the endpoints are usable via API right away. Carry
      //     `entity` (the raw pattern) and `error_detail` with the
      //     pattern + match_type + category name per §13.2 #29-31.
      //   apply_to_all / apply_to_all_failed — retroactive
      //     recategorisation via POST /api/category-overrides/:id/
      //     apply-to-all. Success carries
      //     `error_detail = "scope=personal target=override
      //     affected=<n> skipped_personal=0 category=<name>"` and
      //     `entity` = raw pattern, so the renderer can build the
      //     §13.2 #32 pt-PT message without parsing
      //     (`skipped_personal` stays 0 on the personal path —
      //     shape parity with the admin variant that lands in
      //     Fase 3). Failure carries `reason=<msg>` and inherits
      //     `status: 'error'` from the audit helper heuristic
      //     (`includes('failed')`).
      'expense_category_changed',
      // Bulk multi-select move from the /expenses table
      // (docs/Categories.md §13.2 — batch-move slice). Fired by
      // PUT /api/expenses/bulk-category once per call, regardless of
      // how many rows moved (one audit row scales better than N
      // near-identical rows flooding `curve_logs`). Carries
      // `error_detail = "target=<name> count=<N> from_mixed=true|false"`.
      // `entity` is left null because the selection is typically a
      // mix of entities — the per-row provenance lives in the
      // optimistic update on the client, not in the audit row.
      'expense_category_changed_bulk',
      'override_created', 'override_updated', 'override_deleted',
      'apply_to_all', 'apply_to_all_failed',
      // Admin-only catalogue surgery on the shared `categories`
      // collection (docs/Categories.md §13.2 #23-28). The full
      // admin CRUD slice now exposes create/update/delete of
      // categories plus batch entity add/remove on
      // `POST /api/categories`, `PUT /api/categories/:id`,
      // `DELETE /api/categories/:id`, `POST /:id/entities`, and
      // `DELETE /:id/entities/:entity`. Each handler writes a
      // single `audit()` row with `error_detail` following the
      // k=v convention from §13.2:
      //   category_created       — `name=<name> entity_count=<n>`
      //   category_updated       — `name=<name> changed=<fields>`
      //   category_deleted       — `name=<name> expense_count=<n>`
      //   category_entity_added  — `category=<name> entities=<first>[,+<k>]`
      //   category_entity_removed — `category=<name> entity=<value>`
      // `category_entity_moved` (§13.2 #28) is not yet exposed —
      // no bulk-move handler lands with this slice — but the
      // enum value is added proactively so the audit helper can
      // accept it when the route ships.
      'category_created',
      'category_updated',
      'category_deleted',
      'category_entity_added',
      'category_entity_removed',
      'category_entity_moved',
      // Admin icon change (curve_category_icons, Curve-Sync-owned
      // collection — separate from the Paperclip `icon_*` fields on
      // the shared `categories` row, which we never touch). Fires on
      // both PUT (set/change) and DELETE (clear) — the detail
      // discriminates via `icon=<name|none> previous=<old|none>`, so
      // the curveLogsUtils renderer picks the right pt-PT message
      // without needing a second enum value. §13.4 no-op
      // suppression applies: a PUT whose new name equals the
      // current name is silent, and a DELETE on a category that
      // had no icon is also silent.
      'category_icon_updated',
      // Admin-gate rejection fired by `middleware/requireAdmin.js`
      // when a non-admin hits an admin-only route (§13.2 #35,
      // renamed per §13.7 #2 to include the `failed` suffix so
      // `audit.js` auto-flips `status: 'error'`). Carries
      // `method=<METHOD> path=<path>` in `error_detail`.
      'admin_access_failed',
      // Cycle-exclusion toggle from /expenses (ROADMAP §2.10).
      //   expense_excluded_from_cycle — user marked N expenses as
      //     "do not count for this cycle / Savings Score" via
      //     POST /api/expenses/exclusions. Carries
      //     `error_detail = "count=<N>"` for bulk toggles (the
      //     action-bar path always ships N ≥ 1); `expense_id` +
      //     `entity` are populated only for the single-row branch
      //     (N == 1) so the /curve/logs renderer can surface the
      //     receipt without digging through detail.
      //   expense_included_in_cycle — inverse, via DELETE /exclusions.
      //     Same shape — `count=<N>` in detail, single-row populates
      //     `expense_id` + `entity`.
      'expense_excluded_from_cycle',
      'expense_included_in_cycle',
    ]},
    ip: String,
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'curve_logs',
  },
);

// TTL index: auto-delete logs older than 90 days
curveLogSchema.index({ created_at: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

// Compound index for the "uncategorised this cycle" stat query
// (docs/Categories.md §11.3 Fase 7). The dashboard card and the
// /curve/logs filter both hit `{ user_id, uncategorised: true,
// created_at: {$gte: cycleStart} }` — user + flag + range — so a
// compound on the same three fields makes it covered. Partial
// filter so only the ~5-10% of rows with the flag set occupy
// space; the false/undefined rows stay out of the index.
curveLogSchema.index(
  { user_id: 1, uncategorised: 1, created_at: -1 },
  { partialFilterExpression: { uncategorised: true } },
);

export default mongoose.model('CurveLog', curveLogSchema);
