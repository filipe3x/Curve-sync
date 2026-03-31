import { Router } from 'express';
import CurveConfig from '../models/CurveConfig.js';
import CurveLog from '../models/CurveLog.js';

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
      imap_server, imap_port, imap_username, imap_password,
      imap_folder, sync_enabled, sync_interval_minutes, user_id,
    } = req.body;

    const data = await CurveConfig.findOneAndUpdate(
      {},
      {
        imap_server, imap_port, imap_username, imap_password,
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

// POST /api/curve/sync — trigger manual sync
router.post('/sync', async (_req, res) => {
  // TODO: implement actual IMAP fetch + parse pipeline
  res.json({ message: 'Sync triggered (not yet implemented).' });
});

// POST /api/curve/test-connection
router.post('/test-connection', async (_req, res) => {
  // TODO: implement IMAP connection test
  res.json({ message: 'Connection test (not yet implemented).' });
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
