#!/usr/bin/env node
/**
 * Smoke test for server/src/services/oauthCachePlugin.js.
 *
 * Exercises the cache plugin's full lifecycle without requiring a live
 * MongoDB. Uses dependency injection (loadCache/saveCache overrides)
 * to keep everything in memory, and a hand-rolled fake
 * `TokenCacheContext` because we don't want to pull in the real MSAL
 * TokenCache here — this is a unit test for the glue, not MSAL itself.
 *
 * Usage:
 *   node server/scripts/test-oauth-cache-plugin.js
 *
 * Exit code: 0 if all cases pass, 1 on any failure.
 *
 * Companion to the other standalone smoke tests in this directory
 * (test-parser.js, validate-fixtures.js, etc.) — keeps the dev loop
 * zero-ceremony and dependency-free.
 */

import { createCachePlugin } from '../src/services/oauthCachePlugin.js';

// ----- Tiny test harness (no mocha, no jest, no node:test) ------------

const results = [];
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    results.push({ name, ok: false, err });
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertDeepEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${label}: expected ${b}, got ${a}`);
  }
}

// ----- Fake TokenCacheContext -----------------------------------------
//
// MSAL's real TokenCacheContext exposes:
//   - context.tokenCache.serialize(): string
//   - context.tokenCache.deserialize(json: string): void
//   - context.cacheHasChanged: boolean
//
// For the plugin's purposes that's all we need. The fake tracks the
// current in-memory blob and lets the test drive cacheHasChanged.

function makeFakeContext({ initialBlob = null, hasChanged = false } = {}) {
  let blob = initialBlob;
  let lastDeserialized = null;
  return {
    tokenCache: {
      serialize: () => blob,
      deserialize: (json) => {
        lastDeserialized = json;
        blob = json;
      },
    },
    get cacheHasChanged() {
      return hasChanged;
    },
    // test-only helpers
    _setBlob: (b) => {
      blob = b;
    },
    _setHasChanged: (v) => {
      hasChanged = v;
    },
    _getBlob: () => blob,
    _getLastDeserialized: () => lastDeserialized,
  };
}

// ----- In-memory store stand-in for CurveConfig -----------------------
//
// Keyed by userId. Each entry is the *plaintext* cache blob — the
// plugin's loadCache/saveCache overrides bypass encryption because
// encryption correctness is covered by crypto.js's own tests.

function makeStore(initial = {}) {
  const store = new Map(Object.entries(initial));
  const calls = { loads: 0, saves: 0 };
  return {
    store,
    calls,
    loadCache: async (uid) => {
      calls.loads += 1;
      return store.has(String(uid)) ? store.get(String(uid)) : null;
    },
    saveCache: async (uid, plaintext) => {
      calls.saves += 1;
      store.set(String(uid), plaintext);
    },
  };
}

// ----- Tests ----------------------------------------------------------

console.log('oauthCachePlugin smoke test\n');

await test('beforeCacheAccess: no cache yet → no-op', async () => {
  const { loadCache, saveCache, calls } = makeStore();
  const plugin = createCachePlugin('user-a', { loadCache, saveCache });
  const ctx = makeFakeContext();

  await plugin.beforeCacheAccess(ctx);

  assertEqual(calls.loads, 1, 'loads count');
  assertEqual(ctx._getLastDeserialized(), null, 'no deserialize call');
});

await test('beforeCacheAccess: cache present → deserializes plaintext', async () => {
  const blob = JSON.stringify({ accessTokens: { 'foo': { secret: 'abc' } } });
  const { loadCache, saveCache } = makeStore({ 'user-b': blob });
  const plugin = createCachePlugin('user-b', { loadCache, saveCache });
  const ctx = makeFakeContext();

  await plugin.beforeCacheAccess(ctx);

  assertEqual(ctx._getLastDeserialized(), blob, 'deserialized blob matches');
});

await test('afterCacheAccess: cacheHasChanged=false → no write', async () => {
  const { loadCache, saveCache, calls } = makeStore();
  const plugin = createCachePlugin('user-c', { loadCache, saveCache });
  const ctx = makeFakeContext({ hasChanged: false, initialBlob: 'whatever' });

  await plugin.afterCacheAccess(ctx);

  assertEqual(calls.saves, 0, 'saves count');
});

await test('afterCacheAccess: cacheHasChanged=true → writes serialized blob', async () => {
  const blob = JSON.stringify({ refreshTokens: { 'rt1': { secret: 'xyz' } } });
  const { loadCache, saveCache, store, calls } = makeStore();
  const plugin = createCachePlugin('user-d', { loadCache, saveCache });
  const ctx = makeFakeContext({ hasChanged: true, initialBlob: blob });

  await plugin.afterCacheAccess(ctx);

  assertEqual(calls.saves, 1, 'saves count');
  assertEqual(store.get('user-d'), blob, 'persisted blob matches');
});

await test('full cycle: write then read round-trips the same data', async () => {
  const written = JSON.stringify({
    account: { homeAccountId: 'uid.utid', username: 'user@outlook.com' },
    accessTokens: { a: 1 },
  });
  const { loadCache, saveCache } = makeStore();
  const plugin = createCachePlugin('user-e', { loadCache, saveCache });

  // 1) MSAL calls afterCacheAccess with a "changed" cache
  const writeCtx = makeFakeContext({ hasChanged: true, initialBlob: written });
  await plugin.afterCacheAccess(writeCtx);

  // 2) A subsequent sync calls beforeCacheAccess — MSAL should see the
  //    previously-written blob
  const readCtx = makeFakeContext();
  await plugin.beforeCacheAccess(readCtx);

  assertEqual(readCtx._getLastDeserialized(), written, 'round-tripped blob');
});

await test('corrupted cache: deserialize throws → onCorrupted called, no throw', async () => {
  const { loadCache, saveCache } = makeStore({ 'user-f': 'not-valid-json' });
  const corruption = [];
  const plugin = createCachePlugin('user-f', {
    loadCache,
    saveCache,
    onCorrupted: (uid, msg) => corruption.push({ uid, msg }),
  });

  // Custom context whose deserialize throws, to simulate MSAL rejecting
  // a garbled blob.
  const ctx = {
    tokenCache: {
      deserialize: () => {
        throw new Error('bad JSON');
      },
      serialize: () => '',
    },
    cacheHasChanged: false,
  };

  await plugin.beforeCacheAccess(ctx); // must not throw

  assertEqual(corruption.length, 1, 'onCorrupted called once');
  assertEqual(corruption[0].uid, 'user-f', 'corruption.uid');
  if (!corruption[0].msg.includes('deserialize failed')) {
    throw new Error(`expected "deserialize failed" in msg, got: ${corruption[0].msg}`);
  }
});

await test('loader failure: load throws → onCorrupted called, no throw', async () => {
  const corruption = [];
  const plugin = createCachePlugin('user-g', {
    loadCache: async () => {
      throw new Error('mongo down');
    },
    saveCache: async () => {},
    onCorrupted: (uid, msg) => corruption.push({ uid, msg }),
  });

  const ctx = makeFakeContext();
  await plugin.beforeCacheAccess(ctx);

  assertEqual(corruption.length, 1, 'onCorrupted called once');
  if (!corruption[0].msg.includes('load failed')) {
    throw new Error(`expected "load failed" in msg, got: ${corruption[0].msg}`);
  }
});

await test('isolation: two plugins for different users do not share state', async () => {
  const { loadCache, saveCache, store } = makeStore();
  const pluginA = createCachePlugin('user-h', { loadCache, saveCache });
  const pluginB = createCachePlugin('user-i', { loadCache, saveCache });

  const blobA = JSON.stringify({ who: 'A' });
  const blobB = JSON.stringify({ who: 'B' });

  await pluginA.afterCacheAccess(
    makeFakeContext({ hasChanged: true, initialBlob: blobA }),
  );
  await pluginB.afterCacheAccess(
    makeFakeContext({ hasChanged: true, initialBlob: blobB }),
  );

  assertDeepEqual(
    [store.get('user-h'), store.get('user-i')],
    [blobA, blobB],
    'each user has its own blob',
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
