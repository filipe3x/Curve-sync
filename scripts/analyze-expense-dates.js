#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * scripts/analyze-expense-dates.js — read-only recon for ROADMAP §2.9/§2.10
 * follow-up (Opção C in the investigation comment).
 *
 * Problem we are sizing up
 * ------------------------
 * `Expense.date` is declared as a String in the Mongoose schema (for
 * bit-for-bit compat with curve.py) and is sorted via `sort({ date: -1 })`
 * by /expenses, the dashboard "Despesas recentes" card, and the
 * /categories detail panel. Because the string is day-first ("06 April
 * 2026 08:53:31"), a lexical sort in Mongo orders primarily by day-of-
 * month — so the most recent row can easily land at the bottom of the
 * list. The issue is proven at `ROADMAP §2.x investigation`.
 *
 * On top of that, a quick BSON peek at the dev dump showed the field
 * has MIXED TYPES today — some rows are strings, others are real BSON
 * Dates. BSON's canonical type order puts String < Date, so when the
 * two types coexist a `sort({date: -1})` groups all Date rows at the
 * top and all String rows afterwards, regardless of chronology. Any
 * backfill algorithm has to handle both shapes.
 *
 * What this script does
 * ---------------------
 * Strictly READ-ONLY. Connects to the same MongoDB as the server (via
 * MONGODB_URI, same default as server/src/config/db.js), reads every
 * row from the `expenses` collection, and prints:
 *
 *   1. A histogram of concrete BSON types present in `date`.
 *   2. Parse coverage of the prototype `parseExpenseDate()` helper on
 *      the String rows, with samples of any rows it cannot handle.
 *   3. A side-by-side comparison of the CURRENT broken sort vs the
 *      PROPOSED chronological sort (head + tail) so the delta is
 *      obvious at a glance.
 *   4. A migration summary: how many rows would need backfill, how
 *      many are already typed, and any that would need manual review.
 *
 * Nothing is written. No network writes. Safe to run against prod.
 *
 * Usage
 * -----
 *   MONGODB_URI=mongodb://... node scripts/analyze-expense-dates.js
 *   # or from the server dir so the existing .env is picked up:
 *   cd server && node -r dotenv/config ../scripts/analyze-expense-dates.js
 */

import 'dotenv/config';
import mongoose from 'mongoose';

const MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/embers_db';

// ─── Prototype parser ────────────────────────────────────────────────
//
// This is the proposed backfill / on-insert helper. Returns a Date
// (or null) from whatever shape `Expense.date` may hold today:
//
//   1. already a Date   → return as-is
//   2. string           → try V8 Date.parse (handles "06 April 2026
//                         08:53:31", "25 Dec 2025, 14:30", and most
//                         Curve formats); fall back to an explicit
//                         "DD Month YYYY HH:MM(:SS)?" regex that
//                         parses the numbers manually — this is the
//                         safety net for locales where Date.parse
//                         disagrees (Node builds vary with ICU)
//   3. anything else    → null, row goes on the "needs review" list
//
// The regex uses English month names because that's the one format
// the Curve pipeline produces (see services/emailParser.js — the
// primary + regex fallback both target English months). Portuguese
// month names never land in the DB via this pipeline.
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

function parseExpenseDateProto(value) {
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
  // RFC 2822, and most reasonable variants. On success we still pass
  // it through `new Date(...)` to normalise.
  const t = Date.parse(trimmed);
  if (!Number.isNaN(t)) return { date: new Date(t), reason: 'parse_ok' };

  // Path 2 — explicit DD Month YYYY HH:MM(:SS)? regex. Safety net.
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

// ─── Helpers ─────────────────────────────────────────────────────────

function lexCmp(a, b) {
  // Mirrors how Mongo would lex-compare two strings. `String(a)` for
  // safety — we just want to know how today's broken sort orders the
  // rows in memory.
  const as = String(a);
  const bs = String(b);
  if (as < bs) return -1;
  if (as > bs) return 1;
  return 0;
}

function formatDisplayDate(value) {
  // A compact printable form for console output so `date` objects and
  // raw strings line up visually.
  if (value == null) return '(null)';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function bsonTypeOf(value) {
  if (value === null) return 'null';
  if (value instanceof Date) return 'date';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return 'number';
  return typeof value;
}

function pad(s, n) {
  const str = String(s);
  return str.length >= n ? str : str + ' '.repeat(n - str.length);
}

function printTable(title, rows, parsedMap, currentLexMap) {
  console.log();
  console.log(`── ${title} ─────────────────────────────────────`);
  console.log(
    pad('#', 3) +
      ' ' +
      pad('typed', 22) +
      '  ' +
      pad('raw date (as stored)', 40) +
      '  ' +
      pad('_id', 24),
  );
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const parsed = parsedMap.get(row._id.toString());
    const typed = parsed?.date ? parsed.date.toISOString() : '(unparseable)';
    const raw = formatDisplayDate(row.date);
    console.log(
      pad(i + 1, 3) +
        ' ' +
        pad(typed, 22) +
        '  ' +
        pad(raw.length > 38 ? raw.slice(0, 35) + '…' : raw, 40) +
        '  ' +
        row._id.toString(),
    );
  }
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(`connecting to ${MONGODB_URI}…`);
  await mongoose.connect(MONGODB_URI);

  const Expense = mongoose.connection.collection('expenses');

  const rows = await Expense.find(
    {},
    { projection: { _id: 1, date: 1, created_at: 1, entity: 1, user_id: 1 } },
  ).toArray();

  console.log(`loaded ${rows.length} expense rows\n`);

  // 1) Type histogram
  const typeHist = new Map();
  for (const r of rows) {
    const t = bsonTypeOf(r.date);
    typeHist.set(t, (typeHist.get(t) ?? 0) + 1);
  }
  console.log('── 1. BSON type histogram for `expenses.date` ──');
  for (const [t, n] of [...typeHist.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(t, 10)}  ${n}`);
  }

  // 2) Parse coverage + samples of each failure reason
  const parsed = new Map();
  const reasonHist = new Map();
  const reasonSamples = new Map();
  for (const r of rows) {
    const p = parseExpenseDateProto(r.date);
    parsed.set(r._id.toString(), p);
    reasonHist.set(p.reason, (reasonHist.get(p.reason) ?? 0) + 1);
    if (!reasonSamples.has(p.reason)) reasonSamples.set(p.reason, []);
    const bucket = reasonSamples.get(p.reason);
    if (bucket.length < 5) bucket.push(r);
  }
  console.log('\n── 2. Prototype parser coverage ──');
  for (const [reason, n] of [...reasonHist.entries()].sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${pad(reason, 22)}  ${n}`);
  }
  console.log('  samples per reason (up to 5):');
  for (const [reason, samples] of reasonSamples) {
    console.log(`  • ${reason}`);
    for (const s of samples) {
      console.log(
        `      ${pad(s._id.toString(), 26)}  ${formatDisplayDate(s.date)}`,
      );
    }
  }

  // 3) Side-by-side sort comparison
  //
  // Current broken sort: emulates Mongo's lex sort on whatever shape
  // is in `date`. For mixed-type fields Mongo orders by BSON type
  // first (String < Date), but for head/tail intuition the simpler
  // `lexCmp(String(value))` gets us close enough — the point is
  // showing the USER how off the current ordering is, not bit-for-bit
  // Mongo emulation.
  //
  // Proposed chronological sort: by the parsed typed date descending;
  // unparseable rows fall to the very end (sorted by _id descending
  // as a deterministic tiebreak).
  const FAR_PAST = -Infinity;
  const currentDesc = [...rows].sort((a, b) => lexCmp(b.date, a.date));
  const proposedDesc = [...rows].sort((a, b) => {
    const pa = parsed.get(a._id.toString()).date;
    const pb = parsed.get(b._id.toString()).date;
    const ta = pa ? pa.getTime() : FAR_PAST;
    const tb = pb ? pb.getTime() : FAR_PAST;
    if (ta !== tb) return tb - ta;
    return a._id.toString() < b._id.toString() ? 1 : -1;
  });

  const HEAD = 12;
  const TAIL = 5;
  printTable(
    '3a. CURRENT (broken) sort, head = newest? NO',
    currentDesc.slice(0, HEAD),
    parsed,
  );
  printTable(
    '3b. CURRENT (broken) sort, tail = oldest? NO',
    currentDesc.slice(-TAIL),
    parsed,
  );
  printTable(
    '4a. PROPOSED chronological sort, head',
    proposedDesc.slice(0, HEAD),
    parsed,
  );
  printTable(
    '4b. PROPOSED chronological sort, tail',
    proposedDesc.slice(-TAIL),
    parsed,
  );

  // 5) Migration summary — how Option C lands in practice
  let alreadyTyped = 0;
  let needsBackfill = 0;
  let needsReview = 0;
  for (const r of rows) {
    const p = parsed.get(r._id.toString());
    if (p.reason === 'already_date') alreadyTyped++;
    else if (p.date) needsBackfill++;
    else needsReview++;
  }
  console.log('\n── 5. Option C migration budget ──');
  console.log(
    `  rows already typed (Date)            : ${alreadyTyped} — nothing to do`,
  );
  console.log(
    `  rows parseable from string → Date    : ${needsBackfill} — backfill writes date_at`,
  );
  console.log(
    `  rows unparseable (need manual review): ${needsReview}`,
  );
  if (needsReview > 0) {
    console.log(
      `  → sample ids: ${[...reasonSamples.get('unparseable') ?? []]
        .map((r) => r._id.toString())
        .slice(0, 5)
        .join(', ')}`,
    );
  }

  console.log(
    '\nDONE. No writes. Re-run after any schema / pipeline change to verify.',
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('analysis failed:', err);
  process.exitCode = 1;
  mongoose.disconnect().catch(() => {});
});
