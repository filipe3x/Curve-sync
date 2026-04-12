#!/usr/bin/env node
/**
 * Smoke-test for §8 items 4 + 5 + 6 of EMAIL_AUTH_MVP.md — the
 * "cache foi apagado → user recupera" happy-sad path.
 *
 * The re-auth path is the single most important failure mode of the
 * wizard, and also the one that's hardest to exercise by accident in
 * dev. This script makes it trivial to break the OAuth cache on a
 * real user and then put it back, so a human can walk through the
 * whole observation loop:
 *
 *   1. node scripts/smoke-reauth.js          → prints current state
 *   2. node scripts/smoke-reauth.js --break  → backs up + nulls the cache
 *   3. click "Sincronizar agora" in the dashboard
 *        → sync fails with OAuthReAuthRequired
 *        → last_sync_status flips to 'error'
 *        → CurveLog gets a new `status=error` entry
 *        → dashboard renders the re-auth banner
 *   4. click "Reautorizar →"  → wizard → complete DAG → sync recovers
 *        → OR use --restore to put the cache back if the wizard is flaky
 *   5. node scripts/smoke-reauth.js --restore  → undoes --break
 *
 * The backup lives at `/tmp/curve-reauth-<config_id>.json` with mode
 * 0600 and holds the encrypted cache blob + account fields. It is NOT
 * a plaintext refresh token — the AES-256-GCM envelope is preserved
 * end-to-end, so even if the file leaks, an attacker still needs
 * `IMAP_ENCRYPTION_KEY` to do anything with it.
 *
 * Safety rails:
 *   - Prints a briefing BEFORE acting and asks for "y" confirmation
 *   - --break refuses to run if there is no cache to break (idempotent)
 *   - --break refuses to run if a backup already exists (would clobber
 *     the original and strand the user); delete the backup manually
 *     after verifying recovery, or run --restore first
 *   - --restore refuses to run if no backup exists
 *   - Only touches configs where `oauth_provider='microsoft'`;
 *     App Password users are invisible to this script
 *   - Does NOT touch `last_sync_status` — the whole point is to watch
 *     the orchestrator flip it itself on the next sync run
 *
 * Usage:
 *
 *   cd server && node scripts/smoke-reauth.js            # status
 *   cd server && node scripts/smoke-reauth.js --break    # backup + null
 *   cd server && node scripts/smoke-reauth.js --restore  # reverse
 *
 * Env: MONGODB_URI — same as the dev server (.env).
 */

import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dotenv from 'dotenv';

import CurveConfig from '../src/models/CurveConfig.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: resolve(__dirname, '../.env') });

const MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/embers_db';

// --- pretty output ---------------------------------------------------

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => {
    rl.question(question, (answer) => {
      rl.close();
      r(answer.trim().toLowerCase());
    });
  });
}

function backupPath(configId) {
  return join(tmpdir(), `curve-reauth-${configId}.json`);
}

// --- modes -----------------------------------------------------------

const MODES = { STATUS: 'status', BREAK: 'break', RESTORE: 'restore' };

function parseMode(argv) {
  const flag = argv[2];
  if (!flag) return MODES.STATUS;
  if (flag === '--break') return MODES.BREAK;
  if (flag === '--restore') return MODES.RESTORE;
  throw new Error(
    `unknown flag "${flag}" — use --break, --restore, or no flag for status`,
  );
}

// --- config lookup ---------------------------------------------------

/**
 * Find the target CurveConfig. We look for a Microsoft OAuth config
 * specifically — App Password users and the fixture config are
 * filtered out. If there are multiple OAuth configs in the DB (second
 * user smoke test in progress), the script refuses to pick one
 * without an explicit CURVE_CONFIG_ID env var.
 */
async function findTargetConfig() {
  const configs = await CurveConfig.find({
    oauth_provider: 'microsoft',
  }).lean();

  if (configs.length === 0) {
    throw new Error(
      'No CurveConfig with oauth_provider="microsoft" found.\n' +
        '  → Complete the wizard at least once before running this script.',
    );
  }

  if (configs.length === 1) return configs[0];

  // Multi-config fallback: require an explicit ID.
  const explicit = process.env.CURVE_CONFIG_ID;
  if (!explicit) {
    const ids = configs.map((c) => `    - ${c._id} (user_id=${c.user_id})`).join('\n');
    throw new Error(
      `Multiple OAuth configs found — ambiguous.\n` +
        `  Set CURVE_CONFIG_ID=<id> to pick one:\n${ids}`,
    );
  }
  const picked = configs.find((c) => String(c._id) === explicit);
  if (!picked) {
    throw new Error(
      `CURVE_CONFIG_ID=${explicit} does not match any OAuth config.`,
    );
  }
  return picked;
}

// --- briefings -------------------------------------------------------

function printStatus(config) {
  const hasCache = Boolean(config.oauth_token_cache);
  const cacheLen = hasCache ? config.oauth_token_cache.length : 0;
  const bak = backupPath(config._id);
  const hasBackup = existsSync(bak);

  console.log(bold('\n== CurveConfig ==\n'));
  console.log(`  _id:                 ${config._id}`);
  console.log(`  user_id:             ${config.user_id}`);
  console.log(`  oauth_provider:      ${config.oauth_provider}`);
  console.log(`  oauth_account_id:    ${config.oauth_account_id || dim('(null)')}`);
  console.log(`  oauth_client_id:     ${config.oauth_client_id || dim('(null)')}`);
  console.log(`  oauth_tenant_id:     ${config.oauth_tenant_id || dim('(null)')}`);
  console.log(
    `  oauth_token_cache:   ${
      hasCache
        ? green(`present (${cacheLen} chars, encrypted)`)
        : red('null — cache is broken')
    }`,
  );
  console.log(`  imap_folder:         ${config.imap_folder || 'INBOX'}`);
  console.log(`  last_sync_at:        ${config.last_sync_at || dim('(never)')}`);
  console.log(
    `  last_sync_status:    ${
      config.last_sync_status === 'error'
        ? red('error')
        : config.last_sync_status || dim('(null)')
    }`,
  );
  console.log(
    `  emails_processed:    ${config.emails_processed_total || 0}`,
  );
  console.log(bold('\n== Backup file =='));
  console.log(`  path:                ${bak}`);
  console.log(
    `  exists:              ${
      hasBackup ? yellow('yes — --restore will use it') : dim('no')
    }`,
  );
  console.log('');
}

// --- break -----------------------------------------------------------

async function doBreak(config) {
  const hasCache = Boolean(config.oauth_token_cache);
  if (!hasCache) {
    console.log(
      red('\nNothing to break: oauth_token_cache is already null.'),
    );
    console.log(
      dim(
        '  Run the wizard to populate the cache first, then come back.',
      ),
    );
    return;
  }

  const bak = backupPath(config._id);
  if (existsSync(bak)) {
    console.log(
      red(`\nBackup already exists at ${bak}.`),
    );
    console.log(
      dim(
        '  Refusing to clobber it. Run --restore first, or delete the\n' +
          '  backup manually if you know the original state is safe.',
      ),
    );
    return;
  }

  console.log(bold('\n== Break briefing ==\n'));
  console.log(
    '  1. Back up oauth_token_cache + oauth_account_id +\n' +
      `     oauth_client_id + oauth_tenant_id to ${bak}\n` +
      '     (encrypted blob is preserved as-is — still AES-256-GCM)',
  );
  console.log(
    '  2. Clear oauth_token_cache on the CurveConfig (set to null)',
  );
  console.log('');
  console.log(bold('  Expected next steps (manual observation):'));
  console.log(
    '    - Click "Sincronizar agora" on the dashboard',
    '\n    - Sync fails with OAuthReAuthRequired',
    '\n    - last_sync_status flips to "error"',
    '\n    - /api/curve/logs shows a new error entry',
    '\n    - Dashboard renders the red re-auth banner',
    '\n    - Click "Reautorizar →" → wizard recovers',
    '\n    - OR run this script with --restore to put the cache back',
  );
  console.log('');

  const answer = await ask('Proceed with --break? (y/N) ');
  if (answer !== 'y') {
    console.log(dim('Aborted.'));
    return;
  }

  // 1. Write backup first so we never leave the config in a broken
  //    state without a recovery path.
  const payload = {
    schema: 1,
    created_at: new Date().toISOString(),
    config_id: String(config._id),
    user_id: String(config.user_id),
    oauth_provider: config.oauth_provider,
    oauth_token_cache: config.oauth_token_cache,
    oauth_account_id: config.oauth_account_id,
    oauth_client_id: config.oauth_client_id,
    oauth_tenant_id: config.oauth_tenant_id,
  };
  writeFileSync(bak, JSON.stringify(payload, null, 2));
  // 0600: owner read/write only. The backup holds the encrypted cache
  // envelope; harmless without IMAP_ENCRYPTION_KEY but still not
  // something to leave world-readable.
  chmodSync(bak, 0o600);
  console.log(green(`  ✓ backup written to ${bak} (mode 0600)`));

  // 2. Null the cache. We deliberately do NOT null oauth_account_id,
  //    oauth_client_id or oauth_tenant_id — `oauthManager.getOAuthToken`
  //    needs them to rebuild the MSAL app and then fails cleanly on the
  //    missing cache, which is exactly the error path we want to
  //    exercise.
  await CurveConfig.updateOne(
    { _id: config._id },
    { $set: { oauth_token_cache: null } },
  );
  console.log(green('  ✓ oauth_token_cache cleared on CurveConfig'));
  console.log(
    dim(
      '\nNow go click "Sincronizar agora" and watch the dashboard +\n' +
        '  /api/curve/logs for the re-auth banner and the error entry.',
    ),
  );
}

// --- restore ---------------------------------------------------------

async function doRestore(config) {
  const bak = backupPath(config._id);
  if (!existsSync(bak)) {
    console.log(
      red(`\nNo backup at ${bak} — nothing to restore.`),
    );
    console.log(
      dim(
        '  Did you already run --restore, or was --break never run?\n' +
          '  Check the status view (no flags) to see the current state.',
      ),
    );
    return;
  }

  let payload;
  try {
    payload = JSON.parse(readFileSync(bak, 'utf8'));
  } catch (e) {
    throw new Error(`backup at ${bak} is not valid JSON: ${e.message}`);
  }
  if (payload.schema !== 1) {
    throw new Error(
      `backup schema ${payload.schema} unknown — expected 1`,
    );
  }
  if (String(payload.config_id) !== String(config._id)) {
    throw new Error(
      `backup config_id (${payload.config_id}) does not match target ` +
        `(${config._id}) — refusing to cross-load.`,
    );
  }

  console.log(bold('\n== Restore briefing ==\n'));
  console.log(`  backup:      ${bak}`);
  console.log(`  created_at:  ${payload.created_at}`);
  console.log(`  config_id:   ${payload.config_id}`);
  console.log(
    `  will set:    oauth_token_cache (${
      payload.oauth_token_cache ? payload.oauth_token_cache.length : 0
    } chars)`,
  );
  console.log('');

  const answer = await ask('Proceed with --restore? (y/N) ');
  if (answer !== 'y') {
    console.log(dim('Aborted.'));
    return;
  }

  await CurveConfig.updateOne(
    { _id: config._id },
    {
      $set: {
        oauth_token_cache: payload.oauth_token_cache,
        // These three are normally untouched by --break, but we put
        // them back too just in case the shape of the CurveConfig
        // drifted between the break and the restore (e.g. someone ran
        // the wizard in between).
        oauth_account_id: payload.oauth_account_id,
        oauth_client_id: payload.oauth_client_id,
        oauth_tenant_id: payload.oauth_tenant_id,
      },
    },
  );
  console.log(green('  ✓ oauth_token_cache restored'));

  unlinkSync(bak);
  console.log(green(`  ✓ backup file ${bak} removed`));
  console.log(
    dim(
      '\nRun a sync to verify the restore — expect last_sync_status=ok.',
    ),
  );
}

// --- main ------------------------------------------------------------

async function main() {
  const mode = parseMode(process.argv);

  console.log(dim(`Connecting to ${MONGODB_URI}...`));
  await mongoose.connect(MONGODB_URI);

  const config = await findTargetConfig();
  printStatus(config);

  if (mode === MODES.STATUS) return;
  if (mode === MODES.BREAK) return doBreak(config);
  if (mode === MODES.RESTORE) return doRestore(config);
}

main()
  .catch((e) => {
    console.error(red(`\nFATAL: ${e.message}`));
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect().catch(() => {}));
