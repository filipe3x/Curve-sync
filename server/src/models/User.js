import mongoose from 'mongoose';

// Read-only model — do not insert or update users from this service.
const userSchema = new mongoose.Schema(
  {
    email: String,
    role: String,
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'users',
    strict: false,
  },
);

export default mongoose.model('User', userSchema);
