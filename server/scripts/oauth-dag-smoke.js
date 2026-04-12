#!/usr/bin/env node
/**
 * End-to-end smoke test for the Microsoft OAuth V2 pipeline.
 *
 * Runs the full Device Authorization Grant flow against real Azure AD
 * using the same code paths that the web wizard will use (PR 5+),
 * then opens a real IMAP connection to outlook.office365.com:993 via
 * imapflow XOAUTH2 and lists the folders. No MongoDB, no web UI —
 * just a standalone script you can run from the terminal to validate
 * that everything from Azure App Registration → MSAL → cache plugin
 * → imapflow works before any web plumbing exists.
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │ Pre-req: server/.env has AZURE_CLIENT_ID set to your app's │
 *   │ client id (see .env.example for the full checklist).        │
 *   └────────────────────────────────────────────────────────────┘
 *
 * Usage:
 *
 *   node server/scripts/oauth-dag-smoke.js your.email@outlook.com
 *
 * First run:
 *   - Prints a short code and a URL (https://microsoft.com/devicelogin)
 *   - You open the URL in a browser, paste the code, sign in,
 *     consent to the permissions
 *   - Script resumes, opens IMAP, lists folders, exits OK
 *   - Cache is saved to /tmp/oauth-dag-smoke-cache.json (mode 0600)
 *
 * Second run (any time within the refresh token TTL):
 *   - No device code — acquireTokenSilent serves the cached token or
 *     transparently refreshes it via refresh_token grant
 *   - Opens IMAP straight away
 *
 * Clean up:
 *
 *   node server/scripts/oauth-dag-smoke.js --clean
 *
 * Wipes the cache file. Use this before committing anything, before
 * handing the machine to someone else, or any time you want to force
 * a fresh DAG. The cache holds a real refresh token — treat it like
 * a password.
 *
 * This script is the canonical sanity check before the wizard lands.
 * When PR 5 adds the real web flow, everything below the DAG input
 * step stays the same — the only change is where the code is
 * displayed (React card instead of console.log) and where the cache
 * is persisted (CurveConfig.oauth_token_cache instead of /tmp).
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';

// Pick up AZURE_CLIENT_ID / AZURE_TENANT_ID from server/.env without
// having to run the whole server. Falls back to process.env if no file.
loadDotenv({ path: join(process.cwd(), 'server', '.env') });
loadDotenv({ path: join(process.cwd(), '.env') });

import { ImapFlow } from 'imapflow';
import { buildMsalApp, getOAuthToken } from '../src/services/oauthManager.js';
import { createCachePlugin } from '../src/services/oauthCachePlugin.js';

// ----- Config --------------------------------------------------------

const CACHE_FILE = process.env.OAUTH_SMOKE_CACHE_FILE
  || join(tmpdir(), 'oauth-dag-smoke-cache.json');

const CLIENT_ID = process.env.AZURE_CLIENT_ID;
const TENANT_ID = process.env.AZURE_TENANT_ID || 'common';

// argv[2] is either '--clean' or an email. No other shapes.
const firstArg = process.argv[2];
const cleanMode = firstArg === '--clean';
const email = cleanMode ? null : firstArg;

// ----- Pretty logging ------------------------------------------------

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

function step(n, msg) {
  console.log(`\n${bold(`[${n}]`)} ${msg}`);
}

function fail(msg, extra) {
  console.error(`\n${red('FAIL')} ${msg}`);
  if (extra) console.error(dim(extra));
  process.exit(1);
}

// ----- Pre-flight checks ---------------------------------------------
// --clean runs without any Azure config at all — it's just a file
// remove. Keep the preflight ordering so the happy path (passing an
// email) gets the full error messages.

if (cleanMode) {
  if (existsSync(CACHE_FILE)) {
    unlinkSync(CACHE_FILE);
    console.log(green(`removed ${CACHE_FILE}`));
  } else {
    console.log(dim(`nothing to remove at ${CACHE_FILE}`));
  }
  process.exit(0);
}

if (!CLIENT_ID) {
  fail(
    'AZURE_CLIENT_ID is not set',
    'Put it in server/.env or export it before running. See server/.env.example for the\n' +
      'full App Registration checklist.',
  );
}
if (!email) {
  fail(
    'missing email argument',
    'Usage: node server/scripts/oauth-dag-smoke.js your.email@outlook.com\n' +
      '       node server/scripts/oauth-dag-smoke.js --clean',
  );
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  fail(`not a valid email: ${email}`);
}

// ----- Plaintext file-backed cache (smoke-only) ----------------------
//
// The real production cache plugin encrypts the blob and persists it
// to CurveConfig.oauth_token_cache. For this standalone smoke we use
// the exact same plugin factory but override the loader/saver to read
// and write a local JSON file in plaintext. The blob is sensitive —
// delete it when you're done (or use the OAUTH_SMOKE_CACHE_FILE env
// to redirect it to a secure scratch location).

function makeFileCache() {
  return {
    loadCache: async () => {
      if (!existsSync(CACHE_FILE)) return null;
      return readFileSync(CACHE_FILE, 'utf8');
    },
    saveCache: async (_userId, plaintext) => {
      writeFileSync(CACHE_FILE, plaintext, { mode: 0o600 });
    },
    onCorrupted: (uid, msg) => {
      console.warn(yellow(`  cache corrupted: ${msg}`));
    },
  };
}

// ----- Shared MSAL app builder ---------------------------------------
//
// Uses buildMsalApp's overrides seam to inject a file-backed plugin
// instead of the default Mongo-backed one. Everything else (clientId,
// authority, logger) goes through the same code path the production
// sync will use.

function buildApp(userId) {
  const cachePlugin = createCachePlugin(userId, makeFileCache());
  return buildMsalApp(
    {
      user_id: userId,
      oauth_provider: 'microsoft',
      oauth_client_id: CLIENT_ID,
      oauth_tenant_id: TENANT_ID,
    },
    { cachePlugin },
  );
}

// ----- Phase 1: obtain an account (cached or via DAG) ----------------
//
// The cache file might already have an account from a previous run.
// If it does, skip the DAG entirely — that's the whole point of the
// refresh token. If not, run the DAG interactively.

async function ensureAccount(app) {
  const cache = app.getTokenCache();
  const accounts = await cache.getAllAccounts();
  if (accounts.length > 0) {
    console.log(green('  cached account found → skipping DAG'));
    console.log(`  username: ${cyan(accounts[0].username)}`);
    console.log(`  homeAccountId: ${dim(accounts[0].homeAccountId)}`);
    return accounts[0];
  }

  console.log(dim('  no cached account → starting DAG'));

  const scopes = [
    'https://outlook.office.com/IMAP.AccessAsUser.All',
    'offline_access',
  ];

  const result = await app.acquireTokenByDeviceCode({
    scopes,
    deviceCodeCallback: (resp) => {
      console.log('');
      console.log(bold('  ╔══════════════════════════════════════════════════╗'));
      console.log(bold('  ║              MICROSOFT AUTHORIZATION             ║'));
      console.log(bold('  ╚══════════════════════════════════════════════════╝'));
      console.log('');
      console.log(`  1. Open: ${cyan(resp.verificationUri)}`);
      console.log(`  2. Enter this code:`);
      console.log('');
      console.log(`      ${bold(green(resp.userCode))}`);
      console.log('');
      console.log(`  3. Sign in as ${cyan(email)}`);
      console.log(`  4. Approve the requested permissions`);
      console.log('');
      console.log(dim(`  (this page will wait — expires in ${resp.expiresIn}s)`));
      console.log('');
    },
  });

  console.log(green('  DAG completed'));
  console.log(`  username: ${cyan(result.account.username)}`);
  console.log(`  homeAccountId: ${dim(result.account.homeAccountId)}`);

  if (result.account.username.toLowerCase() !== email.toLowerCase()) {
    console.warn(
      yellow(
        `  WARN: signed in as ${result.account.username} but CLI arg was ${email} — ` +
          'using the account MSAL returned',
      ),
    );
  }
  return result.account;
}

// ----- Phase 2: fresh token via the production getOAuthToken ---------
//
// This deliberately reuses getOAuthToken from oauthManager.js — the
// same helper that imapReader.js will call in PR 4. Proves the code
// path works end-to-end against real Azure AD, not against a stub.

async function getToken(account) {
  const fakeConfig = {
    user_id: 'oauth-dag-smoke',
    oauth_provider: 'microsoft',
    oauth_client_id: CLIENT_ID,
    oauth_tenant_id: TENANT_ID,
    oauth_account_id: account.homeAccountId,
  };
  // Rebuild the app with our file-backed cache so getOAuthToken's
  // internal buildMsalApp is bypassed via the override.
  const app = buildApp(fakeConfig.user_id);
  return getOAuthToken(fakeConfig, { app });
}

// ----- Phase 3: real IMAP connection + folder list -------------------
//
// The same call imapReader.js makes. If this works, the whole OAuth
// pipeline is working end-to-end: Azure → MSAL → cache plugin →
// getOAuthToken → imapflow XOAUTH2 → outlook.office365.com:993.

async function imapListFolders(username, accessToken) {
  const client = new ImapFlow({
    host: 'outlook.office365.com',
    port: 993,
    secure: true,
    auth: { user: username, accessToken },
    logger: false,
    disableAutoIdle: true,
  });

  await client.connect();
  try {
    const folders = await client.list();
    return folders.map((f) => f.path);
  } finally {
    await client.logout().catch(() => {});
  }
}

// ----- Main ----------------------------------------------------------

async function main() {
  console.log(bold('\nMicrosoft OAuth DAG + IMAP smoke test'));
  console.log(dim(`  client_id:  ${CLIENT_ID}`));
  console.log(dim(`  tenant:     ${TENANT_ID}`));
  console.log(dim(`  email:      ${email}`));
  console.log(dim(`  cache file: ${CACHE_FILE}`));

  step(1, 'Building MSAL app with file-backed cache');
  const app = buildApp('oauth-dag-smoke');

  step(2, 'Ensuring we have an authorized account');
  const account = await ensureAccount(app);

  step(3, 'Acquiring fresh access token via getOAuthToken');
  const token = await getToken(account);
  console.log(green(`  got token (${token.length} chars)`));
  console.log(dim(`  preview: ${token.slice(0, 24)}...${token.slice(-8)}`));

  step(4, 'Opening IMAP connection to outlook.office365.com:993');
  const folders = await imapListFolders(account.username, token);
  console.log(green(`  connected & listed ${folders.length} folders:`));
  for (const path of folders.slice(0, 25)) {
    console.log(`    - ${path}`);
  }
  if (folders.length > 25) {
    console.log(dim(`    ... and ${folders.length - 25} more`));
  }

  console.log(`\n${green(bold('ALL GREEN'))} — OAuth + IMAP pipeline works end-to-end.`);
  console.log(dim(`Run the script again to see the refresh path (no DAG prompt).`));
  console.log(
    dim(
      `\nHousekeeping: the cache file below contains a live refresh token.\n` +
        `Treat it like a password. Wipe it when you're done:\n` +
        `  node server/scripts/oauth-dag-smoke.js --clean`,
    ),
  );
  console.log(dim(`  (or: rm ${CACHE_FILE})`));
}

main().catch((err) => {
  console.error('');
  console.error(red('FAIL'), err.message);
  if (err.stack) console.error(dim(err.stack));
  if (err.errorCode) console.error(dim(`errorCode: ${err.errorCode}`));
  process.exit(1);
});
