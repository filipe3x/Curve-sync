#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * analyze-expense-dates.js — audit + one-shot fix for
 * `expenses.date` rows that are still BSON `String` instead of
 * BSON `Date`.
 *
 * Context
 * -------
 * `Expense.date` is now declared as `Date` in the Mongoose schema
 * (matching Embers' Mongoid `field :date, type: DateTime`). Every
 * new insert from either pipeline lands as BSON `Date`. This script
 * exists to clean up rows that were inserted BEFORE that alignment —
 * specifically the dev dump, where 63 rows written by an earlier
 * curve-sync build landed as BSON `String`.
 *
 * Production is already clean (all 1302 rows are BSON `Date` because
 * they all came from Embers/Mongoid), so running this in prod is a
 * no-op — the audit confirms it and no writes happen.
 *
 * BSON type ordering puts `String < Date`, which means Mongoid's
 * cycle filter (`{ :$gte => Date }`) silently drops any String row.
 * Leaving the mixed state in dev is a latent bug — this script
 * closes it.
 *
 * Modes
 * -----
 *   (default, no flags)    Audit only. Histogram of BSON types + parse
 *                          coverage of each String row. Zero writes.
 *
 *   --write                Audit + plan: which rows would be touched,
 *                          which would stay String (unparseable).
 *                          Still zero writes.
 *
 *   --write --yes          Executes the plan: for each parseable String
 *                          row, `$set: { date: <Date> }` via bulkWrite.
 *                          Idempotent — a second run is a no-op because
 *                          the rows are now typed Date and fall out of
 *                          the filter.
 *
 * Usage
 * -----
 *   node server/scripts/analyze-expense-dates.js              # audit
 *   node server/scripts/analyze-expense-dates.js --write      # plan
 *   node server/scripts/analyze-expense-dates.js --write --yes # execute
 *
 * Environment: loads `server/.env` (MONGODB_URI) via dotenv. Override by
 * exporting MONGODB_URI in the shell before invoking.
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Expense from '../src/models/Expense.js';
import { parseExpenseDate } from '../src/services/expenseDate.js';

// Anchor dotenv to server/.env regardless of cwd.
dotenv.config({ path: new URL('../.env', import.meta.url) });

const MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/embers_db';

const CLI_FLAGS = new Set(process.argv.slice(2));
const WRITE = CLI_FLAGS.has('--write');
const CONFIRMED = CLI_FLAGS.has('--yes');
const BULK_CHUNK = 500;

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

async function main() {
  console.log(`connecting to ${MONGODB_URI.replace(/:[^/@]+@/, ':***@')}…`);
  await mongoose.connect(MONGODB_URI);

  // Raw-collection read — bypasses Mongoose's schema coercion so we
  // see the actual BSON types on disk. With the schema now declaring
  // `date: Date`, an `.lean()` call on the model could try to coerce
  // String rows on read and mask the very thing we're looking for.
  const rows = await mongoose.connection
    .collection('expenses')
    .find({}, { projection: { _id: 1, date: 1, entity: 1 } })
    .toArray();

  console.log(`loaded ${rows.length} expense rows\n`);

  if (rows.length === 0) {
    console.warn(
      `⚠  No expenses found. MONGODB_URI might be pointing at an empty DB.\n` +
        `   Connected to: ${MONGODB_URI}\n`,
    );
    await mongoose.disconnect();
    return;
  }

  // 1 · BSON type histogram
  const typeHist = new Map();
  for (const r of rows) {
    const t = bsonTypeOf(r.date);
    typeHist.set(t, (typeHist.get(t) ?? 0) + 1);
  }
  console.log('── 1. BSON type histogram for `expenses.date` ──');
  for (const [t, n] of [...typeHist.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(t, 10)}  ${n}`);
  }

  const stringRows = rows.filter((r) => typeof r.date === 'string');
  if (stringRows.length === 0) {
    console.log('\nAll rows are typed Date already — nothing to do.');
    await mongoose.disconnect();
    return;
  }

  // 2 · Parse coverage of the String rows
  console.log(
    `\n── 2. Parse coverage of the ${stringRows.length} String row(s) ──`,
  );
  const parseable = [];
  const unparseable = [];
  for (const r of stringRows) {
    const p = parseExpenseDate(r.date);
    if (p.date) parseable.push({ row: r, parsed: p.date, reason: p.reason });
    else unparseable.push({ row: r, reason: p.reason });
  }
  console.log(`  parseable       : ${parseable.length}`);
  console.log(`  unparseable     : ${unparseable.length}`);

  if (parseable.length > 0) {
    console.log('\n  samples (up to 5, parseable):');
    for (const s of parseable.slice(0, 5)) {
      console.log(
        `    ${pad(s.row._id.toString(), 26)}  ${JSON.stringify(s.row.date)}` +
          `  →  ${s.parsed.toISOString()}  (${s.reason})`,
      );
    }
  }
  if (unparseable.length > 0) {
    console.log('\n  samples (up to 5, unparseable — manual review):');
    for (const s of unparseable.slice(0, 5)) {
      console.log(
        `    ${pad(s.row._id.toString(), 26)}  ${JSON.stringify(s.row.date)}` +
          `  (${s.reason})`,
      );
    }
  }

  if (!WRITE) {
    console.log(
      '\nDONE (read-only). Re-run with --write to preview a plan, or --write --yes to execute.',
    );
    await mongoose.disconnect();
    return;
  }

  // 3 · Plan
  console.log('\n── 3. Fix plan ──');
  console.log(`  rows to convert (String → Date) : ${parseable.length}`);
  console.log(`  rows that would stay String     : ${unparseable.length}`);

  if (!CONFIRMED) {
    console.log(
      '\nDRY-RUN — no writes performed. Re-run with --write --yes to execute.',
    );
    await mongoose.disconnect();
    return;
  }

  if (parseable.length === 0) {
    console.log(
      '\nNothing to do — no parseable String rows. Unparseable rows need manual review.',
    );
    await mongoose.disconnect();
    return;
  }

  // 4 · Execute — $set each row's `date` to the typed Date via bulkWrite.
  // Filter includes a `$type: 'string'` guard so a second run can't
  // re-touch a row we already fixed.
  const writeOps = parseable.map(({ row, parsed }) => ({
    updateOne: {
      filter: { _id: row._id, date: { $type: 'string' } },
      update: { $set: { date: parsed } },
    },
  }));

  console.log(
    `\nExecuting: ${writeOps.length} ops in chunks of ${BULK_CHUNK}, unordered.`,
  );
  const started = Date.now();
  let okTotal = 0;
  let failTotal = 0;
  for (let i = 0; i < writeOps.length; i += BULK_CHUNK) {
    const chunk = writeOps.slice(i, i + BULK_CHUNK);
    try {
      const result = await mongoose.connection
        .collection('expenses')
        .bulkWrite(chunk, { ordered: false });
      const modified = result.modifiedCount ?? 0;
      okTotal += modified;
      const errs = result.getWriteErrors?.() ?? [];
      failTotal += errs.length;
      const label = `  chunk ${i}–${i + chunk.length - 1}`;
      if (errs.length > 0) {
        console.log(`${label}: ${modified} ok, ${errs.length} failed`);
        for (const e of errs.slice(0, 3)) {
          console.log(
            `    op ${e.index ?? '?'} failed: ${e.errmsg ?? e.message ?? e}`,
          );
        }
      } else {
        console.log(`${label}: ${modified} ok`);
      }
    } catch (err) {
      console.log(
        `  chunk ${i}–${i + chunk.length - 1}: aborted — ${err.message}`,
      );
      failTotal += chunk.length;
    }
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(2);
  console.log(
    `\ncomplete — modified=${okTotal} failed=${failTotal} duration=${elapsed}s`,
  );
  if (unparseable.length > 0) {
    console.log(
      `${unparseable.length} row(s) remain String (unparseable). See sample list above.`,
    );
  }
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
