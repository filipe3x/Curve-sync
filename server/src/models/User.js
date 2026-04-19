import mongoose from 'mongoose';

// Shared `users` collection (owned conceptually by Embers, but writable
// by Curve Sync since the multi-user follow-up — see CLAUDE.md MongoDB
// Collection Access Rules). Allowed operations: READ + INSERT + UPDATE.
// DELETE is forbidden — Embers owns the destroy path, including the
// "last admin" guard. Inserts MUST stay byte-shape-compatible with
// Embers' Mongoid `User` model (email lowercased, salt + encrypted_password
// derived via `services/auth.js:hashPassword`, role defaulting to 'user').
// `strict: false` lets us read rows that carry Embers-only fields
// (Devise leftovers, `name`, `confirmation_*`, ...) without losing them.
const userSchema = new mongoose.Schema(
  {
    email: String,
    role: String,
    encrypted_password: String,
    salt: String,
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'users',
    strict: false,
  },
);

export default mongoose.model('User', userSchema);
