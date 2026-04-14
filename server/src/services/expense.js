import { createHash } from 'crypto';
import Expense from '../models/Expense.js';

/**
 * SHA-256 digest matching the original curve.py logic:
 * hash of concatenated entity + amount + date + card
 */
export function computeDigest({ entity, amount, date, card }) {
  const raw = `${entity}${amount}${date}${card}`;
  return createHash('sha256').update(raw).digest('hex');
}

// Auto-categorisation moved to `services/categoryResolver.js` — the
// two-tier pipeline (personal overrides → global catalogue, §5 of
// docs/Categories.md) replaces the old single-tier `assignCategory`
// / `assignCategoryFromList` helpers that used to live here. Both
// call sites (POST /api/expenses and the sync orchestrator) now import
// `loadContext` + `resolveCategory` directly from the resolver.

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
