/**
 * OAuth wizard state machine for the "Ligar conta Microsoft" flow.
 *
 * The Device Authorization Grant is inherently async and interactive:
 * we hand the user a short code + URL, they open it in a browser on
 * any device, sign in, approve the consent screen, and then MSAL's
 * `acquireTokenByDeviceCode` promise resolves on our end. The wizard
 * UX needs three server interactions wrapped around that single MSAL
 * call:
 *
 *   1. `startDag()` — create a stub CurveConfig (so the MSAL cache
 *      plugin has a doc to write to), build a `PublicClientApplication`
 *      scoped to the user, kick off the DAG in the background, and
 *      return as soon as MSAL fires `deviceCodeCallback` with the
 *      code + URL. The frontend displays those for the user.
 *   2. `pollDag()` — the frontend polls every ~3 s. We check the
 *      stored promise state: pending → `{status:'pending'}`; resolved
 *      → persist `oauth_account_id` and return `{status:'done'}`;
 *      rejected → return `{status:'error'}` with the MSAL error code.
 *   3. `getStatus()` — idempotent read of the persisted state for the
 *      settings page: "connected as foo@outlook.com" or "not connected".
 *
 * State is kept in an in-memory Map keyed by user_id. Single-instance
 * deployment only; if this ever scales horizontally the DAG would need
 * sticky sessions or a Redis-backed store. Out of MVP scope.
 *
 * See docs/EMAIL_AUTH_MVP.md §4 for the UX contract the frontend will
 * build against and docs/EMAIL_AUTH.md §4.2 for the underlying rationale.
 */

import CurveConfig from '../models/CurveConfig.js';
import { buildMsalApp as realBuildMsalApp } from './oauthManager.js';

// ----- Provider detection --------------------------------------------
//
// MVP only supports personal Microsoft accounts, because work/school
// accounts require a tenant-specific authority that we can't probe
// without hitting the AAD discovery endpoint. Gmail is deferred to
// fase 2 (App Password remains the fallback). This list covers the
// most common Outlook/Hotmail/Live domains; unknown domains get
// routed to the "not supported" path and the user can still fall
// back to the legacy App Password form.

const MICROSOFT_HOSTS = ['outlook', 'hotmail', 'live'];
const MICROSOFT_TLDS = [
  'com', 'pt', 'es', 'fr', 'de', 'it', 'nl', 'be',
  'co.uk', 'ie', 'at', 'ch', 'dk', 'fi', 'gr', 'hu',
  'no', 'pl', 'se', 'cz', 'jp', 'com.au', 'com.br',
];
const MICROSOFT_DOMAINS = new Set([
  'msn.com',
  'passport.com',
  'live.ca',
  ...MICROSOFT_HOSTS.flatMap((h) => MICROSOFT_TLDS.map((t) => `${h}.${t}`)),
]);

/**
 * Classify an email address into an OAuth provider.
 * @returns {'microsoft'|null}
 */
export function providerForEmail(email) {
  if (typeof email !== 'string') return null;
  const m = email.toLowerCase().trim().match(/^[^@\s]+@([^@\s]+)$/);
  if (!m) return null;
  return MICROSOFT_DOMAINS.has(m[1]) ? 'microsoft' : null;
}

// ----- In-memory DAG state -------------------------------------------
//
// Keyed by `String(user_id)`. Each entry represents a single in-flight
// DAG. There's intentionally one slot per user — restarting the
// wizard aborts the previous attempt rather than stacking.

/** @type {Map<string, DagState>} */
const pendingDags = new Map();

/**
 * @typedef {Object} DagState
 * @property {boolean}  done
 * @property {?object}  codeInfo     populated after deviceCodeCallback
 * @property {?object}  result       populated on success (contains .account)
 * @property {?Error}   error        populated on failure
 * @property {number}   startedAt    Date.now() when DAG kicked off
 * @property {string}   email        email the user entered in step 1
 * @property {Promise}  promise      the underlying acquireTokenByDeviceCode promise
 */

const DEFAULT_SCOPES = [
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'offline_access',
];

/**
 * Kick off a Device Authorization Grant for `{ userId, email }`.
 *
 * Side effects (production path):
 *   1. Upserts a stub `CurveConfig` with the OAuth fields set and
 *      default IMAP host/port so the cache plugin has a doc to write
 *      to when MSAL persists the token cache.
 *   2. Registers an in-memory state entry for `userId`.
 *   3. Starts the MSAL DAG promise — does NOT await it. Instead,
 *      waits up to `codeTimeoutMs` (10 s by default) for the MSAL
 *      `deviceCodeCallback` to fire with the user code + URL.
 *
 * Returns as soon as the code info is available so the frontend can
 * paint the "enter this code" screen immediately. The DAG promise
 * keeps running in the background and is harvested by `pollDag()`.
 *
 * @param {{userId: any, email: string}} input
 * @param {object} [overrides] Test-only.
 *   - `buildMsalApp` replaces the real MSAL factory (for unit tests)
 *   - `saveStub` replaces the CurveConfig upsert
 *   - `clientId` / `tenantId` override env vars
 *   - `codeTimeoutMs` / `pollInterval` tune the wait loop for tests
 * @returns {Promise<{provider, email, userCode, verificationUri, expiresIn}>}
 */
export async function startDag({ userId, email }, overrides = {}) {
  if (!userId) throw new Error('userId required');
  if (!email) throw new Error('email required');

  const provider = providerForEmail(email);
  if (provider !== 'microsoft') {
    const err = new Error(
      `email "${email}" is not a supported Microsoft account ` +
        '(MVP supports outlook/hotmail/live/msn domains only)',
    );
    err.code = 'UNSUPPORTED_PROVIDER';
    throw err;
  }

  const key = String(userId);
  const existing = pendingDags.get(key);
  if (existing && !existing.done) {
    const err = new Error('authorization already in progress for this user');
    err.code = 'DAG_IN_PROGRESS';
    throw err;
  }
  // Stale terminal state from a previous attempt — clear before retry.
  if (existing) pendingDags.delete(key);

  const clientId = overrides.clientId || process.env.AZURE_CLIENT_ID;
  if (!clientId) {
    const err = new Error('AZURE_CLIENT_ID is not set in the server env');
    err.code = 'MISSING_CLIENT_ID';
    throw err;
  }
  const tenantId = overrides.tenantId || process.env.AZURE_TENANT_ID || 'common';

  // Persist a stub CurveConfig BEFORE MSAL touches the cache plugin.
  // oauthCachePlugin.defaultSaveCache does updateOne() without upsert
  // — if the doc doesn't exist yet the token cache write is silently
  // dropped, which would leave us with a half-completed wizard. The
  // stub carries the default Outlook host/port and the username the
  // user typed; pollDag() later overwrites imap_username with the
  // canonical MSAL account.username (handles aliases and casing).
  const saveStub =
    overrides.saveStub ||
    (async () => {
      await CurveConfig.findOneAndUpdate(
        { user_id: userId },
        {
          $set: {
            user_id: userId,
            oauth_provider: 'microsoft',
            oauth_client_id: clientId,
            oauth_tenant_id: tenantId,
            imap_server: 'outlook.office365.com',
            imap_port: 993,
            imap_tls: true,
            imap_username: email,
          },
        },
        { upsert: true, new: true },
      );
    });
  await saveStub();

  const buildApp = overrides.buildMsalApp || realBuildMsalApp;
  const app = buildApp({
    user_id: userId,
    oauth_provider: 'microsoft',
    oauth_client_id: clientId,
    oauth_tenant_id: tenantId,
  });

  const state = {
    done: false,
    codeInfo: null,
    result: null,
    error: null,
    startedAt: Date.now(),
    email,
    promise: null,
  };
  pendingDags.set(key, state);

  state.promise = app.acquireTokenByDeviceCode({
    scopes: DEFAULT_SCOPES,
    deviceCodeCallback: (resp) => {
      state.codeInfo = {
        userCode: resp.userCode,
        verificationUri: resp.verificationUri,
        expiresIn: resp.expiresIn,
        message: resp.message,
      };
    },
  });

  // Attach handlers synchronously — if we don't, a promptly-rejected
  // promise (e.g. MSAL constructor-level failure) would trigger an
  // UnhandledPromiseRejection before the caller has a chance to poll.
  state.promise.then(
    (result) => {
      state.done = true;
      state.result = result;
    },
    (err) => {
      state.done = true;
      state.error = err;
    },
  );

  // Wait for deviceCodeCallback (or an early failure). Azure normally
  // returns the device code in < 1 s — the 10 s timeout is a safety
  // net, not a target. If the DAG fails outright before the callback
  // fires (invalid client_id, misconfigured tenant) we surface that
  // error here instead of letting the caller think the wizard is
  // happily running in the background.
  const timeoutMs = overrides.codeTimeoutMs ?? 10_000;
  const pollInterval = overrides.pollInterval ?? 50;
  const start = Date.now();
  while (!state.codeInfo && !state.done) {
    if (Date.now() - start >= timeoutMs) {
      pendingDags.delete(key);
      const err = new Error(
        `DAG deviceCodeCallback did not fire within ${timeoutMs}ms`,
      );
      err.code = 'DAG_TIMEOUT';
      throw err;
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  if (state.done && state.error) {
    pendingDags.delete(key);
    throw state.error;
  }

  return {
    provider: 'microsoft',
    email,
    userCode: state.codeInfo.userCode,
    verificationUri: state.codeInfo.verificationUri,
    expiresIn: state.codeInfo.expiresIn,
  };
}

/**
 * Check the status of the in-flight DAG for `userId`. This is the
 * endpoint the frontend polls every few seconds while the user is on
 * the "enter the code" screen.
 *
 * Return shape:
 *   - `{status:'none'}`   — no DAG ever started or it was cleaned up
 *   - `{status:'pending',startedAt}` — still waiting on the user
 *   - `{status:'done',email,homeAccountId}` — tokens written, CurveConfig updated
 *   - `{status:'error',error,errorCode}` — DAG rejected, state cleared
 *
 * On a terminal outcome the in-memory entry is removed so a fresh
 * start is possible without the caller having to cancel first.
 */
export async function pollDag({ userId }, overrides = {}) {
  const key = String(userId);
  const state = pendingDags.get(key);
  if (!state) {
    return { status: 'none' };
  }
  if (!state.done) {
    return {
      status: 'pending',
      startedAt: state.startedAt,
      userCode: state.codeInfo?.userCode,
      verificationUri: state.codeInfo?.verificationUri,
    };
  }
  pendingDags.delete(key);
  if (state.error) {
    return {
      status: 'error',
      error: state.error.message,
      errorCode: state.error.errorCode || null,
    };
  }
  // Happy path. Persist the account id so subsequent syncs can call
  // acquireTokenSilent({ account }) — we need homeAccountId to locate
  // the account record MSAL wrote into the cache during the DAG.
  const account = state.result.account;
  const saveAccount =
    overrides.saveAccount ||
    (async () => {
      await CurveConfig.updateOne(
        { user_id: userId },
        {
          $set: {
            oauth_account_id: account.homeAccountId,
            // Overwrite with MSAL's canonical username — handles the
            // case where the user typed an alias but the mailbox is
            // actually at a different primary address.
            imap_username: account.username,
            // Clear the stale "last sync errored" signal as soon as
            // the wizard hands us fresh tokens. The dashboard's
            // re-auth banner gate (DashboardPage.jsx → needsReauth)
            // ORs `oauthStatus.connected === false` with
            // `syncStatus.last_sync_status === 'error'`, so without
            // this clear the banner kept firing after a successful
            // re-auth until the user manually clicked "Sincronizar
            // agora" to overwrite the field. From the user's POV that
            // was wrong — they JUST proved the auth works. Setting
            // back to `null` ("unknown until next sync") is the right
            // semantic: the previous error is no longer informative.
            last_sync_status: null,
          },
        },
      );
    });
  await saveAccount();
  return {
    status: 'done',
    email: account.username,
    homeAccountId: account.homeAccountId,
  };
}

/**
 * Forget any in-flight DAG for `userId`. The underlying MSAL promise
 * keeps running until Azure rejects it (we have no way to abort it),
 * but the next `pollDag` call returns `{status:'none'}` so the frontend
 * can restart cleanly. The orphaned promise has its rejection handler
 * already attached so there's no unhandled-rejection hazard.
 *
 * @returns {boolean} true if something was cancelled, false if nothing was pending
 */
export function cancelDag({ userId }) {
  return pendingDags.delete(String(userId));
}

/**
 * Idempotent read of the persisted OAuth state for the settings page.
 * "Connected" means all three must be present: provider, account_id,
 * and a non-empty token cache. A half-baked state (e.g. DAG started
 * but never completed) returns connected=false so the UI nudges the
 * user to finish the wizard.
 */
export async function getStatus({ userId }, overrides = {}) {
  const load =
    overrides.loadConfig ||
    (async () => {
      return CurveConfig.findOne(
        { user_id: userId },
        {
          oauth_provider: 1,
          oauth_account_id: 1,
          oauth_token_cache: 1,
          imap_username: 1,
          sync_enabled: 1,
        },
      ).lean();
    });
  const config = await load();
  if (!config) return { connected: false };
  const connected = Boolean(
    config.oauth_provider &&
      config.oauth_account_id &&
      config.oauth_token_cache,
  );
  return {
    connected,
    provider: config.oauth_provider || null,
    email: config.imap_username || null,
    sync_enabled: Boolean(config.sync_enabled),
  };
}

// ----- Test seams -----------------------------------------------------

/** Test-only: wipe the in-memory DAG state between cases. */
export function __resetPendingDags() {
  pendingDags.clear();
}

/** Test-only: introspect the pending map. */
export function __getPendingDags() {
  return pendingDags;
}
