/**
 * Cycle-scoped SINCE for the IMAP reader. Every sync run — first or
 * otherwise — anchors to the start of the user's current custom cycle.
 * The historical `imap_since` override was removed; this test file
 * now guards the narrower invariant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultSince } from '../src/services/imapReader.js';
import { cycleBoundsFor } from '../src/services/cycle.js';

test('with sync_cycle_day: returns the start of the current cycle', () => {
  const got = defaultSince({ sync_cycle_day: 22 });
  const expected = cycleBoundsFor(new Date(), 22).start;
  assert.equal(got.getTime(), expected.getTime());
});

test('with sync_cycle_day=1: cycle starts on the 1st of this month', () => {
  const got = defaultSince({ sync_cycle_day: 1 });
  const expected = cycleBoundsFor(new Date(), 1).start;
  assert.equal(got.getUTCDate(), 1);
  assert.equal(got.getTime(), expected.getTime());
});

test('without config: 31d fallback (defensive — should not trigger in prod)', () => {
  // The Mongoose default for sync_cycle_day is 22, so reaching this
  // branch means the caller forgot to pass a config. Kept as a safety
  // net rather than a supported path.
  const got = defaultSince();
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
  const thirtyTwoDaysAgo = now - 32 * 24 * 60 * 60 * 1000;
  assert.ok(got.getTime() <= thirtyDaysAgo, `got ${got.toISOString()}`);
  assert.ok(got.getTime() >= thirtyTwoDaysAgo, `got ${got.toISOString()}`);
});

test('config without sync_cycle_day: 31d defensive fallback', () => {
  const got = defaultSince({ imap_username: 'x', sync_cycle_day: null });
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  assert.ok(got.getTime() <= thirtyDaysAgo);
});

test('invalid sync_cycle_day (99) is normalised to 22', () => {
  const got = defaultSince({ sync_cycle_day: 99 });
  const expected = cycleBoundsFor(new Date(), 22).start;
  assert.equal(got.getTime(), expected.getTime());
});
