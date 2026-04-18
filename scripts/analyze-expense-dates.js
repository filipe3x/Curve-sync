#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * scripts/analyze-expense-dates.js — expense-date triage + backfill tool
 * for ROADMAP §2.x Opção C.
 *
 * Problem we are sizing up
 * ------------------------
 * `Expense.date` is declared as a String in the Mongoose schema (for
 * bit-for-bit compat with curve.py) and is sorted via `sort({ date: -1 })`
 * by /expenses, the dashboard "Despesas recentes" card, and the
 * /categories detail panel. Because the string is day-first ("06 April
 * 2026 08:53:31"), a lexical sort in Mongo orders primarily by day-of-
 * month — so the most recent row can easily land at the bottom of the
 * list. On top of that, a quick BSON peek at the dev dump showed the
 * field has MIXED TYPES — some rows are strings (curve-sync path),
 * others are BSON Dates (Embers' Mongoid writes, field :date, type:
 * DateTime). BSON's canonical type order puts String < Date, so when
 * the two types coexist a `sort({date: -1})` groups all Date rows at
 * the top and all String rows afterwards regardless of chronology.
 *
 * The long-term fix (Opção C) adds a sibling `date_at: Date` field
 * and moves the sort there. This script handles two of the six steps:
 * read-only audit (any step) and the one-shot backfill (step 3).
 *
 * Modes of operation
 * ------------------
 * The script has three progressive modes, gated by CLI flags:
 *
 *   1. READ-ONLY AUDIT (default, no flags)
 *      Connects, loads every `expenses` row, prints a BSON-type
 *      histogram + prototype parser coverage + side-by-side sort
 *      comparison + migration budget. Zero writes. Safe against prod.
 *
 *   2. BACKFILL PLAN (--write, without --yes)
 *      Same audit output as mode 1 PLUS a plan for the rows that
 *      would be updated: count of rows missing `date_at`, how many
 *      the prototype can parse, how many would stay null
 *      (unparseable), sample ids of each. Still zero writes — this
 *      is the confirmation gate. Rerun with `--yes` to execute.
 *
 *   3. BACKFILL EXECUTION (--write --yes)
 *      Runs the audit, prints the plan, then applies `$set: { date_at }`
 *      via bulkWrite to the rows that need it. Writes are:
 *
 *         • ONLY to rows where `date_at` is currently null/missing
 *           (idempotent — re-running is a no-op);
 *         • chunked at 500 ops per bulkWrite call (scales to tens of
 *           thousands without a fat single request);
 *         • UNORDERED so a single bad row can't halt the batch;
 *         • silent about rows the parser can't handle — they stay at
 *           `date_at: null`, listed in the final report for manual
 *           review. The scripted operator decides what to do with
 *           them (delete, hand-edit, leave alone).
 *
 *      No CurveLog audit rows are written — the backfill is a one-shot
 *      operator action, not a user mutation, so flooding `curve_logs`
 *      with one row per expense would be noise. The script's printed
 *      report is the sole record.
 *
 * The two-flag confirmation (--write --yes) is deliberate: destructive
 * or data-mutating scripts should never write on a single typo. If
 * you forget --yes, you see the plan and bail; if you add --yes by
 * mistake, --write alone still does nothing.
 *
 * Usage
 * -----
 * Run from anywhere inside the repo — the script self-loads the
 * server's .env via createRequire, so no `cd server` or
 * `-r dotenv/config` dance:
 *
 *   # Audit (safe, default)
 *   node scripts/analyze-expense-dates.js
 *
 *   # Preview backfill plan
 *   node scripts/analyze-expense-dates.js --write
 *
 *   # Execute backfill
 *   node scripts/analyze-expense-dates.js --write --yes
 *
 * Environment
 * -----------
 *   MONGODB_URI   — same default as server/src/config/db.js
 *                   (mongodb://localhost:27017/embers_db). Loaded
 *                   from server/.env automatically; also honoured
 *                   if set directly in the process env (overrides
 *                   the .env value).
 */

import { createRequire } from 'node:module';
import mongoose from 'mongoose';
import Expense from '../server/src/models/Expense.js';
import { parseExpenseDate as parseExpenseDateProto } from '../server/src/services/expenseDate.js';

// Load the server's .env ourselves so the script is self-contained —
// runs from anywhere (repo root, server/, scripts/) without needing
// `-r dotenv/config` at invocation. dotenv lives in
// server/node_modules, so we borrow it via createRequire rather than
// making the repo root npm install it separately.
const require = createRequire(import.meta.url);
try {
  const dotenv = require('../server/node_modules/dotenv');
  dotenv.config({
    path: new URL('../server/.env', import.meta.url).pathname,
  });
} catch {
  // .env is optional — MONGODB_URI can come from the process
  // environment directly (e.g. `MONGODB_URI=... node scripts/...`).
}

const MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/embers_db';

// CLI flags. `--write` without `--yes` stops at the plan; `--write
// --yes` actually writes. Unknown flags are ignored silently (the
// script has nothing else to customise).
const CLI_FLAGS = new Set(process.argv.slice(2));
const WRITE = CLI_FLAGS.has('--write');
const CONFIRMED = CLI_FLAGS.has('--yes');

// Bulk-op chunk size. Small enough that a single network round-trip
// is not huge, large enough that tens of thousands of rows finish in
// a handful of round-trips. unordered mode means one failure doesn't
// halt the chunk — the failed op is reported in the write result.
const BULK_CHUNK = 500;

// The parser itself lives in `server/src/services/expenseDate.js` so
// the write paths (sync orchestrator + manual POST) and this script
// share one canonical implementation. Imported under the old name
// (`parseExpenseDateProto`) to keep the rest of this file identical
// to its pre-refactor shape.

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

  // Using the Mongoose model (not the raw collection) so its
  // `date_at` schema + partial index are synced to Mongo on connect.
  // `.lean()` keeps the rows as plain objects — we don't need
  // hydrated docs and the backfill uses bulkWrite directly anyway.
  const rows = await Expense.find(
    {},
    { _id: 1, date: 1, date_at: 1, created_at: 1, entity: 1, user_id: 1 },
  ).lean();

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

  // ─── Backfill mode (--write) ─────────────────────────────────────
  //
  // The read-only audit above already showed what WOULD happen; now
  // we translate that into either a plan (without --yes) or a write
  // (with --yes). Only rows where `date_at` is currently null/missing
  // are touched — running the script a second time after a clean
  // backfill is a no-op because every row already has `date_at` set.

  if (WRITE) {
    console.log('\n── 6. Backfill plan ──');
    const writeOps = [];
    const targetCount = {
      already_has_date_at: 0,
      will_set: 0,
      will_stay_null: 0,
    };
    const willStayNullSamples = [];
    for (const r of rows) {
      if (r.date_at != null) {
        targetCount.already_has_date_at++;
        continue;
      }
      const p = parsed.get(r._id.toString());
      if (p.date) {
        writeOps.push({
          updateOne: {
            filter: { _id: r._id, date_at: null },
            update: { $set: { date_at: p.date } },
          },
        });
        targetCount.will_set++;
      } else {
        targetCount.will_stay_null++;
        if (willStayNullSamples.length < 10) willStayNullSamples.push(r);
      }
    }
    console.log(
      `  rows with date_at already set  : ${targetCount.already_has_date_at} — skip`,
    );
    console.log(
      `  rows to populate this run      : ${targetCount.will_set}`,
    );
    console.log(
      `  rows that would stay null      : ${targetCount.will_stay_null}`,
    );
    if (willStayNullSamples.length > 0) {
      console.log(
        '  sample ids (would stay null — manual review after this run):',
      );
      for (const r of willStayNullSamples) {
        console.log(
          `    ${r._id.toString()}  ${formatDisplayDate(r.date)}`,
        );
      }
    }

    if (!CONFIRMED) {
      console.log(
        '\nDRY-RUN — no writes performed. Re-run with --write --yes to execute.',
      );
      await mongoose.disconnect();
      return;
    }

    // Gate passed — actually run the chunks.
    if (writeOps.length === 0) {
      console.log('\nnothing to do — all rows already have date_at set.');
      await mongoose.disconnect();
      return;
    }

    console.log(
      `\nExecuting backfill: ${writeOps.length} ops in chunks of ${BULK_CHUNK}, unordered.`,
    );
    const started = Date.now();
    let writtenOk = 0;
    let writtenFailed = 0;
    for (let i = 0; i < writeOps.length; i += BULK_CHUNK) {
      const chunk = writeOps.slice(i, i + BULK_CHUNK);
      try {
        const result = await Expense.bulkWrite(chunk, { ordered: false });
        const modified = result.modifiedCount ?? 0;
        writtenOk += modified;
        // `writeErrors` is only populated when individual ops failed;
        // unordered means the rest of the chunk still went through.
        const errs = result.getWriteErrors?.() ?? [];
        writtenFailed += errs.length;
        if (errs.length > 0) {
          console.log(
            `  chunk ${i}–${i + chunk.length - 1}: ${modified} ok, ${errs.length} failed`,
          );
          for (const e of errs.slice(0, 3)) {
            console.log(
              `    op ${e.index ?? '?'} failed: ${e.errmsg ?? e.message ?? e}`,
            );
          }
        } else {
          console.log(
            `  chunk ${i}–${i + chunk.length - 1}: ${modified} ok`,
          );
        }
      } catch (err) {
        // `bulkWrite` rejects only on connection-level failures in
        // unordered mode; per-op errors land on `writeErrors` above.
        console.log(
          `  chunk ${i}–${i + chunk.length - 1}: aborted — ${err.message}`,
        );
        writtenFailed += chunk.length;
      }
    }
    const elapsed = ((Date.now() - started) / 1000).toFixed(2);
    console.log(
      `\nbackfill complete — ok=${writtenOk} failed=${writtenFailed} duration=${elapsed}s`,
    );
    if (targetCount.will_stay_null > 0) {
      console.log(
        `${targetCount.will_stay_null} rows remain with date_at=null (unparseable). See sample list above for manual review.`,
      );
    }
    await mongoose.disconnect();
    return;
  }

  console.log(
    '\nDONE (read-only). Re-run with --write to preview a backfill plan, or --write --yes to execute.',
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('analysis failed:', err);
  process.exitCode = 1;
  mongoose.disconnect().catch(() => {});
});
