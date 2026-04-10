import mongoose from 'mongoose';

// Shared with Embers — read-write for login/logout, strict: false to
// tolerate extra fields (push_token, device_type, etc.) that Embers owns.
const sessionSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    token: { type: String, required: true },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'sessions',
    strict: false,
  },
);

export default mongoose.model('Session', sessionSchema);
