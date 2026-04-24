#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * migrate-expense-date-from-imap.js — correct every `expenses.date`
 * row by re-reading the authoritative UTC moment from the source of
 * truth: the email's MIME `Date:` header (`envelope.date` in
 * imapflow).
 *
 * Why we need this
 * ----------------
 * Earlier ingestion stored the body timestamp ("24 April 2026
 * 15:40:02") via `Date.parse`, which interpreted it as the host's
 * local TZ. The LA/PDT prod server produced an 8 h drift. The old
 * UTC host produced a 1 h drift during Lisbon WEST. And the body's
 * own TZ isn't even stable: Celeiro emits Europe/Lisbon, Continente
 * and Vodafone emit CEST, Apple emits US Eastern, Aliexpress emits
 * UTC+2 — so no single-TZ migration covers every row. The MIME
 * `Date:` header is always `+0000` and always correct. This script
 * pulls it for every email in the Curve folder and updates the
 * matching expense (matched by `digest`) in Mongo.
 *
 * What this script does
 * ---------------------
 *   1. For each `CurveConfig` (filterable via `--user-id`),
 *      `createImapReader(config)` to open the configured folder.
 *   2. Fetch ALL messages (SEEN + UNSEEN) in the folder with
 *      `envelope: true, source: true`.
 *   3. For each email:
 *        - Parse the body via `emailParser.parseEmail(source)` to
 *          recover the digest (entity + amount + date_string + card
 *          → SHA-256).
 *        - Look up the expense by `{ digest, user_id }` in Mongo.
 *        - Compare `expense.date` with `envelope.date`. If different,
 *          queue an update.
 *   4. Dry-run by default. Print a table of proposed updates grouped
 *      by delta. Apply with `--apply --yes`.
 *
 * Rows whose email no longer exists in the folder are listed as
 * "no_email" and left alone — you may want to hunt them in Trash /
 * Archive manually.
 *
 * Rows whose body fails to parse are listed as "parse_error" and
 * skipped — usually older Curve templates whose parser drift isn't
 * worth fixing retroactively.
 *
 * Modes
 * -----
 *   (default)            DRY RUN. Prints plan + summary. Zero writes.
 *
 *   --apply --yes        Executes the plan via bulkWrite.
 *
 *   --user-id=<ObjectId> Only process this user's config.
 *
 *   --entity-like=substr Only report updates for expenses whose
 *                        entity contains substr (case-insensitive).
 *                        Reading still pulls the whole folder.
 *
 *   --max-emails=N       Cap on emails fetched per config (default
 *                        10000). Safety net for huge mailboxes.
 *
 * Usage
 * -----
 *   node server/scripts/migrate-expense-date-from-imap.js
 *   node server/scripts/migrate-expense-date-from-imap.js --entity-like=Celeiro
 *   node server/scripts/migrate-expense-date-from-imap.js --apply --yes
 *
 * Environment: loads `server/.env` (MONGODB_URI, AZURE_CLIENT_ID,
 * IMAP_ENCRYPTION_KEY …) via dotenv. Requires the user to have a
 * valid OAuth token cache on `CurveConfig.oauth_token_cache` —
 * `createImapReader` refreshes it silently.
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import CurveConfig from '../src/models/CurveConfig.js';
import Expense from '../src/models/Expense.js';
import { createImapReader } from '../src/services/imapReader.js';
import { parseEmail, ParseError } from '../src/services/emailParser.js';
import { parseExpenseDateOrNull } from '../src/services/expenseDate.js';

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
const USER_ID = args.get('user-id') ?? null;
const ENTITY_LIKE = args.get('entity-like') ?? null;
const MAX_EMAILS = Number(args.get('max-emails') ?? 10000);
// Updated-receipt guard: Curve re-emits receipts hours/days after the
// original transaction (subject prefixed "Updated Curve Receipt: …")
// and the MIME Date on the re-emission is *not* the transaction
// moment — it's when the update was sent. We detect this by
// comparing the envelope to the body's own date string (parsed as
// numerals-in-UTC): any |diff| greater than --update-threshold-h
// hours is treated as an updated receipt and skipped. Default 12 h
// covers every real-world body TZ (max observed is PDT UTC-7) while
// flagging clear re-emissions (usually > 24 h).
const UPDATE_THRESHOLD_MS =
  Number(args.get('update-threshold-h') ?? 12) * 3_600_000;

function fmtDelta(ms) {
  const sign = ms >= 0 ? '+' : '-';
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  const s = Math.floor((abs % 60_000) / 1000);
  return `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function pad(v, n) {
  const s = String(v ?? '');
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

// -------- core per-config run --------

async function processConfig(config) {
  const header = `config _id=${config._id} user=${config.user_id} folder="${config.imap_folder || 'INBOX'}"`;
  console.log(`\n=== ${header} ===`);

  const reader = await createImapReader(config);
  await reader.connect();
  await reader.openFolder();

  // Fetch ALL messages in the folder — we need envelope + source for
  // every receipt Curve has ever emitted. `{ all: true }` is the
  // imapflow search shorthand for "match everything in the mailbox".
  const entries = [];
  let fetched = 0;
  try {
    for await (const msg of reader.client.fetch(
      { all: true },
      { uid: true, envelope: true, source: true },
    )) {
      if (!msg.source) continue;
      const source = Buffer.isBuffer(msg.source)
        ? msg.source.toString('latin1')
        : String(msg.source);
      const envelopeDate = msg.envelope?.date instanceof Date
        ? msg.envelope.date
        : null;
      entries.push({ uid: msg.uid, source, envelopeDate });
      fetched += 1;
      if (fetched >= MAX_EMAILS) {
        console.log(`  hit --max-emails=${MAX_EMAILS}, stopping fetch`);
        break;
      }
    }
  } finally {
    try { await reader.close(); } catch { /* best effort */ }
  }

  console.log(`  fetched ${entries.length} emails from folder`);

  const stats = {
    no_envelope: 0,
    parse_error: 0,
    no_expense: 0,
    already_correct: 0,
    updated_receipt_skipped: 0,
    needs_update: 0,
  };
  const updates = [];
  const skippedUpdates = [];
  const deltaHist = new Map();

  for (const { uid, source, envelopeDate } of entries) {
    if (!envelopeDate) { stats.no_envelope++; continue; }
    let parsed;
    try {
      parsed = parseEmail(source);
    } catch (e) {
      stats.parse_error++;
      if (!(e instanceof ParseError)) {
        console.warn(`  uid=${uid}: unexpected parse error: ${e.message}`);
      }
      continue;
    }
    // Filter early: if --entity-like is set and doesn't match, skip
    // the Mongo lookup.
    if (
      ENTITY_LIKE &&
      !(parsed.entity || '').toLowerCase().includes(ENTITY_LIKE.toLowerCase())
    ) {
      continue;
    }
    const expense = await Expense.findOne(
      { digest: parsed.digest, user_id: config.user_id },
      { _id: 1, entity: 1, amount: 1, date: 1 },
    ).lean();
    if (!expense) { stats.no_expense++; continue; }

    // Updated-receipt guard: compare envelope to body-date parsed as
    // numerals-in-UTC. If they differ by more than the threshold, the
    // envelope is from a re-emitted receipt and we must NOT overwrite
    // the original transaction moment with it.
    const bodyAsUtcMs = parseExpenseDateOrNull(parsed.date)?.getTime?.() ?? null;
    if (
      bodyAsUtcMs != null &&
      Math.abs(envelopeDate.getTime() - bodyAsUtcMs) > UPDATE_THRESHOLD_MS
    ) {
      stats.updated_receipt_skipped++;
      skippedUpdates.push({
        _id: expense._id,
        entity: expense.entity,
        amount: expense.amount,
        storedDate: expense.date,
        envelopeDate,
        bodyDateStr: parsed.date,
        gapMs: envelopeDate.getTime() - bodyAsUtcMs,
      });
      continue;
    }
    const currentMs = expense.date instanceof Date ? expense.date.getTime() : null;
    const envelopeMs = envelopeDate.getTime();
    if (currentMs === envelopeMs) {
      stats.already_correct++;
      continue;
    }
    stats.needs_update++;
    const deltaMs = envelopeMs - (currentMs ?? envelopeMs);
    const deltaH = Math.round(deltaMs / 3_600_000);
    deltaHist.set(deltaH, (deltaHist.get(deltaH) ?? 0) + 1);
    updates.push({
      _id: expense._id,
      entity: expense.entity,
      amount: expense.amount,
      storedDate: expense.date,
      envelopeDate,
      deltaMs,
    });
  }

  // ---- report ----
  console.log('  Summary:');
  for (const [k, v] of Object.entries(stats)) console.log(`    ${k}: ${v}`);

  if (updates.length > 0) {
    console.log('\n  Proposed updates:');
    console.log(
      '    ' +
        pad('entity', 26) + pad('amount', 10) +
        pad('stored → envelope', 55) + 'delta',
    );
    const show = updates.length > 60
      ? updates.slice(0, 30).concat([null]).concat(updates.slice(-20))
      : updates;
    for (const u of show) {
      if (u == null) {
        console.log(`    … ${updates.length - 50} rows omitted …`);
        continue;
      }
      console.log(
        '    ' +
          pad((u.entity || '').slice(0, 24), 26) +
          pad(`€${Number(u.amount).toFixed(2)}`, 10) +
          pad(
            `${u.storedDate?.toISOString?.() ?? u.storedDate} → ${u.envelopeDate.toISOString()}`,
            55,
          ) +
          fmtDelta(u.deltaMs),
      );
    }

    console.log('\n  Delta histogram (hours):');
    for (const [h, c] of [...deltaHist.entries()].sort((a, b) => a[0] - b[0])) {
      console.log(`    ${h >= 0 ? '+' : ''}${h}h  ${c}`);
    }
  }

  if (skippedUpdates.length > 0) {
    console.log(`\n  Updated-receipt skips (envelope-body gap > ${UPDATE_THRESHOLD_MS / 3_600_000}h — re-emitted receipts where the envelope is not the transaction moment):`);
    console.log(
      '    ' +
        pad('entity', 26) + pad('amount', 10) +
        pad('stored (kept as-is)', 26) + pad('envelope (ignored)', 26) + 'gap',
    );
    for (const u of skippedUpdates) {
      console.log(
        '    ' +
          pad((u.entity || '').slice(0, 24), 26) +
          pad(`€${Number(u.amount).toFixed(2)}`, 10) +
          pad(u.storedDate?.toISOString?.() ?? '?', 26) +
          pad(u.envelopeDate.toISOString(), 26) +
          fmtDelta(u.gapMs),
      );
    }
  }

  // ---- apply ----
  if (!APPLY || updates.length === 0) return { stats, updates };

  if (!CONFIRMED) {
    console.log('\n  --apply requires --yes to confirm. Skipping writes for this config.');
    return { stats, updates };
  }

  console.log(`\n  Writing ${updates.length} updates…`);
  const BULK_CHUNK = 500;
  const ops = updates.map((u) => ({
    updateOne: {
      filter: { _id: u._id },
      update: { $set: { date: u.envelopeDate } },
    },
  }));
  let written = 0;
  for (let i = 0; i < ops.length; i += BULK_CHUNK) {
    const chunk = ops.slice(i, i + BULK_CHUNK);
    const res = await mongoose.connection
      .collection('expenses')
      .bulkWrite(chunk, { ordered: false });
    written += res.modifiedCount ?? chunk.length;
    console.log(`    chunk ${i / BULK_CHUNK + 1}: modified ${res.modifiedCount ?? '?'} / ${chunk.length}`);
  }
  console.log(`  done. ${written} rows updated.`);
  return { stats, updates };
}

// -------- main --------

async function main() {
  console.log(`connecting to ${MONGODB_URI.replace(/:[^/@]+@/, ':***@')}…`);
  await mongoose.connect(MONGODB_URI);

  const q = {};
  if (USER_ID) q.user_id = new mongoose.Types.ObjectId(USER_ID);
  const configs = await CurveConfig.find(q);
  console.log(`found ${configs.length} config(s)${USER_ID ? ` for user ${USER_ID}` : ''}`);

  for (const config of configs) {
    try {
      await processConfig(config);
    } catch (e) {
      console.error(`config ${config._id}: FAILED — ${e.message}`);
      if (e.code) console.error(`  code=${e.code}`);
    }
  }

  if (!APPLY) {
    console.log('\nDRY RUN — no writes. Re-run with --apply --yes to execute.');
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
