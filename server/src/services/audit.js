import CurveLog from '../models/CurveLog.js';

/**
 * Write an audit log entry to curve_logs. Fire-and-forget — errors are
 * logged to stderr but never propagated to the caller, so audit logging
 * can never break the main request flow.
 *
 * @param {Object} opts
 * @param {string}              opts.action   – one of the CurveLog.action enum values
 * @param {import('mongoose').Types.ObjectId} opts.userId
 * @param {string}             [opts.ip]      – client IP address
 * @param {string}             [opts.detail]  – free-text context (e.g. "email: foo@bar.com")
 */
export function audit({ action, userId, ip, detail }) {
  CurveLog.create({
    user_id: userId,
    action,
    status: action.includes('failed') || action === 'session_expired' ? 'error' : 'ok',
    ip: ip ?? null,
    error_detail: detail ?? null,
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
