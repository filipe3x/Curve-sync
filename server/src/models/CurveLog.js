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
