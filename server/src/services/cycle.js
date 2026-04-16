/**
 * Day-22 cycle helpers shared by every endpoint that reports on "this
 * cycle" / "previous cycle" spend. See docs/expense-tracking.md for
 * the rationale (cycles aligned to the bank pay cycle, not calendar
 * months) and CLAUDE.md → Custom Monthly Cycle for the invariant:
 *
 *     if (date.day >= 22) cycle-start = 22 of date.month
 *     else                cycle-start = 22 of date.month - 1
 *
 * Pure, side-effect-free, UTC-anchored. Tested by proxy through the
 * consumers — if either of these drifts, `/api/categories/stats` and
 * `/api/curve/stats/uncategorised` immediately return wrong windows.
 */

/**
 * Compute the start/end of a day-22 cycle as UTC Date objects
 * surrounding the given anchor.
 *
 * - `start` is inclusive at 00:00:00.000 UTC of the 22nd.
 * - `end`   is inclusive at 23:59:59.999 UTC of the 21st of the
 *            following month.
 *
 * Anchored on UTC so cycle boundaries don't drift with server TZ — a
 * cron tick at 00:00:01 Lisbon time in April still lands on the
 * Mar 22 – Apr 21 cycle correctly.
 *
 * @param {Date} anchor
 * @returns {{ start: Date, end: Date }}
 */
export function cycleBoundsFor(anchor) {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth();
  const d = anchor.getUTCDate();
  // If we're on/after day 22, the current cycle starts THIS month on
  // the 22nd; otherwise it started LAST month on the 22nd.
  const startY = d >= 22 ? y : (m === 0 ? y - 1 : y);
  const startM = d >= 22 ? m : (m === 0 ? 11 : m - 1);
  const start = new Date(Date.UTC(startY, startM, 22, 0, 0, 0, 0));
  // End = the 21st of the following month, inclusive through EOD.
  const endY = startM === 11 ? startY + 1 : startY;
  const endM = startM === 11 ? 0 : startM + 1;
  const end = new Date(Date.UTC(endY, endM, 21, 23, 59, 59, 999));
  return { start, end };
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
