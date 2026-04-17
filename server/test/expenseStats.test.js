/**
 * Unit tests for the dashboard KPI helpers. Covers the Embers savings
 * score formula and the cycle-aware aggregation used by GET /expenses
 * meta (ROADMAP Fase 2.5).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeSavingsScore,
  computeDashboardStats,
  parseExpenseDate,
} from '../src/services/expenseStats.js';

test('computeSavingsScore: savings == budget collapses to 10', () => {
  assert.equal(computeSavingsScore(73.75, 73.75), 10);
});

test('computeSavingsScore: savings > budget still clamps to 10 (defensive)', () => {
  assert.equal(computeSavingsScore(500, 73.75), 10);
});

test('computeSavingsScore: savings == 0 → 0', () => {
  assert.equal(computeSavingsScore(0, 73.75), 0);
});

test('computeSavingsScore: negative savings (overspent) → 0', () => {
  assert.equal(computeSavingsScore(-20, 73.75), 0);
});

test('computeSavingsScore: half the budget saved is NOT half the score (log)', () => {
  // log(37.75) / log(74.75) * 10 ≈ 8.4 — this is the point of the
  // log-based formula: small savings are disproportionately rewarded.
  const score = computeSavingsScore(73.75 / 2, 73.75);
  assert.ok(score > 8 && score < 9, `expected ~8.4, got ${score}`);
});

test('computeSavingsScore: zero budget returns 0 (defensive)', () => {
  assert.equal(computeSavingsScore(50, 0), 0);
});

test('parseExpenseDate: parses the canonical Curve format', () => {
  const d = parseExpenseDate('06 April 2026 08:53:31');
  assert.ok(d instanceof Date && !Number.isNaN(d.getTime()));
  assert.equal(d.getUTCFullYear(), 2026);
});

test('parseExpenseDate: returns null for garbage', () => {
  assert.equal(parseExpenseDate(''), null);
  assert.equal(parseExpenseDate(null), null);
  assert.equal(parseExpenseDate('not a date'), null);
  assert.equal(parseExpenseDate(42), null);
});

test('computeDashboardStats: aggregates cycle totals with cycleDay=22', async () => {
  // Anchor in mid-cycle so we have a clear inside/outside split.
  const now = new Date(Date.UTC(2026, 3, 17, 12, 0, 0)); // 17 Apr 2026
  const stats = await computeDashboardStats(
    { userId: 'u1' },
    {
      now,
      config: {
        sync_cycle_day: 22,
        weekly_budget: 73.75,
        emails_processed_total: 42,
        last_sync_at: new Date('2026-04-17T10:00:00Z'),
        last_sync_status: 'ok',
      },
      expenses: [
        { amount: 12.5, date: '25 March 2026 10:00:00' },   // inside cycle
        { amount: 7.8, date: '15 April 2026 08:00:00' },    // inside cycle + week
        { amount: 3.2, date: '12 April 2026 09:00:00' },    // inside cycle + week
        { amount: 99, date: '10 March 2026 09:00:00' },     // BEFORE cycle
        { amount: 50, date: 'not a real date' },            // skipped
      ],
    },
  );
  // Cycle: 22 Mar - 21 Apr. Inside: 12.5 + 7.8 + 3.2 = 23.5
  assert.equal(stats.month_total, 23.5);
  // Week: 10 Apr - 17 Apr. Inside: 7.8 + 3.2 = 11.0
  assert.equal(stats.weekly_expenses, 11);
  assert.equal(stats.weekly_savings, 73.75 - 11);
  assert.ok(stats.savings_score > 0 && stats.savings_score <= 10);
  assert.equal(stats.emails_processed, 42);
  assert.equal(stats.last_sync_at, '2026-04-17T10:00:00.000Z');
  assert.equal(stats.last_sync_status, 'ok');
  assert.equal(stats.cycle.start, '2026-03-22');
  assert.equal(stats.cycle.end, '2026-04-21');
  assert.equal(stats.cycle.day, 22);
});

test('computeDashboardStats: respects cycleDay=1 (calendar month)', async () => {
  const now = new Date(Date.UTC(2026, 3, 17, 12, 0, 0));
  const stats = await computeDashboardStats(
    { userId: 'u1' },
    {
      now,
      config: { sync_cycle_day: 1, weekly_budget: 100 },
      expenses: [
        { amount: 10, date: '05 April 2026 10:00:00' },   // inside
        { amount: 20, date: '25 March 2026 10:00:00' },   // outside
      ],
    },
  );
  assert.equal(stats.month_total, 10);
  assert.equal(stats.cycle.start, '2026-04-01');
  assert.equal(stats.cycle.end, '2026-04-30');
  assert.equal(stats.cycle.day, 1);
});

test('computeDashboardStats: no config falls back to defaults (day 22, budget 73.75)', async () => {
  const stats = await computeDashboardStats(
    { userId: 'u1' },
    { now: new Date('2026-04-17'), config: null, expenses: [] },
  );
  assert.equal(stats.cycle.day, 22);
  assert.equal(stats.weekly_budget, 73.75);
  assert.equal(stats.emails_processed, 0);
  assert.equal(stats.last_sync_at, null);
  assert.equal(stats.savings_score, 10); // no spending → maxed score
});

test('computeDashboardStats: custom weekly_budget feeds savings_score', async () => {
  const stats = await computeDashboardStats(
    { userId: 'u1' },
    {
      now: new Date('2026-04-17'),
      config: { sync_cycle_day: 22, weekly_budget: 200 },
      expenses: [{ amount: 50, date: '15 April 2026 10:00:00' }],
    },
  );
  assert.equal(stats.weekly_expenses, 50);
  assert.equal(stats.weekly_savings, 150);
  assert.equal(stats.weekly_budget, 200);
});

test('computeDashboardStats: string amounts are coerced, non-finite dropped', async () => {
  const stats = await computeDashboardStats(
    { userId: 'u1' },
    {
      now: new Date(Date.UTC(2026, 3, 17, 12, 0, 0)),
      config: { sync_cycle_day: 22, weekly_budget: 73.75 },
      expenses: [
        { amount: '7.50', date: '15 April 2026 10:00:00' },
        { amount: 'not a number', date: '15 April 2026 10:00:00' },
        { amount: Infinity, date: '15 April 2026 10:00:00' },
      ],
    },
  );
  assert.equal(stats.month_total, 7.5);
});
