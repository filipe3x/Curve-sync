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
 * Timezone contract
 * -----------------
 * Curve emails embed the transaction time as a Europe/Lisbon wall
 * clock ("24 April 2026 15:40:02") with no timezone marker — we
 * confirmed against the footer line "Generated on ... UTC" in real
 * receipts that the body delta matches exactly the Lisbon offset at
 * that date (WEST in summer, WET in winter). This parser interprets
 * the numerals AS Lisbon and returns the true UTC moment, so
 * `Expense.date` is always a real instant (not "wall clock stored as
 * UTC"). Frontend then renders in the viewer's browser TZ via the
 * standard Date getters — a Lisbon viewer sees 15:40, a Madrid viewer
 * sees 16:40, a NY viewer sees 10:40.
 *
 * Historical rows stored before this fix (Date.parse interpreting the
 * body as server-local time) are shifted forward by
 * `server_offset + lisbon_offset` hours. Use
 * scripts/migrate-expense-date-tz.js to correct them.
 */

// MONTHS stays exported-shape agnostic — used only by the regex branch
// that tokenises English month names out of the Curve body.
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

// Hardcoded to Europe/Lisbon — the Curve body's TZ for Portuguese
// users. Exposed as a constant (not inlined) so the migration script
// can reuse the exact same conversion primitive.
export const CURVE_BODY_TIMEZONE = 'Europe/Lisbon';

// Cached to avoid allocating a formatter per parse. `en-CA` gives
// ISO-shaped numerals that are stable to read.
const LISBON_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: CURVE_BODY_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/**
 * Convert a set of Y/M/D/h/m/s numerals interpreted in
 * `Europe/Lisbon` to the true UTC moment they represent.
 *
 * Uses the two-pass Intl trick: pack the wall clock into a Date as if
 * it were UTC, ask Intl what that instant reads as in Lisbon, and the
 * delta is the offset we have to subtract. Handles WEST/WET switches
 * correctly without bundling a TZ database.
 *
 * @param {number} year     e.g. 2026
 * @param {number} month    0-indexed (0 = January)
 * @param {number} day      1-31
 * @param {number} hour     0-23
 * @param {number} minute   0-59
 * @param {number} second   0-59
 * @returns {Date} the UTC instant equivalent to the given Lisbon wall clock
 */
export function lisbonWallClockToUtc(year, month, day, hour, minute, second) {
  // First pass: pretend the numerals are UTC so we have a concrete
  // instant to interrogate.
  const guessMs = Date.UTC(year, month, day, hour, minute, second);
  // What does that instant actually read as in Lisbon?
  const parts = LISBON_FMT.formatToParts(new Date(guessMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const lH = get('hour');
  const lisbonAsUtcMs = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    // Intl emits "24" for midnight in some runtimes — collapse to 0.
    lH === 24 ? 0 : lH,
    get('minute'),
    get('second'),
  );
  // Offset (signed, ms): positive means Lisbon is ahead of UTC.
  const offsetMs = lisbonAsUtcMs - guessMs;
  return new Date(guessMs - offsetMs);
}

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

  // Path 1 — Curve body format "DD Month YYYY HH:MM(:SS)?". Numerals
  // are the user's Europe/Lisbon wall clock; we convert to the true
  // UTC instant explicitly (not via Date.parse, which would re-read
  // them in whatever TZ the host is configured for — the bug that
  // caused an 8 h drift on the LA/PDT prod server). Time portion is
  // optional (`25 Dec 2025, 14:30` form).
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
      const d = lisbonWallClockToUtc(year, month, day, hour, minute, second);
      if (!Number.isNaN(d.getTime())) {
        return { date: d, reason: 'regex_ok' };
      }
    }
  }

  // Path 2 — V8 Date.parse for everything else (ISO with explicit TZ,
  // RFC 2822). Inputs reaching this branch carry their own timezone,
  // so Date.parse produces the correct moment regardless of host TZ.
  const t = Date.parse(trimmed);
  if (!Number.isNaN(t)) return { date: new Date(t), reason: 'parse_ok' };

  return { date: null, reason: 'unparseable' };
}

/**
 * Convenience wrapper: the INSERT paths just want a Date-or-null to
 * stash on `Expense.date`, they don't care about the reason. `null`
 * flows to Mongoose which rejects via `required: true` on the schema.
 */
export function parseExpenseDateOrNull(value) {
  return parseExpenseDate(value).date;
}
