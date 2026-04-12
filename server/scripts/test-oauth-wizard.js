#!/usr/bin/env node
/**
 * Smoke test for server/src/services/oauthWizard.js.
 *
 * Exercises the full state machine — providerForEmail, startDag,
 * pollDag, cancelDag, getStatus — with a fake MSAL app injected via
 * the overrides seam. No Azure, no Mongo, no Express. The CurveConfig
 * upsert and oauth_account_id save are also stubbed through
 * overrides, so we only test the logic flow.
 *
 * Usage:
 *   node server/scripts/test-oauth-wizard.js
 */

process.env.IMAP_ENCRYPTION_KEY =
  process.env.IMAP_ENCRYPTION_KEY || '0'.repeat(64);
process.env.AZURE_CLIENT_ID =
  process.env.AZURE_CLIENT_ID || '00000000-0000-0000-0000-000000000000';

import {
  providerForEmail,
  startDag,
  pollDag,
  cancelDag,
  getStatus,
  __resetPendingDags,
} from '../src/services/oauthWizard.js';

// ----- Tiny test harness ----------------------------------------------

const results = [];
let failures = 0;

async function test(name, fn) {
  __resetPendingDags();
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
  if (typeof matcher === 'function' && !matcher(thrown)) {
    throw new Error(`${label}: did not match (${thrown.message})`);
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

// ----- Fake MSAL PCA --------------------------------------------------
//
// Models only the method startDag calls: acquireTokenByDeviceCode.
// The fake fires the deviceCodeCallback synchronously with canned
// code info, then resolves / rejects the returned promise after a
// tick so the test can observe both the "pending" and "done" states.

function makeFakeApp({
  codeInfo = {
    userCode: 'ABCD1234',
    verificationUri: 'https://microsoft.com/devicelogin',
    expiresIn: 900,
    message: 'Open the URL and enter ABCD1234',
  },
  resolveWith = null,
  rejectWith = null,
  delayMs = 20,
} = {}) {
  return {
    acquireTokenByDeviceCode: async ({ deviceCodeCallback }) => {
      deviceCodeCallback(codeInfo);
      // Small delay so the test can poll while still pending.
      await new Promise((r) => setTimeout(r, delayMs));
      if (rejectWith) throw rejectWith;
      return resolveWith;
    },
  };
}

function makeFakeBuildApp(fake) {
  return () => fake;
}

// Stub saveStub / saveAccount to avoid Mongoose. Record calls so we
// can assert the right payload was written.
function makeSaves() {
  const calls = { stub: [], account: [] };
  return {
    calls,
    saveStub: async () => {
      calls.stub.push(true);
    },
    saveAccount: async () => {
      calls.account.push(true);
    },
  };
}

// ----- Tests ----------------------------------------------------------

console.log('oauthWizard smoke test\n');

await test('providerForEmail: outlook.pt → microsoft', async () => {
  assertEqual(providerForEmail('filipe@outlook.pt'), 'microsoft', 'outlook.pt');
  assertEqual(providerForEmail('foo@hotmail.com'), 'microsoft', 'hotmail.com');
  assertEqual(providerForEmail('bar@live.co.uk'), 'microsoft', 'live.co.uk');
  assertEqual(providerForEmail('baz@msn.com'), 'microsoft', 'msn.com');
});

await test('providerForEmail: gmail + custom → null', async () => {
  assertEqual(providerForEmail('foo@gmail.com'), null, 'gmail');
  assertEqual(providerForEmail('foo@example.org'), null, 'example.org');
  assertEqual(providerForEmail('not-an-email'), null, 'bad input');
  assertEqual(providerForEmail(''), null, 'empty');
  assertEqual(providerForEmail(null), null, 'null');
});

await test('providerForEmail: case + whitespace insensitive', async () => {
  assertEqual(providerForEmail('  Foo@Outlook.COM  '), 'microsoft', 'trim + case');
});

await test('startDag: rejects non-Microsoft email', async () => {
  const saves = makeSaves();
  const err = await assertThrows(
    () =>
      startDag(
        { userId: 'u1', email: 'foo@gmail.com' },
        {
          buildMsalApp: makeFakeBuildApp(makeFakeApp()),
          saveStub: saves.saveStub,
        },
      ),
    (e) => e.code === 'UNSUPPORTED_PROVIDER',
    'rejects gmail',
  );
  if (!/not a supported Microsoft account/.test(err.message)) {
    throw new Error(`unexpected message: ${err.message}`);
  }
  assertEqual(saves.calls.stub.length, 0, 'stub not created for rejected');
});

await test('startDag: happy path returns code info', async () => {
  const saves = makeSaves();
  const fake = makeFakeApp({
    resolveWith: {
      accessToken: 'eyJ-mock',
      account: { username: 'foo@outlook.pt', homeAccountId: 'home-id-xxx' },
    },
  });
  const result = await startDag(
    { userId: 'u1', email: 'foo@outlook.pt' },
    {
      buildMsalApp: makeFakeBuildApp(fake),
      saveStub: saves.saveStub,
    },
  );
  assertEqual(result.provider, 'microsoft', 'provider');
  assertEqual(result.userCode, 'ABCD1234', 'userCode');
  assertEqual(
    result.verificationUri,
    'https://microsoft.com/devicelogin',
    'verificationUri',
  );
  assertEqual(result.expiresIn, 900, 'expiresIn');
  assertEqual(saves.calls.stub.length, 1, 'stub created exactly once');
});

await test('startDag: second call while pending → DAG_IN_PROGRESS', async () => {
  const saves = makeSaves();
  // Slow fake so the first DAG stays pending long enough for the
  // second call to hit the in-progress check.
  const fake = makeFakeApp({
    resolveWith: { accessToken: 'x', account: { username: 'u', homeAccountId: 'h' } },
    delayMs: 500,
  });
  await startDag(
    { userId: 'u1', email: 'foo@outlook.pt' },
    { buildMsalApp: makeFakeBuildApp(fake), saveStub: saves.saveStub },
  );
  await assertThrows(
    () =>
      startDag(
        { userId: 'u1', email: 'foo@outlook.pt' },
        { buildMsalApp: makeFakeBuildApp(fake), saveStub: saves.saveStub },
      ),
    (e) => e.code === 'DAG_IN_PROGRESS',
    'second call blocks',
  );
});

await test('pollDag: pending → done lifecycle', async () => {
  const saves = makeSaves();
  const account = { username: 'foo@outlook.pt', homeAccountId: 'home-id-yyy' };
  const fake = makeFakeApp({
    resolveWith: { accessToken: 'eyJ-mock', account },
    delayMs: 40,
  });
  await startDag(
    { userId: 'u1', email: 'foo@outlook.pt' },
    { buildMsalApp: makeFakeBuildApp(fake), saveStub: saves.saveStub },
  );

  // Immediately after startDag returns, the DAG is still pending
  // because the fake's resolution is delayed.
  const pending = await pollDag({ userId: 'u1' }, { saveAccount: saves.saveAccount });
  assertEqual(pending.status, 'pending', 'first poll is pending');

  // Wait for the fake to resolve, then poll again.
  await new Promise((r) => setTimeout(r, 80));
  const done = await pollDag({ userId: 'u1' }, { saveAccount: saves.saveAccount });
  assertEqual(done.status, 'done', 'second poll is done');
  assertEqual(done.email, 'foo@outlook.pt', 'done.email');
  assertEqual(done.homeAccountId, 'home-id-yyy', 'done.homeAccountId');
  assertEqual(saves.calls.account.length, 1, 'account save called once');

  // After done, a third poll returns 'none' (state cleared).
  const after = await pollDag({ userId: 'u1' }, { saveAccount: saves.saveAccount });
  assertEqual(after.status, 'none', 'third poll is none');
});

await test('pollDag: DAG failure surfaces as error and clears state', async () => {
  const saves = makeSaves();
  const rejection = new Error('user declined');
  rejection.errorCode = 'authorization_declined';
  const fake = makeFakeApp({ rejectWith: rejection, delayMs: 20 });
  await startDag(
    { userId: 'u1', email: 'foo@outlook.pt' },
    { buildMsalApp: makeFakeBuildApp(fake), saveStub: saves.saveStub },
  );
  await new Promise((r) => setTimeout(r, 60));

  const result = await pollDag({ userId: 'u1' }, { saveAccount: saves.saveAccount });
  assertEqual(result.status, 'error', 'status');
  assertEqual(result.errorCode, 'authorization_declined', 'errorCode');
  if (!/user declined/.test(result.error)) {
    throw new Error(`expected message, got: ${result.error}`);
  }
  assertEqual(saves.calls.account.length, 0, 'save NOT called on error');

  const after = await pollDag({ userId: 'u1' });
  assertEqual(after.status, 'none', 'state cleared after error');
});

await test('pollDag: no DAG → none', async () => {
  const result = await pollDag({ userId: 'u-none' });
  assertEqual(result.status, 'none', 'none when unknown user');
});

await test('cancelDag: drops the pending slot', async () => {
  const saves = makeSaves();
  const fake = makeFakeApp({
    resolveWith: { accessToken: 'x', account: { username: 'u', homeAccountId: 'h' } },
    delayMs: 500,
  });
  await startDag(
    { userId: 'u1', email: 'foo@outlook.pt' },
    { buildMsalApp: makeFakeBuildApp(fake), saveStub: saves.saveStub },
  );
  assertEqual(cancelDag({ userId: 'u1' }), true, 'cancel returns true');
  assertEqual(cancelDag({ userId: 'u1' }), false, 'second cancel returns false');
  const after = await pollDag({ userId: 'u1' });
  assertEqual(after.status, 'none', 'poll after cancel is none');
});

await test('getStatus: no config → not connected', async () => {
  const status = await getStatus(
    { userId: 'u-missing' },
    { loadConfig: async () => null },
  );
  assertEqual(status.connected, false, 'connected false');
});

await test('getStatus: fully populated config → connected', async () => {
  const status = await getStatus(
    { userId: 'u-full' },
    {
      loadConfig: async () => ({
        oauth_provider: 'microsoft',
        oauth_account_id: 'home-id',
        oauth_token_cache: 'ciphertext',
        imap_username: 'foo@outlook.pt',
        sync_enabled: true,
      }),
    },
  );
  assertEqual(status.connected, true, 'connected');
  assertEqual(status.provider, 'microsoft', 'provider');
  assertEqual(status.email, 'foo@outlook.pt', 'email');
  assertEqual(status.sync_enabled, true, 'sync_enabled');
});

await test('getStatus: half-baked config (no token cache) → not connected', async () => {
  const status = await getStatus(
    { userId: 'u-partial' },
    {
      loadConfig: async () => ({
        oauth_provider: 'microsoft',
        oauth_account_id: 'home-id',
        oauth_token_cache: null,
        imap_username: 'foo@outlook.pt',
      }),
    },
  );
  assertEqual(status.connected, false, 'half-baked not connected');
});

await test('startDag: MSAL-level failure before deviceCodeCallback throws', async () => {
  // MSAL fails outright (e.g. invalid client id) BEFORE the
  // deviceCodeCallback fires. startDag should surface that error
  // instead of timing out at 10 s.
  const saves = makeSaves();
  const brokenApp = {
    acquireTokenByDeviceCode: async () => {
      throw new Error('invalid client_id');
    },
  };
  await assertThrows(
    () =>
      startDag(
        { userId: 'u1', email: 'foo@outlook.pt' },
        {
          buildMsalApp: () => brokenApp,
          saveStub: saves.saveStub,
          codeTimeoutMs: 1000,
          pollInterval: 10,
        },
      ),
    (e) => /invalid client_id/.test(e.message),
    'MSAL failure bubbles',
  );
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
