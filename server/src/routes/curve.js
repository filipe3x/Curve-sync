import { Router } from 'express';
import CurveConfig from '../models/CurveConfig.js';
import CurveLog from '../models/CurveLog.js';
import User from '../models/User.js';
import { testConnection, ImapError, ImapReader } from '../services/imapReader.js';
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

const router = Router();

/** Decrypt the IMAP password in a config object for use by ImapReader. */
function withDecryptedPassword(configObj) {
  return { ...configObj, imap_password: decrypt(configObj.imap_password) };
}

// GET /api/curve/config
// Returns the authenticated user's CurveConfig plus a synthetic `email`
// field resolved from `user_id`.
router.get('/config', async (req, res) => {
  try {
    const data = await CurveConfig.findOne({ user_id: req.userId }).lean();
    if (!data) return res.json({ data: {} });

    const user = await User.findById(req.userId).select('email').lean();
    res.json({ data: { ...data, email: user?.email ?? null } });
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
      confirm_folder,
    } = req.body;

    const update = {
      imap_server, imap_port, imap_username,
      imap_password: imap_password ? encrypt(imap_password) : undefined,
      imap_tls,
      imap_folder, sync_enabled, sync_interval_minutes,
      imap_since: imap_since ? new Date(imap_since) : null,
      max_emails_per_run: max_emails_per_run != null ? Number(max_emails_per_run) : undefined,
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
router.post('/sync', async (req, res) => {
  const dryRun = req.query.dry_run === '1' || req.query.dry_run === 'true';
  try {
    const config = await CurveConfig.findOne({ user_id: req.userId });
    if (!config) {
      return res.status(404).json({
        error: 'Nenhuma configuração guardada. Preenche e carrega em "Guardar" primeiro.',
      });
    }
    const plainConfig = withDecryptedPassword(config.toObject());
    const reader = new ImapReader(plainConfig);
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
      const status =
        { CONFIG: 400, AUTH: 401, CONNECT: 503, FOLDER: 404 }[err.code] ?? 500;
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
    const { folders } = await testConnection(withDecryptedPassword(config));
    res.json({
      message: `Ligação OK. ${folders.length} pastas disponíveis no servidor.`,
      folders,
    });
  } catch (err) {
    if (err instanceof ImapError) {
      const status =
        { CONFIG: 400, AUTH: 401, CONNECT: 503, FOLDER: 404 }[err.code] ?? 500;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/curve/logs
router.get('/logs', async (req, res) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const logFilter = { user_id: req.userId };
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
