import mongoose from 'mongoose';

/**
 * CurveExpenseExclusion — user-flagged "do not count this expense
 * toward the current cycle / Savings Score" marker. ROADMAP §2.10.
 *
 * Owned exclusively by Curve Sync (Embers has no Mongoid model for
 * this collection and never reads or writes it). Same pattern as
 * `CategoryOverride`: every query from the route handlers MUST be
 * scoped by `user_id: req.userId` — even admins cannot see or mutate
 * another user's exclusions. "Personal is sacred."
 *
 * Why a separate collection and not a field on `Expense` — CLAUDE.md →
 * MongoDB Collection Access Rules forbids adding fields to `expenses`
 * (only `category_id` is mutable; all other fields are INSERT-only,
 * DELETE forbidden, full stop). An exclusion is display-only state
 * (the expense still exists, still has its digest, still appears in
 * history); keeping it out-of-band preserves the Embers contract.
 *
 * Why scope is global rather than per-cycle — a user who excludes a
 * refund-pending row today shouldn't have to re-exclude it next
 * cycle. Per-cycle scoping would let a ghost row haunt them until the
 * refund finally clears. Toggle-back via the same action bar is the
 * pressure-release valve.
 */
const curveExpenseExclusionSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    expense_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Expense',
      required: true,
    },
    // Optional — not exposed in the MVP UI, but the field is here so
    // a power user writing directly against the API can annotate why
    // they excluded the row ("waiting for Curve refund", "paid by
    // flatmate", …). Never read back by the server; future UIs may
    // surface it in the exclusion badge tooltip.
    note: {
      type: String,
      trim: true,
      maxlength: 200,
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'curve_expense_exclusions',
  },
);

// Idempotency guard — excluding the same expense twice is a no-op.
// The exclusion POST handler relies on `upsert: true` + this unique
// index to silently absorb a duplicate click without double-counting
// the audit row.
curveExpenseExclusionSchema.index(
  { user_id: 1, expense_id: 1 },
  { unique: true },
);

// Hot query: `computeDashboardStats` loads every exclusion row for
// the user per dashboard fetch. `{ user_id }` alone covers that scan
// without having to touch `expense_id`.
curveExpenseExclusionSchema.index({ user_id: 1 });

export default mongoose.model(
  'CurveExpenseExclusion',
  curveExpenseExclusionSchema,
);
