import { Router } from 'express';
import Expense from '../models/Expense.js';

const router = Router();

// GET /api/autocomplete/:field
//
// Returns the caller's distinct values for `field` (`entity` or
// `card`), ordered by the most recent expense in which they appear.
// Recency beats alphabetical here because the primary consumer is
// the override-form autocomplete on /categories — users typically
// want to catalogue something they just saw on their card, not
// something from 2019. The UI caps the visible list, so putting the
// most relevant rows first is worth the aggregation over a plain
// `distinct`.
//
// `date` is stored as a `YYYY-MM-DD` string (see Expense.js), so a
// lexicographic `$max` still produces the true most-recent date
// without parsing. `created_at` is the secondary tiebreak for rows
// that share the same day (two manual entries, a re-import).
router.get('/:field', async (req, res) => {
  const allowed = ['entity', 'card'];
  const { field } = req.params;

  if (!allowed.includes(field)) {
    return res.status(400).json({ error: `Campo inválido: ${field}` });
  }

  try {
    const rows = await Expense.aggregate([
      { $match: { user_id: req.userId, [field]: { $nin: [null, ''] } } },
      {
        $group: {
          _id: `$${field}`,
          last_date: { $max: '$date' },
          last_created_at: { $max: '$created_at' },
        },
      },
      { $sort: { last_date: -1, last_created_at: -1, _id: 1 } },
    ]);
    res.json({ data: rows.map((r) => r._id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
