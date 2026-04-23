#!/usr/bin/env node
/**
 * Cleanup script for test-orchestrator.js artefacts.
 *
 * Surgically undoes everything the fixture-based orchestrator test
 * inserts into the shared MongoDB instance:
 *
 *   1. The CurveConfig row with `imap_server = '__fixture_test__'`
 *   2. Every CurveLog entry whose `config_id` matches that row
 *   3. Every Expense whose `_id` is referenced by one of those log
 *      entries (status='ok', dry_run=false, expense_id present)
 *
 * Why this scoping is safe:
 *   - CurveLogs are matched by `config_id`, which is unique to the
 *     test config — no risk of touching logs from the real sync.
 *   - Expenses are matched by the `expense_id` link stored in the
 *     test's own CurveLog entries — NEVER by digest or user_id, which
 *     could collide with real production expenses made with the same
 *     Curve card on the same fixture dates.
 *   - Dry-run CurveLog entries have no `expense_id` (nothing was
 *     inserted) so they contribute zero expenses to the delete list.
 *
 * Usage:
 *   cd server && node scripts/cleanup-test-orchestrator.js
 *
 * Exit code: 0 always on success, 1 on fatal Mongo error. Running
 * against a clean DB (test config not present) is a no-op.
 */

import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import dotenv from 'dotenv';

import CurveConfig from '../src/models/CurveConfig.js';
import CurveLog from '../src/models/CurveLog.js';
import Expense from '../src/models/Expense.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: resolve(__dirname, '../.env') });

const MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/embers_db';

const TEST_MARKER = '__fixture_test__';

async function main() {
  console.log(`Connecting to ${MONGODB_URI}...`);
  await mongoose.connect(MONGODB_URI);

  const testConfig = await CurveConfig.findOne({ imap_server: TEST_MARKER });
  if (!testConfig) {
    console.log(`No test config found (imap_server='${TEST_MARKER}'). Nothing to clean.`);
    return;
  }
  console.log(`Found test CurveConfig ${testConfig._id}`);

  // Collect the expense_ids that the orchestrator actually inserted
  // under this test config. This excludes dry-run entries (no
  // expense_id) and duplicate entries (no expense_id written either).
  const expenseIds = await CurveLog.distinct('expense_id', {
    config_id: testConfig._id,
    status: 'ok',
    dry_run: false,
    expense_id: { $exists: true, $ne: null },
  });
  console.log(`  expenses to delete: ${expenseIds.length}`);
  if (expenseIds.length > 0) {
    const sampleExpenses = await Expense.find({ _id: { $in: expenseIds } })
      .select('entity amount date digest')
      .lean();
    for (const e of sampleExpenses) {
      console.log(
        `    - ${e.entity} €${e.amount} ${e.date} [${e.digest.slice(0, 12)}…]`,
      );
    }
  }

  const logCount = await CurveLog.countDocuments({ config_id: testConfig._id });
  console.log(`  log entries to delete: ${logCount}`);

  console.log('\nDeleting...');
  if (expenseIds.length > 0) {
    const r = await Expense.deleteMany({ _id: { $in: expenseIds } });
    console.log(`  expenses: ${r.deletedCount} deleted`);
  }
  const r2 = await CurveLog.deleteMany({ config_id: testConfig._id });
  console.log(`  logs:     ${r2.deletedCount} deleted`);
  const r3 = await CurveConfig.deleteOne({ _id: testConfig._id });
  console.log(`  config:   ${r3.deletedCount} deleted`);

  console.log('\nCleanup done.');
}

main()
  .catch((e) => {
    console.error('FATAL:', e);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect().catch(() => {}));
