import CurveLog from '../models/CurveLog.js';

/**
 * Write an audit log entry to curve_logs. Fire-and-forget — errors are
 * logged to stderr but never propagated to the caller, so audit logging
 * can never break the main request flow.
 *
 * @param {Object} opts
 * @param {string}              opts.action     – one of the CurveLog.action enum values
 * @param {import('mongoose').Types.ObjectId} opts.userId
 * @param {string}             [opts.ip]        – client IP address
 * @param {string}             [opts.detail]    – free-text context (e.g. "email: foo@bar.com")
 * @param {import('mongoose').Types.ObjectId} [opts.expenseId]
 *        Optional reference to the expense the event is about. Used by
 *        `expense_category_changed` (docs/Categories.md §13.2 #34) so
 *        the /curve/logs page can filter by expense without parsing
 *        error_detail. Ignored for events that are not about a single
 *        expense (auth, oauth, apply_to_all, …).
 * @param {string}             [opts.entity]    – raw entity string
 *        associated with the event, mirrored onto the top-level
 *        `entity` field of the CurveLog row. Populated by
 *        `expense_category_changed` (§13.3) for the same reason as
 *        `expenseId` — gives the audit view a filter handle that does
 *        not require parsing error_detail.
 */
export function audit({ action, userId, ip, detail, expenseId, entity }) {
  CurveLog.create({
    user_id: userId,
    action,
    status: action.includes('failed') || action === 'session_expired' ? 'error' : 'ok',
    ip: ip ?? null,
    error_detail: detail ?? null,
    expense_id: expenseId ?? null,
    entity: entity ?? null,
  }).catch((err) => {
    console.error(`Audit log write failed (${action}): ${err.message}`);
  });
}

/**
 * Extract the client IP from an Express request, respecting X-Forwarded-For
 * when behind a reverse proxy.
 */
export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress ?? null;
}
