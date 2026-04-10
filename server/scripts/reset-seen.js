#!/usr/bin/env node
/**
 * Dev helper: reset \Seen flags on the configured IMAP folder.
 *
 * Connects to the IMAP server using the stored CurveConfig credentials,
 * opens the configured folder (e.g. "Curve Receipts"), finds all
 * messages currently flagged \Seen, and removes the flag — making them
 * UNSEEN again so the next `POST /sync` reprocesses them.
 *
 * This is the IMAP-side counterpart of `cleanup-sync.js`: run cleanup
 * first (to wipe Expenses + CurveLogs from Mongo), then reset-seen
 * (to unmark the emails), then sync again from scratch.
 *
 * Safety:
 *   - Prints a summary of what it will do BEFORE acting
 *   - Requires explicit "y" confirmation on stdin
 *   - Only touches the configured imap_folder, never other folders
 *   - Does NOT delete any emails — just flips a flag
 *
 * Usage:
 *   cd server && node scripts/reset-seen.js
 *
 * Env:
 *   MONGODB_URI — same as the dev server (.env)
 */

import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { createInterface } from 'readline';
import dotenv from 'dotenv';
import { ImapFlow } from 'imapflow';

import CurveConfig from '../src/models/CurveConfig.js';

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

  // Load the real config (not the __fixture_test__ one).
  const config = await CurveConfig.findOne({
    imap_server: { $ne: '__fixture_test__' },
  }).lean();
  if (!config) {
    console.log('No real CurveConfig found. Nothing to do.');
    return;
  }

  const folder = config.imap_folder || 'INBOX';
  const useTls = config.imap_tls !== false;
  console.log(`  server:  ${config.imap_server}:${config.imap_port ?? (useTls ? 993 : 1993)}`);
  console.log(`  user:    ${config.imap_username}`);
  console.log(`  folder:  ${folder}`);
  console.log(`  TLS:     ${useTls}`);

  // Connect to IMAP.
  const client = new ImapFlow({
    host: config.imap_server,
    port: config.imap_port ?? (useTls ? 993 : 1993),
    secure: useTls,
    auth: { user: config.imap_username, pass: config.imap_password },
    logger: false,
  });
  client.on('error', () => {}); // prevent unhandled crash

  await client.connect();
  console.log('  IMAP connected.');

  await client.mailboxOpen(folder);

  // Search for SEEN messages only — those are the ones we'd reset.
  const seenUids = await client.search({ seen: true }, { uid: true });
  const unseenUids = await client.search({ seen: false }, { uid: true });

  console.log(`\n== Briefing ==`);
  console.log(`  Folder:         ${folder}`);
  console.log(`  SEEN messages:  ${seenUids.length}  (will be reset to UNSEEN)`);
  console.log(`  UNSEEN now:     ${unseenUids.length} (untouched)`);
  console.log(`  Total:          ${seenUids.length + unseenUids.length}`);

  if (seenUids.length === 0) {
    console.log('\nNo SEEN messages to reset. Nothing to do.');
    await client.logout();
    return;
  }

  console.log(`\nThis will remove the \\Seen flag from ${seenUids.length} messages`);
  console.log(`in "${folder}". No emails are deleted — just unmarked.`);
  console.log(`After this, the next sync will reprocess all of them.`);

  const answer = await ask('\nProceed? (y/N) ');
  if (answer !== 'y') {
    console.log('Aborted.');
    await client.logout();
    return;
  }

  // Remove \Seen flag in one batch STORE command.
  await client.messageFlagsRemove(
    { uid: seenUids.join(',') },
    ['\\Seen'],
    { uid: true },
  );

  console.log(`\nDone. ${seenUids.length} messages reset to UNSEEN in "${folder}".`);
  await client.logout();
}

main()
  .catch((e) => {
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect().catch(() => {}));
