import mongoose from 'mongoose';

const expenseSchema = new mongoose.Schema(
  {
    entity: { type: String, required: true },
    amount: { type: Number, required: true },
    // `date` is the free-form human-readable string from the Curve
    // email ("06 April 2026 08:53:31"). Kept as String for bit-for-bit
    // compat with curve.py + Embers' historical writes (Embers' Mongoid
    // model declares `field :date, type: DateTime` and would serialise
    // it as a BSON Date — so the shared collection holds mixed types
    // in practice, see scripts/analyze-expense-dates.js for the
    // survey). Do NOT sort on this field: lexical order on day-first
    // strings is not chronological, and BSON type ordering puts
    // String < Date so mixed-type rows cluster nonsensically.
    date: { type: String, required: true },
    // Typed chronological companion to `date`, populated at INSERT and
    // via the one-shot backfill in scripts/analyze-expense-dates.js.
    // Nullable so rows pre-backfill validate cleanly; queries that
    // order by it must tolerate null (see ROADMAP Opção C step 5 —
    // the sort default moves to `-date_at` once the backfill lands).
    // Embers has no Mongoid field for this and will silently pass it
    // through on reads — that's the whole point of adding a new
    // column instead of mutating `date`.
    date_at: { type: Date, default: null },
    card: { type: String },
    digest: { type: String, required: true },
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    category_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'expenses',
  },
);

// Compound index: same digest is allowed across different users, but
// the same user cannot have two expenses with the same digest. This
// replaces the old `{ digest: 1 }` unique index.
expenseSchema.index({ digest: 1, user_id: 1 }, { unique: true });

// Hot query for /expenses listing and the dashboard "Despesas
// recentes" card after Opção C step 5: user-scoped reads sorted by
// date_at descending. `partialFilterExpression` keeps the index small
// during the migration window (rows with `date_at: null` stay out of
// the index, which is fine because we never read them via date_at
// until the backfill is done). Post-backfill every row is indexed.
expenseSchema.index(
  { user_id: 1, date_at: -1 },
  { partialFilterExpression: { date_at: { $type: 'date' } } },
);

export default mongoose.model('Expense', expenseSchema);
