import mongoose from 'mongoose';

const expenseSchema = new mongoose.Schema(
  {
    entity: { type: String, required: true },
    amount: { type: Number, required: true },
    // `date` stores the typed chronological timestamp as a BSON `Date`.
    // Embers' Mongoid declares `field :date, type: DateTime` and every
    // prod row from the legacy pipeline landed here as BSON `Date`
    // (Mongoid coerces the curve.py string via `DateTime.parse` before
    // serialising). Curve Sync mirrors that contract: the email parser
    // returns the free-form string ("06 April 2026 08:53:31"), callers
    // parse it to a `Date` via `parseExpenseDate` from
    // services/expenseDate.js immediately before `Expense.create`, and
    // the raw string stays live only long enough to feed the SHA-256
    // digest (see emailParser.js:273-284 — the digest MUST stay
    // bit-for-bit compatible with curve.py, which hashes the original
    // string form). Keeping `date` uniformly typed avoids the BSON
    // type-order landmine where `String < Date` makes `$gte` range
    // queries from Mongoid miss every String row (the dev dump had 76
    // rows split 63 String / 13 Date — Embers' cycle filter silently
    // dropped the String half before this change).
    date: { type: Date, required: true },
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
// recentes" card: user-scoped reads sorted by date descending. Every
// row has a typed `date` (Embers writes Date, Curve Sync parses the
// email string to Date on insert), so no partialFilterExpression is
// needed — the full compound index serves every query.
expenseSchema.index({ user_id: 1, date: -1 });

export default mongoose.model('Expense', expenseSchema);
