/**
 * IMAP reader for Curve receipt emails (Phase 2).
 *
 * Wraps `imapflow` with a small stateful class that the sync orchestrator
 * (Phase 3) can drive:
 *
 *     const reader = new ImapReader(config);
 *     await reader.connect();
 *     try {
 *       for (const { uid, source } of await reader.fetchUnseen()) {
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
  if (/NONEXISTENT|Mailbox doesn't exist|does not exist|folder/i.test(msg)) {
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
   * Fetch every UNSEEN message in the current folder. Each entry has
   * the full raw email source (headers + MIME body) so `emailParser.js`
   * can handle both MIME decoding and HTML parsing itself.
   *
   * The parser and this reader deliberately do NOT share any state: if
   * imapflow later swaps to a different library, the parser's input
   * contract (raw email string) stays identical.
   *
   * @returns {Promise<Array<{ uid: number, source: string }>>}
   */
  async fetchUnseen() {
    await this.openFolder();
    const results = [];
    try {
      for await (const msg of this.client.fetch(
        { seen: false },
        { uid: true, source: true },
      )) {
        if (!msg.source) continue;
        results.push({
          uid: msg.uid,
          // `source` is a Buffer; decode as latin1 so byte values survive
          // into the quoted-printable decoder in emailParser.js — same
          // convention as validate-fixtures.js uses for the on-disk
          // fixture files.
          source: Buffer.isBuffer(msg.source)
            ? msg.source.toString('latin1')
            : String(msg.source),
        });
      }
    } catch (e) {
      throw new ImapError(`fetch failed: ${e.message}`, {
        code: 'FETCH',
        cause: e,
      });
    }
    return results;
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
   */
  async close() {
    try {
      await this.client.logout();
    } catch {
      // ignore
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
