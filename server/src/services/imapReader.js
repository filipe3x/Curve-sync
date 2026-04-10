/**
 * IMAP reader for Curve receipt emails (Phase 2).
 *
 * Wraps `imapflow` with a small stateful class that the sync orchestrator
 * (Phase 3) can drive:
 *
 *     const reader = new ImapReader(config);
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
 * Authentication: basic auth only (App Password / plain). Outlook365 and
 * Gmail both disabled real-password IMAP, so the user is expected to
 * paste an App Password into `CurveConfig.imap_password`. See the
 * "Outlook365 / Microsoft 365 Authentication" section of docs/EMAIL.md
 * for context. OAuth2 / XOAUTH2 is deferred to Phase 7+.
 */

import { ImapFlow } from 'imapflow';

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

const REQUIRED_FIELDS = ['imap_server', 'imap_username', 'imap_password'];

function assertConfig(config) {
  if (!config) {
    throw new ImapError('no config provided', { code: 'CONFIG' });
  }
  for (const key of REQUIRED_FIELDS) {
    if (!config[key] || String(config[key]).trim() === '') {
      throw new ImapError(`missing required config field: ${key}`, {
        code: 'CONFIG',
      });
    }
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
 * user hasn't set an explicit date yet). Returns 31 days ago in
 * Europe/Lisbon time — the IMAP SINCE command compares against the
 * message's internal date (date-only, no time component), so ±1 day
 * from timezone effects is acceptable for a 31-day window.
 *
 * Why Europe/Lisbon: the user is in Portugal and the expense cycle
 * logic (day 22) is defined in local time. Using UTC could shift the
 * cut-off by a day around midnight, which matters when the future
 * cycle-aware mode computes the since date dynamically.
 */
function defaultSince() {
  // Intl gives us "today in Lisbon" regardless of the server's TZ.
  const lisbonDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Lisbon',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [y, m, d] = lisbonDate.split('-').map(Number);
  // Construct a local Date at midnight, then subtract 31 days.
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
  constructor(config) {
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

    this.config = config;
    this.client = new ImapFlow({
      host: config.imap_server,
      port: config.imap_port ?? (useTls ? 993 : 1993),
      secure: useTls,
      auth: {
        user: config.imap_username,
        pass: config.imap_password,
      },
      // Silence imapflow's default bunyan logger — it's noisy and the
      // orchestrator will log anything interesting itself.
      logger: false,
      // Be kind to the server: don't retry silently on disconnect.
      disableAutoIdle: true,
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
      : defaultSince();

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
   * Mark a message as \Seen. The orchestrator calls this ONLY after a
   * successful insert (or confirmed duplicate) — parse errors leave the
   * message UNSEEN so a future sync can retry it.
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
 * One-shot connection test for the "Testar ligação" button:
 * connect → list folders → disconnect. Proves the credentials work AND
 * tells the user what folder paths are available (useful for finding
 * the right value for `imap_folder`).
 *
 * @param {object} config - CurveConfig document / plain object
 * @returns {Promise<{ folders: string[] }>}
 * @throws {ImapError} on any failure (caller maps `code` to HTTP status)
 */
export async function testConnection(config) {
  const reader = new ImapReader(config);
  try {
    await reader.connect();
    const folders = await reader.listFolders();
    return { folders };
  } finally {
    await reader.close();
  }
}
