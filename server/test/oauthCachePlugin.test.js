/**
 * Cross-user isolation tests for the OAuth token cache plugin.
 *
 * MVP OAuth criterion §8.7: "Segundo user (conta diferente) faz o
 * mesmo percurso sem colisões de cache". These tests lock down the
 * factory-per-user contract (see oauthCachePlugin.js §1 "Factory-per-
 * user, never a singleton") and guarantee that no code path can leak
 * one user's token into another user's MSAL cache.
 *
 * The `loadCache` / `saveCache` overrides let us drive the plugin
 * without touching Mongo — the test doubles record every userId they
 * see so we can assert isolation directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCachePlugin } from '../src/services/oauthCachePlugin.js';

function makeStore() {
  const reads = [];
  const writes = [];
  const cache = new Map(); // keyed by userId
  return {
    reads,
    writes,
    loadCache: async (userId) => {
      reads.push(String(userId));
      return cache.get(String(userId)) ?? null;
    },
    saveCache: async (userId, plaintext) => {
      writes.push({ userId: String(userId), plaintext });
      cache.set(String(userId), plaintext);
    },
    peek: (userId) => cache.get(String(userId)) ?? null,
  };
}

function fakeTokenCacheContext({ initial = null, serialized = null } = {}) {
  let stored = initial;
  let changed = false;
  return {
    get cacheHasChanged() {
      return changed;
    },
    set cacheHasChanged(v) {
      changed = v;
    },
    tokenCache: {
      deserialize: (payload) => {
        stored = payload;
      },
      serialize: () => serialized ?? stored ?? '',
      _peek: () => stored,
    },
  };
}

test('user A save does NOT surface in user B load (isolation)', async () => {
  const store = makeStore();
  const pluginA = createCachePlugin('user-A', {
    loadCache: store.loadCache,
    saveCache: store.saveCache,
  });
  const pluginB = createCachePlugin('user-B', {
    loadCache: store.loadCache,
    saveCache: store.saveCache,
  });

  // User A writes a token through MSAL's afterCacheAccess path.
  const ctxA = fakeTokenCacheContext({ serialized: '{"A":"token"}' });
  ctxA.cacheHasChanged = true;
  await pluginA.afterCacheAccess(ctxA);

  // User B loads — MUST see nothing.
  const ctxB = fakeTokenCacheContext();
  await pluginB.beforeCacheAccess(ctxB);

  assert.equal(ctxB.tokenCache._peek(), null);
  assert.equal(store.peek('user-A'), '{"A":"token"}');
  assert.equal(store.peek('user-B'), null);
  // Only user B's loader was called during that beforeCacheAccess.
  assert.deepEqual(store.reads, ['user-B']);
});

test('each createCachePlugin call binds its own userId closure', async () => {
  // Regression guard: if someone ever refactors createCachePlugin into
  // a singleton lookup by homeAccountId, this test must fail. The
  // signature contract in oauthCachePlugin.js §1 forbids it explicitly.
  const store = makeStore();
  const pluginA = createCachePlugin('user-A', {
    loadCache: store.loadCache,
    saveCache: store.saveCache,
  });
  const pluginB = createCachePlugin('user-B', {
    loadCache: store.loadCache,
    saveCache: store.saveCache,
  });

  const ctxA = fakeTokenCacheContext({ serialized: 'A-payload' });
  const ctxB = fakeTokenCacheContext({ serialized: 'B-payload' });
  ctxA.cacheHasChanged = true;
  ctxB.cacheHasChanged = true;

  await pluginA.afterCacheAccess(ctxA);
  await pluginB.afterCacheAccess(ctxB);

  assert.deepEqual(
    store.writes.map((w) => w.userId),
    ['user-A', 'user-B'],
  );
  assert.equal(store.peek('user-A'), 'A-payload');
  assert.equal(store.peek('user-B'), 'B-payload');
});

test('corrupt cache for user A does NOT poison user B', async () => {
  // If user A's blob fails to decrypt/deserialize, the plugin warns
  // and treats it as empty. User B, loaded in the same process a
  // millisecond later, must be unaffected.
  const store = makeStore();
  const corruptions = [];
  const pluginA = createCachePlugin('user-A', {
    loadCache: async () => 'not valid msal json',
    saveCache: store.saveCache,
    onCorrupted: (uid, msg) => corruptions.push({ uid, msg }),
  });
  const pluginB = createCachePlugin('user-B', {
    loadCache: store.loadCache,
    saveCache: store.saveCache,
    onCorrupted: (uid, msg) => corruptions.push({ uid, msg }),
  });

  // User A lands on corrupt JSON. Simulate deserialize throw.
  const ctxA = fakeTokenCacheContext();
  ctxA.tokenCache.deserialize = () => {
    throw new Error('invalid JSON');
  };
  await pluginA.beforeCacheAccess(ctxA);

  // User B loads fresh.
  const ctxB = fakeTokenCacheContext();
  await pluginB.beforeCacheAccess(ctxB);

  assert.equal(corruptions.length, 1);
  assert.equal(corruptions[0].uid, 'user-A');
  assert.equal(ctxB.tokenCache._peek(), null);
});

test('afterCacheAccess with cacheHasChanged=false does not call saveCache', async () => {
  // Avoids needless writes (and — more importantly — avoids stamping
  // an empty serialisation over a healthy stored cache on a read-only
  // acquireTokenSilent call).
  const store = makeStore();
  const plugin = createCachePlugin('user-A', {
    loadCache: store.loadCache,
    saveCache: store.saveCache,
  });

  const ctx = fakeTokenCacheContext({ serialized: 'new' });
  ctx.cacheHasChanged = false;
  await plugin.afterCacheAccess(ctx);

  assert.equal(store.writes.length, 0);
});

test('loadCache throwing does NOT crash the plugin (MSAL sees empty cache)', async () => {
  const warnings = [];
  const plugin = createCachePlugin('user-A', {
    loadCache: async () => {
      throw new Error('mongo down');
    },
    saveCache: async () => {},
    onCorrupted: (uid, msg) => warnings.push(msg),
  });

  const ctx = fakeTokenCacheContext();
  await plugin.beforeCacheAccess(ctx);

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /load failed/);
  assert.equal(ctx.tokenCache._peek(), null);
});
