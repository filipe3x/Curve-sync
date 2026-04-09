#!/usr/bin/env node
/**
 * Smoke test for server/src/services/syncOrchestrator.js using the
 * FixtureReader against a real MongoDB instance.
 *
 * This is the primary dev loop for the orchestrator on the Pi: it
 * runs the full parser → digest → dedup → insert → log pipeline
 * against real Mongo but ZERO IMAP traffic, so the production
 * `Curve Receipts` folder on Outlook is never touched.
 *
 * The test executes three passes to exercise every branch:
 *
 *   1. Dry run   — parser + exists() query, no writes. Confirms the
 *                  orchestrator can traverse fixtures without side
 *                  effects. CurveConfig stats are NOT updated.
 *   2. Real run  — full inserts. On a clean DB, every fixture should
 *                  land as `ok`. CurveConfig.last_sync_at /
 *                  emails_processed_total move; `last_email_at`
 *                  does NOT (FixtureReader doesn't poison the canary).
 *   3. Re-run    — same fixtures again. Every one should hit the
 *                  digest unique index → land as `duplicate`. Proves
 *                  the recovery invariant and the 11000 + keyPattern
 *                  check.
 *
 * Usage:
 *   cd server && node scripts/test-orchestrator.js [fixture_dir]
 *
 * Env:
 *   MONGODB_URI — same as the dev server (.env)
 *
 * Safety:
 *   - Uses a dedicated test CurveConfig (finds or creates one with
 *     `imap_server = '__fixture_test__'`) so it cannot collide with
 *     the real production config row.
 *   - Does NOT delete any data on exit. Inspect the `expenses` and
 *     `curve_logs` collections afterwards to verify the rows exist.
 *     To re-run from a clean state, delete the fixture digests
 *     manually or use a dedicated Mongo database via MONGODB_URI.
 */

import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import dotenv from 'dotenv';

import CurveConfig from '../src/models/CurveConfig.js';
import { FixtureReader, syncEmails } from '../src/services/syncOrchestrator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load server/.env relative to this script's location so the script
// works whether invoked from repo root or from server/.
dotenv.config({ path: resolve(__dirname, '../.env') });

const fixtureDir = process.argv[2] || resolve(__dirname, '../test/fixtures/emails');
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/embers_db';

const TEST_MARKER = '__fixture_test__';

function printSummary(label, s) {
  console.log(`\n== ${label} ==`);
  console.log(
    `  total=${s.total}  ok=${s.ok}  dup=${s.duplicates}  ` +
      `parseErrors=${s.parseErrors}  errors=${s.errors}  ` +
      `halted=${s.halted}  dryRun=${s.dryRun}  ${s.durationMs}ms`,
  );
}

function assertEq(label, actual, expected) {
  if (actual !== expected) {
    console.error(`  FAIL ${label}: expected ${expected}, got ${actual}`);
    process.exitCode = 1;
  } else {
    console.log(`  ok   ${label}: ${actual}`);
  }
}

// Mongoose returns `undefined` (not `null`) for schema fields that have
// no explicit default and were never set — `last_email_at` follows the
// same pattern as `last_sync_at`. Use this helper for "this field must
// remain unset" checks so the test accepts both null and undefined.
function assertNullish(label, actual) {
  if (actual != null) {
    console.error(`  FAIL ${label}: expected null/undefined, got ${actual}`);
    process.exitCode = 1;
  } else {
    console.log(`  ok   ${label}: ${actual}`);
  }
}

async function main() {
  console.log(`Connecting to ${MONGODB_URI}...`);
  await mongoose.connect(MONGODB_URI);

  // Find or create a dedicated test config. We cannot use the real
  // production config because its imap_server points at the real
  // mailbox — we'd risk confusing it with the real sync target in
  // logs, and we'd inherit whatever its last_sync_at / counters are.
  let config = await CurveConfig.findOne({ imap_server: TEST_MARKER });
  if (!config) {
    // Need a user_id — borrow one from the real config if present,
    // otherwise invent a throwaway ObjectId. Either way the fixture
    // test never talks to a real user record.
    const realConfig = await CurveConfig.findOne({
      imap_server: { $ne: TEST_MARKER },
    });
    const user_id = realConfig?.user_id ?? new mongoose.Types.ObjectId();
    config = await CurveConfig.create({
      user_id,
      imap_server: TEST_MARKER,
      imap_port: 0,
      imap_username: 'fixture-runner',
      imap_password: 'n/a',
      imap_tls: false,
      imap_folder: 'fixtures',
      sync_enabled: false,
      sync_interval_minutes: 0,
    });
    console.log(`Created test CurveConfig ${config._id}`);
  } else {
    console.log(`Reusing test CurveConfig ${config._id}`);
  }

  // ---- Pass 1: dry run ----
  const dry = await syncEmails({
    config: config.toObject(),
    reader: new FixtureReader(fixtureDir),
    dryRun: true,
  });
  printSummary('dry run', dry);
  assertEq('dry.dryRun', dry.dryRun, true);
  assertEq('dry.parseErrors', dry.parseErrors, 0);
  assertEq('dry.errors', dry.errors, 0);
  assertEq('dry.halted', dry.halted, false);

  // ---- Pass 2: real insert ----
  const real1 = await syncEmails({
    config: config.toObject(),
    reader: new FixtureReader(fixtureDir),
    dryRun: false,
  });
  printSummary('real insert (first run)', real1);
  assertEq('real1.parseErrors', real1.parseErrors, 0);
  assertEq('real1.errors', real1.errors, 0);
  assertEq('real1.halted', real1.halted, false);
  // ok + duplicates should equal total — real1 is either all new
  // (clean DB) or mixed if the fixtures were already inserted by a
  // previous run. Both are valid end states.
  assertEq('real1 accounting', real1.ok + real1.duplicates, real1.total);

  // ---- Pass 3: re-run → must be all duplicates ----
  const real2 = await syncEmails({
    config: config.toObject(),
    reader: new FixtureReader(fixtureDir),
    dryRun: false,
  });
  printSummary('real insert (re-run)', real2);
  assertEq('real2.ok', real2.ok, 0);
  assertEq('real2.duplicates', real2.duplicates, real2.total);
  assertEq('real2.parseErrors', real2.parseErrors, 0);
  assertEq('real2.errors', real2.errors, 0);

  // ---- Verify CurveConfig stats were updated (real runs only) ----
  const after = await CurveConfig.findById(config._id).lean();
  console.log(`\n== CurveConfig after all runs ==`);
  console.log(`  last_sync_at:            ${after.last_sync_at}`);
  console.log(`  last_sync_status:        ${after.last_sync_status}`);
  console.log(`  emails_processed_total:  ${after.emails_processed_total}`);
  console.log(`  last_email_at:           ${after.last_email_at ?? '(null)'}`);
  console.log(`  is_syncing:              ${after.is_syncing}`);
  assertEq('last_sync_status', after.last_sync_status, 'ok');
  assertEq('is_syncing', after.is_syncing, false);
  // Canary stays unset because FixtureReader is not an ImapReader.
  // Mongoose returns `undefined` for never-set Date fields with no
  // default, so this must accept both null and undefined.
  assertNullish('last_email_at (should stay unset)', after.last_email_at);

  await mongoose.disconnect();
  console.log(
    process.exitCode === 1 ? '\nFAILED' : '\nPASSED (inspect collections to verify)',
  );
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
  mongoose.disconnect().catch(() => {});
});
