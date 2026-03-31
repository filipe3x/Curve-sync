import mongoose from 'mongoose';

const curveConfigSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    imap_server: { type: String, default: '' },
    imap_port: { type: Number, default: 993 },
    imap_username: { type: String, default: '' },
    imap_password: { type: String, default: '' },
    imap_folder: { type: String, default: 'INBOX' },
    sync_enabled: { type: Boolean, default: false },
    sync_interval_minutes: { type: Number, default: 5 },
    last_sync_at: { type: Date },
    last_sync_status: { type: String, enum: ['ok', 'error', null], default: null },
    emails_processed_total: { type: Number, default: 0 },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'curve_configs',
  },
);

export default mongoose.model('CurveConfig', curveConfigSchema);
