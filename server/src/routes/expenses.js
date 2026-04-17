import { Router } from 'express';
import mongoose from 'mongoose';
import Expense from '../models/Expense.js';
import Category from '../models/Category.js';
import {
  computeDigest,
  reassignCategoryBulk,
} from '../services/expense.js';
import { loadContext, resolveCategory } from '../services/categoryResolver.js';
import { computeDashboardStats } from '../services/expenseStats.js';
import { audit, clientIp } from '../services/audit.js';

const router = Router();

// Escape a user-supplied string so it's safe to embed in a RegExp. Without
// this the caller could ship `.*`, `(?:` catastrophic backtracking, or
// unbalanced brackets and either crash the regex compiler or DoS the
// server. The character set is the canonical set from MDN.
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Allowlist of sortable fields. Anything else falls back to `-date`
// (default). This prevents a caller from sorting on an indexed field
// they shouldn't see (e.g. `user_id` would change result ordering but
// leak nothing since the user filter is applied first; still, tight is
// better than loose).
const ALLOWED_SORT_FIELDS = new Set([
  'date',
  'amount',
  'entity',
  'card',
  'created_at',
]);

function sanitiseSort(raw) {
  if (!raw || typeof raw !== 'string') return '-date';
  const desc = raw.startsWith('-');
  const field = desc ? raw.slice(1) : raw;
  if (!ALLOWED_SORT_FIELDS.has(field)) return '-date';
  return desc ? `-${field}` : field;
}

// GET /api/expenses
//
// Compact-mode query param `fields=_id` switches the handler to a
// lean id-only response: `{ ids: [...], total }` with no category
// enrichment, no pagination metadata, and a hard ceiling of 500 rows.
// This feeds the "Seleccionar todas as N" path on the /expenses
// batch-move UX (docs/Categories.md §12.x — bulk slice), where the
// client has already validated `total <= 500` against the normal
// paginated response before asking for all ids at once. Keeping it as
// a query-param flag on the existing endpoint (rather than a separate
// /ids route) means the filter-parsing logic below lives in one place.
//
// Supported filter query params (ROADMAP Fase 2.6 — all optional, all
// additive, unchanged defaults if omitted):
//   search       — fuzzy regex over entity + card (legacy)
//   category_id  — object id, or 'null' / 'uncategorised' synthetic key
//   card         — exact match on Expense.card
//   entity       — exact match on Expense.entity
//   start        — YYYY-MM-DD lower bound (inclusive) on Expense.date
//   end          — YYYY-MM-DD upper bound (inclusive) on Expense.date
//   sort         — one of date/amount/entity/card/created_at ±. Default -date.
// The legacy frontend (`ExpensesPage.jsx`) still only sends
// page/limit/search/sort; new params are driven by UI that lands later.
router.get('/', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      sort,
      search,
      category_id,
      card,
      entity,
      start,
      end,
      fields,
    } = req.query;
    const safeSort = sanitiseSort(sort);
    const filter = { user_id: req.userId };
    if (search) {
      const regex = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ entity: regex }, { card: regex }];
    }
    // Narrow to a specific category. `null`/`uncategorised` (the
    // literal strings) select the synthetic uncategorised bucket —
    // the /categories page uses this to populate the "Despesas
    // recentes" tab for each row, including the uncategorised one.
    if (category_id) {
      if (category_id === 'null' || category_id === 'uncategorised') {
        filter.category_id = null;
      } else if (mongoose.isValidObjectId(category_id)) {
        filter.category_id = category_id;
      }
      // Any other value (malformed id) falls through — the user-scoped
      // filter still applies, so nothing leaks. The client never
      // sends a malformed id in practice.
    }
    // Exact-match filters (ROADMAP Fase 2.6). These are populated from
    // the autocomplete endpoint so the values are already canonical;
    // we don't normalise case here to stay consistent with how the
    // expenses are stored.
    if (typeof card === 'string' && card.trim() !== '') {
      filter.card = card;
    }
    if (typeof entity === 'string' && entity.trim() !== '') {
      filter.entity = entity;
    }
    // Date range. `Expense.date` is a free-form string ("06 April 2026
    // 08:53:31") so we can't compare it lexicographically — parse it
    // Mongo-side via $dateFromString. Rows that fail to parse (onError:
    // null) are excluded, which matches the graceful-skip contract of
    // /categories/stats.
    if (
      (typeof start === 'string' && start.trim() !== '') ||
      (typeof end === 'string' && end.trim() !== '')
    ) {
      const conds = [];
      if (typeof start === 'string' && start.trim() !== '') {
        const s = new Date(`${start}T00:00:00.000Z`);
        if (!Number.isNaN(s.getTime())) {
          conds.push({
            $gte: [
              { $dateFromString: { dateString: '$date', onError: null } },
              s,
            ],
          });
        }
      }
      if (typeof end === 'string' && end.trim() !== '') {
        const e = new Date(`${end}T23:59:59.999Z`);
        if (!Number.isNaN(e.getTime())) {
          conds.push({
            $lte: [
              { $dateFromString: { dateString: '$date', onError: null } },
              e,
            ],
          });
        }
      }
      if (conds.length) {
        filter.$expr = conds.length === 1 ? conds[0] : { $and: conds };
      }
    }

    // ──────── Compact id-only mode ────────
    if (fields === '_id') {
      const total = await Expense.countDocuments(filter);
      // Defence-in-depth: even though the client checks `total <= 500`
      // before issuing this request, refuse the payload if the filter
      // matches more. The caller is expected to refine and retry.
      if (total > 500) {
        return res.status(400).json({
          error: 'bulk_too_large',
          detail: `limit=500 got=${total}`,
        });
      }
      const rows = await Expense.find(filter)
        .sort(safeSort)
        .limit(500)
        .select('_id')
        .lean();
      return res.json({ ids: rows.map((r) => r._id.toString()), total });
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [data, total] = await Promise.all([
      Expense.find(filter)
        .sort(safeSort)
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

    // Dashboard KPIs — computed in parallel with the list fetch above
    // so adding stats doesn't bump the `/expenses` latency. Keeping
    // them on `meta` (instead of a dedicated /stats endpoint) means the
    // dashboard's single `getExpenses({ limit: 5 })` call wires all
    // four StatCards at once. Fast-fail: any error collapses to zeros
    // rather than 500ing the listing — the stat cards handle `null`.
    let dashboardStats = null;
    try {
      dashboardStats = await computeDashboardStats({ userId: req.userId });
    } catch (e) {
      console.warn(`dashboard stats failed: ${e.message}`);
    }

    res.json({
      data: enriched,
      meta: {
        total,
        page: Number(page),
        limit: Number(limit),
        ...(dashboardStats ?? {}),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/expenses
//
// Manual expense creation goes through the same two-tier resolver as
// the sync orchestrator (docs/Categories.md §5) so personal overrides
// are honoured on the one-off write path too. `loadContext(req.userId)`
// is a two-query cost per request — fine for a rare manual create;
// callers that need to create many expenses in a loop should use the
// sync path instead.
router.post('/', async (req, res) => {
  try {
    const { entity, amount, date, card } = req.body;
    const digest = computeDigest({ entity, amount, date, card });
    const resolverContext = await loadContext(req.userId);
    const category_id = resolveCategory(entity, resolverContext);

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

// ─────────────────────────────────────────────────────────────────────
// PUT /api/expenses/bulk-category
//
// Multi-select batch move from the /expenses table. Moves up to 500
// expenses owned by the caller to a target category (or `null` to
// clear). Designed so that a regular user can reassign a handful of
// receipts without opening the popover on each row — the fine-grained
// selection is built up in the client via checkboxes and a
// "Seleccionar todas as N" link, and the payload lands here as a
// bounded array of ids.
//
// Authorisation:
//   - req.userId from `authenticate` (router-level).
//   - Filter always pinned to `{ _id: { $in: ids }, user_id: req.userId }`
//     so a payload carrying ids of a different user's expenses
//     silently matches zero documents. `moved` in the response
//     reflects the user-scoped intersection.
//
// Body:
//   { ids: [String],             // 1..500 ObjectId hex strings
//     category_id: String|null } // ObjectId or null to uncategorise
//
// Responses:
//   200 { moved, skipped, target_category_name }
//       `moved`   = server-side modifiedCount (ignores rows that
//                    were already in the target — includes them in
//                    `skipped` for an honest toast).
//       `skipped` = `ids.length - moved`.
//   400 invalid_body        — ids is not an array, empty, or > 500
//   400 invalid_category_id — category_id is present and not a valid
//                             ObjectId (null is allowed — clears)
//   404 category_not_found  — target category does not exist
// ─────────────────────────────────────────────────────────────────────
router.put('/bulk-category', async (req, res) => {
  try {
    const { ids, category_id } = req.body ?? {};

    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) {
      return res.status(400).json({ error: 'invalid_body' });
    }
    // Reject malformed ids up front — mongo would coerce silently and
    // report `moved: 0` which looks like a bug. Filter out duplicates
    // too, so the client never double-counts `skipped`.
    const unique = [...new Set(ids)];
    if (unique.some((id) => !mongoose.isValidObjectId(id))) {
      return res.status(400).json({ error: 'invalid_body' });
    }
    if (category_id !== null && category_id !== undefined && !mongoose.isValidObjectId(category_id)) {
      return res.status(400).json({ error: 'invalid_category_id' });
    }
    const target = category_id ?? null;

    // Validate the target category exists (when not clearing).
    let targetCategory = null;
    if (target !== null) {
      targetCategory = await Category.findById(target).lean();
      if (!targetCategory) {
        return res.status(404).json({ error: 'category_not_found' });
      }
    }

    // Snapshot the current `category_id` of the selection BEFORE the
    // write so the audit row can report `from_mixed`. The snapshot is
    // user-scoped so cross-user ids never enter the accounting — they
    // simply contribute to `skipped` via the moved-vs-requested delta.
    const current = await Expense.find({
      _id: { $in: unique },
      user_id: req.userId,
    })
      .select('_id category_id')
      .lean();

    const currentIds = new Set(current.map((r) => r._id.toString()));
    const distinctSources = new Set(
      current.map((r) => (r.category_id ? r.category_id.toString() : '__null__')),
    );
    const fromMixed = distinctSources.size > 1;

    // The one sanctioned write. `reassignCategoryBulk` returns both
    // matched (how many the user actually owns) and modified (how
    // many flipped). `skipped` is requested minus modified — covers
    // "not yours", "already in target", and "id is gibberish but
    // happened to be valid hex".
    const result = await reassignCategoryBulk(
      { _id: { $in: [...currentIds] }, user_id: req.userId },
      target,
    );

    const moved = result.modified;
    const skipped = unique.length - moved;

    const detail = `target=${targetCategory?.name ?? '—'} count=${moved} from_mixed=${fromMixed}`;
    audit({
      action: 'expense_category_changed_bulk',
      userId: req.userId,
      ip: clientIp(req),
      detail,
    });

    res.json({
      moved,
      skipped,
      target_category_name: targetCategory?.name ?? null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
