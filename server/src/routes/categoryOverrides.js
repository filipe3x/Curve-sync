import { Router } from 'express';
import mongoose from 'mongoose';
import CategoryOverride from '../models/CategoryOverride.js';
import Category from '../models/Category.js';
import Expense from '../models/Expense.js';
import {
  loadContext,
  normalize,
  resolveCategory,
} from '../services/categoryResolver.js';
import { reassignCategoryBulk } from '../services/expense.js';
import { audit, clientIp } from '../services/audit.js';

/**
 * /api/category-overrides — CRUD for personal matching rules.
 *
 * Source of truth: docs/Categories.md §4.3, §8.4, §13.2.
 *
 * Authorization (§7.3):
 *   - All routes require `authenticate` (mounted in index.js).
 *   - Every query is scoped by `user_id: req.userId` inside the
 *     handler — admins do NOT get a global view. This enforces the
 *     "personal is sacred" invariant: one user cannot read or
 *     mutate another user's overrides, regardless of role.
 *   - Cross-user access returns `404 override_not_found` per §7.5
 *     (404 over 403 to avoid leaking existence).
 *
 * Write-path contract:
 *   - `pattern` is stored verbatim; `pattern_normalized` is computed
 *     server-side via `categoryResolver.normalize()` — clients never
 *     supply it directly (avoids two sources of truth for
 *     normalisation).
 *   - Empty-after-normalize patterns are rejected (§5.8).
 *   - `match_type` defaults to `'contains'`; anything outside the
 *     enum is `400 invalid_match_type`.
 *   - `priority` defaults to `0`; non-integers are
 *     `400 invalid_priority`.
 *   - `category_id` existence is checked against the global
 *     catalogue — `404 category_not_found` if missing.
 *   - Duplicates (same user + same `pattern_normalized`) return
 *     `409 override_exists`.
 *
 * Audit (§13.2 #29-31):
 *   - Every create/update/delete writes an `override_*` row via the
 *     shared `audit()` helper. The `entity` field carries the raw
 *     pattern and `error_detail` follows the k=v convention from
 *     §13.2 so the /curve/logs renderer can surface a useful
 *     message without parsing back.
 */

const router = Router();

const ALLOWED_MATCH_TYPES = ['exact', 'starts_with', 'contains'];

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function isValidPriority(value) {
  if (value === undefined || value === null) return true; // will default to 0
  return Number.isInteger(value);
}

/**
 * Serialize a CategoryOverride document for the API response. Adds
 * `category_name` via a small lookup — callers supply the catalogue so
 * we don't query Category once per doc in list handlers.
 */
function serialize(doc, categoryMap) {
  const id = doc._id?.toString?.() ?? doc._id;
  return {
    id,
    category_id: doc.category_id?.toString?.() ?? doc.category_id ?? null,
    category_name: doc.category_id
      ? categoryMap?.get(doc.category_id.toString()) ?? null
      : null,
    pattern: doc.pattern,
    pattern_normalized: doc.pattern_normalized,
    match_type: doc.match_type,
    priority: doc.priority ?? 0,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
  };
}

async function loadCategoryMap(categoryIds) {
  if (!categoryIds.length) return new Map();
  const rows = await Category.find({ _id: { $in: categoryIds } })
    .select('_id name')
    .lean();
  return new Map(rows.map((c) => [c._id.toString(), c.name]));
}

// ─────────────────────────────────────────────────────────────────────
// GET /api/category-overrides
//
// Lists every override owned by the authenticated user. Category names
// are resolved in a single batch query so the response is self-contained.
// ─────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const rows = await CategoryOverride.find({ user_id: req.userId })
      .sort({ priority: -1, pattern_normalized: 1 })
      .lean();
    const categoryIds = [
      ...new Set(rows.map((r) => r.category_id?.toString()).filter(Boolean)),
    ];
    const categoryMap = await loadCategoryMap(categoryIds);
    res.json({ data: rows.map((r) => serialize(r, categoryMap)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/category-overrides
//
// Create a personal rule. Shape validation → category existence →
// normalise → insert. The unique index on `{ user_id, pattern_normalized }`
// is the final duplicate guard: if two requests race to the same
// normalised pattern, Mongoose returns code 11000 and we translate it
// to `409 override_exists`.
// ─────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { category_id, pattern, match_type, priority } = req.body ?? {};

    // Basic shape checks — in order of cheapness so typos fail fast
    // before we touch the DB.
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      return res.status(400).json({ error: 'pattern_required' });
    }
    const matchType = match_type ?? 'contains';
    if (!ALLOWED_MATCH_TYPES.includes(matchType)) {
      return res.status(400).json({ error: 'invalid_match_type' });
    }
    if (!isValidPriority(priority)) {
      return res.status(400).json({ error: 'invalid_priority' });
    }
    if (!mongoose.isValidObjectId(category_id)) {
      return res.status(404).json({ error: 'category_not_found' });
    }

    // Normalize and reject degenerate patterns (all punctuation, all
    // whitespace, emoji-only) before hitting the DB. §5.8 makes this
    // the service's responsibility — the matcher assumes
    // `pattern_normalized` is non-empty.
    const patternNormalized = normalize(pattern);
    if (!patternNormalized) {
      return res.status(400).json({ error: 'pattern_required' });
    }

    const category = await Category.findById(category_id)
      .select('_id name')
      .lean();
    if (!category) {
      return res.status(404).json({ error: 'category_not_found' });
    }

    let doc;
    try {
      doc = await CategoryOverride.create({
        user_id: req.userId,
        category_id: category._id,
        pattern: pattern.trim(),
        pattern_normalized: patternNormalized,
        match_type: matchType,
        priority: priority ?? 0,
      });
    } catch (err) {
      if (err?.code === 11000) {
        return res.status(409).json({ error: 'override_exists' });
      }
      throw err;
    }

    // §13.2 #29 — "Regra pessoal criada: <pattern> → <category>"
    audit({
      action: 'override_created',
      userId: req.userId,
      ip: clientIp(req),
      detail: `pattern=${doc.pattern} match_type=${doc.match_type} category=${category.name}`,
      entity: doc.pattern,
    });

    const categoryMap = new Map([[category._id.toString(), category.name]]);
    res.status(201).json({ data: serialize(doc.toObject(), categoryMap) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// PUT /api/category-overrides/:id
//
// Partial update — only `category_id`, `pattern`, `match_type`, and
// `priority` may change. `user_id` is never touched. 404 for both
// missing and cross-user IDs (§7.5).
// ─────────────────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ error: 'override_not_found' });
    }

    const existing = await CategoryOverride.findOne({
      _id: id,
      user_id: req.userId,
    });
    if (!existing) {
      return res.status(404).json({ error: 'override_not_found' });
    }

    const { category_id, pattern, match_type, priority } = req.body ?? {};
    const changed = [];

    if (category_id !== undefined) {
      if (!mongoose.isValidObjectId(category_id)) {
        return res.status(404).json({ error: 'category_not_found' });
      }
      const category = await Category.findById(category_id)
        .select('_id')
        .lean();
      if (!category) {
        return res.status(404).json({ error: 'category_not_found' });
      }
      if (existing.category_id?.toString() !== category._id.toString()) {
        existing.category_id = category._id;
        changed.push('category_id');
      }
    }

    if (pattern !== undefined) {
      if (typeof pattern !== 'string' || pattern.trim() === '') {
        return res.status(400).json({ error: 'pattern_required' });
      }
      const patternNormalized = normalize(pattern);
      if (!patternNormalized) {
        return res.status(400).json({ error: 'pattern_required' });
      }
      if (existing.pattern_normalized !== patternNormalized) {
        existing.pattern = pattern.trim();
        existing.pattern_normalized = patternNormalized;
        changed.push('pattern');
      } else if (existing.pattern !== pattern.trim()) {
        // Same normalised form but different raw — cosmetic rename
        // (e.g. "lidl" → "Lidl"). Still worth persisting because the
        // UI surfaces the raw pattern.
        existing.pattern = pattern.trim();
        changed.push('pattern');
      }
    }

    if (match_type !== undefined) {
      if (!ALLOWED_MATCH_TYPES.includes(match_type)) {
        return res.status(400).json({ error: 'invalid_match_type' });
      }
      if (existing.match_type !== match_type) {
        existing.match_type = match_type;
        changed.push('match_type');
      }
    }

    if (priority !== undefined) {
      if (!isValidPriority(priority)) {
        return res.status(400).json({ error: 'invalid_priority' });
      }
      if (existing.priority !== priority) {
        existing.priority = priority;
        changed.push('priority');
      }
    }

    if (changed.length > 0) {
      try {
        await existing.save();
      } catch (err) {
        if (err?.code === 11000) {
          return res.status(409).json({ error: 'override_exists' });
        }
        throw err;
      }
    }

    // Look up the category name once for both the response and the
    // audit row. Skipped when nothing actually changed — no-op PUTs
    // don't write to the audit log (§13.4 discourages noise).
    const category = await Category.findById(existing.category_id)
      .select('_id name')
      .lean();
    const categoryMap = category
      ? new Map([[category._id.toString(), category.name]])
      : new Map();

    if (changed.length > 0) {
      // §13.2 #30 — "Regra pessoal actualizada: <pattern> → <category>"
      audit({
        action: 'override_updated',
        userId: req.userId,
        ip: clientIp(req),
        detail: `pattern=${existing.pattern} category=${category?.name ?? '—'} changed=${changed.join(',')}`,
        entity: existing.pattern,
      });
    }

    res.json({ data: serialize(existing.toObject(), categoryMap) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// DELETE /api/category-overrides/:id
//
// 204 on success, 404 for missing or cross-user IDs.
//
// Optional `cascade=true` (query or body) triggers a post-delete
// re-resolve pass over every expense owned by the caller: the rule is
// dropped first, then `resolveCategory` runs with the fresh context,
// and any expense whose verdict now differs gets written through
// `reassignCategoryBulk`. This closes the gap where deleting a rule
// that had previously been apply-to-all'd would leave those expenses
// "stuck" on the old category (the resolver never re-runs on delete,
// so the `category_id` column stays frozen until another write
// touches it). See docs/Categories.md §6 for the broader re-resolve
// contract — the cascade is semantically identical to apply-to-all,
// just triggered by a delete instead of an explicit click.
//
// Cascade failure posture: the rule is deleted BEFORE the cascade
// starts, so a mid-cascade throw leaves the rule gone with some
// expenses already re-catalogued. The partial state is idempotent —
// re-running apply-to-all on any remaining rule is a no-op for the
// rows that already landed. A dedicated `apply_to_all_failed` audit
// row captures the reason for forensics; the existing `override_deleted`
// row is written BEFORE the cascade so the delete is always traceable,
// whether the cascade succeeded or not.
// ─────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ error: 'override_not_found' });
    }

    // Load first so the audit row can capture the pattern + category
    // name before the document disappears.
    const existing = await CategoryOverride.findOne({
      _id: id,
      user_id: req.userId,
    }).lean();
    if (!existing) {
      return res.status(404).json({ error: 'override_not_found' });
    }

    await CategoryOverride.deleteOne({
      _id: id,
      user_id: req.userId,
    });

    const category = await Category.findById(existing.category_id)
      .select('name')
      .lean();

    // §13.2 #31 — "Regra pessoal apagada: <pattern>". Written BEFORE
    // the optional cascade so the delete itself is always captured
    // in the audit trail, regardless of whether the follow-up
    // re-resolve pass succeeds.
    audit({
      action: 'override_deleted',
      userId: req.userId,
      ip: clientIp(req),
      detail: `pattern=${existing.pattern} category=${category?.name ?? '—'}`,
      entity: existing.pattern,
    });

    // Cascade flag — accepts body or query (same shape as apply-to-all).
    const cascade =
      req.body?.cascade === true ||
      req.query?.cascade === 'true' ||
      req.query?.cascade === '1';

    if (!cascade) {
      return res.status(204).end();
    }

    // Post-delete re-resolve. Mirrors the apply-to-all code path but
    // with an empty-ish target: expenses fan out into whatever the
    // resolver now says, which may be several different global
    // catalogue categories or `null` (uncategorised). Personal rules
    // that still match keep winning — the resolver's own tie-break
    // preserves the "Personal is sacred" invariant for free.
    try {
      const ctx = await loadContext(req.userId);
      const candidates = await Expense.find({ user_id: req.userId })
        .select('_id entity category_id')
        .lean();

      const NULL_KEY = '__null__';
      const grouped = new Map();
      for (const e of candidates) {
        const newCatId = resolveCategory(e.entity, ctx);
        const cur = e.category_id ? e.category_id.toString() : null;
        const nxt = newCatId ? newCatId.toString() : null;
        if (cur === nxt) continue;
        const key = nxt ?? NULL_KEY;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(e._id);
      }

      let updated = 0;
      for (const [key, ids] of grouped) {
        const target = key === NULL_KEY ? null : key;
        const result = await reassignCategoryBulk(
          { _id: { $in: ids }, user_id: req.userId },
          target,
        );
        updated += result.modified ?? 0;
      }

      // §13.2 #32 variant: `target=delete_cascade` flags this as a
      // cascade pass triggered by the delete above, not an
      // explicit user-clicked apply. `category=` is omitted because
      // there is no single target — expenses fan out. The
      // curveLogsUtils parser special-cases this target.
      audit({
        action: 'apply_to_all',
        userId: req.userId,
        ip: clientIp(req),
        detail:
          `scope=personal target=delete_cascade affected=${updated} ` +
          `skipped_personal=0`,
        entity: existing.pattern,
      });

      return res.status(204).end();
    } catch (err) {
      audit({
        action: 'apply_to_all_failed',
        userId: req.userId,
        ip: clientIp(req),
        detail: `reason=${err.message} target=delete_cascade pattern=${existing.pattern}`,
        entity: existing.pattern,
      });
      return res.status(500).json({ error: err.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/category-overrides/:id/apply-to-all
//
// Retroactive recategorisation for a personal override. Re-runs the
// full resolver (§5) over every expense owned by the caller and
// rewrites `category_id` wherever the new verdict differs from the
// stored value. Scope is ALWAYS the caller's own expenses — a user
// never touches another user's rows, even on the admin path (§6.10).
//
// Invariants preserved by construction (§6.5, §6.8):
//   - "Personal is sacred" emerges for free: a more-specific override
//     that already wins inside resolveCategory keeps winning, so the
//     bulk pass will skip those rows on its own — no special case.
//   - Idempotent: two consecutive runs produce the same state because
//     the second run finds current === next on every candidate.
//   - Uses `reassignCategoryBulk` (§4.4) as the ONLY write surface
//     into `expenses.category_id`. No `updateMany` calls here.
//
// Body / query:
//   { dry_run: true }  or  ?dry_run=true
//     → returns `{ matched, updated: 0, samples: [...up to 10] }`
//       with before/after category names, no writes, no audit row.
//   (default) → writes + audit row.
//
// Response shape (§6.4 + §8.5):
//   200 { data: { dry_run, matched, updated, samples? } }
//   404 override_not_found  (missing or cross-user, §7.5)
//   500 on partial failure — any already-applied group stays applied;
//       an `apply_to_all_failed` audit row captures the reason.
//
// Candidate set: `Expense.find({ user_id })` with NO coarse regex
// pre-filter. §6.6 allows a pre-filter to narrow the scan, but
// designing one that's provably permissive against the normalise()
// pipeline (accent-fold + punctuation-to-space + lowercase) is tricky
// — a naive `pattern` regex produces false NEGATIVES on entities like
// "LIDL — CASCAIS" vs pattern "lidl cascais". At MVP scale (<10k
// expenses/user, §6.7 <100 ms budget) a user-scoped full scan is both
// simpler and provably correct. Revisit the pre-filter when a real
// user hits the perf wall.
//
// Rate limiting (§8.5 → `429 apply_to_all_rate_limited`) is NOT
// implemented in the MVP — there is no rate-limit scaffolding in the
// codebase yet, and apply-to-all is a human-initiated single click.
// Add when scaffolding lands.
// ─────────────────────────────────────────────────────────────────────
router.post('/:id/apply-to-all', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ error: 'override_not_found' });
    }

    // Cross-user access returns 404 per §7.5 — same posture as the
    // other handlers in this file.
    const override = await CategoryOverride.findOne({
      _id: id,
      user_id: req.userId,
    }).lean();
    if (!override) {
      return res.status(404).json({ error: 'override_not_found' });
    }

    // `dry_run` accepts body or query form. Body is the documented
    // shape (§8.5); query form is a convenience for GET-like curl
    // probing and matches §6.4 where the preview is described as a
    // dry-run of the same endpoint.
    const dryRun =
      req.body?.dry_run === true ||
      req.query?.dry_run === 'true' ||
      req.query?.dry_run === '1';

    // One `loadContext` call. This is the critical re-validation
    // input: every candidate runs through `resolveCategory(entity,
    // ctx)` with the user's FULL override set, which is why personal
    // more-specific rules survive a broader apply-to-all — the
    // resolver's own tie-break keeps them winning (§6.5 "A
    // re-validação é crítica").
    const ctx = await loadContext(req.userId);

    // Full user-scoped scan — see the header comment for the
    // no-coarse-filter decision. `select` keeps the payload small;
    // no need to load `card`, `digest`, `amount`, etc. for a re-match.
    const candidates = await Expense.find({ user_id: req.userId })
      .select('_id entity category_id date')
      .lean();

    // Re-validate + group. `diffs` captures every expense whose
    // current category differs from the resolver's current verdict;
    // `grouped` buckets them by TARGET category so each
    // `reassignCategoryBulk` call is one round trip with `$in: [...]`.
    //
    // `null` is a valid target (uncategorise) — we key it as the
    // literal string `'__null__'` in the map to keep the key type
    // stable, and translate back before the write.
    const NULL_KEY = '__null__';
    const grouped = new Map();
    const diffs = [];
    for (const e of candidates) {
      const newCatId = resolveCategory(e.entity, ctx);
      const cur = e.category_id ? e.category_id.toString() : null;
      const nxt = newCatId ? newCatId.toString() : null;
      if (cur === nxt) continue;
      diffs.push({ expense: e, from: cur, to: nxt });
      const key = nxt ?? NULL_KEY;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(e._id);
    }

    const matched = diffs.length;

    if (dryRun) {
      // Samples preview. Pull every category name referenced in the
      // first 10 diffs in one batch query so the render is friendly
      // to UI consumers (current_category and new_category as
      // strings, not ObjectIds). 10 is the §6.4 preview cap — more
      // would bloat the response for no user value.
      const preview = diffs.slice(0, 10);
      const catIdsToLookup = new Set();
      for (const d of preview) {
        if (d.from) catIdsToLookup.add(d.from);
        if (d.to) catIdsToLookup.add(d.to);
      }
      const catMap = await loadCategoryMap([...catIdsToLookup]);
      const samples = preview.map(({ expense, from, to }) => ({
        _id: expense._id.toString(),
        entity: expense.entity,
        date: expense.date,
        current_category: from ? catMap.get(from) ?? null : null,
        new_category: to ? catMap.get(to) ?? null : null,
      }));
      return res.json({
        data: { dry_run: true, matched, updated: 0, samples },
      });
    }

    // Real run. One `reassignCategoryBulk` per target category —
    // typically 1-2 round trips because most apply-to-all runs funnel
    // everything into the same `override.category_id`, but the
    // fan-out path handles the case where re-validation moves some
    // expenses to yet another category (e.g. a more-specific rule
    // that now wins after an unrelated edit).
    //
    // The filter always re-includes `user_id: req.userId` as a
    // safety belt, even though the candidate set already guarantees
    // ownership — defence in depth matches the pattern in
    // routes/expenses.js single-expense path.
    let updated = 0;
    try {
      for (const [key, ids] of grouped) {
        const target = key === NULL_KEY ? null : key;
        const result = await reassignCategoryBulk(
          { _id: { $in: ids }, user_id: req.userId },
          target,
        );
        updated += result.modified ?? 0;
      }
    } catch (err) {
      // Partial failure: one group may have landed before the
      // throwing one. The already-applied rows stay applied — this
      // is fine because the next retry is idempotent (resolver
      // returns the same verdict, `cur === nxt` skips the row).
      // Emit the failure row with enough context to correlate
      // against the pattern + the caller.
      const category = await Category.findById(override.category_id)
        .select('name')
        .lean();
      audit({
        action: 'apply_to_all_failed',
        userId: req.userId,
        ip: clientIp(req),
        detail: `reason=${err.message} pattern=${override.pattern} category=${category?.name ?? '—'}`,
        entity: override.pattern,
      });
      return res.status(500).json({ error: err.message });
    }

    // Success audit. `skipped_personal=0` is always zero on the
    // personal path — the caller is the only user whose expenses we
    // touch. The field stays in the detail anyway so the shape
    // mirrors §13.2 #32 and the `/curve/logs` renderer can share one
    // parser with the admin variant that lands in Fase 3.
    const category = await Category.findById(override.category_id)
      .select('name')
      .lean();
    audit({
      action: 'apply_to_all',
      userId: req.userId,
      ip: clientIp(req),
      detail:
        `scope=personal target=override affected=${updated} ` +
        `skipped_personal=0 category=${category?.name ?? '—'}`,
      entity: override.pattern,
    });

    res.json({ data: { dry_run: false, matched, updated } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
