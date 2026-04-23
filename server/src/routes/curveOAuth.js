/**
 * Thin Express wrappers around `services/oauthWizard.js`.
 *
 * Routes (all under `/api/curve/oauth`, all auth-gated via the parent
 * `curve.js` router which is mounted with the `authenticate` middleware
 * in `index.js`):
 *
 *   POST /check-email   { email }             → { provider, supported, message }
 *   POST /start         { email }             → { provider, userCode, verificationUri, expiresIn }
 *   POST /poll                                 → { status, ... }
 *   POST /cancel                               → { cancelled }
 *   GET  /status                               → { connected, provider, email }
 *
 * Error codes from `oauthWizard`:
 *   UNSUPPORTED_PROVIDER  → 400
 *   DAG_IN_PROGRESS       → 409
 *   MISSING_CLIENT_ID     → 500 (server misconfig)
 *   DAG_TIMEOUT           → 504
 *
 * Everything else falls through to 500 with the raw error message.
 */

import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import {
  providerForEmail,
  startDag,
  pollDag,
  cancelDag,
  getStatus,
} from '../services/oauthWizard.js';
import { audit, clientIp } from '../services/audit.js';

const router = Router();

// Per-user OAuth DAG start limiter — tight half of the hybrid scheme.
// The loose per-IP ceiling lives in server/src/index.js at
// /api/curve/oauth/start and catches shared-NAT / multi-account DDoS;
// this one catches the individual-account variant. 5/hour is the
// blanket cap originally spec'd in docs/EMAIL_AUTH_MVP.md §4 PR 5 —
// generous enough for a human retrying a stuck wizard a few times,
// tight enough to make scripted abuse uninteresting.
//
// Dependencies verified:
//   - curveOAuth is mounted as a sub-router inside curveRouter, which
//     is mounted behind `authenticate` in index.js. req.userId is
//     therefore guaranteed at keyGenerator time.
//   - startDag() in services/oauthWizard.js upserts a CurveConfig
//     stub, allocates an in-memory pendingDags slot, starts the MSAL
//     acquireTokenByDeviceCode promise, and writes an audit row. All
//     of these run AFTER this middleware, so a 429 short-circuits
//     every side effect cleanly.
//   - DAG_IN_PROGRESS (409) responses from startDag still count
//     against the bucket — that is deliberate, since "user hammering
//     the button while a previous flow is pending" is exactly the
//     cadence we want to throttle.
//
// The IP fallback in keyGenerator is defensive only — with the
// current middleware order it is unreachable. Prefixes namespace the
// two bucket spaces so a user id cannot collide with an IP string.
//
// IPv6 note: the IP fallback funnels req.ip through `ipKeyGenerator`
// (re-exported by express-rate-limit) instead of using the raw string.
// Without it, express-rate-limit v8 throws ERR_ERL_KEY_GEN_IPV6 at
// startup because a naive req.ip fallback would let an IPv6 client
// rotate through every address in their /64 to bypass the bucket.
// `ipKeyGenerator` collapses an IPv6 address to its /56 prefix and
// passes IPv4 through unchanged. The same fix is applied to the
// per-user sync limiter in routes/curve.js.
const perUserOauthStartLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,                    // 5 DAG kickoffs per hour, per authenticated user
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    req.userId ? `user:${req.userId}` : `ip:${ipKeyGenerator(req.ip)}`,
  message: {
    error:
      'Demasiados pedidos de autorização. Tenta novamente daqui a uma hora.',
  },
});

// POST /api/curve/oauth/check-email
// Pure lookup — returns which OAuth provider (if any) matches the
// given email's domain. The frontend calls this at wizard step 1 to
// decide whether to show the "OAuth with Microsoft" button or the
// "paste an App Password" fallback.
router.post('/check-email', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'email required' });
    }
    const provider = providerForEmail(email);
    const supported = provider === 'microsoft';
    res.json({
      email,
      provider,
      supported,
      message: supported
        ? 'Conta Microsoft pessoal detectada — podes autorizar via OAuth.'
        : 'Domínio não suportado no MVP. Usa o formulário de App Password ou abre uma issue para pedirmos suporte.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/curve/oauth/start
// Fires the DAG and returns the short code + verification URL. The
// request holds until MSAL's `deviceCodeCallback` fires (usually
// < 1 s) — after that the call returns and the promise keeps running
// in the background. Subsequent polls discover whether the user
// completed the code entry.
//
// Rate limits (hybrid, multi-user safe):
//   - 15/hour per IP   (server/src/index.js → oauthStartLimiter, NAT cap)
//   - 5/hour per user  (perUserOauthStartLimiter above, real abuse guard)
// Both apply; whichever bucket empties first returns 429.
router.post('/start', perUserOauthStartLimiter, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'email required' });
    }
    const result = await startDag({ userId: req.userId, email });
    audit({
      action: 'oauth_start',
      userId: req.userId,
      ip: clientIp(req),
      detail:
        `provider=${result.provider} ` +
        `email=${email} ` +
        `verificationUri=${result.verificationUri}`,
    });
    res.json(result);
  } catch (err) {
    if (err.code === 'UNSUPPORTED_PROVIDER') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    if (err.code === 'DAG_IN_PROGRESS') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    if (err.code === 'DAG_TIMEOUT') {
      return res.status(504).json({ error: err.message, code: err.code });
    }
    if (err.code === 'MISSING_CLIENT_ID') {
      return res.status(500).json({ error: err.message, code: err.code });
    }
    audit({
      action: 'oauth_failed',
      userId: req.userId,
      ip: clientIp(req),
      detail: err.message,
    });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/curve/oauth/poll
// Frontend polls this every ~3 s while the user is on the code-entry
// screen. Terminal outcomes ('done' / 'error') clean up the in-memory
// slot so a fresh start is possible without an explicit cancel.
router.post('/poll', async (req, res) => {
  try {
    const result = await pollDag({ userId: req.userId });
    if (result.status === 'done') {
      audit({
        action: 'oauth_completed',
        userId: req.userId,
        ip: clientIp(req),
        // `accountId` is the MSAL homeAccountId — the primary key inside
        // the encrypted token cache. Writing it here lets ops correlate
        // a wizard run with the exact cache record, which matters for
        // second-user / multi-account debugging (§8 item 7).
        detail:
          `provider=microsoft ` +
          `email=${result.email} ` +
          `accountId=${result.homeAccountId}`,
      });
    } else if (result.status === 'error') {
      audit({
        action: 'oauth_failed',
        userId: req.userId,
        ip: clientIp(req),
        detail: `code=${result.errorCode || 'unknown'} ${result.error}`,
      });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/curve/oauth/cancel
// User clicked "cancelar" on the code-entry screen. We drop the
// in-memory state; the underlying MSAL promise keeps running until
// Azure rejects it (no abort API), but it has a rejection handler
// attached so Node won't crash.
router.post('/cancel', async (req, res) => {
  try {
    const cancelled = cancelDag({ userId: req.userId });
    if (cancelled) {
      audit({
        action: 'oauth_cancelled',
        userId: req.userId,
        ip: clientIp(req),
      });
    }
    res.json({ cancelled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/curve/oauth/status
// Idempotent read of the persisted OAuth state for the settings page.
// The "Ligar conta Microsoft" button uses this to decide whether to
// show "Conectado como foo@outlook.com" or "Não conectado".
router.get('/status', async (req, res) => {
  try {
    const status = await getStatus({ userId: req.userId });
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
