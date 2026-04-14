import { Router } from 'express';
import mongoose from 'mongoose';
import Expense from '../models/Expense.js';
import Category from '../models/Category.js';
import {
  assignCategory,
  computeDigest,
  reassignCategoryBulk,
} from '../services/expense.js';
import { audit, clientIp } from '../services/audit.js';

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

// PUT /api/expenses/:id/category
// Single-expense quick-edit path from the <CategoryPickerPopover>
// (docs/Categories.md §12.7). Updates ONLY the `category_id` field of
// one expense, going through the `reassignCategoryBulk` helper — the
// single authorised write surface for the §4.4 relaxation.
//
// Authorisation:
//   - req.userId comes from the `authenticate` middleware.
//   - The filter is `{ _id, user_id }` so cross-user writes match 0
//     documents and the handler returns `404 expense_not_found`
//     (§7.5 — 404 over 403 to avoid leaking existence).
//
// Body: `{ category_id: ObjectId | null }`. `null` clears the
// association; any other non-ObjectId string is rejected as
// `400 invalid_category_id` before any DB work.
router.put('/:id/category', async (req, res) => {
  try {
    const { id } = req.params;
    const { category_id } = req.body ?? {};

    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ error: 'expense_not_found' });
    }
    // `null` is allowed — "uncategorise" is a valid quick-edit target.
    if (category_id !== null && !mongoose.isValidObjectId(category_id)) {
      return res.status(400).json({ error: 'invalid_category_id' });
    }

    // Load the current expense first so we can (a) emit a 404 for
    // missing / cross-user without touching the category table and
    // (b) capture the `from` category name for the audit row.
    const current = await Expense.findOne({
      _id: id,
      user_id: req.userId,
    }).lean();
    if (!current) {
      return res.status(404).json({ error: 'expense_not_found' });
    }

    // Validate the target category exists (when not clearing). Done
    // after the expense lookup so we never reveal the existence of an
    // unknown category to a user who doesn't even own the expense.
    let targetCategory = null;
    if (category_id !== null) {
      targetCategory = await Category.findById(category_id).lean();
      if (!targetCategory) {
        return res.status(404).json({ error: 'category_not_found' });
      }
    }

    // Early-out when the target matches the current value — avoids a
    // no-op write and a confusing audit row. The popover already
    // disables the Save button in this case but defending the endpoint
    // keeps it honest against scripted callers.
    const currentCategoryId = current.category_id
      ? current.category_id.toString()
      : null;
    const nextCategoryId = category_id ? category_id.toString() : null;
    if (currentCategoryId === nextCategoryId) {
      return res.json({
        data: { ...current, category_name: targetCategory?.name ?? null },
      });
    }

    // The one sanctioned write. Scoped by `{ _id, user_id }` so a
    // cross-user write hits 0 rows even if the caller managed to
    // fake an id.
    await reassignCategoryBulk(
      { _id: id, user_id: req.userId },
      category_id,
    );

    // Re-read so the response carries the updated `updated_at` that
    // Mongoose just stamped — the popover optimistically updates the
    // chip and the response confirms it.
    const updated = await Expense.findById(id).lean();

    // Resolve both names (from + to) once for the response AND the
    // audit payload. `from` can be null if the expense was
    // uncategorised; `to` can be null if the user just cleared it.
    const fromName = currentCategoryId
      ? (await Category.findById(currentCategoryId).lean())?.name ?? null
      : null;
    const toName = targetCategory?.name ?? null;

    // `error_detail` follows the k=v space-separated convention from
    // docs/Categories.md §13.2 #34. `truncateDetail` is applied at the
    // CurveLog.create level — this line is well under 120 chars for
    // realistic names.
    const detail = `from=${fromName ?? '—'} to=${toName ?? '—'}`;
    audit({
      action: 'expense_category_changed',
      userId: req.userId,
      ip: clientIp(req),
      detail,
      expenseId: updated._id,
      entity: updated.entity,
    });

    res.json({
      data: { ...updated, category_name: toName },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
