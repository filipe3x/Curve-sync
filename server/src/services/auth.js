import { createHash, randomBytes } from 'node:crypto';

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
 * Generates a cryptographically secure random token for sessions.
 */
export function generateToken() {
  return randomBytes(32).toString('hex');
}
