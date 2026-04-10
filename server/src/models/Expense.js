import mongoose from 'mongoose';

const expenseSchema = new mongoose.Schema(
  {
    entity: { type: String, required: true },
    amount: { type: Number, required: true },
    date: { type: String, required: true },
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

export default mongoose.model('Expense', expenseSchema);
