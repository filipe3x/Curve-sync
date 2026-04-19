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
import Category from '../models/Category.js';
import CurveConfig from '../models/CurveConfig.js';
import CurveExpenseExclusion from '../models/CurveExpenseExclusion.js';
import { cycleBoundsFor, formatISODate, normaliseCycleDay } from './cycle.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Default window size for the dashboard cycle-trend chart (ROADMAP §2.8).
// The frontend toggles between 6 / 12 / 24; the backend always returns
// up to MAX so the client can slice locally without a round-trip.
const DEFAULT_CYCLE_HISTORY_COUNT = 12;
const MAX_CYCLE_HISTORY_COUNT = 36;
// Conversion from the per-user weekly budget to the monthly-equivalent
// value drawn as a horizontal reference line on the cycle-trend chart.
//
//   monthly_budget = weekly_budget * (30.4375 / 7)
//                  ≈ weekly_budget * 4.348
//
// With the default weekly_budget = €73.75 the line lands at **€321**.
// See `docs/expense-tracking.md` → "Linha de orçamento no gráfico
// «Evolução por ciclo»" for the full rationale — TL;DR: using × 4
// (the naive "4 weeks = 1 month") lands the line at €295, which reads
// as overspend in every 30-31 day cycle even when the user is exactly
// on budget. A Gregorian month averages 365.25 / 12 = 30.4375 days,
// i.e. 4.348 weeks, which matches real cycle length.
//
// Kept as a constant (not per-cycle) on purpose: a horizontal line is
// easier to read as a reference than a stepped line that jumps by
// ± 3 % every February. If that trade-off ever flips, swap the
// ReferenceLine on the frontend for a Line fed with `cycle_days`.
const WEEKS_PER_MONTH = 30.4375 / 7;

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

/**
 * Compute the per-cycle spending history used by the dashboard trend
 * chart (ROADMAP §2.8). Walks back `cycles` windows from the current
 * one, bucketing expenses by the user's `sync_cycle_day`, and enriches
 * each bucket with the delta vs. the previous cycle, a trailing 3-cycle
 * moving average, the top entity/category of that cycle, and an
 * `in_progress` flag for the cycle that still contains `now`.
 *
 * Exclusions (`curve_expense_exclusions`) are filtered out exactly as
 * `computeDashboardStats` does — a row the user flagged "don't count"
 * drops from both the bucket total and the top-entity/category stats
 * so the chart stays coherent with the month-total KPI card.
 *
 * Pure-ish: the only IO is the expense/exclusion/category reads, all
 * overridable via the second argument so tests can run hermetically.
 *
 * @param {object} args
 * @param {import('mongoose').Types.ObjectId|string} args.userId
 * @param {number} [args.cycles=12] How many cycles to walk back. Capped
 *   to [1, 36]; shorter values trim from the *oldest* end.
 * @param {object} [overrides] Test hook: `{ now, config, expenses,
 *   exclusions, categories }`.
 * @returns {Promise<{
 *   cycles: Array<{
 *     cycle_start: string,          // YYYY-MM-DD (inclusive)
 *     cycle_end: string,            // YYYY-MM-DD (inclusive)
 *     total: number,
 *     expense_count: number,
 *     delta_absolute: number|null,
 *     delta_pct: number|null,
 *     moving_avg_3: number|null,
 *     top_entity: { name: string, total: number }|null,
 *     top_category: { name: string, pct: number }|null,
 *     in_progress: boolean,
 *   }>,
 *   monthly_budget: number,
 *   weekly_budget: number,
 *   average: number,                // mean of completed cycles (skip in_progress)
 *   trend: { direction: 'up'|'down'|'stable', text: string }|null,
 *   cycle_day: number,
 * }>}
 */
export async function computeCycleHistory(
  { userId, cycles = DEFAULT_CYCLE_HISTORY_COUNT },
  overrides = {},
) {
  const now = overrides.now ? new Date(overrides.now) : new Date();
  const count = Math.max(
    1,
    Math.min(MAX_CYCLE_HISTORY_COUNT, Number(cycles) || DEFAULT_CYCLE_HISTORY_COUNT),
  );

  const config =
    overrides.config !== undefined
      ? overrides.config
      : await CurveConfig.findOne(
          { user_id: userId },
          { sync_cycle_day: 1, weekly_budget: 1 },
        ).lean();

  const cycleDay = normaliseCycleDay(config?.sync_cycle_day);
  const weeklyBudget = Number.isFinite(Number(config?.weekly_budget))
    ? Number(config.weekly_budget)
    : 73.75;
  const monthlyBudget = weeklyBudget * WEEKS_PER_MONTH;

  // Walk back `count` cycles. Each step lands on the day before the
  // current window starts, which unambiguously puts us in the previous
  // cycle regardless of how many days it contains.
  const windows = [];
  let anchor = new Date(now.getTime());
  for (let i = 0; i < count; i++) {
    const { start, end } = cycleBoundsFor(anchor, cycleDay);
    windows.unshift({ start, end });
    anchor = new Date(start.getTime() - DAY_MS);
  }

  const buckets = windows.map((w) => ({
    start: w.start,
    end: w.end,
    total: 0,
    expense_count: 0,
    entity_totals: new Map(),
    category_totals: new Map(),
  }));

  const rows =
    overrides.expenses !== undefined
      ? overrides.expenses
      : await Expense.find({ user_id: userId })
          .select('_id amount date entity category_id')
          .lean();

  const exclusions =
    overrides.exclusions !== undefined
      ? overrides.exclusions
      : await CurveExpenseExclusion.find({ user_id: userId })
          .select('expense_id')
          .lean();
  const excludedIds = new Set(
    exclusions.map((e) => e.expense_id?.toString()).filter(Boolean),
  );

  for (const r of rows) {
    if (r._id && excludedIds.has(r._id.toString())) continue;
    const when = parseExpenseDate(r.date);
    if (!when) continue;
    const amount = typeof r.amount === 'number' ? r.amount : Number(r.amount);
    if (!Number.isFinite(amount)) continue;
    // Linear bucket walk — windows are few (≤ 36) and expenses are
    // bounded at MVP scale, so a binary search is overkill.
    for (const b of buckets) {
      if (when >= b.start && when <= b.end) {
        b.total += amount;
        b.expense_count += 1;
        if (r.entity) {
          b.entity_totals.set(
            r.entity,
            (b.entity_totals.get(r.entity) ?? 0) + amount,
          );
        }
        if (r.category_id) {
          const cid = r.category_id.toString();
          b.category_totals.set(cid, (b.category_totals.get(cid) ?? 0) + amount);
        }
        break;
      }
    }
  }

  // Resolve category names once. Uses only the ids that actually
  // appeared as a "top" candidate in any bucket so we don't drag the
  // full catalogue over the wire when a user has hundreds of
  // categories but only a handful show up here.
  const topCategoryIds = new Set();
  for (const b of buckets) {
    let topId = null;
    let topTotal = -Infinity;
    for (const [cid, total] of b.category_totals.entries()) {
      if (total > topTotal) {
        topTotal = total;
        topId = cid;
      }
    }
    if (topId) topCategoryIds.add(topId);
  }
  const categoryDocs =
    overrides.categories !== undefined
      ? overrides.categories
      : topCategoryIds.size
        ? await Category.find({ _id: { $in: [...topCategoryIds] } })
            .select('_id name')
            .lean()
        : [];
  const categoryNameById = new Map(
    categoryDocs.map((c) => [c._id.toString(), c.name]),
  );

  const result = buckets.map((b, idx) => {
    const prev = idx > 0 ? buckets[idx - 1] : null;
    const deltaAbsolute = prev ? b.total - prev.total : null;
    const deltaPct =
      prev && prev.total > 0
        ? ((b.total - prev.total) / prev.total) * 100
        : null;

    // Trailing 3-cycle mean — emitted only once we have the current +
    // two prior buckets filled. The in-progress cycle is included (it
    // smooths itself out by design); if it looks noisy in practice we
    // can switch to excluding it.
    let movingAvg3 = null;
    if (idx >= 2) {
      movingAvg3 =
        (buckets[idx - 2].total + buckets[idx - 1].total + b.total) / 3;
    }

    let topEntity = null;
    let topEntityTotal = -Infinity;
    for (const [name, total] of b.entity_totals.entries()) {
      if (total > topEntityTotal) {
        topEntity = { name, total };
        topEntityTotal = total;
      }
    }
    if (topEntity) {
      topEntity = {
        name: topEntity.name,
        total: Math.round(topEntity.total * 100) / 100,
      };
    }

    let topCategoryName = null;
    let topCategoryTotal = 0;
    for (const [cid, total] of b.category_totals.entries()) {
      if (total > topCategoryTotal) {
        topCategoryTotal = total;
        topCategoryName = categoryNameById.get(cid) ?? null;
      }
    }
    const topCategory =
      topCategoryName && b.total > 0
        ? {
            name: topCategoryName,
            pct: Math.round((topCategoryTotal / b.total) * 100),
          }
        : null;

    const inProgress = now >= b.start && now <= b.end;

    return {
      cycle_start: formatISODate(b.start),
      cycle_end: formatISODate(b.end),
      total: Math.round(b.total * 100) / 100,
      expense_count: b.expense_count,
      delta_absolute:
        deltaAbsolute == null
          ? null
          : Math.round(deltaAbsolute * 100) / 100,
      delta_pct: deltaPct == null ? null : Math.round(deltaPct * 10) / 10,
      moving_avg_3:
        movingAvg3 == null ? null : Math.round(movingAvg3 * 100) / 100,
      top_entity: topEntity,
      top_category: topCategory,
      in_progress: inProgress,
    };
  });

  // Trend over the last 3 *completed* cycles. An in-progress cycle is
  // skipped — its total is partial, so comparing against it would tell
  // the user they're "gastando menos" simply because the cycle hasn't
  // ended yet.
  const completed = result.filter((c) => !c.in_progress);
  let trend = null;
  if (completed.length >= 3) {
    const last3 = completed.slice(-3);
    // If every recent completed cycle is empty there's no trend to
    // report — "Estável" on all-zeros reads as a false positive of
    // meaningful data. (All-equal-and-nonzero is still correctly
    // classified as "stable" by the 5 % ratio band below.)
    const allZero = last3.every((c) => c.total === 0);
    if (!allZero) {
      const first = last3[0].total;
      const last = last3[last3.length - 1].total;
      const diff = last - first;
      const ratio = first > 0 ? Math.abs(diff) / first : Math.abs(diff);
      if (ratio < 0.05) {
        trend = { direction: 'stable', text: 'Estável nos últimos 3 ciclos' };
      } else if (diff < 0) {
        trend = {
          direction: 'down',
          text: 'A tendência dos últimos 3 ciclos é de redução',
        };
      } else {
        trend = {
          direction: 'up',
          text: 'A tendência dos últimos 3 ciclos é de aumento',
        };
      }
    }
  }

  const completedTotals = completed.map((c) => c.total);
  const average =
    completedTotals.length > 0
      ? completedTotals.reduce((a, b) => a + b, 0) / completedTotals.length
      : 0;

  return {
    cycles: result,
    monthly_budget: Math.round(monthlyBudget * 100) / 100,
    weekly_budget: Math.round(weeklyBudget * 100) / 100,
    average: Math.round(average * 100) / 100,
    trend,
    cycle_day: cycleDay,
  };
}
