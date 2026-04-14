import { Router } from 'express';
import Category from '../models/Category.js';
import Expense from '../models/Expense.js';

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

// ─────────────────────────────────────────────────────────────────────
// GET /api/categories/stats
//
// Feeds the distribution bar, category list totals, and KPI strip on
// the /categories management screen (docs/Categories.md §8.6 + §9).
//
// Query params:
//   ?cycle=current (default)
//   ?cycle=previous
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD   (explicit range)
//
// Response shape (§8.6):
//   {
//     data: {
//       cycle:       { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' },
//       totals:      [{ category_id, category_name, total, expense_count, entity_count }, ...],
//       grand_total: Number,
//     }
//   }
//
// Notes:
//   - Always user-scoped (`user_id: req.userId`) — no cross-user view,
//     even for admins (§9.9: graphics are always personal).
//   - Uncategorised expenses collapse into a synthetic bucket with
//     `category_id: null` and `category_name: null`.
//   - `200` even for users with zero expenses (§8.6 contract) —
//     returns `totals: []` and `grand_total: 0`.
//   - `400 invalid_range` for malformed dates or `start > end`.
//
// Implementation notes:
//   `Expense.date` is stored as a raw human-readable string
//   ("06 April 2026 08:53:31") because the sync pipeline mirrors
//   curve.py byte-for-byte to keep the digest stable (§emailParser).
//   That rules out Mongo-side date filtering, so we load the user's
//   expense set and filter + aggregate in JS. At MVP scale (<10k
//   expenses/user, §6.7) a full user scan is fine — the same pattern
//   is used by routes/categoryOverrides apply-to-all.
// ─────────────────────────────────────────────────────────────────────

// Compute the start/end of a day-22 cycle as UTC Date objects.
// - `start` is inclusive at 00:00:00 UTC of the 22nd.
// - `end`   is inclusive at 23:59:59.999 UTC of the 21st (next month).
// Anchored on UTC so cycle boundaries don't drift with server TZ.
function cycleBoundsFor(anchor) {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth();
  const d = anchor.getUTCDate();
  // If we're on/after day 22, the current cycle starts THIS month on
  // the 22nd; otherwise it started LAST month on the 22nd.
  const startY = d >= 22 ? y : (m === 0 ? y - 1 : y);
  const startM = d >= 22 ? m : (m === 0 ? 11 : m - 1);
  const start = new Date(Date.UTC(startY, startM, 22, 0, 0, 0, 0));
  // End = the 21st of the following month, inclusive through EOD.
  const endY = startM === 11 ? startY + 1 : startY;
  const endM = startM === 11 ? 0 : startM + 1;
  const end = new Date(Date.UTC(endY, endM, 21, 23, 59, 59, 999));
  return { start, end };
}

function formatISODate(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Parse "06 April 2026 08:53:31" (the format emitted by the Curve
// email parser) into a JS Date. Node's Date constructor handles this
// format natively in V8 — tested end-to-end before wiring this in.
// Returns `null` on any failure so the caller can skip bad rows
// without poisoning the aggregate.
function parseExpenseDate(str) {
  if (!str || typeof str !== 'string') return null;
  const t = Date.parse(str);
  if (Number.isNaN(t)) return null;
  return new Date(t);
}

// Resolve the requested cycle into `{ start, end }` Dates + labels.
// Returns `null` + an error code when the caller supplied a bad range.
function resolveCycleParam({ cycle, start, end }) {
  // Explicit range wins over the `cycle` shortcut so `?start=&end=`
  // behaves predictably even if `cycle` is accidentally kept around.
  if (start || end) {
    if (!start || !end) return { error: 'invalid_range' };
    const startTs = Date.parse(`${start}T00:00:00.000Z`);
    const endTs = Date.parse(`${end}T23:59:59.999Z`);
    if (Number.isNaN(startTs) || Number.isNaN(endTs)) {
      return { error: 'invalid_range' };
    }
    if (startTs > endTs) return { error: 'invalid_range' };
    return {
      bounds: { start: new Date(startTs), end: new Date(endTs) },
      label: { start, end },
    };
  }

  const now = new Date();
  if (cycle === 'previous') {
    // "Previous cycle" = the cycle ending the day before the current
    // cycle starts. We derive it by walking the current cycle's start
    // back by one day and rounding to that anchor's 22nd — this
    // handles year boundaries and variable month lengths for free
    // (e.g. Mar 22 - Apr 21 previous = Feb 22 - Mar 21, not Jan).
    const currentBounds = cycleBoundsFor(now);
    const anchor = new Date(currentBounds.start.getTime() - 24 * 60 * 60 * 1000);
    const bounds = cycleBoundsFor(anchor);
    return {
      bounds,
      label: { start: formatISODate(bounds.start), end: formatISODate(bounds.end) },
    };
  }
  // Default: current cycle.
  const bounds = cycleBoundsFor(now);
  return {
    bounds,
    label: { start: formatISODate(bounds.start), end: formatISODate(bounds.end) },
  };
}

router.get('/stats', async (req, res) => {
  try {
    const resolved = resolveCycleParam({
      cycle: req.query.cycle,
      start: req.query.start,
      end: req.query.end,
    });
    if (resolved.error) {
      return res.status(400).json({ error: resolved.error });
    }
    const { bounds, label } = resolved;

    // User-scoped full scan. `select` keeps the payload small — we
    // only need the three fields the aggregate touches.
    const rows = await Expense.find({ user_id: req.userId })
      .select('entity amount date category_id')
      .lean();

    // Group by category_id (or the synthetic `__null__` key for
    // uncategorised). Each bucket tracks total, count, and a Set of
    // distinct entity names for `entity_count`.
    const NULL_KEY = '__null__';
    const buckets = new Map();
    let grandTotal = 0;

    for (const r of rows) {
      const when = parseExpenseDate(r.date);
      if (!when) continue; // skip malformed rows silently
      if (when < bounds.start || when > bounds.end) continue;

      const amount = typeof r.amount === 'number' ? r.amount : Number(r.amount);
      if (!Number.isFinite(amount)) continue;

      const key = r.category_id ? r.category_id.toString() : NULL_KEY;
      let b = buckets.get(key);
      if (!b) {
        b = { total: 0, expense_count: 0, entities: new Set() };
        buckets.set(key, b);
      }
      b.total += amount;
      b.expense_count += 1;
      if (r.entity) b.entities.add(r.entity);
      grandTotal += amount;
    }

    // Hydrate category names in one batch query.
    const realIds = [...buckets.keys()].filter((k) => k !== NULL_KEY);
    const cats = realIds.length
      ? await Category.find({ _id: { $in: realIds } })
          .select('_id name')
          .lean()
      : [];
    const nameMap = new Map(cats.map((c) => [c._id.toString(), c.name]));

    const totals = [...buckets.entries()]
      .map(([key, b]) => ({
        category_id: key === NULL_KEY ? null : key,
        category_name: key === NULL_KEY ? null : nameMap.get(key) ?? null,
        total: Math.round(b.total * 100) / 100,
        expense_count: b.expense_count,
        entity_count: b.entities.size,
      }))
      // Descending by total — matches the default sort of the
      // category list (§9.3).
      .sort((a, b) => b.total - a.total);

    res.json({
      data: {
        cycle: label,
        totals,
        grand_total: Math.round(grandTotal * 100) / 100,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
