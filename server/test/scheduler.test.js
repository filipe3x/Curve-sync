/**
 * Unit tests for `services/scheduler.js :: shouldRunAtTick`.
 *
 * The scheduler cron fires every 5 min, so the gate only ever sees
 * tickMinute ∈ {0, 5, 10, ..., 55}. These tests walk the 4 UI options
 * (5 / 15 / 30 / 60) through every possible tick and assert the exact
 * firing pattern.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldRunAtTick } from '../src/services/scheduler.js';

const TICKS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

test('5-minute interval fires on every tick', () => {
  const config = { sync_interval_minutes: 5 };
  for (const m of TICKS) {
    assert.equal(shouldRunAtTick(config, m), true, `minute=${m}`);
  }
});

test('15-minute interval fires only at :00/:15/:30/:45', () => {
  const config = { sync_interval_minutes: 15 };
  const firing = TICKS.filter((m) => shouldRunAtTick(config, m));
  assert.deepEqual(firing, [0, 15, 30, 45]);
});

test('30-minute interval fires only at :00/:30', () => {
  const config = { sync_interval_minutes: 30 };
  const firing = TICKS.filter((m) => shouldRunAtTick(config, m));
  assert.deepEqual(firing, [0, 30]);
});

test('60-minute interval fires only at :00', () => {
  const config = { sync_interval_minutes: 60 };
  const firing = TICKS.filter((m) => shouldRunAtTick(config, m));
  assert.deepEqual(firing, [0]);
});

test('missing sync_interval_minutes defaults to 5 (every tick)', () => {
  const firing = TICKS.filter((m) => shouldRunAtTick({}, m));
  assert.deepEqual(firing, TICKS);
});

test('null/undefined config is treated as the 5-min default', () => {
  assert.equal(shouldRunAtTick(null, 0), true);
  assert.equal(shouldRunAtTick(undefined, 15), true);
});

test('zero or negative interval never fires (defensive)', () => {
  assert.equal(shouldRunAtTick({ sync_interval_minutes: 0 }, 0), false);
  assert.equal(shouldRunAtTick({ sync_interval_minutes: -5 }, 0), false);
});

test('non-numeric interval falls back to 5 (every tick)', () => {
  const firing = TICKS.filter((m) =>
    shouldRunAtTick({ sync_interval_minutes: 'bogus' }, m),
  );
  assert.deepEqual(firing, TICKS);
});
