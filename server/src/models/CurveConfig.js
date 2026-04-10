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
    // IMAP SEARCH SINCE filter. When set, the reader appends
    // `SINCE <date>` to the SEARCH UNSEEN query so the IMAP server
    // filters old messages server-side before sending. When `null`,
    // the reader falls back to 31 days ago in Europe/Lisbon time.
    //
    // Future: the frontend will expose this as a cycle-aware
    // control — if the user's month starts on day 22, `imap_since`
    // is auto-computed to the 22nd of the current (or previous)
    // month on each sync invocation. See CLAUDE.md → Custom Monthly
    // Cycle for the day-22 logic.
    imap_since: { type: Date, default: null },
    // Hard cap on emails fetched per sync run. Prevents a first-time
    // sync against a folder with thousands of UNSEEN historical emails
    // from blocking the lock for hours. The reader stops yielding
    // after this many messages and sets a `capped` flag that the
    // summary surfaces. Remaining emails stay UNSEEN for the next run.
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
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'curve_configs',
  },
);

export default mongoose.model('CurveConfig', curveConfigSchema);
