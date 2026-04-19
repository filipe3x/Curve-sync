#!/usr/bin/env node
/**
 * Dev helper: reset \Seen flags on the configured IMAP folder.
 *
 * Connects to the IMAP server using the stored CurveConfig credentials
 * (OAuth2 **or** legacy App Password), opens the configured folder
 * (e.g. "Curve Receipts"), finds all messages currently flagged \Seen,
 * and removes the flag — making them UNSEEN again so the next
 * `POST /sync` reprocesses them.
 *
 * This is the IMAP-side counterpart of `cleanup-sync.js`: run cleanup
 * first (to wipe Expenses + CurveLogs from Mongo), then reset-seen
 * (to unmark the emails), then sync again from scratch.
 *
 * Auth branches (mirrors `createImapReader` in src/services/imapReader.js):
 *   - **OAuth (wizard path)**: `config.oauth_provider` is set. We ask
 *     the MSAL cache plugin for a fresh access token via
 *     `getOAuthToken(config)` and pass `{ user, accessToken }` to
 *     imapflow, which speaks XOAUTH2 SASL.
 *   - **Legacy App Password**: `config.oauth_provider` is null. We use
 *     `{ user, pass }` from the config's `imap_password` field (which
 *     the in-app AES-GCM decryption has already resolved).
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
 *   MONGODB_URI         — same as the dev server (.env)
 *   IMAP_ENCRYPTION_KEY — required for OAuth configs (decrypts the
 *                         MSAL token cache). Must match the value the
 *                         wizard used when writing the config.
 *   AZURE_CLIENT_ID,
 *   AZURE_TENANT_ID     — required for OAuth configs (MSAL needs them
 *                         to exchange the refresh token).
 */

import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { createInterface } from 'readline';
import dotenv from 'dotenv';
import { ImapFlow } from 'imapflow';

import CurveConfig from '../src/models/CurveConfig.js';
import {
  getOAuthToken,
  OAuthReAuthRequired,
} from '../src/services/oauthManager.js';

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
  const authMode = config.oauth_provider
    ? `OAuth (${config.oauth_provider})`
    : 'App Password (legacy)';
  console.log(`  server:  ${config.imap_server}:${config.imap_port ?? (useTls ? 993 : 1993)}`);
  console.log(`  user:    ${config.imap_username}`);
  console.log(`  folder:  ${folder}`);
  console.log(`  TLS:     ${useTls}`);
  console.log(`  auth:    ${authMode}`);

  // Resolve the imapflow `auth` shape based on the config branch. OAuth
  // configs go through MSAL's silent-refresh path (getOAuthToken) and
  // hand imapflow `{ user, accessToken }` for XOAUTH2 SASL. Legacy
  // configs keep the original `{ user, pass }` path.
  let auth;
  if (config.oauth_provider) {
    try {
      const accessToken = await getOAuthToken(config);
      auth = { user: config.imap_username, accessToken };
    } catch (e) {
      if (e instanceof OAuthReAuthRequired) {
        console.error(
          '\nFATAL: OAuth re-auth required — abre a wizard em /curve/setup ' +
            'e volta a autorizar a conta antes de correr este script.',
        );
        console.error(`  detail: ${e.message}`);
        process.exitCode = 1;
        return;
      }
      throw e;
    }
  } else {
    auth = { user: config.imap_username, pass: config.imap_password };
  }

  // Connect to IMAP.
  const client = new ImapFlow({
    host: config.imap_server,
    port: config.imap_port ?? (useTls ? 993 : 1993),
    secure: useTls,
    auth,
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
