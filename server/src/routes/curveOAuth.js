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
import {
  providerForEmail,
  startDag,
  pollDag,
  cancelDag,
  getStatus,
} from '../services/oauthWizard.js';
import { audit, clientIp } from '../services/audit.js';

const router = Router();

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
router.post('/start', async (req, res) => {
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
