/**
 * MSAL token cache plugin bound to a specific user_id.
 *
 * `@azure/msal-node` defines the `ICachePlugin` interface:
 *
 *     interface ICachePlugin {
 *       beforeCacheAccess(context: TokenCacheContext): Promise<void>;
 *       afterCacheAccess(context: TokenCacheContext): Promise<void>;
 *     }
 *
 * MSAL calls `beforeCacheAccess` before every cache read/write and
 * `afterCacheAccess` after. The plugin's job is to:
 *   - Populate MSAL's in-memory cache from persistent storage via
 *     `context.tokenCache.deserialize(json)` (before)
 *   - Serialize MSAL's in-memory cache and persist it when
 *     `context.cacheHasChanged` is true (after)
 *
 * Design notes (see docs/EMAIL_AUTH.md §3.4):
 *
 * 1. **Factory-per-user, never a singleton.** Each sync builds a new
 *    plugin with the CurveConfig's user_id baked into the closure. A
 *    singleton plugin keyed by `homeAccountId` is tempting for
 *    efficiency but opens the door to cross-user token leakage — the
 *    V2 doc rejects that explicitly and so do we.
 *
 * 2. **Encryption at rest.** The serialized MSAL cache is encrypted
 *    with AES-256-GCM via the existing crypto.js (same
 *    IMAP_ENCRYPTION_KEY that protects imap_password). Nothing in the
 *    cache plugin is aware of the encryption scheme — it just calls
 *    encrypt/decrypt.
 *
 * 3. **Corrupt cache is non-fatal.** If the persisted blob fails to
 *    decrypt or deserialize, we warn once and treat the cache as
 *    empty. MSAL sees "no accounts", `acquireTokenSilent` throws
 *    naturally, and the orchestrator surfaces a "re-authorize" banner.
 *    Crashing here would take the whole sync down for a single user's
 *    broken cache — not worth it. See §7.5 of the V2 doc.
 *
 * 4. **Dependency injection for testability.** The plugin takes
 *    optional `loadCache` / `saveCache` overrides. Production code
 *    uses the defaults (which hit CurveConfig in MongoDB); the smoke
 *    test passes in-memory stubs to exercise the full lifecycle
 *    without requiring a live database.
 */

import CurveConfig from '../models/CurveConfig.js';
import { encrypt, decrypt } from './crypto.js';

/**
 * Default loader: reads `oauth_token_cache` for a user_id and returns
 * the decrypted plaintext (or `null` if no cache exists yet).
 */
async function defaultLoadCache(userId) {
  const config = await CurveConfig.findOne(
    { user_id: userId },
    { oauth_token_cache: 1 },
  ).lean();
  if (!config?.oauth_token_cache) return null;
  return decrypt(config.oauth_token_cache);
}

/**
 * Default saver: encrypts the plaintext cache and writes it to the
 * user's CurveConfig document via updateOne.
 */
async function defaultSaveCache(userId, plaintext) {
  const ciphertext = encrypt(plaintext);
  await CurveConfig.updateOne(
    { user_id: userId },
    { $set: { oauth_token_cache: ciphertext } },
  );
}

/**
 * Build a fresh ICachePlugin instance scoped to a single user_id.
 *
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {object} [overrides]
 * @param {(userId) => Promise<string|null>} [overrides.loadCache]
 *   Returns the decrypted MSAL cache JSON or null if not yet populated.
 * @param {(userId, plaintext: string) => Promise<void>} [overrides.saveCache]
 *   Persists the given plaintext MSAL cache (encryption is the
 *   saver's responsibility — the default uses crypto.js).
 * @param {(userId, message: string) => void} [overrides.onCorrupted]
 *   Called when the loaded cache cannot be deserialized. Default logs
 *   a warning. Tests can pass a spy to assert the branch was taken.
 * @returns {import('@azure/msal-node').ICachePlugin}
 */
export function createCachePlugin(userId, overrides = {}) {
  const loadCache = overrides.loadCache || defaultLoadCache;
  const saveCache = overrides.saveCache || defaultSaveCache;
  const onCorrupted =
    overrides.onCorrupted ||
    ((uid, msg) => {
      console.warn(
        `[oauth] token cache unreadable for user ${uid}: ${msg}. ` +
          `Treating as empty — user will need to re-authorize.`,
      );
    });

  return {
    async beforeCacheAccess(context) {
      let plaintext;
      try {
        plaintext = await loadCache(userId);
      } catch (err) {
        // Loader itself failed (e.g. Mongo down). Don't crash the
        // cache plugin — let MSAL see an empty cache and fail at
        // acquireTokenSilent, which has better error context.
        onCorrupted(userId, `load failed: ${err.message}`);
        return;
      }
      if (!plaintext) return; // First auth — MSAL starts empty.
      try {
        context.tokenCache.deserialize(plaintext);
      } catch (err) {
        onCorrupted(userId, `deserialize failed: ${err.message}`);
      }
    },

    async afterCacheAccess(context) {
      if (!context.cacheHasChanged) return;
      const plaintext = context.tokenCache.serialize();
      await saveCache(userId, plaintext);
    },
  };
}
