import { Router } from 'express';
import Category from '../models/Category.js';

const router = Router();

// GET /api/categories (read-only)
router.get('/', async (_req, res) => {
  try {
    const data = await Category.find().sort('name').lean();
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
