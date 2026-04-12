#!/usr/bin/env node
/**
 * Smoke test for server/src/services/oauthManager.js.
 *
 * Exercises buildMsalApp + getOAuthToken + OAuthReAuthRequired without
 * touching Azure AD. We stub `PublicClientApplication` via the
 * `overrides.PublicClientApplicationCtor` / `overrides.app` seams
 * exposed for this purpose.
 *
 * Usage:
 *   node server/scripts/test-oauth-manager.js
 *
 * Exit code: 0 if all cases pass, 1 on any failure.
 */

process.env.IMAP_ENCRYPTION_KEY =
  process.env.IMAP_ENCRYPTION_KEY || '0'.repeat(64);
process.env.AZURE_CLIENT_ID =
  process.env.AZURE_CLIENT_ID || '00000000-0000-0000-0000-000000000000';

import { InteractionRequiredAuthError } from '@azure/msal-node';
import {
  buildMsalApp,
  getOAuthToken,
  OAuthReAuthRequired,
} from '../src/services/oauthManager.js';

// ----- Tiny test harness ----------------------------------------------

const results = [];
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
  }
}

async function assertThrows(fn, matcher, label) {
  let thrown;
  try {
    await fn();
  } catch (err) {
    thrown = err;
  }
  if (!thrown) throw new Error(`${label}: expected throw, nothing thrown`);
  if (typeof matcher === 'function') {
    if (!matcher(thrown)) {
      throw new Error(`${label}: thrown error did not match (${thrown.message})`);
    }
  } else if (matcher instanceof RegExp) {
    if (!matcher.test(thrown.message)) {
      throw new Error(`${label}: message did not match ${matcher} — got: ${thrown.message}`);
    }
  }
  return thrown;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// ----- Fake MSAL PublicClientApplication -------------------------------
//
// Models only the methods oauthManager.js actually calls:
//   - getTokenCache() → { getAccountByHomeId }
//   - acquireTokenSilent({ account, scopes }) → { accessToken }
//
// The fake's behavior is configurable per-test so we can drive the
// happy path, the InteractionRequiredAuthError path, and the
// "no account in cache" path independently.

function makeFakePca({
  accountByHomeId = null,
  silentResult,
  silentThrows,
} = {}) {
  const calls = { acquireTokenSilent: [], getAccountByHomeId: [] };
  return {
    calls,
    getTokenCache: () => ({
      getAccountByHomeId: async (id) => {
        calls.getAccountByHomeId.push(id);
        return accountByHomeId;
      },
    }),
    acquireTokenSilent: async (req) => {
      calls.acquireTokenSilent.push(req);
      if (silentThrows) throw silentThrows;
      return silentResult;
    },
  };
}

// Minimal config factory. Mirrors the V2 schema shape.
function makeConfig(overrides = {}) {
  return {
    user_id: 'user-1',
    oauth_provider: 'microsoft',
    oauth_account_id: 'home-id-aaa',
    oauth_client_id: '00000000-0000-0000-0000-000000000000',
    oauth_tenant_id: 'common',
    ...overrides,
  };
}

// ----- Tests ----------------------------------------------------------

console.log('oauthManager smoke test\n');

await test('buildMsalApp: throws on missing config', async () => {
  await assertThrows(
    () => buildMsalApp(null),
    /config is required/,
    'missing config',
  );
});

await test("buildMsalApp: rejects oauth_provider='google' in MVP", async () => {
  await assertThrows(
    () => buildMsalApp(makeConfig({ oauth_provider: 'google' })),
    /unsupported oauth_provider 'google'/,
    'google rejected',
  );
});

await test('buildMsalApp: errors when no client id is available', async () => {
  const savedEnv = process.env.AZURE_CLIENT_ID;
  delete process.env.AZURE_CLIENT_ID;
  try {
    await assertThrows(
      () => buildMsalApp(makeConfig({ oauth_client_id: null })),
      /no client id/,
      'missing clientId',
    );
  } finally {
    process.env.AZURE_CLIENT_ID = savedEnv;
  }
});

await test('buildMsalApp: real MSAL constructor accepts our options', async () => {
  // This path actually hits @azure/msal-node. It doesn't make any
  // network calls — PublicClientApplication's constructor is pure.
  // Regression guard: if MSAL bumps a major and renames an option,
  // this blows up at unit-test time instead of in production.
  const app = buildMsalApp(makeConfig());
  if (typeof app.acquireTokenSilent !== 'function') {
    throw new Error('expected real MSAL PCA, got something else');
  }
});

await test('getOAuthToken: config without oauth_provider throws a plain Error', async () => {
  await assertThrows(
    () => getOAuthToken({ user_id: 'u' }),
    (e) =>
      !(e instanceof OAuthReAuthRequired) &&
      /without oauth_provider/.test(e.message),
    'plain Error for missing provider',
  );
});

await test('getOAuthToken: missing oauth_account_id → OAuthReAuthRequired', async () => {
  const err = await assertThrows(
    () => getOAuthToken(makeConfig({ oauth_account_id: null })),
    (e) => e instanceof OAuthReAuthRequired,
    'reauth required',
  );
  assertEqual(err.code, 'OAUTH_REAUTH', 'error.code');
});

await test('getOAuthToken: happy path returns accessToken string', async () => {
  const fake = makeFakePca({
    accountByHomeId: { homeAccountId: 'home-id-aaa' },
    silentResult: { accessToken: 'eyJtok' },
  });
  const token = await getOAuthToken(makeConfig(), { app: fake });
  assertEqual(token, 'eyJtok', 'access token');
  assertEqual(fake.calls.acquireTokenSilent.length, 1, 'silent call count');
  const req = fake.calls.acquireTokenSilent[0];
  if (!req.scopes.includes('offline_access')) {
    throw new Error('scopes must include offline_access');
  }
  if (!req.scopes.some((s) => s.includes('IMAP.AccessAsUser.All'))) {
    throw new Error('scopes must include IMAP.AccessAsUser.All');
  }
});

await test('getOAuthToken: account not in cache → OAuthReAuthRequired', async () => {
  const fake = makeFakePca({
    accountByHomeId: null, // cache loaded but homeAccountId missing
    silentResult: { accessToken: 'never reached' },
  });
  await assertThrows(
    () => getOAuthToken(makeConfig(), { app: fake }),
    (e) => e instanceof OAuthReAuthRequired && /not found in cache/.test(e.message),
    'reauth on missing account',
  );
  assertEqual(fake.calls.acquireTokenSilent.length, 0, 'silent not called');
});

await test('getOAuthToken: InteractionRequiredAuthError → OAuthReAuthRequired', async () => {
  const iface = new InteractionRequiredAuthError('invalid_grant', 'no more refresh');
  const fake = makeFakePca({
    accountByHomeId: { homeAccountId: 'home-id-aaa' },
    silentThrows: iface,
  });
  const err = await assertThrows(
    () => getOAuthToken(makeConfig(), { app: fake }),
    (e) => e instanceof OAuthReAuthRequired,
    'maps InteractionRequired → reauth',
  );
  // Error code from MSAL ('invalid_grant') should be preserved in msg
  if (!/invalid_grant|no more refresh/.test(err.message)) {
    throw new Error(`expected MSAL detail in wrapped message, got: ${err.message}`);
  }
});

await test('getOAuthToken: generic Error bubbles through unwrapped', async () => {
  const netErr = new Error('ETIMEDOUT');
  const fake = makeFakePca({
    accountByHomeId: { homeAccountId: 'home-id-aaa' },
    silentThrows: netErr,
  });
  const err = await assertThrows(
    () => getOAuthToken(makeConfig(), { app: fake }),
    (e) => !(e instanceof OAuthReAuthRequired),
    'non-interactive errors bubble',
  );
  assertEqual(err.message, 'ETIMEDOUT', 'original message preserved');
});

// ----- Summary --------------------------------------------------------

console.log('');
if (failures === 0) {
  console.log(`all ${results.length} tests passed`);
  process.exit(0);
} else {
  console.log(`${failures} of ${results.length} tests failed`);
  process.exit(1);
}
