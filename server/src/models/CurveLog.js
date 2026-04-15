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
    error_detail: String,
    // Distinguishes entries produced by a dry run (syncEmails({..., dryRun:true}))
    // from real syncs. Dry runs still write CurveLog entries for visibility, but
    // the audit UI should filter them out of normal views by default.
    dry_run: { type: Boolean, default: false },
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
      // Admin-gate rejection fired by `middleware/requireAdmin.js`
      // when a non-admin hits an admin-only route (§13.2 #35,
      // renamed per §13.7 #2 to include the `failed` suffix so
      // `audit.js` auto-flips `status: 'error'`). Carries
      // `method=<METHOD> path=<path>` in `error_detail`.
      'admin_access_failed',
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

export default mongoose.model('CurveLog', curveLogSchema);
