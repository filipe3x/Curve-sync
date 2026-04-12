/**
 * OAuth lifecycle glue between `imapReader.js` and `@azure/msal-node`.
 *
 * Exposes three things:
 *
 *   1. `buildMsalApp(config)` — constructs a `PublicClientApplication`
 *      scoped to a single CurveConfig, wired to a fresh cache plugin
 *      (`createCachePlugin(config.user_id)` — see oauthCachePlugin.js).
 *      Cheap to call on every sync; MSAL's init is stateless and the
 *      cache populates lazily via the plugin.
 *
 *   2. `getOAuthToken(config)` — happy-path helper. Returns a fresh
 *      access token string, doing transparent refresh if the cached
 *      one has expired. On the cold path (refresh token expired or
 *      cache wiped) throws `OAuthReAuthRequired`, which the sync
 *      orchestrator maps to `last_sync_status='error'` + `code='AUTH'`
 *      + a banner on the dashboard.
 *
 *   3. `OAuthReAuthRequired` — custom error class tagged with
 *      `code='OAUTH_REAUTH'` so the orchestrator can match on it
 *      without sniffing messages.
 *
 * Notes:
 *
 * - **MVP scope is Microsoft only.** `oauth_provider='google'` raises
 *   a hard error — fase 2 (`EMAIL_AUTH_MVP.md` §2.2) will add the
 *   external-auth branch.
 *
 * - **Env var fallback.** Per-config `oauth_client_id` /
 *   `oauth_tenant_id` take precedence over the process env, so a
 *   future key rotation can leave existing caches running on the old
 *   client_id until re-auth. For wizard-fresh configs both flavours
 *   are identical.
 *
 * - **No token string ever leaves this module except via
 *   `getOAuthToken`'s return value.** Don't log tokens, don't put
 *   them in error messages, don't return the `AuthenticationResult`
 *   wholesale.
 *
 * See docs/EMAIL_AUTH.md §3.5 for the full design rationale.
 */

import {
  PublicClientApplication,
  InteractionRequiredAuthError,
  LogLevel,
} from '@azure/msal-node';

import { createCachePlugin } from './oauthCachePlugin.js';

const SCOPES_BY_PROVIDER = {
  microsoft: [
    'https://outlook.office.com/IMAP.AccessAsUser.All',
    // Without `offline_access` MS does not return a refresh token —
    // every access token expires in ~1h and the user is locked out.
    // This is the single most common misconfiguration; keep it here
    // and do not let anyone "simplify" the scopes list.
    'offline_access',
  ],
};

/**
 * Thrown when MSAL cannot produce a valid access token without user
 * interaction — e.g. refresh token expired (90d inactivity), admin
 * revoked consent, or the token cache is corrupt/wiped.
 *
 * The orchestrator catches this specifically and surfaces a
 * re-authorize banner. Do not catch it anywhere else.
 */
export class OAuthReAuthRequired extends Error {
  constructor(message) {
    super(`OAuth re-authorization required: ${message}`);
    this.name = 'OAuthReAuthRequired';
    this.code = 'OAUTH_REAUTH';
  }
}

/**
 * Build a fresh `PublicClientApplication` for a given CurveConfig.
 *
 * @param {object} config CurveConfig document (plain object or
 *   hydrated — only reads fields).
 * @param {object} [overrides] Test-only. Accepts
 *   `{ PublicClientApplicationCtor, cachePlugin }` for unit tests
 *   that want to stub MSAL without touching the network.
 */
export function buildMsalApp(config, overrides = {}) {
  if (!config) {
    throw new Error('buildMsalApp: config is required');
  }
  if (config.oauth_provider !== 'microsoft') {
    throw new Error(
      `buildMsalApp: unsupported oauth_provider '${config.oauth_provider}' ` +
        `(MVP supports 'microsoft' only — see docs/EMAIL_AUTH_MVP.md §2.2)`,
    );
  }

  const clientId = config.oauth_client_id || process.env.AZURE_CLIENT_ID;
  if (!clientId) {
    throw new Error(
      'buildMsalApp: no client id — set AZURE_CLIENT_ID in the server ' +
        'environment or populate CurveConfig.oauth_client_id',
    );
  }
  const tenantId =
    config.oauth_tenant_id || process.env.AZURE_TENANT_ID || 'common';

  const Ctor =
    overrides.PublicClientApplicationCtor || PublicClientApplication;
  const cachePlugin =
    overrides.cachePlugin || createCachePlugin(config.user_id);

  return new Ctor({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
    cache: { cachePlugin },
    system: {
      loggerOptions: {
        loggerCallback: (level, message) => {
          if (level <= LogLevel.Warning) {
            // eslint-disable-next-line no-console
            console.log(`[msal] ${message}`);
          }
        },
        logLevel: LogLevel.Warning,
        piiLoggingEnabled: false,
      },
    },
  });
}

/**
 * Return a fresh access token for the account associated with
 * `config`. Happy path is a cache hit (~ms); if the cached access
 * token is expired, MSAL silently exchanges the refresh token and
 * writes the updated cache back via the plugin.
 *
 * @param {object} config CurveConfig document
 * @param {object} [overrides] Test-only. `{ app }` lets a caller
 *   inject a pre-built PCA stub, bypassing `buildMsalApp` entirely.
 * @returns {Promise<string>} The access token.
 * @throws {OAuthReAuthRequired} When the refresh token is expired,
 *   the cache is empty/corrupt, or consent was revoked.
 */
export async function getOAuthToken(config, overrides = {}) {
  if (!config?.oauth_provider) {
    throw new Error(
      'getOAuthToken called on a config without oauth_provider',
    );
  }
  if (!config.oauth_account_id) {
    throw new OAuthReAuthRequired(
      'no account in cache — wizard not completed',
    );
  }

  const scopes = SCOPES_BY_PROVIDER[config.oauth_provider];
  if (!scopes) {
    throw new Error(
      `getOAuthToken: unsupported oauth_provider '${config.oauth_provider}'`,
    );
  }

  const app = overrides.app || buildMsalApp(config);
  const cache = app.getTokenCache();
  const account = await cache.getAccountByHomeId(config.oauth_account_id);
  if (!account) {
    // Cache plugin successfully loaded something, but it doesn't
    // contain the homeAccountId we stored at wizard time. Treat as
    // re-auth required — most likely cause is a cache that was wiped
    // or truncated, or a deserialize failure silently dropped the
    // account records.
    throw new OAuthReAuthRequired(
      'account not found in cache (cache corrupted or wiped)',
    );
  }

  try {
    const result = await app.acquireTokenSilent({ account, scopes });
    return result.accessToken;
  } catch (err) {
    if (err instanceof InteractionRequiredAuthError) {
      throw new OAuthReAuthRequired(err.errorCode || err.message);
    }
    // Any other error (network, server 5xx, ...) bubbles up so the
    // orchestrator can retry on the next schedule without marking the
    // token as dead. See §3.7 — only InteractionRequiredAuthError is
    // terminal for auth.
    throw err;
  }
}
