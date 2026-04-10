import { Router } from 'express';
import Expense from '../models/Expense.js';

const router = Router();

// GET /api/autocomplete/:field
router.get('/:field', async (req, res) => {
  const allowed = ['entity', 'card'];
  const { field } = req.params;

  if (!allowed.includes(field)) {
    return res.status(400).json({ error: `Campo inválido: ${field}` });
  }

  try {
    const values = await Expense.distinct(field, { user_id: req.userId });
    res.json({ data: values.filter(Boolean).sort() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
