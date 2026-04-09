/**
 * Curve Card receipt email parser.
 *
 * Ports the logic from docs/embers-reference/curve.py to Node.js using
 * cheerio, with a layered fallback strategy so that minor template changes
 * on Curve's side degrade gracefully instead of dropping every email.
 *
 * Contract with the MongoDB `expenses` collection:
 *
 *   REQUIRED (missing any of these → ParseError, expense skipped, logged):
 *     - entity    String  (Expense.entity, required by schema)
 *     - amount    Number  (Expense.amount, required by schema)
 *     - date      String  (Expense.date,   required by schema)
 *
 *   OPTIONAL (missing → warning, expense still inserted):
 *     - card      String  (Expense.card; curve.py includes it in the digest,
 *                          so missing it weakens dedup but doesn't block)
 *
 * The parser NEVER crashes on bad input: for required fields it throws a
 * structured `ParseError` (caught by the orchestrator, logged as
 * `parse_error` in curve_logs, email left UNSEEN for retry); for optional
 * fields it accumulates `warnings` on the returned object.
 */

import { load } from 'cheerio';
import { createHash } from 'crypto';

/**
 * Structured parse error. Thrown ONLY when a required field cannot be
 * extracted via primary OR fallback selectors. The orchestrator uses
 * `field`, `attempted` and `details` to build a useful curve_logs entry.
 */
export class ParseError extends Error {
  constructor(message, { field, attempted, details } = {}) {
    super(message);
    this.name = 'ParseError';
    this.field = field;
    this.attempted = attempted;
    this.details = details;
  }
}

// ---------- Quoted-printable decoder ----------
/**
 * Decode MIME quoted-printable to a UTF-8 string. Safe on already-decoded
 * input: if no `=XX` / `=\n` patterns are present, returns unchanged.
 * Mirrors the Python `quopri.decodestring(...).decode('utf-8')` pipeline.
 */
function decodeQuopri(input) {
  if (!/=\r?\n|=[0-9A-Fa-f]{2}/.test(input)) return input;
  const bytes = [];
  let i = 0;
  while (i < input.length) {
    const ch = input.charCodeAt(i);
    if (ch === 0x3d /* = */) {
      const next = input.charCodeAt(i + 1);
      if (next === 0x0a) { i += 2; continue; }                              // =\n
      if (next === 0x0d && input.charCodeAt(i + 2) === 0x0a) { i += 3; continue; } // =\r\n
      const hex = input.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 3;
        continue;
      }
    }
    bytes.push(ch & 0xff);
    i++;
  }
  return Buffer.from(bytes).toString('utf-8');
}

/**
 * Extract HTML body from a raw email source. Tolerates:
 *   - full MIME email with headers and quoted-printable body (fixtures)
 *   - already-decoded HTML (imapflow output)
 *   - case variations of the doctype marker
 * Throws ParseError if no HTML marker can be located at all.
 */
export function extractHtml(raw) {
  if (typeof raw !== 'string') {
    throw new ParseError('input is not a string', { field: 'html' });
  }
  const lower = raw.toLowerCase();
  let start = lower.indexOf('<!doctype html');
  if (start === -1) start = lower.indexOf('<html');
  if (start === -1) {
    throw new ParseError('no <!doctype html> or <html> marker found', {
      field: 'html',
      details: { head: raw.slice(0, 200) },
    });
  }
  return decodeQuopri(raw.slice(start));
}

// ---------- Amount parser ----------
/**
 * Parse a human amount string into a Number. Tolerant of formats:
 *   "€0.99"    → 0.99
 *   "0.99€"    → 0.99
 *   "EUR 12.34" → 12.34
 *   "12,34"    → 12.34     (European decimal comma)
 *   "1,234.56" → 1234.56   (US thousands)
 *   "1.234,56" → 1234.56   (EU thousands)
 *   "-5.00"    → -5        (refund / credit)
 * Throws Error on no numeric match (caller wraps into ParseError).
 */
export function parseAmount(text) {
  if (!text) throw new Error('empty amount string');
  const cleaned = text.replace(/€/g, '').replace(/EUR/gi, '').trim();
  const match = cleaned.match(/-?\d[\d.,]*/);
  if (!match) throw new Error(`no numeric token in "${text}"`);
  let n = match[0];
  const lastDot = n.lastIndexOf('.');
  const lastComma = n.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    // Both present: rightmost is the decimal separator
    if (lastDot > lastComma) {
      n = n.replace(/,/g, ''); // comma is thousands
    } else {
      n = n.replace(/\./g, '').replace(',', '.'); // dot is thousands
    }
  } else if (lastComma >= 0) {
    // Only comma: treat as decimal separator (European style)
    n = n.replace(',', '.');
  }
  const val = parseFloat(n);
  if (!Number.isFinite(val)) throw new Error(`cannot parse "${text}"`);
  return val;
}

// ---------- Main parser ----------
/**
 * Parse a Curve Card receipt email into a structured expense object.
 *
 * Accepts either a raw email source (MIME with headers + QP body) OR
 * already-decoded HTML; auto-detected.
 *
 * Strategy: try canonical selectors from curve.py first; on any miss,
 * fall back to progressively looser heuristics, accumulating `warnings`.
 * Throws `ParseError` only when a REQUIRED field can't be extracted.
 *
 * @param {string} input - raw email or HTML
 * @returns {{
 *   entity: string,
 *   amount: number,
 *   date: string,
 *   card: string,
 *   digest: string,
 *   warnings: string[],
 * }}
 */
export function parseEmail(input) {
  const html = extractHtml(input);
  const $ = load(html);
  const warnings = [];

  // -------- entity (REQUIRED) --------
  // Primary: first <td class="u-bold"> (matches curve.py)
  // Fallback: any element with class u-bold (tag may change)
  let entity = null;
  let entityEl = null;
  const bolds = $('td.u-bold');
  if (bolds.length >= 1) {
    entityEl = bolds.first();
    entity = entityEl.text().trim();
  }
  if (!entity) {
    const anyBold = $('.u-bold').first();
    if (anyBold.length) {
      entityEl = anyBold;
      entity = anyBold.text().trim();
      warnings.push('entity: fallback to .u-bold (not td.u-bold)');
    }
  }
  if (!entity) {
    throw new ParseError('could not extract entity (required)', {
      field: 'entity',
      attempted: ['td.u-bold', '.u-bold'],
    });
  }

  // -------- amount (REQUIRED) --------
  // Primary: entity's next sibling td.u-bold (matches curve.py's find_next_sibling)
  // Fallback 1: second global td.u-bold
  // Fallback 2: regex for "€X.XX" / "€X,XX" anywhere in the document
  let amountText = null;
  if (entityEl && entityEl.is('td')) {
    const sib = entityEl.nextAll('td.u-bold').first();
    if (sib.length) amountText = sib.text().trim();
  }
  if (!amountText && bolds.length >= 2) {
    amountText = bolds.eq(1).text().trim();
    warnings.push('amount: fallback to 2nd td.u-bold (non-sibling)');
  }
  if (!amountText) {
    const m = html.match(/€\s*-?\d[\d.,]*/);
    if (m) {
      amountText = m[0];
      warnings.push('amount: regex fallback on raw HTML');
    }
  }
  if (!amountText) {
    throw new ParseError('could not extract amount (required)', {
      field: 'amount',
      attempted: [
        'entity.nextAll(td.u-bold)',
        '2nd td.u-bold',
        'regex /€\\s*-?\\d[\\d.,]*/',
      ],
    });
  }
  let amount;
  try {
    amount = parseAmount(amountText);
  } catch (e) {
    throw new ParseError(
      `could not parse amount value from "${amountText}": ${e.message}`,
      { field: 'amount', details: { raw: amountText } },
    );
  }

  // -------- date (REQUIRED) --------
  // Primary: td.u-greySmaller.u-padding__top--half
  // Fallback 1: any td.u-greySmaller
  // Fallback 2: regex /DD Month YYYY HH:MM:SS/
  let date = null;
  const primaryDate = $('td.u-greySmaller.u-padding__top--half').first();
  if (primaryDate.length) date = primaryDate.text().trim();
  if (!date) {
    const loose = $('td.u-greySmaller').first();
    if (loose.length) {
      date = loose.text().trim();
      warnings.push('date: fallback to td.u-greySmaller');
    }
  }
  if (!date) {
    // Curve uses English month names in the format "06 April 2026 08:53:31"
    const m = html
      .replace(/<[^>]*>/g, ' ')
      .match(/\d{1,2}\s+[A-Za-z]+\s+\d{4}\s+\d{1,2}:\d{2}:\d{2}/);
    if (m) {
      date = m[0];
      warnings.push('date: regex fallback /DD Month YYYY HH:MM:SS/');
    }
  }
  if (!date) {
    throw new ParseError('could not extract date (required)', {
      field: 'date',
      attempted: [
        'td.u-greySmaller.u-padding__top--half',
        'td.u-greySmaller',
        'regex /DD Month YYYY HH:MM:SS/',
      ],
    });
  }

  // -------- card (OPTIONAL — never throws) --------
  // Primary: penultimate td.u-padding__top--half (matches curve.py's [-2])
  // Mirrors BeautifulSoup's `' '.join(stripped_strings)` by collapsing
  // whitespace runs in the text content.
  let card = '';
  const paddingTds = $('td.u-padding__top--half');
  if (paddingTds.length >= 2) {
    const penult = paddingTds.eq(paddingTds.length - 2);
    card = penult.text().replace(/\s+/g, ' ').trim();
  }
  if (!card) {
    warnings.push(
      'card: missing (optional; digest computed with empty card)',
    );
  }

  // -------- digest --------
  // CRITICAL: must stay bit-for-bit compatible with curve.py so Embers and
  // Curve Sync produce the same unique_id for the same email (the digest is
  // a unique index on `expenses` — mismatched formats would bypass dedup).
  //
  // curve.py does `amount.replace(u'€', '')` on the STRING form (e.g.
  // "0.99", not 0.99). We reuse the raw string here rather than the parsed
  // Number to preserve formatting like "1,234.56".
  const amountRaw = amountText.replace(/€/g, '').trim();
  const digest = createHash('sha256')
    .update(`${entity}${amountRaw}${date}${card}`)
    .digest('hex');

  return { entity, amount, date, card, digest, warnings };
}
