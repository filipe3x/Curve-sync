/**
 * Legacy expense-date string parser.
 *
 * HISTORICAL NOTE
 * ---------------
 * `expense.date` is now sourced from the MIME `Date:` header
 * (`envelope.date` from imapflow, yielded by
 * services/imapReader.js::fetchUnseen and consumed by the sync
 * orchestrator). That header is always UTC with seconds precision and
 * independent of the per-merchant TZ variance in the Curve email body
 * — see CLAUDE.md → Expense Date Timezone Invariant for the full
 * contract.
 *
 * This helper therefore exists only for **fallback** and **legacy
 * conversion** scenarios:
 *
 *   - Orchestrator fallback when `envelopeDate` is unexpectedly null
 *     (malformed email without a Date header). Logs a parse_error
 *     upstream.
 *   - `POST /api/expenses` manual create (unused from the UI today,
 *     but the route is live).
 *   - `scripts/analyze-expense-dates.js` cleanup of Embers-era rows
 *     that landed in Mongo as BSON `String` instead of `Date`.
 *
 * Contract
 * --------
 *   parseExpenseDate(value) → { date: Date|null, reason: string }
 *
 * Never throws. Always returns an object so call-sites can log the
 * reason string if they care.
 *
 * For string inputs matching the canonical Curve body format
 * ("DD Month YYYY HH:MM:SS") the numerals are packed into a Date's
 * UTC components via `Date.UTC(...)`. This is **not** the
 * authoritative transaction moment (body TZ varies per email) — it's
 * just a deterministic host-TZ-independent coercion so legacy
 * callers get stable Date objects. Real ingestion bypasses this by
 * using `envelopeDate` directly.
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

  // Path 1 — Curve body format. Numerals packed into UTC components
  // via Date.UTC so the result is server-TZ-independent. Only used as
  // a fallback today; see the module docstring.
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

  // Path 2 — V8 Date.parse for ISO / RFC 2822 shapes that carry their
  // own timezone. Produces the correct UTC moment regardless of host.
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
