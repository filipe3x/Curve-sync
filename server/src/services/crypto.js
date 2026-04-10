import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Returns the 32-byte encryption key from the environment.
 * Throws if missing or wrong length.
 */
function getKey() {
  const hex = process.env.IMAP_ENCRYPTION_KEY;
  if (!hex) throw new Error('IMAP_ENCRYPTION_KEY not set in environment.');
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) {
    throw new Error(`IMAP_ENCRYPTION_KEY must be 64 hex chars (32 bytes), got ${hex.length} chars.`);
  }
  return buf;
}

/**
 * Encrypt a plaintext string. Returns a hex string containing
 * iv + authTag + ciphertext, so it can be stored in a single field.
 */
export function encrypt(plaintext) {
  if (!plaintext) return plaintext;
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // iv (12) + authTag (16) + ciphertext
  return Buffer.concat([iv, authTag, encrypted]).toString('hex');
}

/**
 * Decrypt a hex string produced by encrypt(). Returns the original
 * plaintext. If the input doesn't look encrypted (no hex, too short),
 * returns it as-is for backwards compatibility with existing plaintext
 * passwords.
 */
export function decrypt(stored) {
  if (!stored) return stored;
  // Backwards compat: if it doesn't look like a hex-encoded encrypted
  // value (min length = (12 + 16 + 1) * 2 = 58 hex chars), treat it
  // as plaintext from before encryption was enabled.
  if (!/^[0-9a-f]+$/i.test(stored) || stored.length < 58) return stored;

  const key = getKey();
  const buf = Buffer.from(stored, 'hex');
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  try {
    return decipher.update(ciphertext) + decipher.final('utf8');
  } catch {
    // Decryption failed — likely a plaintext password stored before
    // encryption was enabled. Return as-is.
    return stored;
  }
}

/**
 * Generate a random 256-bit key for IMAP_ENCRYPTION_KEY.
 * Run: node -e "import('./src/services/crypto.js').then(m => console.log(m.generateKey()))"
 */
export function generateKey() {
  return randomBytes(32).toString('hex');
}
