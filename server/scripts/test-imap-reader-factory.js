#!/usr/bin/env node
/**
 * Smoke test for server/src/services/imapReader.js → createImapReader.
 *
 * Exercises the async factory's branching (legacy vs OAuth) without
 * opening a real IMAP socket. We reach into the constructed
 * `ImapReader` and inspect `client.options.auth` to verify imapflow
 * received the right auth shape for each branch — this is the only
 * behaviourally-meaningful output of the factory that can be asserted
 * in pure memory.
 *
 * Also covers:
 *   - assertConfig() branching: missing password on legacy path,
 *     missing oauth_account_id on OAuth path
 *   - OAuthReAuthRequired → ImapError(AUTH) translation
 *   - Generic MSAL/network error → ImapError(CONNECT) translation
 *
 * Usage:
 *   node server/scripts/test-imap-reader-factory.js
 *
 * Exit code: 0 if all cases pass, 1 on any failure.
 */

import {
  createImapReader,
  ImapReader,
  ImapError,
} from '../src/services/imapReader.js';
import { OAuthReAuthRequired } from '../src/services/oauthManager.js';

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

// ----- Shared config factories ----------------------------------------

function legacyConfig(overrides = {}) {
  return {
    user_id: 'u1',
    imap_server: 'imap.gmail.com',
    imap_username: 'foo@gmail.com',
    imap_password: 'app-password-16chars',
    imap_port: 993,
    imap_tls: true,
    ...overrides,
  };
}

function oauthConfig(overrides = {}) {
  return {
    user_id: 'u1',
    imap_server: 'outlook.office365.com',
    imap_username: 'foo@outlook.com',
    imap_password: null,
    imap_port: 993,
    imap_tls: true,
    oauth_provider: 'microsoft',
    oauth_account_id: 'home-id-aaa',
    oauth_client_id: '00000000-0000-0000-0000-000000000000',
    oauth_tenant_id: 'common',
    ...overrides,
  };
}

// ----- Tests ----------------------------------------------------------

console.log('imapReader.createImapReader smoke test\n');

await test('legacy branch: returns ImapReader with password auth', async () => {
  const reader = await createImapReader(legacyConfig());
  if (!(reader instanceof ImapReader)) {
    throw new Error('expected ImapReader instance');
  }
  const auth = reader.client.options.auth;
  assertEqual(auth.user, 'foo@gmail.com', 'auth.user');
  assertEqual(auth.pass, 'app-password-16chars', 'auth.pass');
  if (auth.accessToken) {
    throw new Error('legacy branch must NOT set accessToken');
  }
});

await test('legacy branch: missing password → ImapError(CONFIG)', async () => {
  const err = await assertThrows(
    () => createImapReader(legacyConfig({ imap_password: null })),
    (e) => e instanceof ImapError && e.code === 'CONFIG',
    'missing password',
  );
  if (!/imap_password/.test(err.message)) {
    throw new Error(`expected imap_password in message, got: ${err.message}`);
  }
});

await test('legacy branch: missing imap_server → ImapError(CONFIG)', async () => {
  await assertThrows(
    () => createImapReader(legacyConfig({ imap_server: null })),
    (e) => e instanceof ImapError && e.code === 'CONFIG' && /imap_server/.test(e.message),
    'missing imap_server',
  );
});

await test('OAuth branch: returns ImapReader with XOAUTH2 auth', async () => {
  const stubToken = 'eyJ0.AAA.BBB';
  const reader = await createImapReader(oauthConfig(), {
    getOAuthToken: async (cfg) => {
      assertEqual(cfg.oauth_provider, 'microsoft', 'getOAuthToken cfg.oauth_provider');
      assertEqual(cfg.oauth_account_id, 'home-id-aaa', 'getOAuthToken cfg.oauth_account_id');
      return stubToken;
    },
  });
  if (!(reader instanceof ImapReader)) {
    throw new Error('expected ImapReader instance');
  }
  const auth = reader.client.options.auth;
  assertEqual(auth.user, 'foo@outlook.com', 'auth.user');
  assertEqual(auth.accessToken, stubToken, 'auth.accessToken');
  if (auth.pass) {
    throw new Error('OAuth branch must NOT set pass');
  }
});

await test('OAuth branch: missing oauth_account_id → ImapError(CONFIG)', async () => {
  await assertThrows(
    () => createImapReader(oauthConfig({ oauth_account_id: null })),
    (e) =>
      e instanceof ImapError &&
      e.code === 'CONFIG' &&
      /oauth_account_id/.test(e.message),
    'missing oauth_account_id',
  );
});

await test('OAuth branch: missing imap_username still required', async () => {
  await assertThrows(
    () => createImapReader(oauthConfig({ imap_username: null })),
    (e) =>
      e instanceof ImapError &&
      e.code === 'CONFIG' &&
      /imap_username/.test(e.message),
    'missing imap_username on OAuth path',
  );
});

await test('OAuth branch: OAuthReAuthRequired → ImapError(AUTH)', async () => {
  const err = await assertThrows(
    () =>
      createImapReader(oauthConfig(), {
        getOAuthToken: async () => {
          throw new OAuthReAuthRequired('invalid_grant');
        },
      }),
    (e) => e instanceof ImapError && e.code === 'AUTH',
    'reauth → AUTH',
  );
  if (!/invalid_grant|re-authorization/.test(err.message)) {
    throw new Error(`expected reauth detail in message, got: ${err.message}`);
  }
  if (!(err.cause instanceof OAuthReAuthRequired)) {
    throw new Error('expected err.cause to be OAuthReAuthRequired');
  }
});

await test('OAuth branch: generic token error → ImapError(CONNECT)', async () => {
  const err = await assertThrows(
    () =>
      createImapReader(oauthConfig(), {
        getOAuthToken: async () => {
          throw new Error('ETIMEDOUT connecting to login.microsoftonline.com');
        },
      }),
    (e) => e instanceof ImapError && e.code === 'CONNECT',
    'network → CONNECT',
  );
  if (!/ETIMEDOUT/.test(err.message)) {
    throw new Error(`expected network detail in message, got: ${err.message}`);
  }
});

await test('constructor still accepts prebuilt auth directly', async () => {
  // Back-compat / test-fixture path: other code can still new up an
  // ImapReader with a prebuilt auth object without going through the
  // factory.
  const reader = new ImapReader(legacyConfig(), {
    user: 'direct@outlook.com',
    accessToken: 'eyJ-direct',
  });
  const auth = reader.client.options.auth;
  assertEqual(auth.user, 'direct@outlook.com', 'direct auth.user');
  assertEqual(auth.accessToken, 'eyJ-direct', 'direct auth.accessToken');
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
