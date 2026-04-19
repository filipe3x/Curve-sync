import mongoose from 'mongoose';

/**
 * CategoryOverride — personal category matching rule.
 *
 * Source of truth for the schema: docs/Categories.md §4.3.
 *
 * Owned exclusively by Curve Sync (Embers has no Mongoid model for
 * this collection and never reads or writes it). Every query from the
 * route handlers MUST be scoped by `user_id: req.userId` — even admins
 * cannot see or mutate another user's overrides (§7.3, §3.6). This is
 * the "personal is sacred" invariant.
 *
 * Why two pattern fields — `pattern` is what the user typed and sees
 * in the UI (e.g. "Lidl"); `pattern_normalized` is the lowercase,
 * diacritic-free, whitespace-collapsed form the resolver compares
 * against and the one the unique index covers. Keeping them separate
 * avoids re-normalising on every read and lets us migrate the
 * normaliser without losing the original input.
 *
 * Why `pattern_normalized` has the unique index (per user) instead of
 * `pattern` — two users typing "Lidl" and "LIDL" are the same rule
 * for matching purposes. Enforcing uniqueness on the normalised form
 * is what makes it impossible to end up with an unresolvable tie
 * inside the same user's rules (§5.8).
 */
const categoryOverrideSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    category_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: true,
    },
    // Raw pattern as the user typed it — preserved so the UI never
    // surprises them with a normalised form ("lidl" instead of "Lidl").
    pattern: {
      type: String,
      required: true,
      trim: true,
    },
    // Normalised form used by the resolver. Populated by
    // `services/categoryResolver.js :: normalize()` at write time.
    // The unique index below sits on (user_id, pattern_normalized).
    pattern_normalized: {
      type: String,
      required: true,
    },
    match_type: {
      type: String,
      enum: ['exact', 'starts_with', 'contains'],
      default: 'contains',
      required: true,
    },
    // Power-user tie-breaker when two rules match the same expense.
    // Longest-match-wins handles ~all real cases (§5.4); priority is
    // the manual escape hatch.
    priority: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'curve_category_overrides',
  },
);

// Two rules from the same user with the same normalised pattern are
// forbidden (§4.3). If the user wants to change the category of "Lidl"
// they edit the existing override — they don't create a second one
// that shadows the first. This also guarantees the matcher never hits
// an unresolvable tie within the user's own tier (§5.8).
categoryOverrideSchema.index(
  { user_id: 1, pattern_normalized: 1 },
  { unique: true },
);

// Hot query: the sync orchestrator loads ALL overrides for the
// config's owner at the start of each run (§5.7). The index on
// `user_id` alone serves that read without having to scan by pattern.
categoryOverrideSchema.index({ user_id: 1 });

export default mongoose.model('CategoryOverride', categoryOverrideSchema);
