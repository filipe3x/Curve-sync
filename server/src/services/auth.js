import { createHash, randomBytes } from 'node:crypto';

/** Session lifetime in milliseconds (1 day). */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Replicates Ruby's Digest::SHA2.hexdigest(string) exactly.
 */
export function sha256(string) {
  return createHash('sha256').update(string).digest('hex');
}

/**
 * Verifies a password against the Embers hash stored in MongoDB.
 * Embers: encrypted_password = SHA256("password--salt")
 */
export function verifyPassword(password, salt, encryptedPassword) {
  return sha256(`${password}--${salt}`) === encryptedPassword;
}

/**
 * Builds an Embers-compatible {salt, encrypted_password} pair for a new
 * password. Mirrors the `make_salt` + `encrypt_password` callbacks in
 * `docs/embers-reference/models/user.rb`:
 *
 *   make_salt          → SHA256("#{Time.now.utc}--#{password}")
 *   encrypt_password   → SHA256("#{password}--#{salt}")
 *
 * The salt is opaque — Embers reads whatever string we wrote and feeds
 * it back into `encrypt(password)` on subsequent logins. Using
 * `new Date().toISOString()` instead of Ruby's `Time.now.utc` produces
 * a different timestamp format but the resulting SHA-256 is just as
 * unpredictable, and Embers never re-derives the salt from the
 * timestamp — only re-applies it. A user registered here will log into
 * the Embers app unchanged.
 */
export function hashPassword(password) {
  const salt = sha256(`${new Date().toISOString()}--${password}`);
  const encrypted_password = sha256(`${password}--${salt}`);
  return { salt, encrypted_password };
}

/**
 * Generates a cryptographically secure random token for sessions.
 */
export function generateToken() {
  return randomBytes(32).toString('hex');
}
