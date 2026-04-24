// pt-PT relative date formatter for the expenses tables (ROADMAP §2.9).
//
// The goal is simple: turn a server-serialised date string ("06 April
// 2026 08:53:31", or an ISO) into something a human reads at a glance.
// Seven bands:
//
//   diff (local civil)     →  text
//   --------------------      ----------------------
//   < 60 s                    "há segundos"
//   < 60 min (same day)       "há N min"
//   < 24 h   (same day)       "há N h"
//   1 civil day               "ontem"
//   2 civil days              "anteontem"
//   3–5 civil days            "há N dias"
//   > 5 days / future / bad   absolute "DD MMM YYYY"
//
// Why civil-day and not rolling 24 h: a receipt from yesterday at
// 23:00 read this morning at 08:00 should say "ontem", not "há 9 h".
// Users think in days, not in 24-hour wheels.
//
// Timezone contract: Curve receipt emails carry the transaction time
// in the user's local wall clock ("24 April 2026 15:40:33") with no
// timezone marker. The backend parses those numerals as UTC (see
// server/src/services/expenseDate.js) so the stored Date's UTC
// components *are* the Europe/Lisbon wall clock. This module reads
// those UTC components back directly — rendering is therefore
// independent of the browser's timezone, which matters for users
// hitting the app from elsewhere (mobile roaming, laptop away from
// home). For relative comparisons we fabricate "now" as a Date whose
// UTC components are the current Lisbon wall clock, so the diff is in
// the same space as the expense.

// Europe/Lisbon is hardcoded: this is a Portugal-focused app and the
// Curve receipts are emitted in the user's Lisbon-tied Curve account
// timezone (see CLAUDE.md → Stack / MVP scope).
const APP_TZ = 'Europe/Lisbon';

const WALL_CLOCK_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

// Return a Date whose UTC components equal the current Europe/Lisbon
// wall clock. Used only for relative comparisons against expense
// Dates (which also store the wall clock in UTC components).
function nowAsWallClockUtc() {
  const parts = WALL_CLOCK_FMT.formatToParts(new Date());
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  // Intl emits "24" for midnight in some engines — normalise.
  const h = get('hour');
  return new Date(Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    h === 24 ? 0 : h,
    get('minute'),
    get('second'),
  ));
}

function startOfUtcDay(d) {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// Accept either an already-serialised Date/ISO string or the legacy
// "06 April 2026 08:53:31" body string. Either way, interpret the
// calendar components as Europe/Lisbon wall clock and return them
// packed into a Date's UTC components (so getUTC* reads them back).
function parseInput(input) {
  if (input == null || input === '') return null;
  const t = Date.parse(input);
  if (Number.isNaN(t)) return null;
  return new Date(t);
}

// Build a single formatter once and reuse — constructing
// Intl.DateTimeFormat per render is surprisingly expensive for a
// table with 20 rows that re-renders often.
const ABSOLUTE_FMT = new Intl.DateTimeFormat('pt-PT', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

export function formatAbsoluteDate(input) {
  const d = parseInput(input);
  if (!d) return input == null || input === '' ? '—' : String(input);
  return ABSOLUTE_FMT.format(d);
}

// Composed manually to avoid the verbose "10 de abr. de 2026, 11:58"
// full-ICU browsers produce for pt-PT — we want "10 Abr 2026, 11:58".
const MONTHS_PT_SHORT = [
  'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun',
  'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez',
];

export function formatExpenseDateFull(input) {
  const d = parseInput(input);
  if (!d) return input == null || input === '' ? '—' : String(input);
  const day = String(d.getUTCDate()).padStart(2, '0');
  const mon = MONTHS_PT_SHORT[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day} ${mon} ${year}, ${hh}:${mm}`;
}

/**
 * Render an expense date as a pt-PT relative string.
 *
 * @param {string} input       Free-form date string from Expense.date
 * @param {number|Date} [now]  Injected clock for tests; defaults to
 *                             Date.now(). Numbers treated as ms epoch.
 * @returns {string}
 */
export function formatExpenseDate(input, now) {
  const then = parseInput(input);
  if (!then) return input == null || input === '' ? '—' : String(input);

  // `nowAsWallClockUtc()` puts the current Europe/Lisbon wall clock
  // into a Date's UTC components — the same space the expense Date
  // lives in — so subtracting the two yields a real elapsed duration.
  const nowDate =
    now instanceof Date
      ? now
      : typeof now === 'number'
        ? new Date(now)
        : nowAsWallClockUtc();
  const diffMs = nowDate.getTime() - then.getTime();

  // Future timestamps (clock skew, bad data) fall straight through
  // to the absolute form — "há -3 min" would be a bug.
  if (diffMs < 0) return ABSOLUTE_FMT.format(then);

  const dayDiff = Math.round(
    (startOfUtcDay(nowDate) - startOfUtcDay(then)) / 86_400_000,
  );

  if (dayDiff === 0) {
    if (diffMs < 60_000) return 'há segundos';
    if (diffMs < 3_600_000) {
      const min = Math.floor(diffMs / 60_000);
      return `há ${min} min`;
    }
    const hr = Math.floor(diffMs / 3_600_000);
    return `há ${hr} h`;
  }
  if (dayDiff === 1) return 'ontem';
  if (dayDiff === 2) return 'anteontem';
  if (dayDiff <= 5) return `há ${dayDiff} dias`;
  return ABSOLUTE_FMT.format(then);
}
