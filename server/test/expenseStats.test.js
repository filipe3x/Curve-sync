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
  computeCycleHistory,
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
      exclusions: [],
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
      exclusions: [],
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
    {
      now: new Date('2026-04-17'),
      config: null,
      expenses: [],
      exclusions: [],
    },
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
      exclusions: [],
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
      exclusions: [],
    },
  );
  assert.equal(stats.month_total, 7.5);
});

// ─── computeCycleHistory (ROADMAP §2.8) ──────────────────────────

test('computeCycleHistory: buckets expenses into 12 cycles with correct deltas', async () => {
  const now = new Date(Date.UTC(2026, 3, 17, 12, 0, 0)); // mid-Apr cycle
  const history = await computeCycleHistory(
    { userId: 'u1', cycles: 12 },
    {
      now,
      config: { sync_cycle_day: 22, weekly_budget: 73.75 },
      expenses: [
        // Cycle 22 Mar – 21 Apr (current, in_progress)
        { _id: 'e1', amount: 40, date: '15 April 2026 10:00:00', entity: 'Continente' },
        { _id: 'e2', amount: 10, date: '25 March 2026 10:00:00', entity: 'Lidl' },
        // Cycle 22 Feb – 21 Mar (previous, completed)
        { _id: 'e3', amount: 100, date: '10 March 2026 10:00:00', entity: 'Continente' },
      ],
      exclusions: [],
      categories: [],
    },
  );

  assert.equal(history.cycles.length, 12);
  const last = history.cycles[history.cycles.length - 1];
  const prev = history.cycles[history.cycles.length - 2];
  assert.equal(last.cycle_start, '2026-03-22');
  assert.equal(last.cycle_end, '2026-04-21');
  assert.equal(last.total, 50);
  assert.equal(last.expense_count, 2);
  assert.equal(last.in_progress, true);
  assert.equal(prev.cycle_start, '2026-02-22');
  assert.equal(prev.total, 100);
  assert.equal(last.delta_absolute, -50); // 50 - 100
  assert.equal(last.delta_pct, -50);
  assert.equal(history.cycle_day, 22);
});

test('computeCycleHistory: caps count to [1, 36] and trims oldest end', async () => {
  const now = new Date(Date.UTC(2026, 3, 17, 12, 0, 0));
  const short = await computeCycleHistory(
    { userId: 'u1', cycles: 0 },
    { now, config: { sync_cycle_day: 22 }, expenses: [], exclusions: [], categories: [] },
  );
  assert.equal(short.cycles.length, 12); // 0 coerces to default 12

  const way = await computeCycleHistory(
    { userId: 'u1', cycles: 9999 },
    { now, config: { sync_cycle_day: 22 }, expenses: [], exclusions: [], categories: [] },
  );
  assert.equal(way.cycles.length, 36);
});

test('computeCycleHistory: excluded expenses drop from total + top_entity', async () => {
  const now = new Date(Date.UTC(2026, 3, 17, 12, 0, 0));
  const history = await computeCycleHistory(
    { userId: 'u1', cycles: 3 },
    {
      now,
      config: { sync_cycle_day: 22, weekly_budget: 73.75 },
      expenses: [
        { _id: 'e1', amount: 50, date: '15 April 2026 10:00:00', entity: 'Refund' },
        { _id: 'e2', amount: 10, date: '15 April 2026 11:00:00', entity: 'Lidl' },
      ],
      exclusions: [{ expense_id: 'e1' }],
      categories: [],
    },
  );
  const current = history.cycles[history.cycles.length - 1];
  assert.equal(current.total, 10);
  assert.equal(current.expense_count, 1);
  assert.equal(current.top_entity?.name, 'Lidl');
});

test('computeCycleHistory: moving_avg_3 starts at index 2', async () => {
  const now = new Date(Date.UTC(2026, 3, 17, 12, 0, 0));
  const history = await computeCycleHistory(
    { userId: 'u1', cycles: 5 },
    {
      now,
      config: { sync_cycle_day: 22, weekly_budget: 73.75 },
      // cycleDay=22: walking back 5 cycles from 17 Apr covers Nov 22 –
      // Dec 21, Dec 22 – Jan 21, Jan 22 – Feb 21, Feb 22 – Mar 21,
      // Mar 22 – Apr 21 (in_progress). One €100 per cycle keeps the
      // rolling mean flat at 100 from idx 2 onwards.
      expenses: [
        { _id: 'a', amount: 100, date: '25 November 2025 10:00:00' },
        { _id: 'b', amount: 100, date: '25 December 2025 10:00:00' },
        { _id: 'c', amount: 100, date: '25 January 2026 10:00:00' },
        { _id: 'd', amount: 100, date: '25 February 2026 10:00:00' },
        { _id: 'e', amount: 100, date: '15 April 2026 10:00:00' },
      ],
      exclusions: [],
      categories: [],
    },
  );
  assert.equal(history.cycles[0].moving_avg_3, null);
  assert.equal(history.cycles[1].moving_avg_3, null);
  // First bucket with a moving avg is index 2; all totals are 100 so mean is 100.
  assert.equal(history.cycles[2].moving_avg_3, 100);
});

test('computeCycleHistory: empty data returns zeroed cycles and null trend', async () => {
  const now = new Date(Date.UTC(2026, 3, 17, 12, 0, 0));
  const history = await computeCycleHistory(
    { userId: 'u1', cycles: 6 },
    {
      now,
      config: { sync_cycle_day: 22, weekly_budget: 73.75 },
      expenses: [],
      exclusions: [],
      categories: [],
    },
  );
  assert.equal(history.cycles.length, 6);
  for (const c of history.cycles) {
    assert.equal(c.total, 0);
    assert.equal(c.expense_count, 0);
    assert.equal(c.top_entity, null);
    assert.equal(c.top_category, null);
  }
  assert.equal(history.average, 0);
  assert.equal(history.trend, null);
});

test('computeCycleHistory: trend reports "down" when last 3 completed cycles drop', async () => {
  const now = new Date(Date.UTC(2026, 3, 17, 12, 0, 0));
  const history = await computeCycleHistory(
    { userId: 'u1', cycles: 6 },
    {
      now,
      config: { sync_cycle_day: 22, weekly_budget: 73.75 },
      expenses: [
        // Apr (in_progress) — should be skipped by the trend
        { _id: 'a', amount: 10, date: '10 April 2026 10:00:00' },
        // Mar cycle (Feb 22 – Mar 21): 300
        { _id: 'b', amount: 300, date: '10 March 2026 10:00:00' },
        // Feb cycle (Jan 22 – Feb 21): 500
        { _id: 'c', amount: 500, date: '10 February 2026 10:00:00' },
        // Jan cycle (Dec 22 – Jan 21): 700
        { _id: 'd', amount: 700, date: '10 January 2026 10:00:00' },
      ],
      exclusions: [],
      categories: [],
    },
  );
  assert.equal(history.trend?.direction, 'down');
  // Average over 5 completed cycles (Dec, Jan, Feb, Mar + 1 empty).
  // Actually we have 6 cycles total, 1 in_progress, so 5 completed.
  // Totals: 700, 500, 300, 0, 0 → avg 300.
  assert.equal(history.average, 300);
});

test('computeCycleHistory: top_category resolves via categories override', async () => {
  const now = new Date(Date.UTC(2026, 3, 17, 12, 0, 0));
  const history = await computeCycleHistory(
    { userId: 'u1', cycles: 2 },
    {
      now,
      config: { sync_cycle_day: 22, weekly_budget: 73.75 },
      expenses: [
        {
          _id: 'a',
          amount: 40,
          date: '10 April 2026 10:00:00',
          entity: 'Continente',
          category_id: { toString: () => 'cat1' },
        },
        {
          _id: 'b',
          amount: 10,
          date: '10 April 2026 11:00:00',
          entity: 'Lidl',
          category_id: { toString: () => 'cat2' },
        },
      ],
      exclusions: [],
      categories: [
        { _id: { toString: () => 'cat1' }, name: 'Supermercado' },
        { _id: { toString: () => 'cat2' }, name: 'Outros' },
      ],
    },
  );
  const current = history.cycles[history.cycles.length - 1];
  assert.equal(current.top_category?.name, 'Supermercado');
  assert.equal(current.top_category?.pct, 80); // 40/50
});
