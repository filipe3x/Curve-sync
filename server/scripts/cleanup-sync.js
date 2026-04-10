#!/usr/bin/env node
/**
 * Dev helper: wipe Expenses + CurveLogs from real sync runs.
 *
 * This is the Mongo-side counterpart of `reset-seen.js`: run this
 * first (to delete the inserted data), then reset-seen (to unmark
 * the emails on the IMAP server), then sync again from scratch.
 *
 * Scope:
 *   - Finds the REAL CurveConfig (imap_server ≠ '__fixture_test__')
 *   - Finds ALL CurveLogs linked to that config_id
 *   - Finds ALL Expenses whose _id is referenced by those logs
 *     (status='ok', dry_run=false, expense_id present)
 *   - Optionally resets CurveConfig stats (last_sync_at, counters)
 *
 * What it does NOT touch:
 *   - The CurveConfig document itself (credentials stay)
 *   - Expenses NOT linked to any CurveLog (manual entries, Embers)
 *   - The __fixture_test__ config and its artefacts (use
 *     cleanup-test-orchestrator.js for that)
 *
 * Safety:
 *   - Prints a full briefing with counts and sample data BEFORE acting
 *   - Requires explicit "y" confirmation on stdin
 *   - Never touches expenses that don't have a CurveLog link
 *
 * Usage:
 *   cd server && node scripts/cleanup-sync.js
 *
 * Env:
 *   MONGODB_URI — same as the dev server (.env)
 */

import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { createInterface } from 'readline';
import dotenv from 'dotenv';

import CurveConfig from '../src/models/CurveConfig.js';
import CurveLog from '../src/models/CurveLog.js';
import Expense from '../src/models/Expense.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: resolve(__dirname, '../.env') });

const MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/embers_db';

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function main() {
  console.log(`Connecting to ${MONGODB_URI}...`);
  await mongoose.connect(MONGODB_URI);

  // Find the real config (not the fixture test one).
  const config = await CurveConfig.findOne({
    imap_server: { $ne: '__fixture_test__' },
  });
  if (!config) {
    console.log('No real CurveConfig found. Nothing to clean.');
    return;
  }
  console.log(`Found CurveConfig ${config._id} (${config.imap_server})`);

  // Count logs by status and dry_run.
  const logsByStatus = await CurveLog.aggregate([
    { $match: { config_id: config._id } },
    { $group: { _id: { status: '$status', dry_run: '$dry_run' }, count: { $sum: 1 } } },
    { $sort: { '_id.dry_run': 1, '_id.status': 1 } },
  ]);

  const totalLogs = logsByStatus.reduce((sum, g) => sum + g.count, 0);

  // Collect expense_ids from real (non-dry-run) ok logs.
  const expenseIds = await CurveLog.distinct('expense_id', {
    config_id: config._id,
    status: 'ok',
    dry_run: false,
    expense_id: { $exists: true, $ne: null },
  });

  // Also collect expense_ids from dry-run logs (should be zero, but
  // let's be explicit about what we're NOT deleting).
  const dryRunLogCount = logsByStatus
    .filter((g) => g._id.dry_run === true)
    .reduce((sum, g) => sum + g.count, 0);
  const realLogCount = totalLogs - dryRunLogCount;

  // Sample a few expenses to show what will be deleted.
  const sampleExpenses = await Expense.find({ _id: { $in: expenseIds.slice(0, 8) } })
    .select('entity amount date card digest')
    .lean();

  // ---- Briefing ----
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  BRIEFING — cleanup of real sync data`);
  console.log(`${'='.repeat(50)}`);
  console.log(`\n  Config:    ${config._id}`);
  console.log(`  Server:    ${config.imap_server}`);
  console.log(`  Folder:    ${config.imap_folder || 'INBOX'}`);
  console.log(`\n  CurveLogs to delete: ${totalLogs}`);
  for (const g of logsByStatus) {
    const tag = g._id.dry_run ? ' (dry run)' : '';
    console.log(`    ${g._id.status}${tag}: ${g.count}`);
  }
  console.log(`\n  Expenses to delete:  ${expenseIds.length}`);
  console.log(`    (only expenses linked via CurveLog.expense_id)`);
  if (sampleExpenses.length > 0) {
    console.log(`\n  Sample expenses:`);
    for (const e of sampleExpenses) {
      console.log(
        `    - ${e.entity}  €${e.amount}  ${e.date}  [${e.digest.slice(0, 12)}…]`,
      );
    }
    if (expenseIds.length > sampleExpenses.length) {
      console.log(`    ... and ${expenseIds.length - sampleExpenses.length} more`);
    }
  }
  console.log(`\n  Config stats to reset:`);
  console.log(`    last_sync_at:           ${config.last_sync_at ?? '(null)'}`);
  console.log(`    last_sync_status:       ${config.last_sync_status ?? '(null)'}`);
  console.log(`    emails_processed_total: ${config.emails_processed_total}`);
  console.log(`    last_email_at:          ${config.last_email_at ?? '(null)'}`);

  console.log(`\n  NOT touched:`);
  console.log(`    - CurveConfig credentials (imap_server, password, etc.)`);
  console.log(`    - imap_folder + imap_folder_confirmed_at`);
  console.log(`    - Expenses not linked to any CurveLog`);
  console.log(`    - __fixture_test__ config (use cleanup-test-orchestrator.js)`);
  console.log();

  if (totalLogs === 0 && expenseIds.length === 0) {
    console.log('Nothing to clean — no logs or expenses found for this config.');
    return;
  }

  const answer = await ask('Proceed with deletion? (y/N) ');
  if (answer !== 'y') {
    console.log('Aborted.');
    return;
  }

  // ---- Delete ----
  console.log('\nDeleting...');

  if (expenseIds.length > 0) {
    const r = await Expense.deleteMany({ _id: { $in: expenseIds } });
    console.log(`  Expenses:   ${r.deletedCount} deleted`);
  }

  const r2 = await CurveLog.deleteMany({ config_id: config._id });
  console.log(`  CurveLogs:  ${r2.deletedCount} deleted`);

  // Reset config stats so the dashboard doesn't show stale data.
  await CurveConfig.updateOne(
    { _id: config._id },
    {
      $set: {
        last_sync_at: null,
        last_sync_status: null,
        last_email_at: null,
        emails_processed_total: 0,
        is_syncing: false,
      },
    },
  );
  console.log(`  Config:     stats reset (last_sync_at, counters, etc.)`);

  console.log('\nCleanup done. Run reset-seen.js next to unmark emails on IMAP.');
}

main()
  .catch((e) => {
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect().catch(() => {}));
