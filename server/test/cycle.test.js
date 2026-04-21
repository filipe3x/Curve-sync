/**
 * Unit tests for `services/cycle.js`. Locks down the day-22 default
 * (to protect existing callers) AND the configurable-cycleDay path
 * that backs Fase 2.1 of the ROADMAP.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cycleBoundsFor,
  formatISODate,
  normaliseCycleDay,
} from '../src/services/cycle.js';

// Convenience: build a mid-day UTC anchor for a specific calendar day.
function utc(y, m, d) {
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

test('default cycleDay=22: anchor on the 25th lands in current cycle (current→next 21)', () => {
  const { start, end } = cycleBoundsFor(utc(2026, 1, 25));
  assert.equal(formatISODate(start), '2026-01-22');
  assert.equal(formatISODate(end), '2026-02-21');
});

test('default cycleDay=22: anchor on the 15th lands in previous-month cycle', () => {
  const { start, end } = cycleBoundsFor(utc(2026, 1, 15));
  assert.equal(formatISODate(start), '2025-12-22');
  assert.equal(formatISODate(end), '2026-01-21');
});

test('default cycleDay=22: anchor exactly on the 22nd is inclusive (start = today)', () => {
  const { start, end } = cycleBoundsFor(utc(2026, 3, 22));
  assert.equal(formatISODate(start), '2026-03-22');
  assert.equal(formatISODate(end), '2026-04-21');
});

test('cycleDay=1: anchor mid-month lands in the calendar-month cycle', () => {
  const { start, end } = cycleBoundsFor(utc(2026, 4, 17), 1);
  assert.equal(formatISODate(start), '2026-04-01');
  assert.equal(formatISODate(end), '2026-04-30');
});

test('cycleDay=1: Feb cycle correctly ends on Feb 28 (non-leap)', () => {
  const { end } = cycleBoundsFor(utc(2026, 2, 10), 1);
  assert.equal(formatISODate(end), '2026-02-28');
});

test('cycleDay=1: Feb cycle in a leap year ends on Feb 29', () => {
  const { end } = cycleBoundsFor(utc(2028, 2, 10), 1);
  assert.equal(formatISODate(end), '2028-02-29');
});

test('cycleDay=28: anchor on the 27th lands in previous cycle', () => {
  const { start, end } = cycleBoundsFor(utc(2026, 5, 27), 28);
  assert.equal(formatISODate(start), '2026-04-28');
  assert.equal(formatISODate(end), '2026-05-27');
});

test('cycleDay=28: anchor on the 28th is inclusive of today', () => {
  const { start } = cycleBoundsFor(utc(2026, 5, 28), 28);
  assert.equal(formatISODate(start), '2026-05-28');
});

test('year boundary: cycleDay=22 anchor Jan 10 lands in Dec cycle of previous year', () => {
  const { start, end } = cycleBoundsFor(utc(2027, 1, 10), 22);
  assert.equal(formatISODate(start), '2026-12-22');
  assert.equal(formatISODate(end), '2027-01-21');
});

test('end is inclusive at 23:59:59.999 UTC', () => {
  const { end } = cycleBoundsFor(utc(2026, 4, 17));
  assert.equal(end.getUTCHours(), 23);
  assert.equal(end.getUTCMinutes(), 59);
  assert.equal(end.getUTCSeconds(), 59);
  assert.equal(end.getUTCMilliseconds(), 999);
});

test('start is inclusive at 00:00:00.000 UTC', () => {
  const { start } = cycleBoundsFor(utc(2026, 4, 17));
  assert.equal(start.getUTCHours(), 0);
  assert.equal(start.getUTCMinutes(), 0);
  assert.equal(start.getUTCSeconds(), 0);
  assert.equal(start.getUTCMilliseconds(), 0);
});

test('normaliseCycleDay: valid integers pass through', () => {
  assert.equal(normaliseCycleDay(1), 1);
  assert.equal(normaliseCycleDay(22), 22);
  assert.equal(normaliseCycleDay(28), 28);
});

test('normaliseCycleDay: out-of-range, NaN, null, undefined fall back to 22', () => {
  assert.equal(normaliseCycleDay(0), 22);
  assert.equal(normaliseCycleDay(29), 22);
  assert.equal(normaliseCycleDay(31), 22);
  assert.equal(normaliseCycleDay(-5), 22);
  assert.equal(normaliseCycleDay(NaN), 22);
  assert.equal(normaliseCycleDay(null), 22);
  assert.equal(normaliseCycleDay(undefined), 22);
  assert.equal(normaliseCycleDay('abc'), 22);
});

test('normaliseCycleDay: floats are floored', () => {
  assert.equal(normaliseCycleDay(22.9), 22);
  assert.equal(normaliseCycleDay(1.1), 1);
});

test('cycleBoundsFor treats invalid cycleDay as 22', () => {
  const { start } = cycleBoundsFor(utc(2026, 4, 25), 99);
  assert.equal(formatISODate(start), '2026-04-22');
});
