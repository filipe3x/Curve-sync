import { Router } from 'express';
import CurveConfig from '../models/CurveConfig.js';
import CurveLog from '../models/CurveLog.js';
import { testConnection, ImapError, ImapReader } from '../services/imapReader.js';
import {
  syncEmails,
  isSyncing,
  SyncConflictError,
} from '../services/syncOrchestrator.js';

const router = Router();

// GET /api/curve/config
router.get('/config', async (req, res) => {
  try {
    // For now return the first config (single-user). TODO: auth + user scoping.
    const data = await CurveConfig.findOne().lean();
    res.json({ data: data ?? {} });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/curve/config
router.put('/config', async (req, res) => {
  try {
    const {
      imap_server, imap_port, imap_username, imap_password, imap_tls,
      imap_folder, sync_enabled, sync_interval_minutes, user_id,
    } = req.body;

    const data = await CurveConfig.findOneAndUpdate(
      {},
      {
        imap_server, imap_port, imap_username, imap_password, imap_tls,
        imap_folder, sync_enabled, sync_interval_minutes,
        ...(user_id && { user_id }),
      },
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
    return res.json({
      message: summary.halted
        ? `Sync abortada pelo circuit breaker após ${summary.parseErrors} parse errors consecutivos.`
        : `Sync OK. ${summary.ok} novos, ${summary.duplicates} duplicados, ${summary.parseErrors} parse errors, ${summary.errors} erros.`,
      summary,
    });
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
