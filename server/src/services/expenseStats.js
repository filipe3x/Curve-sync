/**
 * Dashboard KPI helpers.
 *
 * Lives next to `categoryResolver.js` and `expense.js` so the three
 * dashboard-adjacent services sit together — anyone touching the
 * savings-score formula or the cycle-bound totals lands here first.
 *
 * Design choices:
 *
 *   - `Expense.date` is a free-form string ("06 April 2026 08:53:31")
 *     for bit-for-bit compat with curve.py (see CLAUDE.md → Deliberately
 *     deferred). We parse it with `Date.parse` — V8 handles the format
 *     natively. Rows that fail to parse are silently skipped, matching
 *     the `/api/categories/stats` contract.
 *
 *   - Totals are aggregated in JS on a lean user-scoped find() rather
 *     than via an aggregation pipeline. The volume ceiling is ~one user's
 *     monthly card receipts (low hundreds), so the saving from pushing
 *     into Mongo is immaterial and the JS path is easier to unit test.
 *
 *   - Savings score uses the canonical Embers formula (see ROADMAP Fase
 *     2.3 / CLAUDE.md → Savings Score):
 *         score = (log(weekly_savings + 1) / log(budget + 1)) * 10
 *     Clamped to [0, 10]. `weekly_savings <= 0` collapses to 0 (you
 *     overspent); `weekly_savings >= budget` collapses to 10.
 */

import Expense from '../models/Expense.js';
import CurveConfig from '../models/CurveConfig.js';
import CurveExpenseExclusion from '../models/CurveExpenseExclusion.js';
import { cycleBoundsFor, normaliseCycleDay } from './cycle.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Parse the free-form `Expense.date` string into a Date, or null if it
 * doesn't look like a recognisable timestamp. Mirrors the helper in
 * `routes/categories.js` — re-exported here so anyone computing totals
 * from `Expense.date` can share one parser.
 */
export function parseExpenseDate(str) {
  if (!str || typeof str !== 'string') return null;
  const t = Date.parse(str);
  if (Number.isNaN(t)) return null;
  return new Date(t);
}

/**
 * Compute the Embers Savings Score from a `weekly_savings` value and a
 * per-user `weekly_budget`. Pure function — no IO. Clamped to [0, 10]
 * and rounded to one decimal place.
 *
 * ## What the score measures
 *
 * How much the user has saved this week **relative to their budget**.
 * Higher is better: 0 = the budget is blown, 10 = nothing was spent.
 *
 * ## Inputs, intuitively
 *
 *     weekly_budget   = EUR they've decided is fair to spend per week
 *                       (default €73,75 = €295 / 4 weeks).
 *     weekly_expenses = EUR actually spent in the last rolling 7 days.
 *     weekly_savings  = weekly_budget - weekly_expenses.
 *                       Can be negative (overspent) — the score
 *                       collapses to 0 in that case.
 *
 * ## Formula (Embers canonical, see docs/expense-tracking.md)
 *
 *     score = (log(weekly_savings + 1) / log(weekly_budget + 1)) * 10
 *
 * The `+ 1` shift prevents `log(0) = -Infinity` when the user saved
 * exactly zero and keeps the score continuous around that boundary.
 *
 * The scale is **logarithmic on purpose**: psychologically, someone
 * who spent €60 out of €74 is already close to blowing the budget and
 * shouldn't walk away with 80 % of the max score. Log curve rewards
 * early savings steeply and plateaus near the ceiling.
 *
 * ## Worked examples (budget €73,75)
 *
 *     spent      saved       score   notes
 *     ─────      ─────       ─────   ─────
 *     €73,75     €0,00       0,0     budget fully consumed
 *     €60,00     €13,75      6,1
 *     €50,00     €23,75      7,3
 *     €42,11     €31,64      8,1     ← the dashboard "example" case
 *     €20,00     €53,75      9,3
 *     €0,00      €73,75      10,0    saved everything → clamped top
 *     €90,00     −€16,25     0,0     overspent → collapsed to 0
 *
 * ## Relationship to the dashboard sub-label
 *
 * The `/` card on `DashboardPage` renders the sub-label as
 * `{weekly_savings} / {weekly_budget}` — i.e. **what you kept** over
 * **the ceiling you set**. Not to be confused with expenses-vs-budget:
 * a user who spent €42,11 of €73,75 sees `€31,64 / €73,75` (kept 31,
 * could have kept up to 74).
 *
 * @param {number} weeklySavings EUR saved this week (may be negative).
 * @param {number} weeklyBudget  EUR ceiling (must be > 0).
 * @returns {number} 0–10 score, rounded to 1dp. Negative savings and
 *                   non-finite inputs collapse to 0.
 */
export function computeSavingsScore(weeklySavings, weeklyBudget) {
  if (!Number.isFinite(weeklyBudget) || weeklyBudget <= 0) return 0;
  if (!Number.isFinite(weeklySavings) || weeklySavings <= 0) return 0;
  const raw = (Math.log(weeklySavings + 1) / Math.log(weeklyBudget + 1)) * 10;
  const clamped = Math.max(0, Math.min(10, raw));
  return Math.round(clamped * 10) / 10;
}

/**
 * Compute dashboard KPIs for a single user.
 *
 * Aggregates in a single pass over the user's expenses so the rolling
 * 7-day window and the current-cycle window share one scan. Returns a
 * plain object safe to inline into the `meta` field of a paginated
 * response — never throws, unfindable rows short-circuit to zeros.
 *
 * @param {object} args
 * @param {import('mongoose').Types.ObjectId|string} args.userId
 * @param {object} [overrides] Test-only: `{ config, expenses,
 *   exclusions, now }` bypasses the mongoose lookups so unit tests
 *   stay hermetic. `exclusions` is an array of `{ expense_id }` rows.
 * @returns {Promise<{
 *   month_total: number,
 *   weekly_expenses: number,
 *   weekly_savings: number,
 *   weekly_budget: number,
 *   savings_score: number,
 *   emails_processed: number,
 *   last_sync_at: string|null,
 *   last_sync_status: string|null,
 *   cycle: { start: string, end: string, day: number },
 * }>}
 */
export async function computeDashboardStats({ userId }, overrides = {}) {
  const now = overrides.now ? new Date(overrides.now) : new Date();

  const config =
    overrides.config !== undefined
      ? overrides.config
      : await CurveConfig.findOne(
          { user_id: userId },
          {
            sync_cycle_day: 1,
            weekly_budget: 1,
            emails_processed_total: 1,
            last_sync_at: 1,
            last_sync_status: 1,
          },
        ).lean();

  const cycleDay = normaliseCycleDay(config?.sync_cycle_day);
  const weeklyBudget = Number.isFinite(Number(config?.weekly_budget))
    ? Number(config.weekly_budget)
    : 73.75;

  const { start: cycleStart, end: cycleEnd } = cycleBoundsFor(now, cycleDay);
  const weekStart = new Date(now.getTime() - WEEK_MS);

  // Expenses selected with `_id` so the excluded-set lookup below can
  // skip them. The extra bytes are tiny compared to the wire cost of
  // the full document — amount + date + _id is still a few dozen
  // bytes per row.
  const rows =
    overrides.expenses !== undefined
      ? overrides.expenses
      : await Expense.find({ user_id: userId })
          .select('_id amount date')
          .lean();

  // Exclusions loaded in parallel-enough fashion (consecutive awaits
  // are fine at this volume — each finds is a few dozen ObjectIds).
  // ROADMAP §2.10: excluded rows drop out of BOTH `month_total` and
  // `weekly_expenses`, so they can't inflate spending or depress the
  // Savings Score.
  const exclusions =
    overrides.exclusions !== undefined
      ? overrides.exclusions
      : await CurveExpenseExclusion.find({ user_id: userId })
          .select('expense_id')
          .lean();
  const excludedIds = new Set(
    exclusions.map((e) => e.expense_id?.toString()).filter(Boolean),
  );

  let monthTotal = 0;
  let weeklyExpenses = 0;
  for (const r of rows) {
    if (r._id && excludedIds.has(r._id.toString())) continue;
    const when = parseExpenseDate(r.date);
    if (!when) continue;
    const amount = typeof r.amount === 'number' ? r.amount : Number(r.amount);
    if (!Number.isFinite(amount)) continue;
    if (when >= cycleStart && when <= cycleEnd) monthTotal += amount;
    if (when >= weekStart && when <= now) weeklyExpenses += amount;
  }

  const weeklySavings = weeklyBudget - weeklyExpenses;
  const savingsScore = computeSavingsScore(weeklySavings, weeklyBudget);

  return {
    month_total: Math.round(monthTotal * 100) / 100,
    weekly_expenses: Math.round(weeklyExpenses * 100) / 100,
    weekly_savings: Math.round(weeklySavings * 100) / 100,
    weekly_budget: Math.round(weeklyBudget * 100) / 100,
    savings_score: savingsScore,
    emails_processed: Number(config?.emails_processed_total ?? 0),
    last_sync_at: config?.last_sync_at ? config.last_sync_at.toISOString() : null,
    last_sync_status: config?.last_sync_status ?? null,
    cycle: {
      start: cycleStart.toISOString().slice(0, 10),
      end: cycleEnd.toISOString().slice(0, 10),
      day: cycleDay,
    },
  };
}
