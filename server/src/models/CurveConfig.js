import mongoose from 'mongoose';

const curveConfigSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    imap_server: { type: String, default: '' },
    imap_port: { type: Number, default: 993 },
    imap_username: { type: String, default: '' },
    imap_password: { type: String, default: '' },
    // TLS on by default. Only turn off for loopback relays (Caminho B:
    // email-oauth2-proxy on 127.0.0.1:1993). See docs/EMAIL.md.
    imap_tls: { type: Boolean, default: true },
    imap_folder: { type: String, default: 'INBOX' },
    // Timestamp of the last time the user explicitly confirmed the
    // folder pick (either by choosing a folder from the loaded list or
    // by clicking "Manter INBOX" in the confirmation banner). `null`
    // means "not confirmed since the picker UX shipped" — the frontend
    // shows a confirmation banner until this is set, and the sync
    // orchestrator clears it back to `null` if a run fails with
    // code=FOLDER, forcing the user to re-confirm. See docs/EMAIL.md →
    // Config UX for the full state machine and rollout rationale.
    imap_folder_confirmed_at: { type: Date, default: null },
    sync_enabled: { type: Boolean, default: false },
    sync_interval_minutes: { type: Number, default: 5 },
    // Day-of-month that starts the user's expense cycle. Defaults to
    // 22 (pay cycle alignment — see CLAUDE.md → Custom Monthly Cycle)
    // and drives three things uniformly per user: the IMAP reader's
    // SINCE window (sync only looks at the current cycle), the
    // dashboard's "este mês" totals, and the /categories/stats +
    // /curve/stats/uncategorised windows. Clamped to [1, 28] in
    // services/cycle.js → normaliseCycleDay to avoid Feb overflow
    // when a user picks something like 31.
    sync_cycle_day: { type: Number, default: 22, min: 1, max: 28 },
    // Weekly spending budget in EUR — feeds the dashboard savings-score
    // KPI. Default of 73.75 comes from the original Embers analysis
    // (€295/month ÷ 4 weeks). Stored per-user so everyone can calibrate
    // to their own pay; the score formula lives in
    // services/expenseStats.js → computeSavingsScore.
    weekly_budget: { type: Number, default: 73.75, min: 0 },
    // Hard cap on emails fetched per sync run. Belt-and-suspenders
    // alongside the cycle-start SINCE filter (see imapReader.js →
    // defaultSince): even within a single cycle, a mailbox carrying
    // thousands of UNSEEN receipts could blow the request budget. The
    // reader stops yielding after this many messages and sets a
    // `capped` flag that the summary surfaces. Remaining emails stay
    // UNSEEN for the next run.
    //
    // Note: `imap_since` was removed in the drop-date_at release —
    // the SINCE filter is now always cycle-start, non-overridable.
    // See imapReader.js :: defaultSince for the rationale.
    max_emails_per_run: { type: Number, default: 500 },
    last_sync_at: { type: Date },
    last_sync_status: { type: String, enum: ['ok', 'error', null], default: null },
    emails_processed_total: { type: Number, default: 0 },
    // Silent-failure canary. Updated only when a sync inserts a genuine
    // new expense (CurveLog status='ok') — duplicates do NOT bump it.
    // The dashboard paints this red if older than 3 days while
    // last_sync_at is fresh, because that combination is the Embers
    // silent-failure signature (OAuth token expired upstream, sync
    // reports success, zero new rows). See docs/EMAIL.md → Phase 3.
    last_email_at: { type: Date },
    // UI hint for the "a sincronizar agora" badge. NOT the authoritative
    // concurrency lock (that's an in-memory flag in syncOrchestrator.js).
    // Kept as a separate field instead of adding 'running' to
    // last_sync_status, because last_sync_status describes the outcome
    // of the *last completed* sync, not the current one.
    is_syncing: { type: Boolean, default: false },

    // --- OAuth (V2, direct XOAUTH2 — see docs/EMAIL_AUTH.md §3.3) -----
    //
    // All five fields are nullable by default: users still on the App
    // Password branch (V1 / Gmail legacy) keep these as `null` and
    // `imapReader.js` takes the plain auth path. The OAuth branch
    // activates only when `oauth_provider` is set.

    // OAuth provider name. `null` = App Password (legacy). When set,
    // imapReader.js uses getOAuthToken() instead of imap_password.
    // MVP only supports 'microsoft' — 'google' is reserved for fase 2.
    oauth_provider: {
      type: String,
      enum: ['microsoft', 'google', null],
      default: null,
    },

    // Serialized MSAL token cache, encrypted with AES-256-GCM via
    // server/src/services/crypto.js (same IMAP_ENCRYPTION_KEY that
    // protects imap_password). MSAL emits a ~2-4 KB JSON blob with
    // accessTokens, refreshTokens, idTokens and account records. The
    // cache plugin (oauthCachePlugin.js) encrypts before write and
    // decrypts on read. Never exposed to the frontend.
    oauth_token_cache: {
      type: String,
      default: null,
    },

    // MSAL `homeAccountId` of the authorized account within the cache.
    // MSAL supports multiple accounts per cache — we only ever have
    // one per CurveConfig, but still need to remember which homeAccountId
    // so acquireTokenSilent can look it up. Format: `<uid>.<utid>`.
    oauth_account_id: {
      type: String,
      default: null,
    },

    // Azure AD client ID used for THIS specific config. Normally
    // matches process.env.AZURE_CLIENT_ID, but stored per-config so
    // that a future key rotation doesn't invalidate existing caches —
    // old configs keep running on the old client_id until re-auth.
    oauth_client_id: {
      type: String,
      default: null,
    },

    // Azure AD tenant (`common`, `consumers`, `organizations`, or a
    // GUID). Defaults to `common` for multi-tenant + personal accounts.
    // Stored per-config because a single Curve Sync instance may serve
    // users from different tenants.
    oauth_tenant_id: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'curve_configs',
  },
);

export default mongoose.model('CurveConfig', curveConfigSchema);
