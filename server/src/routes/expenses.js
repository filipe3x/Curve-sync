import { Router } from 'express';
import Expense from '../models/Expense.js';
import Category from '../models/Category.js';
import { assignCategory, computeDigest } from '../services/expense.js';

const router = Router();

// GET /api/expenses
router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 20, sort = '-date', search } = req.query;
    const filter = { user_id: req.userId };
    if (search) {
      const regex = new RegExp(search, 'i');
      filter.$or = [{ entity: regex }, { card: regex }];
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [data, total] = await Promise.all([
      Expense.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      Expense.countDocuments(filter),
    ]);

    // Attach category names
    const catIds = [...new Set(data.filter((e) => e.category_id).map((e) => e.category_id.toString()))];
    const cats = catIds.length
      ? await Category.find({ _id: { $in: catIds } }).lean()
      : [];
    const catMap = Object.fromEntries(cats.map((c) => [c._id.toString(), c.name]));
    const enriched = data.map((e) => ({
      ...e,
      category_name: e.category_id ? catMap[e.category_id.toString()] ?? null : null,
    }));

    res.json({ data: enriched, meta: { total, page: Number(page), limit: Number(limit) } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/expenses
router.post('/', async (req, res) => {
  try {
    const { entity, amount, date, card } = req.body;
    const digest = computeDigest({ entity, amount, date, card });
    const category_id = await assignCategory(entity);

    const expense = await Expense.create({
      entity,
      amount,
      date,
      card,
      digest,
      user_id: req.userId,
      category_id,
    });

    res.status(201).json({ data: expense });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Despesa duplicada (digest já existe).' });
    }
    res.status(500).json({ error: err.message });
  }
});

export default router;
