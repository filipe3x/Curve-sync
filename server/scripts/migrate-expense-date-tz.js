#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * migrate-expense-date-tz.js — correct `expenses.date` values that
 * were stored with the body wall clock mis-interpreted as the server's
 * local timezone.
 *
 * Why this exists
 * ---------------
 * Curve emails embed the transaction time in Europe/Lisbon wall clock
 * ("24 April 2026 15:40:02") with no timezone marker. Until the fix
 * that ships alongside this script, `parseExpenseDate` funneled the
 * string through `Date.parse`, which V8 reads as the *host's* local
 * timezone. On the LA/PDT production server that turned "15:40" into
 * 22:40 UTC (15:40 PDT = 22:40 UTC) — an 8 h drift during Lisbon WEST,
 * 7 h during Lisbon WET. The same bug on the earlier UTC host
 * produced a 1 h drift during WEST (and 0 during WET — invisible).
 *
 * What this script does
 * ---------------------
 * For each candidate row:
 *
 *   1. Recover the body wall clock: `body = stored_UTC_numerals + server_offset_at_created_at`
 *      Because `Date.parse(body, localAtServer)` stored `body - server_offset_to_UTC`.
 *   2. Re-interpret those numerals as Europe/Lisbon → true UTC moment.
 *   3. If the new UTC differs from the stored UTC, queue an update.
 *
 * Server-offset lookup uses `Intl.DateTimeFormat` with
 * America/Los_Angeles (or whatever `--server-tz` is set to) applied
 * at the row's `created_at` — so WEST/WET transitions are handled
 * correctly without bundling a TZ database.
 *
 * For rows whose `created_at < --cutoff-date` we assume the ingest
 * host was UTC (the Raspberry Pi / earlier VPS); for rows at or after
 * the cutoff we use `--server-tz`. Both ranges go through the same
 * recovery logic — the only difference is the server offset at
 * `created_at`.
 *
 * Rows where `created_at` is missing (pre-Mongoose inserts) are
 * SKIPPED and listed at the end so the operator can decide case by
 * case. Rows parseable only by Date.parse with seconds-level drift
 * get reported but not touched.
 *
 * Modes
 * -----
 *   (default)              DRY RUN. Prints every planned change, plus a
 *                          summary. Zero writes.
 *
 *   --apply                Executes the plan via `bulkWrite`. Requires
 *                          the operator to pass `--yes` too.
 *
 *   --yes                  Skip the interactive confirmation.
 *
 *   --cutoff-date=ISO      `created_at` boundary between UTC host and
 *                          `--server-tz` host. Defaults to the dev
 *                          dump date 2026-04-19T11:05:52Z — the last
 *                          moment the old UTC host was writing rows.
 *
 *   --server-tz=IANA       TZ of the host handling post-cutoff rows.
 *                          Default: America/Los_Angeles.
 *
 *   --since=ISO            Only look at rows with `created_at >= ISO`.
 *                          Useful to scope a dry-run to today's rows.
 *
 *   --entity-like=substr   Only rows whose `entity` contains substr.
 *                          Case-insensitive. Quick way to check a
 *                          specific merchant.
 *
 * Usage
 * -----
 *   node server/scripts/migrate-expense-date-tz.js                       # full dry run
 *   node server/scripts/migrate-expense-date-tz.js --since=2026-04-24    # scope to today
 *   node server/scripts/migrate-expense-date-tz.js --entity-like=Celeiro # one merchant
 *   node server/scripts/migrate-expense-date-tz.js --apply --yes         # actually write
 *
 * Environment: loads `server/.env` (MONGODB_URI) via dotenv. Override
 * by exporting MONGODB_URI before invoking.
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';

// Anchor dotenv to server/.env regardless of cwd.
dotenv.config({ path: new URL('../.env', import.meta.url) });

const MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/embers_db';

// -------- arg parsing --------
const args = new Map();
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--')) {
    const [k, v = 'true'] = a.slice(2).split('=');
    args.set(k, v);
  }
}
const APPLY = args.has('apply');
const CONFIRMED = args.has('yes');
const CUTOFF_DATE = new Date(args.get('cutoff-date') ?? '2026-04-19T11:05:52Z');
const SERVER_TZ = args.get('server-tz') ?? 'America/Los_Angeles';
const SINCE = args.has('since') ? new Date(args.get('since')) : null;
const ENTITY_LIKE = args.get('entity-like') ?? null;

if (Number.isNaN(CUTOFF_DATE.getTime())) {
  console.error(`invalid --cutoff-date: ${args.get('cutoff-date')}`);
  process.exit(2);
}
if (SINCE && Number.isNaN(SINCE.getTime())) {
  console.error(`invalid --since: ${args.get('since')}`);
  process.exit(2);
}

// -------- TZ offset helpers --------
//
// Given a UTC instant and an IANA zone, return the zone's offset at
// that instant in milliseconds (positive = zone ahead of UTC). Uses
// the same two-pass Intl trick as services/expenseDate.js, inlined
// here so the script has zero dependencies on the live codebase.
function tzOffsetMsAt(instantMs, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(instantMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const h = get('hour');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    h === 24 ? 0 : h,
    get('minute'),
    get('second'),
  );
  return asUtc - instantMs;
}

// Server offset (ms) at the moment `created_at` — determines how much
// the buggy Date.parse shifted the body numerals. Rows before the
// cutoff are on the old UTC host (offset 0); rows on or after are on
// `SERVER_TZ`.
function serverOffsetMs(createdAt) {
  if (!createdAt) return null;
  if (createdAt.getTime() < CUTOFF_DATE.getTime()) return 0;
  return tzOffsetMsAt(createdAt.getTime(), SERVER_TZ);
}

// Given the buggy-stored UTC Date and the server's offset at parse
// time, recover what the body wall clock was:
//
//   stored_UTC = body_numerals_as_UTC - server_offset
//   body_numerals_as_UTC = stored_UTC + server_offset
//
// Those numerals reinterpreted as Europe/Lisbon then give the true
// UTC moment.
function correctFromBuggyStored(stored, serverOffset) {
  // Step 1: put the body numerals back.
  const bodyNumeralsMs = stored.getTime() + serverOffset;
  const bodyDate = new Date(bodyNumeralsMs);
  // Step 2: pull them out as a Europe/Lisbon wall clock. We read the
  // UTC components directly because `bodyNumeralsMs` is those
  // numerals packed as UTC.
  const y = bodyDate.getUTCFullYear();
  const mo = bodyDate.getUTCMonth();
  const d = bodyDate.getUTCDate();
  const h = bodyDate.getUTCHours();
  const mi = bodyDate.getUTCMinutes();
  const s = bodyDate.getUTCSeconds();
  // Step 3: re-interpret as Lisbon. Same two-pass trick as the parser.
  const guess = Date.UTC(y, mo, d, h, mi, s);
  const lisbonOffset = tzOffsetMsAt(guess, 'Europe/Lisbon');
  return new Date(guess - lisbonOffset);
}

// Classify a row for the audit report.
function classify(row, serverOffset, corrected) {
  if (!row.date || !(row.date instanceof Date)) return 'non_date';
  if (!row.created_at) return 'no_created_at';
  const delta = corrected.getTime() - row.date.getTime();
  if (delta === 0) return 'already_correct';
  return 'needs_update';
}

function fmtDelta(ms) {
  const sign = ms >= 0 ? '+' : '-';
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  const s = Math.floor((abs % 60_000) / 1000);
  return `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function pad(v, n) {
  const s = String(v);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

// -------- main --------

async function main() {
  console.log(`connecting to ${MONGODB_URI.replace(/:[^/@]+@/, ':***@')}…`);
  await mongoose.connect(MONGODB_URI);

  const q = {};
  if (SINCE) q.created_at = { $gte: SINCE };
  if (ENTITY_LIKE) q.entity = { $regex: ENTITY_LIKE, $options: 'i' };

  const rows = await mongoose.connection
    .collection('expenses')
    .find(q, {
      projection: { _id: 1, date: 1, created_at: 1, entity: 1, amount: 1 },
    })
    .sort({ created_at: 1 })
    .toArray();

  console.log(`loaded ${rows.length} rows (filter=${JSON.stringify(q) || '{}'})`);
  console.log(`cutoff-date: ${CUTOFF_DATE.toISOString()} (rows before → UTC host, after → ${SERVER_TZ})`);
  console.log(`server-tz:   ${SERVER_TZ}`);
  console.log();

  const buckets = {
    needs_update: [],
    already_correct: [],
    no_created_at: [],
    non_date: [],
  };

  for (const r of rows) {
    const serverOffset = serverOffsetMs(r.created_at);
    if (serverOffset == null || !(r.date instanceof Date)) {
      buckets[r.date instanceof Date ? 'no_created_at' : 'non_date'].push(r);
      continue;
    }
    const corrected = correctFromBuggyStored(r.date, serverOffset);
    const klass = classify(r, serverOffset, corrected);
    buckets[klass].push({ row: r, corrected, serverOffset });
  }

  // ---- report ----
  console.log('=== Summary ===');
  console.log(`  needs_update:    ${buckets.needs_update.length}`);
  console.log(`  already_correct: ${buckets.already_correct.length}`);
  console.log(`  no_created_at:   ${buckets.no_created_at.length}  (skipped)`);
  console.log(`  non_date:        ${buckets.non_date.length}  (skipped)`);
  console.log();

  if (buckets.needs_update.length > 0) {
    console.log('=== Proposed updates ===');
    console.log(
      pad('entity', 28) + pad('amount', 10) + pad('created_at', 26) +
      pad('stored → corrected', 55) + 'delta',
    );
    // Print at most 50 rows; beyond that just show the tail.
    const show = buckets.needs_update.length > 60
      ? buckets.needs_update.slice(0, 30).concat([null]).concat(buckets.needs_update.slice(-20))
      : buckets.needs_update;
    for (const item of show) {
      if (item == null) {
        console.log(`  … ${buckets.needs_update.length - 50} rows omitted …`);
        continue;
      }
      const { row, corrected } = item;
      const delta = corrected.getTime() - row.date.getTime();
      console.log(
        '  ' +
          pad((row.entity || '').slice(0, 26), 28) +
          pad(`€${Number(row.amount).toFixed(2)}`, 10) +
          pad(row.created_at.toISOString(), 26) +
          pad(`${row.date.toISOString()} → ${corrected.toISOString()}`, 55) +
          fmtDelta(delta),
      );
    }
    console.log();
  }

  if (buckets.no_created_at.length > 0) {
    console.log('=== Skipped (no created_at) ===');
    for (const r of buckets.no_created_at.slice(0, 20)) {
      console.log(`  _id=${r._id}  entity=${r.entity}  date=${r.date?.toISOString?.() ?? r.date}`);
    }
    if (buckets.no_created_at.length > 20) {
      console.log(`  … ${buckets.no_created_at.length - 20} more`);
    }
    console.log();
  }

  // Distribution of deltas so the operator can sanity-check at a glance.
  if (buckets.needs_update.length > 0) {
    const hist = new Map();
    for (const { row, corrected } of buckets.needs_update) {
      const h = Math.round((corrected.getTime() - row.date.getTime()) / 3_600_000);
      hist.set(h, (hist.get(h) ?? 0) + 1);
    }
    const keys = [...hist.keys()].sort((a, b) => a - b);
    console.log('=== Delta histogram (hours) ===');
    for (const k of keys) {
      console.log(`  ${k >= 0 ? '+' : ''}${k}h  ${hist.get(k)}`);
    }
    console.log();
  }

  // ---- apply ----
  if (!APPLY) {
    console.log('DRY RUN — no writes. Re-run with --apply --yes to execute.');
    await mongoose.disconnect();
    return;
  }
  if (!CONFIRMED) {
    console.log('--apply requires --yes to confirm. Aborting without writes.');
    await mongoose.disconnect();
    process.exit(1);
  }

  if (buckets.needs_update.length === 0) {
    console.log('Nothing to write. Exiting.');
    await mongoose.disconnect();
    return;
  }

  console.log(`writing ${buckets.needs_update.length} updates…`);
  const ops = buckets.needs_update.map(({ row, corrected }) => ({
    updateOne: {
      filter: { _id: row._id },
      update: { $set: { date: corrected } },
    },
  }));

  const BULK_CHUNK = 500;
  let written = 0;
  for (let i = 0; i < ops.length; i += BULK_CHUNK) {
    const chunk = ops.slice(i, i + BULK_CHUNK);
    const res = await mongoose.connection.collection('expenses').bulkWrite(chunk, { ordered: false });
    written += res.modifiedCount ?? chunk.length;
    console.log(`  chunk ${i / BULK_CHUNK + 1}: modified ${res.modifiedCount ?? '?'} / ${chunk.length}`);
  }
  console.log(`done. ${written} rows updated.`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
