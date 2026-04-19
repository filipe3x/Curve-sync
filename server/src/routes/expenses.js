import { Router } from 'express';
import mongoose from 'mongoose';
import Expense from '../models/Expense.js';
import Category from '../models/Category.js';
import CurveLog from '../models/CurveLog.js';
import CurveExpenseExclusion from '../models/CurveExpenseExclusion.js';
import {
  computeDigest,
  reassignCategoryBulk,
} from '../services/expense.js';
import { loadContext, resolveCategory } from '../services/categoryResolver.js';
import {
  computeDashboardStats,
  computeCycleHistory,
} from '../services/expenseStats.js';
import { parseExpenseDateOrNull } from '../services/expenseDate.js';
import { audit, clientIp } from '../services/audit.js';

const router = Router();

// Escape a user-supplied string so it's safe to embed in a RegExp. Without
// this the caller could ship `.*`, `(?:` catastrophic backtracking, or
// unbalanced brackets and either crash the regex compiler or DoS the
// server. The character set is the canonical set from MDN.
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Allowlist of sortable fields. Anything else falls back to
// `-date_at` (default). `date` (the raw string) is kept in the
// allowlist for retro-compat with any client that hasn't migrated
// yet; it will be removed one or two sprints from now once the
// dashboards, the /expenses page, and the /categories detail panel
// are all confirmed to be sending `-date_at`. Sorting on `date`
// remains broken (lexical on day-first strings + mixed BSON types,
// see ROADMAP §2.x investigation + scripts/analyze-expense-dates.js);
// leaving it is an explicit retro-compat choice, not an endorsement.
const ALLOWED_SORT_FIELDS = new Set([
  'date_at',
  'date',
  'amount',
  'entity',
  'card',
  'created_at',
]);

function sanitiseSort(raw) {
  if (!raw || typeof raw !== 'string') return '-date_at';
  const desc = raw.startsWith('-');
  const field = desc ? raw.slice(1) : raw;
  if (!ALLOWED_SORT_FIELDS.has(field)) return '-date_at';
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
      // ROADMAP §2.10 — 'excluded' = only rows the user has flagged
      // as "don't count this cycle"; 'included' = only rows they
      // haven't. Default 'all' mirrors pre-§2.10 behaviour.
      exclude_filter,
      // ROADMAP §2.10.1 — CSV of ObjectIds for the /curve/logs
      // drill-down of bulk exclusion rows. When present, the
      // response is scoped to exactly these ids (still enforcing
      // user_id) and every other filter (category, card, date) is
      // ignored — the consumer is a targeted resolver, not a search.
      // Cap 200 ids per call to keep the $in list small; beyond that
      // the caller should paginate client-side.
      ids,
    } = req.query;
    const safeSort = sanitiseSort(sort);
    const filter = { user_id: req.userId };
    // Early exit: targeted id lookup short-circuits every other
    // filter branch. We still apply user_id scope for safety.
    if (typeof ids === 'string' && ids.trim() !== '') {
      const parsed = ids
        .split(',')
        .map((s) => s.trim())
        .filter((s) => mongoose.isValidObjectId(s))
        .slice(0, 200);
      if (parsed.length === 0) {
        return res.json({ data: [], meta: { total: 0 } });
      }
      const rows = await Expense.find({
        _id: { $in: parsed },
        user_id: req.userId,
      })
        .lean();
      // Annotate with excluded flag so the drill-down row can show
      // the current live state (may have drifted since the audit row
      // was written — e.g. a bulk exclusion partially reverted).
      const exclusions = await CurveExpenseExclusion.find({
        user_id: req.userId,
        expense_id: { $in: rows.map((r) => r._id) },
      })
        .select('expense_id')
        .lean();
      const excludedSet = new Set(
        exclusions.map((e) => String(e.expense_id)),
      );
      const data = rows.map((r) => ({
        ...r,
        excluded: excludedSet.has(String(r._id)),
      }));
      return res.json({ data, meta: { total: data.length } });
    }
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

    // Pre-compute the user's exclusion set once — used both to filter
    // by `exclude_filter` (if present) and to annotate each returned
    // row with `excluded: boolean`. At MVP scale this set is small
    // (dozens per user at most) so a single in-memory Set is the
    // simplest join strategy.
    const exclusionRows = await CurveExpenseExclusion.find({
      user_id: req.userId,
    })
      .select('expense_id')
      .lean();
    const excludedSet = new Set(
      exclusionRows.map((r) => r.expense_id.toString()),
    );

    if (exclude_filter === 'excluded' || exclude_filter === 'included') {
      // Narrow the Mongo filter by the excluded ids before counting.
      // An empty exclusion set + `exclude_filter=excluded` correctly
      // yields zero rows (via `_id: { $in: [] }`).
      const idList = [...excludedSet];
      if (exclude_filter === 'excluded') {
        filter._id = { $in: idList };
      } else {
        filter._id = { $nin: idList };
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
      // `excluded` is derived from the exclusion set loaded above;
      // the `CurveExpenseExclusion` collection is the source of truth.
      excluded: excludedSet.has(e._id.toString()),
    }));

    // Dashboard KPIs + cycle history — computed in parallel so
    // adding the trend chart doesn't bump the `/expenses` latency.
    // Keeping them on `meta` (instead of dedicated /stats endpoints)
    // means the dashboard's single `getExpenses({ limit: 5 })` call
    // wires the four StatCards AND the trend card at once.
    // Fast-fail per branch: either helper blowing up collapses to
    // null rather than 500ing the listing — the UI handles `null`.
    const [statsRes, historyRes] = await Promise.allSettled([
      computeDashboardStats({ userId: req.userId }),
      computeCycleHistory({
        userId: req.userId,
        // Always return the max window (24) so the 6m/12m/24m
        // toggle is a pure client-side slice with no round-trip.
        cycles: 24,
      }),
    ]);
    const dashboardStats =
      statsRes.status === 'fulfilled' ? statsRes.value : null;
    if (statsRes.status === 'rejected') {
      console.warn(`dashboard stats failed: ${statsRes.reason?.message}`);
    }
    const cycleHistory =
      historyRes.status === 'fulfilled' ? historyRes.value : null;
    if (historyRes.status === 'rejected') {
      console.warn(`cycle history failed: ${historyRes.reason?.message}`);
    }

    res.json({
      data: enriched,
      meta: {
        total,
        page: Number(page),
        limit: Number(limit),
        ...(dashboardStats ?? {}),
        cycle_history: cycleHistory,
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
    // Digest stays hashed from the raw request string — mirrors
    // curve.py + the sync path's emailParser, preserving dedup against
    // Embers-era rows for the same (entity, amount, date, card) tuple.
    const digest = computeDigest({ entity, amount, date, card });
    const resolverContext = await loadContext(req.userId);
    const category_id = resolveCategory(entity, resolverContext);

    // `date` on the wire is the human string; schema stores BSON Date.
    // `parseExpenseDateOrNull` returns null on garbage input, which
    // Mongoose then rejects via `required: true` — caller gets a 500
    // and the row never lands. Preferable to silently accepting
    // unparseable dates given this endpoint has no validator gate.
    const typedDate = parseExpenseDateOrNull(date);

    const expense = await Expense.create({
      entity,
      amount,
      date: typedDate,
      date_at: typedDate,
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

    // Keep the denormalised `CurveLog.uncategorised` flag in sync with
    // the live expense state. The flag was originally snapshotted at
    // sync time to feed the /curve/stats/uncategorised count and the
    // /curve/logs?tab=uncategorised view without joining to Expense.
    // Once the user recategorises, the flag stops matching reality and
    // the row lingers in the "Sem categoria" tab until the next sync.
    // Fix it here: category_id=null means uncategorised, anything else
    // means categorised. `updateMany` is scoped to `{ expense_id, user_id }`
    // for defence-in-depth. Best-effort — a failure here doesn't roll
    // back the expense write (the log is a view, not the source of
    // truth), but it is logged so ops can spot the inconsistency.
    try {
      await CurveLog.updateMany(
        { expense_id: id, user_id: req.userId },
        { $set: { uncategorised: category_id === null } },
      );
    } catch (e) {
      console.warn(
        `expenses.putCategory: could not sync CurveLog.uncategorised for ${id}: ${e.message}`,
      );
    }

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

// ─────────────────────────────────────────────────────────────────────
// POST /api/expenses/exclusions
// DELETE /api/expenses/exclusions
//
// Toggle the "do not count for cycle / savings score" flag on up to
// 500 expenses owned by the caller (ROADMAP §2.10). The exclusion
// lives in the Curve-Sync-owned `curve_expense_exclusions` collection
// — we never mutate `expenses` beyond the §4.4 `category_id`
// relaxation (CLAUDE.md → MongoDB Collection Access Rules).
//
// Body: `{ expense_ids: [String] }` (1..500 hex strings). DELETE
// accepts the same shape for symmetry; RESTful sensibilities want a
// body on DELETE rarely but here it's worth it — a URL with 500 ids
// would be unwieldy and the handlers mirror each other's validation.
//
// Authorisation: req.userId from the router-level `authenticate`
// middleware. Every write is scoped by `{ user_id: req.userId, expense_id }`
// so cross-user payloads silently no-op. We also re-check that every
// id in the payload actually belongs to the caller before writing —
// this is belt-and-braces (the write itself is already safe) but it
// keeps the `count` in the audit row honest.
//
// Responses:
//   200 { affected, skipped }
//       `affected` = number of exclusions actually created (POST) or
//                     deleted (DELETE). POST absorbs duplicates
//                     silently (idempotent — unique index on
//                     (user_id, expense_id)); DELETE collapses to 0
//                     when the row wasn't excluded.
//       `skipped`  = ids the user doesn't own OR ids that were
//                     already in the target state.
//   400 invalid_body           — array missing, empty, > 500, or
//                                containing malformed hex strings
// ─────────────────────────────────────────────────────────────────────
const MAX_EXCLUSION_BATCH = 500;

function parseExclusionBody(body) {
  const ids = body?.expense_ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_EXCLUSION_BATCH) {
    return { error: 'invalid_body' };
  }
  const unique = [...new Set(ids)];
  if (unique.some((id) => !mongoose.isValidObjectId(id))) {
    return { error: 'invalid_body' };
  }
  return { unique };
}

router.post('/exclusions', async (req, res) => {
  try {
    const parsed = parseExclusionBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    // Filter down to ids the caller actually owns — anything else
    // contributes to `skipped` without ever touching the DB.
    const owned = await Expense.find({
      _id: { $in: parsed.unique },
      user_id: req.userId,
    })
      .select('_id entity')
      .lean();
    const ownedIds = owned.map((r) => r._id);

    // Bulk upsert: one write per id, but the unique index on
    // (user_id, expense_id) collapses duplicates to the existing row
    // with no-op. `bulkWrite` in unordered mode returns `upsertedCount`
    // — the number of *new* exclusions, which is what the user sees
    // as "N excluídas" in the toast.
    let affected = 0;
    if (ownedIds.length > 0) {
      const ops = ownedIds.map((id) => ({
        updateOne: {
          filter: { user_id: req.userId, expense_id: id },
          update: { $setOnInsert: { user_id: req.userId, expense_id: id } },
          upsert: true,
        },
      }));
      const result = await CurveExpenseExclusion.bulkWrite(ops, {
        ordered: false,
      });
      affected = result.upsertedCount ?? 0;
    }
    const skipped = parsed.unique.length - affected;

    // Single-row branch carries expense_id + entity for the
    // /curve/logs renderer. Bulk branch leaves them null, persists
    // the full ownedIds into `affected_expense_ids` so the /curve/logs
    // drill-down (§2.10.1) can resolve them back to expense rows,
    // and keeps `count=N` in detail for read-paths that only look at
    // the legacy string.
    const single = ownedIds.length === 1 ? owned[0] : null;
    audit({
      action: 'expense_excluded_from_cycle',
      userId: req.userId,
      ip: clientIp(req),
      detail: `count=${affected}`,
      expenseId: single?._id,
      entity: single?.entity,
      affectedExpenseIds: ownedIds.length > 1 ? ownedIds : undefined,
    });

    res.json({ affected, skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/exclusions', async (req, res) => {
  try {
    const parsed = parseExclusionBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    // Validate ownership first — same belt-and-braces as POST.
    const owned = await Expense.find({
      _id: { $in: parsed.unique },
      user_id: req.userId,
    })
      .select('_id entity')
      .lean();
    const ownedIds = owned.map((r) => r._id);

    let affected = 0;
    if (ownedIds.length > 0) {
      const result = await CurveExpenseExclusion.deleteMany({
        user_id: req.userId,
        expense_id: { $in: ownedIds },
      });
      affected = result.deletedCount ?? 0;
    }
    const skipped = parsed.unique.length - affected;

    const single = ownedIds.length === 1 ? owned[0] : null;
    audit({
      action: 'expense_included_in_cycle',
      userId: req.userId,
      ip: clientIp(req),
      detail: `count=${affected}`,
      expenseId: single?._id,
      entity: single?.entity,
      affectedExpenseIds: ownedIds.length > 1 ? ownedIds : undefined,
    });

    res.json({ affected, skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
