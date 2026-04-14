import { createHash } from 'crypto';
import Category from '../models/Category.js';
import Expense from '../models/Expense.js';

/**
 * SHA-256 digest matching the original curve.py logic:
 * hash of concatenated entity + amount + date + card
 */
export function computeDigest({ entity, amount, date, card }) {
  const raw = `${entity}${amount}${date}${card}`;
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Auto-assign category by matching entity name against
 * each category's `entities` array (case-insensitive).
 * Returns category _id or null.
 *
 * Does a fresh `Category.find()` on every call. Fine for the one-off
 * `POST /api/expenses` route; wrong for batch processing in the sync
 * orchestrator, where it would run N queries per sync run. For that
 * case use `assignCategoryFromList()` below with a cache.
 */
export async function assignCategory(entity) {
  if (!entity) return null;
  const categories = await Category.find().lean();
  return assignCategoryFromList(entity, categories);
}

/**
 * Pure variant of `assignCategory` that takes an already-loaded
 * categories array. The sync orchestrator loads categories once at
 * the start of a run and passes them to this function for every
 * email, reducing `Category.find()` to a single call per sync
 * regardless of how many emails the sync processes.
 *
 * @param {string} entity - expense entity (merchant name)
 * @param {Array<object>} categories - pre-loaded Category docs (lean)
 * @returns {string|null} category _id or null
 */
export function assignCategoryFromList(entity, categories) {
  if (!entity) return null;
  const lower = entity.toLowerCase();
  for (const cat of categories) {
    if (cat.entities?.some((e) => lower.includes(e.toLowerCase()))) {
      return cat._id;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// !!! THE ONLY AUTHORISED WRITE PATH INTO Expense.category_id !!!
//
// CLAUDE.md is explicit: `expenses` is READ + INSERT + UPDATE of
// `category_id` only — every other field (entity, amount, date, card,
// digest, user_id, timestamps) stays INSERT-only, DELETE stays
// forbidden. Rewriting any other field would break the dedup digest or
// the isolation-by-user contract we keep with Embers.
//
// The Mongoose schema has no native way of rejecting granular updates,
// so the discipline is enforced here, in one place, via code review.
// See `docs/Categories.md §4.4` for the full rationale and §12.7 for
// the single-expense quick-edit caller.
//
// NEVER CALL `Expense.update*` DIRECTLY FROM ANOTHER FILE WITH A
// PAYLOAD THAT IS NOT `{ $set: { category_id } }`. If you find
// yourself wanting to, push the new field through here and widen the
// CLAUDE.md contract first — don't smuggle it past this guard.
//
// Two call sites are expected:
//
//   1. Single-expense quick-edit popover (§12.7) — filter shape
//      `{ _id, user_id }`, one document affected.
//   2. Apply-to-all retroactive recat (§6) — filter shape
//      `{ entity_normalized, user_id }` or similar, potentially
//      thousands of documents affected.
//
// The helper is filter-agnostic precisely so both paths share one
// audited write surface. `category_id` may be `null` to clear the
// association.
//
// @param {object} filter           Mongo filter — MUST be scoped to a
//                                  single user_id. Cross-user writes
//                                  are a bug; the caller is
//                                  responsible for enforcing the
//                                  scoping.
// @param {string|null} category_id ObjectId of the new category, or
//                                  null to clear the association.
// @returns {Promise<{ matched: number, modified: number }>}
// ─────────────────────────────────────────────────────────────────────
export async function reassignCategoryBulk(filter, category_id) {
  const result = await Expense.updateMany(filter, { $set: { category_id } });
  return {
    matched: result.matchedCount ?? result.n ?? 0,
    modified: result.modifiedCount ?? result.nModified ?? 0,
  };
}
