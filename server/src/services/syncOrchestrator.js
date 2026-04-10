/**
 * Sync orchestrator for Curve Card receipt emails (Phase 3).
 *
 * Coordinates the full ingestion pipeline:
 *
 *     reader.fetchUnseen()
 *       → parseEmail(source)
 *         → assignCategoryFromList(entity, cachedCategories)
 *           → Expense.create(...)  (duplicate? → log + markSeen)
 *             → CurveLog.create(...)
 *               → reader.markSeen(uid)
 *
 * This module is deliberately NOT coupled to the IMAP transport. It
 * accepts an `EmailReader` (duck-typed) so that:
 *
 *   - Production sync uses `ImapReader` against the real mailbox.
 *   - Development on the Pi uses `FixtureReader` (defined below),
 *     which reads saved `.eml`-style files from disk and has a no-op
 *     `markSeen`. This is how we test the orchestrator end-to-end on
 *     the same box that runs production without any risk of flipping
 *     the \Seen flag on the real Curve Receipts folder.
 *   - Tests can pass any object matching the contract.
 *
 * See docs/EMAIL.md → Phase 3 for the full design rationale
 * (multi-user scoping, duplicate-detection trap, circuit breaker,
 * silent-failure canary, recovery invariants).
 */

import fs from 'node:fs';
import path from 'node:path';

import CurveConfig from '../models/CurveConfig.js';
import CurveLog from '../models/CurveLog.js';
import Expense from '../models/Expense.js';
import Category from '../models/Category.js';
import { parseEmail, ParseError } from './emailParser.js';
import { assignCategoryFromList } from './expense.js';
import { ImapReader } from './imapReader.js';

// ---------- Tunables ----------

/**
 * Circuit breaker: if the orchestrator sees this many consecutive
 * `parse_error` with zero `ok` in the same run, it halts to avoid a
 * retry storm caused by (e.g.) a Curve template change that broke the
 * parser on every incoming email. State is per-run only — no
 * persistent poison-pill tracking; the dashboard surfaces the
 * `last_sync_status = 'error'` signal instead.
 */
const PARSE_ERROR_CIRCUIT_BREAKER = 10;

/**
 * Upper bound on the `error_detail` text written to CurveLog. Verbose
 * stack traces with `cause` chains easily reach 5 KB; combined with
 * the 90-day TTL on curve_logs, that would bloat the collection under
 * any sustained failure. 2000 chars is enough to read a human-friendly
 * message + the first few stack frames.
 */
const MAX_ERROR_DETAIL = 2000;

// ---------- In-memory concurrency lock (per-config) ----------
//
// Prevents overlapping syncs for the SAME config while allowing
// different users to sync in parallel. Each entry is a config._id
// string. The route layer and scheduler check this before calling
// syncEmails(). Intentionally module-level so every caller shares
// the same state.

const running = new Set();

/**
 * @param {string} [configId] - If provided, checks whether that
 *   specific config is syncing. If omitted, returns true if ANY
 *   sync is running (useful for global status checks).
 */
export function isSyncing(configId) {
  return configId ? running.has(String(configId)) : running.size > 0;
}

/**
 * Thrown when `syncEmails()` is called while another run is still in
 * progress. The route layer should catch this and return HTTP 409.
 */
export class SyncConflictError extends Error {
  constructor(message = 'sync already in progress') {
    super(message);
    this.name = 'SyncConflictError';
  }
}

// ---------- Utilities ----------

function truncateDetail(value) {
  const str = value == null ? '' : String(value);
  return str.length > MAX_ERROR_DETAIL
    ? `${str.slice(0, MAX_ERROR_DETAIL)}…`
    : str;
}

/**
 * Check whether a MongoServerError from `Expense.create(...)` is a
 * digest-collision duplicate specifically (as opposed to any other
 * future unique index). This is the trap documented in Phase 3: a
 * bare `err.code === 11000` check would silently classify other
 * unique-index violations as duplicates and skip them.
 */
function isDigestDuplicate(err) {
  if (err?.code !== 11000) return false;
  // Mongoose bubbles the key pattern from the driver error.
  return Boolean(err.keyPattern?.digest || err.keyValue?.digest);
}

// ---------- FixtureReader (dev / tests) ----------

/**
 * EmailReader that reads raw email files from a directory. Each file
 * becomes one `{uid, source}` pair, with `uid` set to the file's
 * zero-based index in the sorted directory listing. `markSeen` and
 * `close` are no-ops. `connect` validates the directory.
 *
 * This is the dev-loop alternative to ImapReader on the Pi. Running
 * `syncEmails({ config, reader: new FixtureReader(...) })` exercises
 * the parser → digest → dedup → insert → log → summary pipeline
 * against real Mongo with zero IMAP traffic, so the production
 * `Curve Receipts` folder is never touched.
 *
 * Matches the byte-for-byte `latin1` convention used by
 * `validate-fixtures.js` and `ImapReader.fetchUnseen()`, so
 * `emailParser.extractHtml()` runs unchanged on the output.
 */
export class FixtureReader {
  constructor(dir) {
    this.dir = dir;
    this.files = [];
  }

  async connect() {
    let entries;
    try {
      entries = await fs.promises.readdir(this.dir, { withFileTypes: true });
    } catch (e) {
      throw new Error(`FixtureReader: cannot read ${this.dir}: ${e.message}`);
    }
    // Sort for deterministic UID assignment and filter out dotfiles +
    // directories. We do NOT care about extensions — the email
    // fixtures on disk are maildir-style files with long names.
    this.files = entries
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  }

  async *fetchUnseen() {
    for (let i = 0; i < this.files.length; i++) {
      const filePath = path.join(this.dir, this.files[i]);
      const buf = await fs.promises.readFile(filePath);
      yield { uid: i, source: buf.toString('latin1') };
    }
  }

  async markSeen(_uid) {
    // No-op by design. Fixture files on disk are immutable from the
    // reader's perspective; re-running the orchestrator re-processes
    // them, which is what makes this a useful dev loop (the second
    // run exercises the duplicate path without any manual setup).
  }

  async close() {
    // No-op.
  }
}

// ---------- Main entry point ----------

/**
 * Run one sync pass for the given config, using the given reader.
 *
 * @param {object}  args
 * @param {object}  args.config  - CurveConfig document / plain object. Must
 *                                 include `_id` and `user_id`. The function
 *                                 does ZERO `findOne()` calls internally;
 *                                 multi-user scoping is the caller's job.
 * @param {object}  args.reader  - EmailReader implementation (ImapReader or
 *                                 FixtureReader). See module docstring.
 * @param {boolean} [args.dryRun=false] - If true: parser runs, duplicate
 *                                 check runs as a read-only query, but NO
 *                                 Expense.create, NO reader.markSeen, and
 *                                 NO CurveConfig stats update. CurveLog
 *                                 entries ARE written with `dry_run: true`
 *                                 so they can be audited but filtered out
 *                                 of normal views.
 * @returns {Promise<Summary>}
 *
 * @throws {SyncConflictError} if another sync is already running.
 */
export async function syncEmails({ config, reader, dryRun = false }) {
  if (!config?._id) throw new Error('syncEmails: config with _id required');
  if (!config?.user_id) throw new Error('syncEmails: config.user_id required');
  if (!reader) throw new Error('syncEmails: reader required');

  const configKey = String(config._id);
  if (running.has(configKey)) throw new SyncConflictError();
  running.add(configKey);

  const startedAt = Date.now();
  const summary = {
    total: 0,
    ok: 0,
    duplicates: 0,
    parseErrors: 0,
    errors: 0,
    halted: false,
    dryRun,
    durationMs: 0,
    // Human-readable aborted-run error message + classified code. `null`
    // on clean runs. Surfaced in the POST /sync response so curl / the
    // dashboard can show the real reason without grepping CurveLog.
    error: null,
    errorCode: null,
    // Set to true when the reader hit the per-run cap before
    // exhausting all UNSEEN messages. Tells the user "there are more
    // emails waiting — run sync again to continue".
    capped: false,
  };

  // Circuit-breaker state: counter of consecutive parse errors since
  // the last successful `ok` or `duplicate` in THIS run. Reset on any
  // non-parse-error outcome.
  let consecutiveParseErrors = 0;

  // Mark the config as syncing for UI visibility. Skip for dry runs —
  // dry runs are meant to be invisible to the dashboard. The
  // authoritative lock is the in-memory `running` flag above; this
  // field is just a hint.
  if (!dryRun) {
    try {
      await CurveConfig.updateOne({ _id: config._id }, { $set: { is_syncing: true } });
    } catch (e) {
      // Non-fatal — proceed even if the hint write fails.
      console.warn(`syncEmails: could not set is_syncing flag: ${e.message}`);
    }
  }

  // Categories are loaded ONCE per run and reused for every email. The
  // existing `assignCategory` would otherwise do a full Category.find()
  // per email, which is an N+1 on every sync.
  let categoriesCache = [];
  try {
    categoriesCache = await Category.find().lean();
  } catch (e) {
    console.warn(`syncEmails: could not load categories: ${e.message}`);
    // We continue with an empty cache — every expense just ends up
    // with category_id = null instead of an auto-assigned category.
  }

  // Track whether we ever got an `ok` from a real IMAP reader, so we
  // know whether to update the last_email_at canary. Fixture-driven
  // runs must NOT update the canary even on success, otherwise a dev
  // loop would poison the "days since last real email" signal.
  const shouldUpdateCanary = reader instanceof ImapReader;
  let sawRealOk = false;

  // Connect the reader. Any failure here is terminal for the whole
  // run — nothing to process, but we still have to update stats +
  // release the lock in `finally`.
  // UIDs of emails that were successfully processed (ok or duplicate)
  // and should be marked \Seen after the loop. Batching into a single
  // IMAP STORE command avoids the N-round-trip timeout that killed the
  // connection when markSeen was called per-email (~1.5 s × 61 emails
  // on the Pi via email-oauth2-proxy). See imapReader.markSeenBatch().
  const seenUids = [];

  let runError = null;
  try {
    await reader.connect();

    for await (const { uid, source } of reader.fetchUnseen()) {
      summary.total += 1;

      // ---- 1. Parse ----
      let parsed;
      try {
        parsed = parseEmail(source);
      } catch (e) {
        summary.parseErrors += 1;
        consecutiveParseErrors += 1;
        await writeLog({
          config,
          status: 'parse_error',
          dryRun,
          error_detail: truncateDetail(
            e instanceof ParseError
              ? `${e.message}${e.field ? ` [field=${e.field}]` : ''}${
                  e.attempted ? ` [tried=${JSON.stringify(e.attempted)}]` : ''
                }`
              : e?.message ?? String(e),
          ),
        });
        // Circuit breaker: bail out hard if we're clearly stuck in a
        // repeatable failure mode (e.g. Curve changed their template
        // overnight). Leaves the emails UNSEEN so the next sync can
        // try again once the parser is fixed.
        if (
          consecutiveParseErrors >= PARSE_ERROR_CIRCUIT_BREAKER &&
          summary.ok === 0
        ) {
          summary.halted = true;
          await writeLog({
            config,
            status: 'error',
            dryRun,
            error_detail: truncateDetail(
              `circuit breaker: ${PARSE_ERROR_CIRCUIT_BREAKER} consecutive ` +
                'parse errors without a successful parse — halting to ' +
                'avoid retry storm',
            ),
          });
          break;
        }
        // NOTE: do NOT markSeen — leave the email UNSEEN so the next
        // sync retries it after the parser is fixed.
        continue;
      }

      // ---- 2. Categorise ----
      const category_id = assignCategoryFromList(parsed.entity, categoriesCache);

      // ---- 3. Dry run: check-only path, no writes ----
      if (dryRun) {
        let exists = false;
        try {
          exists = Boolean(await Expense.exists({ digest: parsed.digest }));
        } catch (e) {
          summary.errors += 1;
          consecutiveParseErrors = 0;
          await writeLog({
            config,
            status: 'error',
            dryRun,
            entity: parsed.entity,
            amount: parsed.amount,
            digest: parsed.digest,
            error_detail: truncateDetail(`dry_run exists() failed: ${e.message}`),
          });
          continue;
        }
        if (exists) {
          summary.duplicates += 1;
          await writeLog({
            config,
            status: 'duplicate',
            dryRun,
            entity: parsed.entity,
            amount: parsed.amount,
            digest: parsed.digest,
          });
        } else {
          summary.ok += 1;
          await writeLog({
            config,
            status: 'ok',
            dryRun,
            entity: parsed.entity,
            amount: parsed.amount,
            digest: parsed.digest,
          });
        }
        consecutiveParseErrors = 0;
        continue;
      }

      // ---- 4. Real insert path ----
      let expenseDoc = null;
      try {
        expenseDoc = await Expense.create({
          entity: parsed.entity,
          amount: parsed.amount,
          date: parsed.date,
          card: parsed.card,
          digest: parsed.digest,
          user_id: config.user_id,
          category_id,
        });
      } catch (e) {
        if (isDigestDuplicate(e)) {
          // ---- 4a. Digest duplicate → log + markSeen + continue ----
          // This is the self-healing path: a previous sync's insert
          // succeeded but markSeen failed, so the email came back as
          // UNSEEN, we re-parsed it, and now the unique index rejects
          // the re-insert. markSeen-on-duplicate is how we finish the
          // job. Do NOT "optimize" this to skip markSeen — the recovery
          // mechanism depends on it.
          summary.duplicates += 1;
          consecutiveParseErrors = 0;
          await writeLog({
            config,
            status: 'duplicate',
            dryRun,
            entity: parsed.entity,
            amount: parsed.amount,
            digest: parsed.digest,
          });
          seenUids.push(uid);
          continue;
        }
        // ---- 4b. Any other error → log, leave UNSEEN for retry ----
        summary.errors += 1;
        consecutiveParseErrors = 0;
        await writeLog({
          config,
          status: 'error',
          dryRun,
          entity: parsed.entity,
          amount: parsed.amount,
          digest: parsed.digest,
          error_detail: truncateDetail(
            `Expense.create failed: ${e.message}` +
              (e.code ? ` (code=${e.code})` : ''),
          ),
        });
        continue;
      }

      // ---- 5. Insert succeeded → log ok + markSeen ----
      summary.ok += 1;
      consecutiveParseErrors = 0;
      sawRealOk = true;
      await writeLog({
        config,
        status: 'ok',
        dryRun,
        entity: parsed.entity,
        amount: parsed.amount,
        digest: parsed.digest,
        expense_id: expenseDoc._id,
      });
      seenUids.push(uid);
    }

    // Batch markSeen: one IMAP STORE for all successfully processed
    // UIDs instead of N individual round-trips. If this fails, the
    // emails stay UNSEEN → next sync re-fetches → all duplicate →
    // retry markSeen. The recovery invariant holds.
    if (seenUids.length > 0 && !dryRun) {
      await safeMarkSeenBatch(reader, seenUids);
    }

    // The reader sets `capped = true` when it stopped yielding because
    // the per-run cap was reached (not because it ran out of messages).
    // Surface it on the summary so the route / frontend can tell the
    // user "there are more emails waiting — run sync again".
    if (reader.capped === true) {
      summary.capped = true;
    }
  } catch (e) {
    // Reader-level failure (connect failed, fetch stream died, etc.).
    // Individual per-email errors are caught inside the loop above;
    // anything reaching here is a whole-run problem.
    runError = e;
    summary.errors += 1;
    // Surface the failure on the summary object so the route layer
    // can return it to the frontend / curl without a CurveLog lookup.
    // `e.code` is the ImapError classification (FOLDER, AUTH, etc.)
    // when the reader is ImapReader — other readers just return null.
    summary.error = e?.message ?? String(e);
    summary.errorCode = e?.code ?? null;
    try {
      await writeLog({
        config,
        status: 'error',
        dryRun,
        error_detail: truncateDetail(
          `sync aborted: ${e.message}` + (e.code ? ` (code=${e.code})` : ''),
        ),
      });
    } catch {
      // swallow — we're already in the error path, don't mask the root cause
    }
  } finally {
    // Best-effort reader close (has its own 5s logout timeout).
    try {
      await reader.close();
    } catch (e) {
      console.warn(`syncEmails: reader.close() failed: ${e.message}`);
    }

    summary.durationMs = Date.now() - startedAt;

    // Write per-sync stats back to the config, EXCEPT for dry runs
    // (they must stay invisible to the dashboard).
    if (!dryRun) {
      const status =
        summary.halted || summary.errors > 0 || runError ? 'error' : 'ok';
      const update = {
        $set: {
          last_sync_at: new Date(),
          last_sync_status: status,
          is_syncing: false,
        },
      };
      if (summary.ok > 0) {
        update.$inc = { emails_processed_total: summary.ok };
      }
      // Silent-failure canary: only tick forward on a REAL insert
      // from a REAL ImapReader run. Duplicates don't count, dry runs
      // don't count, and neither do fixture runs (see `sawRealOk`
      // guard above).
      if (sawRealOk && shouldUpdateCanary) {
        update.$set.last_email_at = new Date();
      }
      // Folder auto-invalidation: if the run aborted specifically
      // because the configured folder is missing from the server,
      // clear the confirmation timestamp so the frontend re-raises
      // the banner on the next visit to /curve/config. This is what
      // makes the folder picker self-healing after a rename on the
      // mail provider side. See docs/EMAIL.md → Config UX.
      if (runError?.code === 'FOLDER') {
        update.$set.imap_folder_confirmed_at = null;
      }
      try {
        await CurveConfig.updateOne({ _id: config._id }, update);
      } catch (e) {
        console.warn(`syncEmails: could not update config stats: ${e.message}`);
      }
    }

    running.delete(configKey);
  }

  return summary;
}

// ---------- Internals ----------

async function writeLog(entry) {
  const {
    config,
    status,
    dryRun,
    entity,
    amount,
    digest,
    expense_id,
    error_detail,
  } = entry;
  try {
    await CurveLog.create({
      user_id: config.user_id,
      config_id: config._id,
      status,
      entity,
      amount,
      digest,
      expense_id,
      error_detail,
      dry_run: Boolean(dryRun),
    });
  } catch (e) {
    // CurveLog write failure is bad but non-fatal — we still want the
    // sync to continue so the user gets their expenses. Print to
    // stderr so ops can spot it in journalctl.
    console.error(`syncEmails: CurveLog.create failed: ${e.message}`);
  }
}

/**
 * Mark an email as \Seen, swallowing any failure to a console warning.
 * Kept for the FixtureReader contract (no-op) and as a fallback. The
 * main sync loop now uses `safeMarkSeenBatch` instead.
 */
async function safeMarkSeen(reader, uid) {
  try {
    await reader.markSeen(uid);
  } catch (e) {
    console.warn(`syncEmails: markSeen(${uid}) failed: ${e.message}`);
  }
}

/**
 * Batch version of safeMarkSeen — one IMAP STORE for all UIDs.
 *
 * Falls back to per-UID markSeen if the reader doesn't support
 * `markSeenBatch` (e.g. FixtureReader, which has a no-op `markSeen`).
 * This keeps the duck-typing contract simple: only ImapReader needs
 * to implement the batch method.
 */
async function safeMarkSeenBatch(reader, uids) {
  if (typeof reader.markSeenBatch === 'function') {
    try {
      await reader.markSeenBatch(uids);
    } catch (e) {
      console.warn(
        `syncEmails: markSeenBatch(${uids.length} uids) failed: ${e.message}`,
      );
    }
  } else {
    // Fallback for readers without batch support (FixtureReader).
    for (const uid of uids) {
      await safeMarkSeen(reader, uid);
    }
  }
}

/**
 * @typedef {object} Summary
 * @property {number}  total         emails fetched by the reader
 * @property {number}  ok            new expenses inserted (or would-insert in dryRun)
 * @property {number}  duplicates    dedup hits (not errors)
 * @property {number}  parseErrors
 * @property {number}  errors        everything else (Mongo errors, reader errors)
 * @property {boolean} halted        true iff the circuit breaker fired
 * @property {boolean} dryRun
 * @property {number}  durationMs
 * @property {?string} error         human-readable reason the run aborted, or null
 * @property {?string} errorCode     ImapError classification (FOLDER, AUTH, ...) or null
 * @property {boolean} capped        true iff the reader stopped at max_emails_per_run
 */
