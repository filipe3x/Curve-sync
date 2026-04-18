/**
 * Expense date parser — shared between the sync orchestrator, the
 * manual POST /api/expenses handler, and the one-shot backfill in
 * scripts/analyze-expense-dates.js.
 *
 * Sits alongside `expenseStats.js::parseExpenseDate` which is a
 * simpler Date.parse-only helper used by the dashboard aggregation.
 * The two are kept separate for now because this one is the
 * "canonical" typed-Date producer (writes go through here) and the
 * stats one is "best-effort for reads" — unifying them is a follow-up
 * once the migration is done and nobody reads the string `date`
 * anymore.
 *
 * Contract
 * --------
 *   parseExpenseDate(value) → { date: Date|null, reason: string }
 *
 * Never throws. Always returns an object so call-sites can log the
 * reason string if they care (the backfill does; the INSERT paths
 * don't — they just write `date: null` and move on).
 *
 * Handles the three shapes observed in the shared `expenses`
 * collection (see scripts/analyze-expense-dates.js for the dev-dump
 * survey):
 *
 *   1. already a Date (BSON Date, typically from Embers' Mongoid
 *      write path which declares `field :date, type: DateTime`) →
 *      pass through
 *   2. string in the canonical Curve format ("06 April 2026
 *      08:53:31") or anything `Date.parse` can handle → normalised
 *      to a Date via `new Date(Date.parse(...))`
 *   3. string that Date.parse rejects but matches the explicit
 *      "DD Month YYYY HH:MM(:SS)?" regex → parsed manually, used as
 *      a safety net for Node builds with minimal ICU where Date.parse
 *      disagrees with V8 mainline
 *
 * Everything else (null, empty string, weird numbers, unparseable
 * strings) returns `{ date: null, reason: <descriptor> }`.
 */

const MONTHS = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

export function parseExpenseDate(value) {
  if (value == null) return { date: null, reason: 'null_or_undefined' };

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return { date: null, reason: 'invalid_date_object' };
    }
    return { date: value, reason: 'already_date' };
  }

  if (typeof value !== 'string') {
    return { date: null, reason: `unsupported_type:${typeof value}` };
  }

  const trimmed = value.trim();
  if (trimmed === '') return { date: null, reason: 'empty_string' };

  // Path 1 — V8 Date.parse. Handles the canonical Curve string, ISO,
  // RFC 2822, and most reasonable variants.
  const t = Date.parse(trimmed);
  if (!Number.isNaN(t)) return { date: new Date(t), reason: 'parse_ok' };

  // Path 2 — explicit DD Month YYYY HH:MM(:SS)? regex. Parses the
  // numbers manually so we don't depend on Date.parse handling
  // English month names in whatever locale the host is configured
  // for. Time portion is optional (`25 Dec 2025, 14:30` form).
  const m = trimmed.match(
    /^(\d{1,2})\s+([A-Za-z]+)(?:,)?\s+(\d{4})(?:[\s,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (m) {
    const day = Number(m[1]);
    const month = MONTHS[m[2].toLowerCase()];
    const year = Number(m[3]);
    const hour = Number(m[4] ?? 0);
    const minute = Number(m[5] ?? 0);
    const second = Number(m[6] ?? 0);
    if (month != null) {
      const d = new Date(Date.UTC(year, month, day, hour, minute, second));
      if (!Number.isNaN(d.getTime())) {
        return { date: d, reason: 'regex_ok' };
      }
    }
  }

  return { date: null, reason: 'unparseable' };
}

/**
 * Convenience wrapper: the INSERT paths just want a Date-or-null to
 * stash on `Expense.date_at`, they don't care about the reason.
 */
export function parseExpenseDateOrNull(value) {
  return parseExpenseDate(value).date;
}
