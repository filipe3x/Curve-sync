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

const router = Router();

// Escape a string for safe use inside a RegExp literal. The admin types
// the email by hand, so we don't trust the characters to be regex-safe
// even though real addresses rarely contain metacharacters.
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// GET /api/curve/config
// Returns the singleton CurveConfig plus a synthetic `email` field
// resolved from `user_id` (matches the Embers User collection's field
// name). The frontend uses `email` to pre-fill the "Email Embers" input
// — the raw `user_id` ObjectId is never shown.
router.get('/config', async (req, res) => {
  try {
    // For now return the first config (single-user). TODO: auth + user scoping.
    const data = await CurveConfig.findOne().lean();
    if (!data) return res.json({ data: {} });

    let email = null;
    if (data.user_id) {
      const user = await User.findById(data.user_id).select('email').lean();
      email = user?.email ?? null;
    }
    res.json({ data: { ...data, email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/curve/config
// The client sends `email` (the Embers user's email — same field name as
// the Embers User collection) instead of `user_id`. We look up the User
// by that email (case-insensitive exact match) and set `user_id` from the
// lookup result. This is the ONLY path that writes `user_id` — we never
// trust a client-supplied ObjectId for multi-user scoping.
router.put('/config', async (req, res) => {
  try {
    const {
      imap_server, imap_port, imap_username, imap_password, imap_tls,
      imap_folder, sync_enabled, sync_interval_minutes, email,
      imap_since, max_emails_per_run,
      // `confirm_folder: true` is sent by the frontend folder picker
      // (auto-save on dropdown change) and by the "Manter INBOX"
      // dismiss button. It's the ONLY way to set imap_folder_confirmed_at
      // — we don't let the client forge the timestamp directly.
      confirm_folder,
    } = req.body;

    const emailTrimmed = typeof email === 'string' ? email.trim() : '';
    if (!emailTrimmed) {
      return res.status(400).json({
        error: 'Email do utilizador Embers é obrigatório.',
      });
    }

    // Embers stores emails lowercase (downcase_email before_validation)
    // but we use a case-insensitive exact match so casing typos in the
    // admin UI don't cause a false negative.
    const user = await User.findOne({
      email: { $regex: `^${escapeRegex(emailTrimmed)}$`, $options: 'i' },
    })
      .select('_id')
      .lean();
    if (!user) {
      return res.status(404).json({
        error: `Nenhum utilizador Embers encontrado com email "${emailTrimmed}".`,
      });
    }

    const update = {
      imap_server, imap_port, imap_username, imap_password, imap_tls,
      imap_folder, sync_enabled, sync_interval_minutes,
      imap_since: imap_since ? new Date(imap_since) : null,
      max_emails_per_run: max_emails_per_run != null ? Number(max_emails_per_run) : undefined,
      user_id: user._id,
    };
    if (confirm_folder === true) {
      update.imap_folder_confirmed_at = new Date();
    }

    const data = await CurveConfig.findOneAndUpdate(
      {},
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
    const config = await CurveConfig.findOne();
    if (!config) {
      return res.status(404).json({
        error: 'Nenhuma configuração guardada. Preenche e carrega em "Guardar" primeiro.',
      });
    }
    if (!config.user_id) {
      return res.status(400).json({
        error:
          'CurveConfig sem user_id — multi-user scoping exige que o config esteja associado a um utilizador.',
      });
    }
    const reader = new ImapReader(config.toObject());
    const summary = await syncEmails({
      config: config.toObject(),
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
router.get('/sync/status', async (_req, res) => {
  try {
    const config = await CurveConfig.findOne().lean();
    res.json({
      running: isSyncing(),
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
router.post('/test-connection', async (_req, res) => {
  try {
    const config = await CurveConfig.findOne().lean();
    if (!config) {
      return res.status(404).json({
        error: 'Nenhuma configuração guardada. Preenche e carrega em "Guardar" primeiro.',
      });
    }
    const { folders } = await testConnection(config);
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

    const [data, total] = await Promise.all([
      CurveLog.find()
        .sort('-created_at')
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      CurveLog.countDocuments(),
    ]);

    res.json({ data, meta: { total, page: Number(page), limit: Number(limit) } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
