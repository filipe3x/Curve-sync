import { Router } from 'express';
import mongoose from 'mongoose';
import CategoryOverride from '../models/CategoryOverride.js';
import Category from '../models/Category.js';
import { normalize } from '../services/categoryResolver.js';
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

    // §13.2 #31 — "Regra pessoal apagada: <pattern>"
    audit({
      action: 'override_deleted',
      userId: req.userId,
      ip: clientIp(req),
      detail: `pattern=${existing.pattern} category=${category?.name ?? '—'}`,
      entity: existing.pattern,
    });

    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
