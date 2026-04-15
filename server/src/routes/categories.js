import { Router } from 'express';
import mongoose from 'mongoose';
import Category from '../models/Category.js';
import CategoryOverride from '../models/CategoryOverride.js';
import Expense from '../models/Expense.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import {
  loadContext,
  matches,
  normalize,
  resolveCategory,
} from '../services/categoryResolver.js';
import { reassignCategoryBulk } from '../services/expense.js';
import { audit, clientIp } from '../services/audit.js';

const router = Router();

// ─────────────────────────────────────────────────────────────────────
// GET /api/categories (read-only)
//
// Returns the catalogue sorted by name. The default shape is the
// full Category document — consumers like /expenses, the dashboard
// and CategoryPickerPopover only need the id + name + icon and
// ignore everything else.
//
// Opt-in `?with_match_counts=true` adds a per-category
// `entity_match_counts: { [entity_raw]: N }` map, keyed on the raw
// entries of `entities[]`, counting how many of the caller's own
// expenses each global entity catches right now. Semantics mirror
// the personal-override counter (§8.4, docs/Categories.md): "how
// wide is this entity's net" — not "how many would move on an
// apply-to-all". User-scoped by construction (`user_id: req.userId`)
// so the number on the /categories screen reflects *my* expenses,
// never the platform total.
//
// The heavy consumers (ExpensesPage, DashboardPage, CategoryPicker)
// never set the flag, so they stay on the cheap two-field path.
// ─────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const data = await Category.find().sort('name').lean();

    const withCounts =
      req.query.with_match_counts === 'true' ||
      req.query.with_match_counts === '1';
    if (withCounts) {
      const countsByCategory = await countGlobalEntityMatches(req.userId, data);
      for (const cat of data) {
        cat.entity_match_counts =
          countsByCategory.get(cat._id.toString()) ?? {};
      }
    }

    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Per-global-entity match count, user-scoped.
//
// Mirrors `countMatchesPerRule` in routes/categoryOverrides.js — one
// `{ entity → count }` aggregation for the caller, followed by an
// in-memory O(total_global_entities × distinct_user_entities) pass
// that reuses `categoryResolver.matches()`. At MVP scale
// (~50 categories × ~10 entities × <50 distinct user entities) this
// is a few tens of thousands of comparisons and stays comfortably
// under the §6.7 budget.
//
// Global entities are always `match_type: 'contains'` with
// `priority: 0` (§5.5 loadContext) — same rule shape the resolver
// uses on the hot path, so the count is computed with the exact
// same `matches()` verdict the sync orchestrator would apply.
// ─────────────────────────────────────────────────────────────────────
async function countGlobalEntityMatches(userId, categories) {
  const result = new Map();
  if (!userId || !categories.length) return result;

  const entityAgg = await Expense.aggregate([
    { $match: { user_id: userId } },
    { $group: { _id: '$entity', count: { $sum: 1 } } },
  ]);
  const normalisedUserEntities = entityAgg
    .map(({ _id, count }) => ({ norm: normalize(_id), count }))
    .filter((e) => e.norm);

  // Early out: no expenses yet → every category gets an empty map.
  if (!normalisedUserEntities.length) {
    for (const cat of categories) result.set(cat._id.toString(), {});
    return result;
  }

  for (const cat of categories) {
    const counts = {};
    if (Array.isArray(cat.entities)) {
      for (const entity of cat.entities) {
        const norm = normalize(entity);
        if (!norm) {
          counts[entity] = 0;
          continue;
        }
        const rule = { pattern_normalized: norm, match_type: 'contains' };
        let total = 0;
        for (const { norm: userNorm, count } of normalisedUserEntities) {
          if (matches(userNorm, rule)) total += count;
        }
        counts[entity] = total;
      }
    }
    result.set(cat._id.toString(), counts);
  }
  return result;
}

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

// ─────────────────────────────────────────────────────────────────────
// DELETE /api/categories/:id/entities/:entity   (admin only)
//
// Removes a single entity string from the `entities` array of a global
// catalogue category. This is the minimal admin-surgery slice of the
// `/categories` screen (PR #6 of the roadmap in docs/Categories.md
// §11.3 Fase 5) — the full admin CRUD (create/rename/delete category,
// batch-add entities) lands separately.
//
// Auth: requires `authenticate` (router-level, mounted in index.js)
// AND `requireAdmin` (per-route below). Non-admins receive 403 plus
// an `admin_access_failed` audit row; the middleware handles both.
//
// Route params:
//   :id     — category _id (validated as ObjectId, 404 otherwise)
//   :entity — URL-encoded entity string, matched verbatim (case-sensitive)
//
// Responses:
//   204 on success
//   404 category_not_found  — invalid id or no such category
//   404 entity_not_found    — category exists but the entity is not in
//                             its `entities` array (nothing to remove)
//
// Write shape: `$pull` is a single atomic mongo operation, so we don't
// need to round-trip load→mutate→save. `modifiedCount === 1` is the
// authoritative "did we remove something?" signal. The category
// document is looked up beforehand so the audit row can carry the
// category name without a second query.
//
// Audit (docs/Categories.md §13.2 #27):
//   action: 'category_entity_removed'
//   detail: `category=<name> entity=<value>`
//   Canonical pt-PT (via curveLogsUtils): "Entidade removida de <name>: <value>"
// ─────────────────────────────────────────────────────────────────────
router.delete('/:id/entities/:entity', requireAdmin, async (req, res) => {
  try {
    const { id, entity } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ error: 'category_not_found' });
    }

    // Load first so the audit row can capture the category name, and
    // so a missing category returns a clean 404 before we attempt the
    // $pull (which would otherwise silently succeed with matched=0).
    const category = await Category.findById(id).select('name entities').lean();
    if (!category) {
      return res.status(404).json({ error: 'category_not_found' });
    }

    // URL-decoded by Express, so `entity` is the raw string as it
    // appears in the array. Match is case-sensitive — admins edit with
    // full awareness of the exact value they typed in.
    if (!category.entities?.includes(entity)) {
      return res.status(404).json({ error: 'entity_not_found' });
    }

    const result = await Category.updateOne(
      { _id: id },
      { $pull: { entities: entity } },
    );

    // Belt-and-braces: if the in-memory check passed but the atomic
    // $pull removed nothing (racing admin, case drift, ...), treat it
    // as not-found so the client re-renders with fresh state.
    if (result.modifiedCount !== 1) {
      return res.status(404).json({ error: 'entity_not_found' });
    }

    audit({
      action: 'category_entity_removed',
      userId: req.userId,
      ip: clientIp(req),
      detail: `category=${category.name} entity=${entity}`,
      entity,
    });

    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Case-insensitive name collision check for POST / and PUT /:id.
//
// The unique index on `categories.name` is case-sensitive (standard
// Mongo behaviour, and we can't switch it to a collation-aware form
// without rewriting the shared `categories` schema Embers expects to
// read). §8.2 of docs/Categories.md requires case-insensitive
// uniqueness, so we pre-check with a regex before writing and still
// catch the race-condition 11000 error at write time as a safety belt.
//
// `excludeId` is used by PUT to allow a no-op rename ("Groceries" →
// "groceries") that would otherwise collide with its own row.
// ─────────────────────────────────────────────────────────────────────
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function nameCollides(name, excludeId) {
  const filter = {
    name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' },
  };
  if (excludeId) filter._id = { $ne: excludeId };
  const hit = await Category.findOne(filter).select('_id').lean();
  return !!hit;
}

// ─────────────────────────────────────────────────────────────────────
// Normalise + dedupe a caller-supplied `entities` payload.
//
// Used by POST / and POST /:id/entities to collapse cosmetic variants
// ("Lidl", "LIDL", " lidl ") onto a single entry before we touch the
// DB. Dedup key is `normalize()` (§5.2) so the collision surface
// matches the matcher's — two forms that the resolver treats as
// identical never both land in `entities[]`.
//
// Input:  raw array (may contain non-strings, blanks, unicode noise)
// Output: { raw: <trimmed>, norm: <normalized> }[] — only well-formed
//         entries survive, order preserved for deterministic audits.
// ─────────────────────────────────────────────────────────────────────
function normaliseEntityInput(entities) {
  const seen = new Set();
  const out = [];
  for (const e of entities) {
    if (typeof e !== 'string') continue;
    const trimmed = e.trim();
    if (!trimmed) continue;
    const norm = normalize(trimmed);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push({ raw: trimmed, norm });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// POST /api/categories   (admin only)
//
// Creates a new global catalogue category. This is the first of the
// admin CRUD endpoints specified in docs/Categories.md §8.2, and the
// gating item that unblocks Fase 5 (admin mode in /categories screen,
// §11.3). The schema stays identical to Embers' Mongoid `Category`
// (name + entities[] + timestamps) — no new fields are introduced,
// per CLAUDE.md's "never modify the schema of categories" rule.
//
// Auth: `authenticate` (router-level, mounted in index.js) +
// `requireAdmin` (per-route). Non-admins get 403 + an
// `admin_access_failed` audit row handled by the middleware.
//
// Body:
//   { name: string, entities?: string[] }
//
// Validation:
//   400 name_required        — name missing or empty after trim
//   400 invalid_entities     — entities is present but not an array
//   409 name_taken           — case-insensitive collision with an
//                              existing category (pre-check by regex,
//                              plus 11000 catch for race safety)
//
// Entities are normalised and deduped server-side: blanks, non-string
// entries, and repeated normalised forms are dropped silently before
// the insert. The raw trimmed form is persisted — consistent with how
// DELETE /:id/entities/:entity matches on the raw string (§8.3).
//
// Response: 201 { data: Category }
//
// Audit (§13.2 #23):
//   action: 'category_created'
//   detail: `name=<name> entity_count=<n>`
//   Canonical pt-PT (curveLogsUtils): "Categoria criada: <name>"
// ─────────────────────────────────────────────────────────────────────
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { name, entities } = req.body ?? {};

    if (typeof name !== 'string' || name.trim() === '') {
      return res.status(400).json({ error: 'name_required' });
    }
    const trimmedName = name.trim();

    let entityArr = [];
    if (entities !== undefined) {
      if (!Array.isArray(entities)) {
        return res.status(400).json({ error: 'invalid_entities' });
      }
      entityArr = normaliseEntityInput(entities).map((e) => e.raw);
    }

    // Pre-check for case-insensitive collision. The unique index on
    // `name` is case-sensitive, so "Groceries" and "groceries" would
    // both succeed without this guard.
    if (await nameCollides(trimmedName)) {
      return res.status(409).json({ error: 'name_taken' });
    }

    let doc;
    try {
      doc = await Category.create({
        name: trimmedName,
        entities: entityArr,
      });
    } catch (err) {
      // Race condition: another admin created a colliding name between
      // our pre-check and the insert. Translate the Mongo duplicate
      // key error into the documented 409 response.
      if (err?.code === 11000) {
        return res.status(409).json({ error: 'name_taken' });
      }
      throw err;
    }

    audit({
      action: 'category_created',
      userId: req.userId,
      ip: clientIp(req),
      detail: `name=${doc.name} entity_count=${doc.entities.length}`,
    });

    res.status(201).json({ data: doc.toObject() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// PUT /api/categories/:id   (admin only)
//
// Partial update of a global catalogue category. Only `name` is
// actually persisted in this slice — the `entities[]` array is NOT
// editable here (use the granular §8.3 endpoints), and `icon_url`
// is accepted-but-dropped until the schema question is resolved
// (see the comment inside the handler). Together with POST and
// DELETE, this is the second of the five admin CRUD endpoints from
// docs/Categories.md §8.2.
//
// Auth: `authenticate` + `requireAdmin`.
//
// Route params:
//   :id  — category _id (validated as ObjectId, 404 otherwise)
//
// Body:
//   { name?: string, icon_url?: string }
//
// Validation:
//   404 category_not_found   — invalid id or no such row
//   400 name_required        — name is present but empty after trim
//   409 name_taken           — case-insensitive collision against ANY
//                              OTHER category (pre-check via
//                              nameCollides() + 11000 catch as a
//                              safety belt for concurrent renames)
//
// No-op PUTs (identical name, or a request that carries only a
// dropped icon_url) return 200 with the current document and skip
// the audit row entirely — §13.4 discourages audit noise from
// autosave-style writes that don't actually change state.
//
// Response: 200 { data: Category }
//
// Audit (§13.2 #24):
//   action: 'category_updated'
//   detail: `name=<name> changed=<fields>`
//   Canonical pt-PT (curveLogsUtils): "Categoria actualizada: <name>"
// ─────────────────────────────────────────────────────────────────────
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ error: 'category_not_found' });
    }

    const existing = await Category.findById(id);
    if (!existing) {
      return res.status(404).json({ error: 'category_not_found' });
    }

    const { name, icon_url } = req.body ?? {};
    const changed = [];

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim() === '') {
        return res.status(400).json({ error: 'name_required' });
      }
      const trimmedName = name.trim();
      if (trimmedName !== existing.name) {
        // Collision check against every OTHER row. Case-insensitive
        // to match POST / behaviour, with `excludeId` so a cosmetic
        // case-only rename ("Groceries" → "groceries") doesn't
        // self-collide with the row being edited.
        if (await nameCollides(trimmedName, id)) {
          return res.status(409).json({ error: 'name_taken' });
        }
        existing.name = trimmedName;
        changed.push('name');
      }
    }

    // `icon_url` is part of the documented contract (§8.2) but the
    // Mongoose `Category` model has no `icon` field — Embers stores
    // the icon as a Paperclip attachment (icon_file_name +
    // icon_content_type + icon_file_size + icon_updated_at), and
    // CLAUDE.md forbids adding fields to the shared `categories`
    // schema. Until the schema question is resolved (follow-up PR),
    // the parameter is accepted to keep the contract stable but
    // never persisted, so writes never diverge from Embers' read
    // expectations. The frontend can POST icon_url into the wind
    // without getting a 400 or a silent "unknown field" error —
    // it just won't stick yet.
    if (icon_url !== undefined) {
      void icon_url;
    }

    if (changed.length === 0) {
      // No-op PUT: nothing to persist and nothing to audit (§13.4).
      // Return the current document so clients that PUT {name:same}
      // as part of an autosave flow still see a coherent response.
      return res.json({ data: existing.toObject() });
    }

    try {
      await existing.save();
    } catch (err) {
      // Race condition: another admin renamed a sibling into our
      // target between nameCollides() and save(). The unique index
      // on `name` is case-sensitive, so 11000 only fires on an
      // exact-case collision — the case-insensitive variant is
      // already caught above. Translate either to the documented
      // 409 so the client path is uniform.
      if (err?.code === 11000) {
        return res.status(409).json({ error: 'name_taken' });
      }
      throw err;
    }

    audit({
      action: 'category_updated',
      userId: req.userId,
      ip: clientIp(req),
      detail: `name=${existing.name} changed=${changed.join(',')}`,
    });

    res.json({ data: existing.toObject() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// DELETE /api/categories/:id   (admin only)
//
// Deletes a global catalogue category, with a hard guard against
// dangling references: the delete is refused with `409 category_in_use`
// when there are any `expenses` or `curve_category_overrides` still
// pointing at the category. The 409 body carries both counts so the
// frontend modal can tell the admin exactly what needs to be
// reassigned before the delete goes through (§11.4 risk #3).
//
// This is the only admin CRUD endpoint that gets a pre-delete scan —
// POST and PUT work on the row in isolation, but DELETE has to
// protect the invariant that every `expense.category_id` and every
// `override.category_id` points at a row that exists. Embers never
// writes either field, but it does read them, so a dangling id would
// silently produce a `null` category on the shared app.
//
// Auth: `authenticate` + `requireAdmin`.
//
// Route params:
//   :id  — category _id (validated as ObjectId, 404 otherwise)
//
// Responses:
//   204 on success (no body)
//   404 category_not_found
//   409 category_in_use  — body: `{ error, expenses_count, overrides_count }`
//
// Audit (§13.2 #25):
//   action: 'category_deleted'
//   detail: `name=<name> expense_count=0`
//   Canonical pt-PT (curveLogsUtils): "Categoria apagada: <name>"
//
// `expense_count` is always `0` at audit time because the 409 guard
// above blocks any delete where expenses still reference the row.
// The field is retained in the detail for shape-parity with §13.2
// and forensic clarity ("yes, we confirmed zero references before
// the drop"). Future variants that allow force-delete with cascade
// would carry a non-zero count here.
// ─────────────────────────────────────────────────────────────────────
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(404).json({ error: 'category_not_found' });
    }

    // Load first so the audit row can capture the category name, and
    // so a missing category returns a clean 404 before we run the
    // in-use scan (which would otherwise succeed vacuously with zero
    // references for a non-existent id).
    const category = await Category.findById(id).select('_id name').lean();
    if (!category) {
      return res.status(404).json({ error: 'category_not_found' });
    }

    // Parallel count of references. Both collections index
    // `category_id` (expenses via its own field, overrides via the
    // user_id compound index fallback), so at MVP scale this is two
    // cheap round trips.
    const [expensesCount, overridesCount] = await Promise.all([
      Expense.countDocuments({ category_id: id }),
      CategoryOverride.countDocuments({ category_id: id }),
    ]);

    if (expensesCount > 0 || overridesCount > 0) {
      return res.status(409).json({
        error: 'category_in_use',
        expenses_count: expensesCount,
        overrides_count: overridesCount,
      });
    }

    // Safe to drop: zero references in both collections. `deleteOne`
    // instead of `findByIdAndDelete` because we already have the doc
    // in memory — no need for a second round trip to reload it.
    await Category.deleteOne({ _id: id });

    audit({
      action: 'category_deleted',
      userId: req.userId,
      ip: clientIp(req),
      detail: `name=${category.name} expense_count=0`,
    });

    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
