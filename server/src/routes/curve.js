import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import CurveConfig from '../models/CurveConfig.js';
import CurveLog from '../models/CurveLog.js';
import User from '../models/User.js';
import {
  testConnection,
  ImapError,
  createImapReader,
} from '../services/imapReader.js';
import {
  syncEmails,
  isSyncing,
  SyncConflictError,
} from '../services/syncOrchestrator.js';
import {
  startScheduler,
  stopScheduler,
  getSchedulerStatus,
} from '../services/scheduler.js';
import { encrypt, decrypt } from '../services/crypto.js';
import { audit, clientIp } from '../services/audit.js';
import {
  cycleBoundsFor,
  cycleBoundsForUser,
  formatISODate,
  normaliseCycleDay,
} from '../services/cycle.js';
import oauthRouter from './curveOAuth.js';

const router = Router();

// OAuth wizard routes (V2). Mounted as a sub-router so everything
// inherits the `authenticate` middleware applied to /api/curve in
// index.js. See server/src/routes/curveOAuth.js for the endpoint list.
router.use('/oauth', oauthRouter);

// Per-user sync limiter — tight half of the hybrid scheme. The loose
// per-IP ceiling lives in server/src/index.js at /api/curve/sync and
// catches shared-NAT / multi-account DDoS; this one catches the
// individual-account variant (a single logged-in user hammering
// "Sincronizar agora" or scripting against POST /api/curve/sync).
// Because curveRouter is mounted AFTER `authenticate` in index.js,
// req.userId is guaranteed to be populated by the time keyGenerator
// runs. The IP fallback exists only as a defensive no-op in case
// the middleware order ever changes — with the current wiring it is
// unreachable. The `user:`/`ip:` prefixes namespace the two buckets
// so a user id can never collide with someone's IP string.
//
// IPv6 note: the IP fallback funnels req.ip through `ipKeyGenerator`
// (re-exported by express-rate-limit) instead of using the raw string.
// Without it, express-rate-limit v8 throws ERR_ERL_KEY_GEN_IPV6 at
// startup because a naive req.ip fallback would let an IPv6 client
// rotate through every address in their /64 to bypass the bucket.
// `ipKeyGenerator` collapses an IPv6 address to its /56 prefix and
// passes IPv4 through unchanged, so a single host gets exactly one
// bucket regardless of address family. This branch only fires if the
// `authenticate` middleware ever stops running before the limiter,
// but the helper is cheap and silences the validator unconditionally.
const perUserSyncLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 3,              // 3 syncs per minute, per authenticated user
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    req.userId ? `user:${req.userId}` : `ip:${ipKeyGenerator(req.ip)}`,
  message: { error: 'Demasiados pedidos de sync. Aguarda um momento.' },
});

/**
 * Return a plain-object copy of a CurveConfig with imap_password
 * decrypted (legacy branch) or left null (OAuth branch).
 *
 * OAuth configs never have an imap_password in the first place —
 * decrypting `null` would throw. Guarding here lets the rest of the
 * pipeline treat the two branches uniformly via `createImapReader`.
 */
function toPlainConfig(configObj) {
  return {
    ...configObj,
    imap_password: configObj.imap_password
      ? decrypt(configObj.imap_password)
      : null,
  };
}

// GET /api/curve/config
// Returns the authenticated user's CurveConfig plus a synthetic `email`
// field resolved from `user_id`.
router.get('/config', async (req, res) => {
  try {
    const data = await CurveConfig.findOne({ user_id: req.userId }).lean();
    if (!data) return res.json({ data: {} });

    const user = await User.findById(req.userId).select('email').lean();
    // Never send the encrypted password to the frontend — only a boolean
    // flag so the UI can show "password saved" vs empty.
    const { imap_password, ...safe } = data;
    safe.has_imap_password = Boolean(imap_password);
    safe.email = user?.email ?? null;
    res.json({ data: safe });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/curve/config
// The user_id comes from the authenticated session (req.userId), not from
// the request body. The email→user lookup is no longer needed — the user
// IS the authenticated user.
router.put('/config', async (req, res) => {
  try {
    const {
      imap_server, imap_port, imap_username, imap_password, imap_tls,
      imap_folder, sync_enabled, sync_interval_minutes,
      imap_since, max_emails_per_run,
      sync_cycle_day, weekly_budget,
      confirm_folder,
    } = req.body;

    const update = {
      imap_server, imap_port, imap_username,
      imap_password: imap_password ? encrypt(imap_password) : undefined,
      imap_tls,
      imap_folder, sync_enabled, sync_interval_minutes,
      imap_since: imap_since ? new Date(imap_since) : null,
      max_emails_per_run: max_emails_per_run != null ? Number(max_emails_per_run) : undefined,
      // Clamp on write so the DB never holds a value cycleBoundsFor
      // would reject. Omit from the update when the caller didn't
      // send the field, so partial PUTs (e.g. wizard's folder-only
      // save) don't stomp on a previously-set cycle day.
      sync_cycle_day:
        sync_cycle_day != null ? normaliseCycleDay(sync_cycle_day) : undefined,
      // Parse + clamp to a non-negative finite number. Mongoose's `min: 0`
      // still runs on the update via runValidators, but parsing up-front
      // keeps "73,75" strings and "Infinity" out of the DB entirely.
      weekly_budget:
        weekly_budget != null && Number.isFinite(Number(weekly_budget))
          ? Math.max(0, Number(weekly_budget))
          : undefined,
      user_id: req.userId,
    };
    if (confirm_folder === true) {
      update.imap_folder_confirmed_at = new Date();
    }

    const data = await CurveConfig.findOneAndUpdate(
      { user_id: req.userId },
      update,
      { upsert: true, new: true, runValidators: true },
    );

    const detail = imap_password ? 'config + password updated' : 'config updated';
    audit({
      action: imap_password ? 'password_changed' : 'config_updated',
      userId: req.userId,
      ip: clientIp(req),
      detail,
    });

    // Auto-start the scheduler when sync is enabled for the first time.
    // The boot-time check in server/src/index.js only arms the cron if a
    // sync_enabled=true config already existed — a fresh user completing
    // the wizard would otherwise upsert sync_enabled=true into a DB
    // where the scheduler is dormant, and the first sync would never
    // run without a server restart. Guarded by getSchedulerStatus so we
    // don't double-schedule when it's already armed from boot.
    if (sync_enabled === true && !getSchedulerStatus().running) {
      startScheduler();
    }

    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/curve/sync — trigger a manual sync pass against the stored
// CurveConfig. Query params:
//   ?dry_run=1      → run the parser + dedup check with zero side effects
//                     (no Expense.create, no markSeen, no stats update).
//                     CurveLog entries are still written with dry_run=true.
//
// Returns the orchestrator's summary contract verbatim, plus a top-level
// `message` for the frontend toast. Concurrency: in-memory lock — a second
// call while a sync is in progress returns 409 with SyncConflictError.
//
// Rate limits (hybrid, multi-user safe):
//   - 10/min per IP  (server/src/index.js → syncLimiter, shared NAT cap)
//   - 3/min per user (perUserSyncLimiter below, real abuse guard)
// Both apply; whichever bucket empties first returns 429.
router.post('/sync', perUserSyncLimiter, async (req, res) => {
  const dryRun = req.query.dry_run === '1' || req.query.dry_run === 'true';
  try {
    const config = await CurveConfig.findOne({ user_id: req.userId });
    if (!config) {
      return res.status(404).json({
        error: 'Nenhuma configuração guardada. Preenche e carrega em "Guardar" primeiro.',
      });
    }
    const plainConfig = toPlainConfig(config.toObject());
    const reader = await createImapReader(plainConfig);

    audit({
      action: 'sync_manual',
      userId: req.userId,
      ip: clientIp(req),
      detail: dryRun ? 'dry_run' : null,
    });

    const summary = await syncEmails({
      config: plainConfig,
      reader,
      dryRun,
    });
    // Build a human-readable message in priority order:
    //   1. Hard abort via circuit breaker
    //   2. Whole-run failure surfaced on summary.error (folder not found,
    //      auth rejected, connect timeout, etc.) — include the classified
    //      code so curl / the dashboard don't have to grep CurveLog
    //   3. Normal outcome counts
    let message;
    if (summary.halted) {
      message = `Sync abortada pelo circuit breaker após ${summary.parseErrors} parse errors consecutivos.`;
    } else if (summary.error) {
      const codeSuffix = summary.errorCode ? ` (${summary.errorCode})` : '';
      message = `Sync falhou${codeSuffix}: ${summary.error}`;
    } else {
      message = `Sync OK. ${summary.ok} novos, ${summary.duplicates} duplicados, ${summary.parseErrors} parse errors, ${summary.errors} erros.`;
    }
    if (summary.capped) {
      message += ` (limitado a ${config.max_emails_per_run ?? 500} — há mais emails por processar)`;
    }
    return res.json({ message, summary });
  } catch (err) {
    if (err instanceof SyncConflictError) {
      return res.status(409).json({ error: err.message });
    }
    if (err instanceof ImapError) {
      // Flip last_sync_status='error' for ALL ImapError paths so the
      // dashboard re-auth banner gate sees the breakage even when the
      // failure happened BEFORE the orchestrator started — for example
      // `createImapReader` → `getOAuthToken` → `OAuthReAuthRequired`
      // in the OAuth branch, which aborts the sync before `syncEmails`
      // gets a chance to run its own `finally` stats update. Without
      // this, `last_sync_status` stays frozen on the previous "ok" and
      // the banner never lights up until a full sync actually starts.
      // Failure to write this is non-fatal — swallow and proceed.
      try {
        await CurveConfig.updateOne(
          { user_id: req.userId },
          { $set: { last_sync_status: 'error', last_sync_at: new Date() } },
        );
      } catch (e) {
        console.warn(`curve/sync: could not flip last_sync_status: ${e.message}`);
      }
      // AUTH deliberately maps to 502 (Bad Gateway), NOT 401. A 401 on
      // a `/api/curve/*` response is indistinguishable from a session
      // expiry for the frontend's `api.request()` wrapper, which would
      // then dispatch `auth:logout` and boot the user to the login
      // page. That is wrong: the user's session is fine — it's the
      // upstream IMAP/Azure auth that failed. 502 cleanly separates
      // "your cookie is bad" (401) from "our upstream dep is unhappy"
      // (502) and lets the dashboard render the re-auth banner
      // instead. See docs/EMAIL_AUTH_MVP.md §8 items 4-5.
      const status =
        { CONFIG: 400, AUTH: 502, CONNECT: 503, FOLDER: 404 }[err.code] ?? 500;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/curve/sync/status — lightweight poll endpoint for the
// "a sincronizar agora" badge in the UI. Returns the in-memory lock state
// (authoritative) AND the config's `is_syncing` field (UI hint).
router.get('/sync/status', async (req, res) => {
  try {
    const config = await CurveConfig.findOne({ user_id: req.userId }).lean();
    res.json({
      running: config ? isSyncing(config._id) : false,
      config_is_syncing: Boolean(config?.is_syncing),
      last_sync_at: config?.last_sync_at ?? null,
      last_sync_status: config?.last_sync_status ?? null,
      last_email_at: config?.last_email_at ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/curve/test-connection
// Reads the stored CurveConfig, attempts an IMAP connect + folder list,
// and returns the folder paths so the user can verify the `imap_folder`
// value. Maps ImapError.code → HTTP status for nicer UX on the frontend.
router.post('/test-connection', async (req, res) => {
  try {
    const config = await CurveConfig.findOne({ user_id: req.userId }).lean();
    if (!config) {
      return res.status(404).json({
        error: 'Nenhuma configuração guardada. Preenche e carrega em "Guardar" primeiro.',
      });
    }
    const { folders } = await testConnection(toPlainConfig(config));
    res.json({
      message: `Ligação OK. ${folders.length} pastas disponíveis no servidor.`,
      folders,
    });
  } catch (err) {
    if (err instanceof ImapError) {
      // AUTH → 502 (Bad Gateway), NOT 401 — see the same mapping on
      // POST /sync above for the rationale. A 401 here would cause
      // the frontend's api wrapper to treat the test-connection click
      // as a session expiry and redirect to /login, which is exactly
      // the pre-fix bug reported against /curve/config.
      const status =
        { CONFIG: 400, AUTH: 502, CONNECT: 503, FOLDER: 404 }[err.code] ?? 500;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/curve/logs
// Optional query: ?type=audit          → only audit/security events (action != null)
//                 ?type=sync           → only sync events (action == null)
//                 ?uncategorised=true  → only ok sync rows with no tier match
//                                        (docs/Categories.md §11.3 Fase 7). Hits
//                                        the partial compound index on
//                                        `{user_id, uncategorised, created_at}`
//                                        so the count is O(matches), not
//                                        O(user's logs).
//                 (omit)               → all entries
router.get('/logs', async (req, res) => {
  try {
    const { page = 1, limit = 30, type, uncategorised } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const logFilter = { user_id: req.userId };
    if (type === 'audit') logFilter.action = { $ne: null };
    else if (type === 'sync') logFilter.action = null;
    // `?uncategorised=true` is an additive filter — it composes with
    // `?type=sync` (the implied bucket for these rows) but the client
    // can omit `type` and the server still restricts to sync rows
    // because only sync rows ever carry the flag.
    if (uncategorised === 'true') logFilter.uncategorised = true;
    const [data, total] = await Promise.all([
      CurveLog.find(logFilter)
        .sort('-created_at')
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      CurveLog.countDocuments(logFilter),
    ]);

    res.json({ data, meta: { total, page: Number(page), limit: Number(limit) } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/curve/stats/uncategorised
//
// Lightweight count of "Sem categoria" sync rows for the caller within
// the current day-22 cycle. Feeds the dashboard stat card that
// deep-links to `/curve/logs?tab=uncategorised`. The `uncategorised`
// flag is written by the orchestrator (see §10.5 of docs/Categories.md)
// and the partial compound index on CurveLog keeps this query O(matches).
//
// Response shape mirrors the rest of the cycle-aware endpoints
// (/api/categories/stats): `{ count, cycle: { start, end } }` where
// start/end are YYYY-MM-DD labels of the cycle bounds.
// ─────────────────────────────────────────────────────────────────────
router.get('/stats/uncategorised', async (req, res) => {
  try {
    const { start, end } = await cycleBoundsForUser(req.userId);
    const count = await CurveLog.countDocuments({
      user_id: req.userId,
      uncategorised: true,
      created_at: { $gte: start, $lte: end },
    });
    res.json({
      count,
      cycle: { start: formatISODate(start), end: formatISODate(end) },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Scheduler routes (admin only) ----------

// POST /api/curve/scheduler/start
router.post('/scheduler/start', async (req, res) => {
  try {
    const interval = Number(req.query.interval) || 5;
    startScheduler(interval);
    res.json({ message: `Scheduler iniciado (cada ${interval} min).` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/curve/scheduler/stop
router.post('/scheduler/stop', async (_req, res) => {
  try {
    stopScheduler();
    res.json({ message: 'Scheduler parado.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/curve/scheduler/status
router.get('/scheduler/status', async (_req, res) => {
  try {
    res.json(getSchedulerStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
