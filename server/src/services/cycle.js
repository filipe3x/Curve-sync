/**
 * Custom-cycle helpers shared by every endpoint that reports on "this
 * cycle" / "previous cycle" spend. See docs/expense-tracking.md for
 * the rationale (cycles aligned to the user's pay cycle, not calendar
 * months) and CLAUDE.md → Custom Monthly Cycle for the invariant:
 *
 *     if (date.day >= cycleDay) cycle-start = cycleDay of date.month
 *     else                      cycle-start = cycleDay of date.month - 1
 *
 * The cycle day is user-configurable via `CurveConfig.sync_cycle_day`
 * (1..28, default 22). Callers that don't have a config in hand (cron
 * boot, tests) still get the day-22 default when `cycleDay` is omitted.
 *
 * Pure, side-effect-free, UTC-anchored. Tested by proxy through the
 * consumers — if either of these drifts, `/api/categories/stats`,
 * `/api/curve/stats/uncategorised`, and `/api/expenses/stats/dashboard`
 * immediately return wrong windows.
 */

const DEFAULT_CYCLE_DAY = 22;

// Lazy import to avoid a circular dep: CurveConfig → mongoose → services.
let _CurveConfig = null;
async function loadConfigModel() {
  if (!_CurveConfig) {
    _CurveConfig = (await import('../models/CurveConfig.js')).default;
  }
  return _CurveConfig;
}

/**
 * Normalise a `sync_cycle_day` value to a usable integer in [1, 28].
 * Values outside the range, NaN, or nullish fall back to 22. The
 * upper bound is 28 to avoid Feb overflow (a cycleDay=31 config would
 * otherwise produce a March 3rd "start" in February).
 */
export function normaliseCycleDay(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_CYCLE_DAY;
  const floored = Math.floor(n);
  if (floored < 1 || floored > 28) return DEFAULT_CYCLE_DAY;
  return floored;
}

/**
 * Compute the start/end of a custom-cycle window as UTC Date objects
 * surrounding the given anchor.
 *
 * - `start` is inclusive at 00:00:00.000 UTC of `cycleDay`.
 * - `end`   is inclusive at 23:59:59.999 UTC of `cycleDay - 1` of the
 *            following month (for cycleDay=1 that resolves to the last
 *            day of the current month — `Date.UTC(y, m+1, 0)` rolls
 *            correctly).
 *
 * Anchored on UTC so cycle boundaries don't drift with server TZ — a
 * cron tick at 00:00:01 Lisbon time in April still lands on the
 * Mar 22 – Apr 21 cycle correctly.
 *
 * @param {Date} anchor
 * @param {number} [cycleDay=22] Day of month the cycle starts on.
 *   Clamped to [1, 28] via `normaliseCycleDay`.
 * @returns {{ start: Date, end: Date }}
 */
export function cycleBoundsFor(anchor, cycleDay = DEFAULT_CYCLE_DAY) {
  const day = normaliseCycleDay(cycleDay);
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth();
  const d = anchor.getUTCDate();
  // If we're on/after the cycle day, the current cycle starts THIS
  // month on that day; otherwise it started LAST month on that day.
  const startY = d >= day ? y : (m === 0 ? y - 1 : y);
  const startM = d >= day ? m : (m === 0 ? 11 : m - 1);
  const start = new Date(Date.UTC(startY, startM, day, 0, 0, 0, 0));
  // End = the day before `cycleDay` of the following month, inclusive
  // through EOD. `Date.UTC(y, m+1, 0)` collapses to the last day of
  // month m — the same trick handles cycleDay=1 without a branch.
  const endY = startM === 11 ? startY + 1 : startY;
  const endM = startM === 11 ? 0 : startM + 1;
  const end = new Date(Date.UTC(endY, endM, day - 1, 23, 59, 59, 999));
  return { start, end };
}

/**
 * Resolve the `sync_cycle_day` for a given user with a single lean
 * query. Defaults to 22 when the user has no CurveConfig yet (fresh
 * account, pre-wizard) or when the field is nullish.
 *
 * Used by every route that needs per-user cycle bounds — factors out
 * the lookup so handlers don't carry a mongoose import just to read
 * a single integer.
 *
 * @param {import('mongoose').Types.ObjectId|string} userId
 * @returns {Promise<number>} normalised cycle day in [1, 28]
 */
export async function getUserCycleDay(userId) {
  if (!userId) return DEFAULT_CYCLE_DAY;
  const CurveConfig = await loadConfigModel();
  const row = await CurveConfig.findOne(
    { user_id: userId },
    { sync_cycle_day: 1 },
  ).lean();
  return normaliseCycleDay(row?.sync_cycle_day);
}

/**
 * Convenience wrapper: resolve the user's cycle day AND compute the
 * bounds in one call. Equivalent to
 * `cycleBoundsFor(anchor, await getUserCycleDay(userId))` but spares
 * callers the two-step dance.
 *
 * @param {import('mongoose').Types.ObjectId|string} userId
 * @param {Date} [anchor=new Date()]
 * @returns {Promise<{ start: Date, end: Date, cycleDay: number }>}
 */
export async function cycleBoundsForUser(userId, anchor = new Date()) {
  const cycleDay = await getUserCycleDay(userId);
  return { ...cycleBoundsFor(anchor, cycleDay), cycleDay };
}

/**
 * Render a `YYYY-MM-DD` label from a UTC Date — the shape the frontend
 * expects on `cycle.start` / `cycle.end` in API responses.
 */
export function formatISODate(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
