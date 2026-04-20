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
// Parsing is defensive: Expense.date is free-form (kept compatible
// with curve.py — see CLAUDE.md → Deliberately deferred) and V8's
// Date.parse is what the backend also uses. Anything unparseable
// falls through to the raw input so the row never renders blank.

function startOfLocalDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// Build a single formatter once and reuse — constructing
// Intl.DateTimeFormat per render is surprisingly expensive for a
// table with 20 rows that re-renders often.
const ABSOLUTE_FMT = new Intl.DateTimeFormat('pt-PT', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

export function formatAbsoluteDate(input) {
  if (input == null || input === '') return '—';
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) return String(input);
  return ABSOLUTE_FMT.format(new Date(parsed));
}

// Composed manually to avoid the verbose "10 de abr. de 2026, 11:58"
// full-ICU browsers produce for pt-PT — we want "10 Abr 2026, 11:58".
const MONTHS_PT_SHORT = [
  'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun',
  'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez',
];

export function formatExpenseDateFull(input) {
  if (input == null || input === '') return '—';
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) return String(input);
  const d = new Date(parsed);
  const day = String(d.getDate()).padStart(2, '0');
  const mon = MONTHS_PT_SHORT[d.getMonth()];
  const year = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
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
  if (input == null || input === '') return '—';
  const parsed = Date.parse(input);
  if (Number.isNaN(parsed)) return String(input);

  const then = new Date(parsed);
  const nowDate =
    now instanceof Date
      ? now
      : new Date(typeof now === 'number' ? now : Date.now());
  const diffMs = nowDate.getTime() - then.getTime();

  // Future timestamps (clock skew, bad data) fall straight through
  // to the absolute form — "há -3 min" would be a bug.
  if (diffMs < 0) return ABSOLUTE_FMT.format(then);

  const dayDiff = Math.round(
    (startOfLocalDay(nowDate) - startOfLocalDay(then)) / 86_400_000,
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
