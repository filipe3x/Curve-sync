/**
 * IMAP reader for Curve receipt emails (Phase 2, OAuth-aware in V2).
 *
 * Wraps `imapflow` with a small stateful class that the sync orchestrator
 * (Phase 3) can drive:
 *
 *     const reader = await createImapReader(config);
 *     await reader.connect();
 *     try {
 *       for await (const { uid, source } of reader.fetchUnseen()) {
 *         try {
 *           const parsed = parseEmail(source);
 *           // insert expense, log, etc.
 *           await reader.markSeen(uid);
 *         } catch (e) {
 *           // log parse_error — DO NOT markSeen (leave for retry)
 *         }
 *       }
 *     } finally {
 *       await reader.close();
 *     }
 *
 * Note that `fetchUnseen()` is an async generator, not an array-returning
 * function — it yields one message at a time so the orchestrator can
 * process each email fully before the next is pulled from the server.
 * A first sync against a 5000-email mailbox would otherwise hold ~250 MB
 * of latin1 strings in memory on the Pi.
 *
 * Also exports a standalone `testConnection(config)` for the
 * `POST /api/curve/test-connection` route — opens, lists folders,
 * disconnects. Used by the "Testar ligação" button.
 *
 * Authentication has two branches:
 *
 *   1. **Legacy (App Password).** `config.oauth_provider` is null and
 *      `config.imap_password` holds the plaintext App Password. Used by
 *      Gmail (App Passwords still work) and any already-configured V1
 *      users still on the password branch. imapflow sends LOGIN/PLAIN.
 *
 *   2. **OAuth (XOAUTH2).** `config.oauth_provider === 'microsoft'` and
 *      the MSAL token cache in `config.oauth_token_cache` is populated.
 *      `createImapReader` resolves a fresh access token via
 *      `oauthManager.getOAuthToken` and hands it to imapflow which
 *      speaks XOAUTH2 SASL. This is the V2 path for Outlook/Microsoft
 *      accounts — see docs/EMAIL_AUTH_MVP.md for the full flow.
 *
 * The `ImapReader` constructor is still synchronous and accepts a
 * prebuilt `auth` object as its second argument. The async factory
 * `createImapReader(config)` is the production entry point — it knows
 * how to build the auth object for either branch and must be used by
 * all call sites (routes, scheduler, tests). Calling
 * `new ImapReader(config)` without a prebuilt auth still works for
 * legacy App Password configs, but it cannot be used for OAuth configs
 * because token acquisition is inherently async.
 */

import { ImapFlow } from 'imapflow';
import { getOAuthToken, OAuthReAuthRequired } from './oauthManager.js';
import { cycleBoundsFor, normaliseCycleDay } from './cycle.js';

/**
 * Structured IMAP error. `code` is one of:
 *   CONFIG   — missing/invalid config field (fix before retry)
 *   CONNECT  — DNS / TCP / TLS failure (network or host wrong)
 *   AUTH     — credentials rejected (likely wrong App Password)
 *   FOLDER   — configured folder doesn't exist on the server
 *   FETCH    — error while streaming messages
 *   FLAG     — error setting the \Seen flag
 *   UNKNOWN  — everything else
 *
 * The route layer maps these to HTTP status codes for a nicer UX.
 */
export class ImapError extends Error {
  constructor(message, { code = 'UNKNOWN', cause } = {}) {
    super(message);
    this.name = 'ImapError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

// Fields that must be present regardless of the auth branch. The
// password vs oauth fields are checked separately below because they
// are mutually exclusive — requiring both would reject every valid
// config in exactly one of the two worlds.
const BASE_REQUIRED_FIELDS = ['imap_server', 'imap_username'];

function assertConfig(config) {
  if (!config) {
    throw new ImapError('no config provided', { code: 'CONFIG' });
  }
  for (const key of BASE_REQUIRED_FIELDS) {
    if (!config[key] || String(config[key]).trim() === '') {
      throw new ImapError(`missing required config field: ${key}`, {
        code: 'CONFIG',
      });
    }
  }
  // OAuth branch: oauth_provider decides which auth material we need.
  // A config that sets oauth_provider but forgot oauth_account_id is
  // half-baked — the wizard never completed. Surface as CONFIG so the
  // route layer returns 400, not AUTH (which would imply the token
  // cache is dead and trigger the re-auth banner unnecessarily).
  if (config.oauth_provider) {
    if (!config.oauth_account_id) {
      throw new ImapError(
        'missing required config field: oauth_account_id ' +
          '(oauth_provider is set but the wizard never completed)',
        { code: 'CONFIG' },
      );
    }
    return;
  }
  // Legacy branch: App Password must be present and non-empty.
  if (!config.imap_password || String(config.imap_password).trim() === '') {
    throw new ImapError('missing required config field: imap_password', {
      code: 'CONFIG',
    });
  }
}

/**
 * Safety check: plain IMAP (no TLS) is only tolerable over a loopback
 * interface, because the password travels in the clear. If the user
 * disables TLS against a non-loopback host we refuse to connect rather
 * than leak credentials over the network. Localhost/loopback targets
 * are fine because they're the whole point of Caminho B (relaying to
 * email-oauth2-proxy on 127.0.0.1).
 */
const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  '0.0.0.0',
]);

function isLoopbackHost(host) {
  if (!host) return false;
  return LOOPBACK_HOSTS.has(String(host).trim().toLowerCase());
}

/**
 * Fallback SINCE date when `CurveConfig.imap_since` is null (i.e. the
 * user hasn't set an explicit date yet). Returns the start of the
 * user's current custom cycle — `cycleDay` of this month if today is
 * on/after `cycleDay`, otherwise `cycleDay` of the previous month.
 *
 * Why cycle-aware: expenses belong to a cycle, not a rolling 31-day
 * window. A fresh user who enables sync on the 25th should ingest
 * receipts from the 22nd onward (current cycle) rather than reaching
 * into the previous cycle's territory. The IMAP SINCE command
 * compares against the message's internal date (day-precision), so
 * any UTC midnight boundary is fine for the filter.
 *
 * Fallback to 31d (legacy behaviour) when cycleDay is nullish or the
 * caller forgot to pass a config — preserves the old invariant for
 * any callsite that still uses the no-arg form.
 *
 * @param {{sync_cycle_day?: number}} [config]
 */
export function defaultSince(config) {
  if (config && config.sync_cycle_day != null) {
    const { start } = cycleBoundsFor(
      new Date(),
      normaliseCycleDay(config.sync_cycle_day),
    );
    return start;
  }
  // Legacy fallback (no cycle day): 31 days ago in Europe/Lisbon.
  const lisbonDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Lisbon',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [y, m, d] = lisbonDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 31);
  return dt;
}

/**
 * Classify raw errors from imapflow into one of our ImapError codes.
 * imapflow doesn't use stable error codes, so we pattern-match on the
 * message. Keep the regexes permissive — the goal is a useful UX hint,
 * not forensic accuracy.
 */
function classifyError(e) {
  const msg = e?.responseText || e?.message || String(e);
  if (/authentication failed|invalid credentials|535|AUTHENTICATIONFAILED/i.test(msg)) {
    return new ImapError(
      `authentication failed — check the App Password (not the account password): ${msg}`,
      { code: 'AUTH', cause: e },
    );
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) {
    return new ImapError(`could not resolve IMAP host: ${msg}`, {
      code: 'CONNECT',
      cause: e,
    });
  }
  if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|socket|TLS|certificate/i.test(msg)) {
    return new ImapError(`could not connect to IMAP server: ${msg}`, {
      code: 'CONNECT',
      cause: e,
    });
  }
  // Folder-not-found errors vary wildly by provider:
  //   Outlook365: `"INBOX/Curve Receipts" doesn't exist.`
  //   Gmail:      `[NONEXISTENT] Unknown Mailbox: Curve`
  //   Dovecot:    `Mailbox doesn't exist: Curve`
  //   Fastmail:   `[TRYCREATE] Mailbox does not exist`
  // Match on the stable signals rather than a specific vendor string.
  if (
    /NONEXISTENT|TRYCREATE|doesn'?t exist|does not exist|no such (mailbox|folder)|unknown mailbox/i.test(
      msg,
    )
  ) {
    return new ImapError(`folder not found on server: ${msg}`, {
      code: 'FOLDER',
      cause: e,
    });
  }
  return new ImapError(msg, { code: 'UNKNOWN', cause: e });
}

export class ImapReader {
  /**
   * @param {object} config CurveConfig doc (or plain object)
   * @param {object} [prebuiltAuth] Optional prebuilt auth object passed
   *   through to imapflow verbatim. Used by `createImapReader` to
   *   inject an OAuth XOAUTH2 auth (`{ user, accessToken }`) so token
   *   acquisition can stay async while this constructor stays sync.
   *   If omitted, falls back to `{ user, pass }` from the config —
   *   the legacy App Password path. OAuth configs without prebuiltAuth
   *   are rejected because `assertConfig` requires imap_password on
   *   the legacy branch.
   */
  constructor(config, prebuiltAuth = null) {
    assertConfig(config);

    // TLS default: on unless explicitly disabled. Plain IMAP is only
    // tolerated against loopback hosts (Caminho B → email-oauth2-proxy).
    const useTls = config.imap_tls !== false;
    if (!useTls && !isLoopbackHost(config.imap_server)) {
      throw new ImapError(
        `refusing plain IMAP to non-loopback host "${config.imap_server}" ` +
          `— TLS can only be disabled for 127.0.0.1 / localhost / ::1`,
        { code: 'CONFIG' },
      );
    }

    // If the caller passed a prebuilt auth (OAuth branch) use it;
    // otherwise we're on the legacy App Password branch and we build
    // one from the config's imap_password. assertConfig has already
    // guaranteed imap_password is present in that case.
    const auth = prebuiltAuth || {
      user: config.imap_username,
      pass: config.imap_password,
    };

    this.config = config;
    this.client = new ImapFlow({
      host: config.imap_server,
      port: config.imap_port ?? (useTls ? 993 : 1993),
      secure: useTls,
      auth,
      // Silence imapflow's default bunyan logger — it's noisy and the
      // orchestrator will log anything interesting itself.
      logger: false,
      // Be kind to the server: don't retry silently on disconnect.
      disableAutoIdle: true,
    });
    // ImapFlow emits 'error' events on the underlying socket (e.g.
    // ETIMEOUT, ECONNRESET). If nobody listens, Node.js crashes the
    // process with "Unhandled 'error' event". This handler converts
    // the event into a stored error that the next operation picks up
    // via classifyError — no crash, no swallowed failure.
    this.client.on('error', (err) => {
      this._socketError = err;
    });
    this.folderOpen = false;
  }

  async connect() {
    try {
      await this.client.connect();
    } catch (e) {
      throw classifyError(e);
    }
  }

  /**
   * List all folders on the server. Used by `testConnection` to prove
   * the credentials work without opening a specific mailbox.
   * @returns {Promise<string[]>} array of folder paths
   */
  async listFolders() {
    try {
      const folders = await this.client.list();
      return folders.map((f) => f.path);
    } catch (e) {
      throw classifyError(e);
    }
  }

  /**
   * Open the folder configured in `CurveConfig.imap_folder`
   * (default INBOX). Idempotent — safe to call multiple times.
   */
  async openFolder() {
    if (this.folderOpen) return;
    const folder = this.config.imap_folder || 'INBOX';
    try {
      await this.client.mailboxOpen(folder);
      this.folderOpen = true;
    } catch (e) {
      throw classifyError(e);
    }
  }

  /**
   * Fetch UNSEEN messages in the current folder, one at a time.
   *
   * This is an async generator — NOT an array-returning function. The
   * orchestrator iterates with `for await (...)` and processes each
   * email fully (parse → digest → insert → log → markSeen) before the
   * next is pulled from the server. This keeps peak memory roughly
   * constant regardless of how many unseen emails are waiting: a first
   * sync against a large mailbox would otherwise hold the entire
   * source payload of every email in a single array.
   *
   * Two safety nets prevent a first-time sync from pulling thousands
   * of historical emails:
   *
   *   1. **`imap_since`** — IMAP `SEARCH UNSEEN SINCE <date>` filter.
   *      When set on the config, the server discards messages older
   *      than that date before sending. When `null`, the reader falls
   *      back to 31 days ago in Europe/Lisbon time. The frontend will
   *      eventually expose this as a cycle-aware control (day 22).
   *
   *   2. **`max_emails_per_run`** — client-side hard cap (default 500).
   *      After yielding this many messages, the generator stops and
   *      sets `this.capped = true`. Remaining emails stay UNSEEN for
   *      the next run.
   *
   * Each yielded value has the full raw email source (headers + MIME
   * body) so `emailParser.js` can handle MIME decoding and HTML parsing
   * itself. The parser and this reader share no state besides the
   * `{uid, source}` contract — swapping out imapflow later would not
   * touch the parser.
   *
   * @yields {{ uid: number, source: string }}
   */
  async *fetchUnseen() {
    await this.openFolder();

    const maxPerRun = this.config.max_emails_per_run ?? 500;
    const since = this.config.imap_since
      ? new Date(this.config.imap_since)
      : defaultSince(this.config);

    const criteria = { seen: false };
    if (since) criteria.since = since;

    this.capped = false;
    let fetched = 0;

    try {
      for await (const msg of this.client.fetch(
        criteria,
        { uid: true, source: true },
      )) {
        if (!msg.source) continue;
        yield {
          uid: msg.uid,
          // `source` is a Buffer; decode as latin1 so byte values survive
          // into the quoted-printable decoder in emailParser.js — same
          // convention as validate-fixtures.js uses for the on-disk
          // fixture files.
          source: Buffer.isBuffer(msg.source)
            ? msg.source.toString('latin1')
            : String(msg.source),
        };
        fetched += 1;
        if (fetched >= maxPerRun) {
          this.capped = true;
          return;
        }
      }
    } catch (e) {
      throw new ImapError(`fetch failed: ${e.message}`, {
        code: 'FETCH',
        cause: e,
      });
    }
  }

  /**
   * Mark a single message as \Seen. Kept for the duck-typing contract
   * (FixtureReader also has `markSeen`), but the orchestrator now
   * prefers `markSeenBatch` to avoid per-email IMAP round-trips.
   */
  async markSeen(uid) {
    try {
      await this.client.messageFlagsAdd(
        { uid: String(uid) },
        ['\\Seen'],
        { uid: true },
      );
    } catch (e) {
      throw new ImapError(`could not mark uid ${uid} as seen: ${e.message}`, {
        code: 'FLAG',
        cause: e,
      });
    }
  }

  /**
   * Mark multiple messages as \Seen in a single IMAP STORE command.
   *
   * This is the primary markSeen path for the orchestrator — instead
   * of 61 sequential round-trips (one per email, ~1.5 s each on the
   * Pi via email-oauth2-proxy), we accumulate UIDs during the loop
   * and issue one `UID STORE <uid1,uid2,...> +FLAGS (\Seen)` at the
   * end. Total IMAP time drops from ~90 s to ~1 s.
   *
   * If the batch fails, the emails stay UNSEEN — the next sync will
   * re-fetch them, hit the digest unique index, land as `duplicate`,
   * and retry markSeen from the duplicate branch. This is the same
   * recovery invariant the single-UID path relies on.
   *
   * @param {number[]} uids - array of message UIDs to mark
   */
  async markSeenBatch(uids) {
    if (!uids || uids.length === 0) return;
    try {
      await this.client.messageFlagsAdd(
        { uid: uids.join(',') },
        ['\\Seen'],
        { uid: true },
      );
    } catch (e) {
      throw new ImapError(
        `could not mark ${uids.length} messages as seen: ${e.message}`,
        { code: 'FLAG', cause: e },
      );
    }
  }

  /**
   * Close the connection. Best-effort — logout failures are swallowed
   * because by the time we're closing, we already have whatever data we
   * need and the server will reap the session anyway.
   *
   * Wrapped in a 5-second timeout so a misbehaving server (or a
   * half-closed socket on the email-oauth2-proxy side of Caminho B)
   * cannot hang the orchestrator indefinitely in its `finally` block.
   */
  async close() {
    try {
      await Promise.race([
        this.client.logout(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('imap logout timeout')), 5000),
        ),
      ]);
    } catch {
      // ignore — best effort
    }
    this.folderOpen = false;
  }
}

/**
 * Async factory that builds an `ImapReader` for either auth branch.
 *
 * This is the production entry point that all non-test call sites must
 * use (routes, scheduler, testConnection). It hides the OAuth token
 * acquisition behind a single `await` so callers don't have to care
 * whether the config is OAuth or legacy — the branching is localized
 * here.
 *
 * Legacy configs (oauth_provider === null) go straight to
 * `new ImapReader(config)`, which uses config.imap_password.
 *
 * OAuth configs call `getOAuthToken(config)` to obtain a fresh access
 * token (cache hit or silent refresh), then pass it to imapflow via
 * the XOAUTH2 auth shape. `OAuthReAuthRequired` is translated here to
 * an `ImapError` with `code='AUTH'` so the route layer's existing
 * `{ AUTH: 401 }` mapping lights up the re-auth banner without needing
 * to teach every caller about MSAL errors.
 *
 * @param {object} config - CurveConfig document / plain object
 * @param {object} [overrides] Test-only. `{ getOAuthToken }` lets a
 *   smoke test inject a stub without reaching Azure AD.
 * @returns {Promise<ImapReader>} a connected-ready ImapReader instance
 * @throws {ImapError} with code CONFIG, AUTH, CONNECT, FOLDER, or UNKNOWN
 */
export async function createImapReader(config, overrides = {}) {
  assertConfig(config);

  if (!config.oauth_provider) {
    // Legacy App Password branch — plain constructor path.
    return new ImapReader(config);
  }

  // OAuth branch. Acquire a fresh access token before handing off to
  // imapflow. Any InteractionRequiredAuthError / expired refresh token
  // surfaces here as OAuthReAuthRequired — translate it to AUTH so
  // the existing error code → HTTP status mapping still works.
  const getToken = overrides.getOAuthToken || getOAuthToken;
  let accessToken;
  try {
    accessToken = await getToken(config);
  } catch (e) {
    if (e instanceof OAuthReAuthRequired) {
      throw new ImapError(e.message, { code: 'AUTH', cause: e });
    }
    // Network / transient MSAL error (5xx from token endpoint, etc.).
    // Classify as CONNECT so callers retry later instead of marking
    // the token as dead.
    throw new ImapError(`OAuth token acquisition failed: ${e.message}`, {
      code: 'CONNECT',
      cause: e,
    });
  }

  return new ImapReader(config, {
    user: config.imap_username,
    accessToken,
  });
}

/**
 * One-shot connection test for the "Testar ligação" button:
 * connect → list folders → disconnect. Proves the credentials work AND
 * tells the user what folder paths are available (useful for finding
 * the right value for `imap_folder`).
 *
 * @param {object} config - CurveConfig document / plain object
 * @returns {Promise<{ folders: string[] }>}
 * @throws {ImapError} on any failure (caller maps `code` to HTTP status)
 */
export async function testConnection(config, { timeoutMs = 10_000 } = {}) {
  const reader = await createImapReader(config);
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new ImapError(
      `connection test timed out after ${timeoutMs / 1000}s`,
      { code: 'CONNECT' },
    )), timeoutMs),
  );
  try {
    const work = async () => {
      await reader.connect();
      return reader.listFolders();
    };
    const folders = await Promise.race([work(), timer]);
    return { folders };
  } finally {
    await reader.close();
  }
}
