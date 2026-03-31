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
 */
export async function assignCategory(entity) {
  if (!entity) return null;
  const lower = entity.toLowerCase();
  const categories = await Category.find().lean();
  for (const cat of categories) {
    if (cat.entities?.some((e) => lower.includes(e.toLowerCase()))) {
      return cat._id;
    }
  }
  return null;
}
