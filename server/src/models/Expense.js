import mongoose from 'mongoose';

const expenseSchema = new mongoose.Schema(
  {
    entity: { type: String, required: true },
    amount: { type: Number, required: true },
    date: { type: String, required: true },
    card: { type: String },
    digest: { type: String, required: true, unique: true },
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    category_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'expenses',
  },
);

export default mongoose.model('Expense', expenseSchema);
