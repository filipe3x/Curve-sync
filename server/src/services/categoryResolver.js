import Category from '../models/Category.js';
import CategoryOverride from '../models/CategoryOverride.js';

/**
 * categoryResolver — the single matching pipeline.
 *
 * Source of truth: docs/Categories.md §5.
 *
 * One function, three consumers:
 *   1. POST /api/expenses  (per-request loadContext)
 *   2. Sync orchestrator   (loadContext once per run, reused for N emails)
 *   3. Apply-to-all (§6)   (loadContext once per execution)
 *
 * Pipeline:
 *
 *   raw entity  →  normalize  →  resolveCategory(norm, ctx)  →  category_id | null
 *
 * Every match is a pure function of `(norm, ctx)` — no DB reads
 * during `resolveCategory`. That is what makes it cheap enough to run
 * over thousands of expenses per sync (~3 μs per expense, §5.6). The
 * DB cost lives entirely inside `loadContext`, which is called once
 * per caller and then reused.
 */

// ─────────────────────────────────────────────────────────────────────
// §5.2 — Normalization
//
// Six deterministic, idempotent steps. `normalize(normalize(x)) === normalize(x)`
// is a property, not an accident — the resolver relies on it to avoid
// having to re-normalise on the read side.
// ─────────────────────────────────────────────────────────────────────

/**
 * Normalise an entity or pattern string for matching.
 *
 * @param {string|null|undefined} raw
 * @returns {string} normalised form (empty string if raw was falsy
 *                   or contained only non-alphanumerics)
 */
export function normalize(raw) {
  if (!raw) return '';
  return String(raw)
    // 1. Decompose accents (café → cafe + combining acute)
    .normalize('NFD')
    // 2. Drop combining marks (the acute goes, the 'e' stays)
    .replace(/\p{M}/gu, '')
    // 3. Lowercase — done after the decompose so the base chars are ASCII
    .toLowerCase()
    // 4. Non-alphanumerics → space. `\p{L}` + `\p{N}` covers unicode letters
    //    and digits; everything else (punctuation, symbols, emoji) maps to
    //    whitespace.
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    // 5. Collapse consecutive whitespace
    .replace(/\s+/g, ' ')
    // 6. Trim
    .trim();
}

// ─────────────────────────────────────────────────────────────────────
// §5.3 — Match types
//
// All three operate on already-normalised strings. `starts_with`
// checks for a full-token boundary (trailing space) so "lidl" does
// not match "lidlmart".
// ─────────────────────────────────────────────────────────────────────

export function matches(norm, rule) {
  const p = rule.pattern_normalized;
  if (!p) return false;
  switch (rule.match_type) {
    case 'exact':
      return norm === p;
    case 'starts_with':
      // Equality is a starts_with at zero-length remainder, and the
      // trailing-space branch enforces a word boundary for everything
      // else. Together they accept "lidl" and "lidl cascais" but
      // reject "lidlmart".
      return norm === p || norm.startsWith(p + ' ');
    case 'contains':
    default:
      return norm.includes(p);
  }
}

// ─────────────────────────────────────────────────────────────────────
// §5.4 — Tie-breaking
//
// Strict order: priority → pattern length → match specificity →
// created_at. Deterministic for identical inputs across runs.
// ─────────────────────────────────────────────────────────────────────

const MATCH_TYPE_SPECIFICITY = {
  exact: 3,
  starts_with: 2,
  contains: 1,
};

function pickBetter(a, b) {
  if (!a) return b;
  if (!b) return a;

  // 1. priority (higher wins) — manual escape hatch
  if (a.priority !== b.priority) return a.priority > b.priority ? a : b;

  // 2. pattern length (longer wins) — longest-match-wins covers
  //    almost everything that priority doesn't.
  const lenA = a.pattern_normalized?.length ?? 0;
  const lenB = b.pattern_normalized?.length ?? 0;
  if (lenA !== lenB) return lenA > lenB ? a : b;

  // 3. match type specificity (exact > starts_with > contains)
  const specA = MATCH_TYPE_SPECIFICITY[a.match_type] ?? 0;
  const specB = MATCH_TYPE_SPECIFICITY[b.match_type] ?? 0;
  if (specA !== specB) return specA > specB ? a : b;

  // 4. created_at ascending — the older rule wins when absolutely
  //    everything else is equal. Determinism over recency so two runs
  //    with the same inputs always emit the same output.
  const tA = a.created_at ? new Date(a.created_at).getTime() : Infinity;
  const tB = b.created_at ? new Date(b.created_at).getTime() : Infinity;
  return tA <= tB ? a : b;
}

// ─────────────────────────────────────────────────────────────────────
// §5.5 — Context loader
//
// Two queries. Global rules come from `Category.entities[]` and need
// to be pre-normalised once (Embers doesn't store the normalised
// form). Overrides come with `pattern_normalized` already on the
// document so we do not re-normalise on the read side.
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the resolver context for a given user.
 *
 * @param {import('mongoose').Types.ObjectId|string|null} userId
 *        User to scope the overrides by. `null` / `undefined` is
 *        allowed — `userRules` comes back empty and only the global
 *        catalogue is consulted. The sync orchestrator always passes
 *        the config owner; route handlers always pass `req.userId`.
 * @returns {Promise<{userRules: Rule[], globalRules: Rule[]}>}
 *
 * A Rule is `{ category_id, pattern_normalized, match_type, priority,
 * created_at }`. Global rules always have `priority: 0` and
 * `match_type: 'contains'` — the `Category.entities[]` schema has no
 * way to express anything else.
 */
export async function loadContext(userId) {
  // Run the two reads in parallel — they are independent and the
  // round-trip savings matter in the per-request path.
  const [categories, overrides] = await Promise.all([
    Category.find().lean(),
    userId
      ? CategoryOverride.find({ user_id: userId }).lean()
      : Promise.resolve([]),
  ]);

  // Global tier: flatten each Category.entities[] into one Rule per
  // entity string. Pre-normalise once so per-despesa matching stays
  // free of string work beyond the substring compare.
  const globalRules = [];
  for (const cat of categories) {
    if (!Array.isArray(cat.entities)) continue;
    for (const entity of cat.entities) {
      const norm = normalize(entity);
      if (!norm) continue;
      globalRules.push({
        category_id: cat._id,
        pattern_normalized: norm,
        match_type: 'contains',
        priority: 0,
        created_at: cat.created_at ?? null,
      });
    }
  }

  // User tier: trust `pattern_normalized` on the document. Invariant
  // enforced at write time in `routes/categoryOverrides.js`.
  const userRules = overrides.map((o) => ({
    _id: o._id,
    category_id: o.category_id,
    pattern_normalized: o.pattern_normalized,
    match_type: o.match_type,
    priority: o.priority ?? 0,
    created_at: o.created_at ?? null,
  }));

  return { userRules, globalRules };
}

// ─────────────────────────────────────────────────────────────────────
// §5.4 — Top-level resolver
//
// The one public entry point. Personal rules short-circuit the
// global tier — "override pessoal substitui o global, não se
// acumula" (§3.4, §3.6). Within a tier, every match is collected
// and `pickBetter` picks the winner, so priority+longest-match works
// across rule pairs and not just first-seen.
// ─────────────────────────────────────────────────────────────────────

/**
 * Resolve an entity string to a category_id (or null).
 *
 * @param {string|null|undefined} raw  entity from the expense
 * @param {{userRules: Rule[], globalRules: Rule[]}} ctx
 *        from `loadContext()`
 * @returns {import('mongoose').Types.ObjectId|null}
 */
export function resolveCategory(raw, ctx) {
  if (!raw) return null;
  const norm = normalize(raw);
  if (!norm) return null;

  // Personal tier first. If any user rule matches we short-circuit
  // after `pickBetter` has run across the whole user tier — global
  // rules never get a chance.
  let best = null;
  for (const r of ctx.userRules) {
    if (matches(norm, r)) best = pickBetter(best, r);
  }
  if (best) return best.category_id;

  // Global tier only if no user rule won.
  for (const r of ctx.globalRules) {
    if (matches(norm, r)) best = pickBetter(best, r);
  }
  return best?.category_id ?? null;
}
