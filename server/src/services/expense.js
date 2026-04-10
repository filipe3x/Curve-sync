import { createHash } from 'crypto';
import Category from '../models/Category.js';

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
