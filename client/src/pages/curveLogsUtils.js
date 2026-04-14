// Pure helpers for /curve/logs rendering.
//
// `curve_logs` is a dual-purpose collection (see docs/CURVE_LOGS.md):
//   - sync events  → action == null, may carry entity/amount/digest
//   - audit events → action != null, carry ip/error_detail
//
// describeLog() turns a single log into the user-facing { type, title }
// pair shown in the "Tipo" + "Detalhe" columns.
//
// groupSyncBatches() collapses runs of consecutive expense rows that
// landed within BATCH_WINDOW_MS into a single expandable entry — when
// the orchestrator processes a backlog of N receipts during one sync,
// they all share roughly the same `created_at`, and the user wants to
// see "5 despesas importadas" instead of 5 near-duplicate rows.

const BATCH_WINDOW_MS = 5_000;

// Maps a CurveLog to a human-readable { type, title }.
// `type` drives the badge colour. `title` is the leading description
// shown in the Detalhe column. The full canonical message tables live
// in docs/CURVE_LOGS.md §3 and §4 — keep this in sync if you add a new
// branch over there.
export function describeLog(log) {
  // ---- Audit events (action != null) ----
  if (log.action) {
    const auth = ['login', 'login_failed', 'logout', 'session_expired', 'password_changed'];
    // `despesa` for category-management rows so the badge colour is
    // consistent with the chip they originated from on /expenses and /.
    // Source: docs/Categories.md §13.5.
    const despesaActions = ['expense_category_changed'];
    const type = auth.includes(log.action)
      ? 'auth'
      : despesaActions.includes(log.action)
        ? 'despesa'
        : 'sistema';

    switch (log.action) {
      case 'login':            return { type, title: 'Login efectuado' };
      case 'login_failed':     return { type, title: 'Login falhou' };
      case 'logout':           return { type, title: 'Sessão terminada' };
      case 'session_expired':  return { type, title: 'Sessão expirou' };
      case 'password_changed': return { type, title: 'Password alterada' };
      case 'config_updated':   return { type, title: 'Configuração actualizada' };
      case 'sync_manual':
        return {
          type,
          title: log.error_detail === 'dry_run'
            ? 'Sincronização manual iniciada (simulação)'
            : 'Sincronização manual iniciada',
        };
      case 'oauth_start':            return { type, title: 'Início de autorização Microsoft' };
      case 'oauth_completed':        return { type, title: 'Autorização concluída' };
      case 'oauth_cancelled':        return { type, title: 'Autorização cancelada' };
      case 'oauth_failed':
        return { type, title: `Autorização falhou${log.error_detail ? `: ${log.error_detail}` : ''}` };
      case 'oauth_token_refreshed':  return { type, title: 'Token Microsoft renovado automaticamente' };
      case 'first_sync_completed':   return { type, title: 'Primeira sincronização concluída' };
      case 'expense_category_changed': {
        // docs/Categories.md §13.2 #34 — canonical pt-PT:
        // "Despesa recategorizada: <entity> → <to>"
        //
        // `error_detail` follows the k=v convention ("from=X to=Y").
        // We display the `to` side because that's what the user is
        // going to look for when scanning history; the `from` is
        // useful context but would bloat the row.
        const toMatch = log.error_detail?.match(/to=([^\s]+)/);
        const to = toMatch ? toMatch[1] : null;
        const entity = log.entity ?? '—';
        return {
          type,
          title: to
            ? `Despesa recategorizada: ${entity} → ${to}`
            : `Despesa recategorizada: ${entity}`,
        };
      }
      case 'override_created':
      case 'override_updated':
      case 'override_deleted': {
        // docs/Categories.md §13.2 #29-31 — canonical pt-PT:
        //   #29 "Regra pessoal criada: <pattern> → <category>"
        //   #30 "Regra pessoal actualizada: <pattern> → <category>"
        //   #31 "Regra pessoal apagada: <pattern>"
        //
        // The route handlers in server/src/routes/categoryOverrides.js
        // write `entity: <raw pattern>` so we never have to parse
        // `pattern=` out of error_detail — the server already gave us
        // a structured copy. `error_detail` still carries `category=`
        // for the created/updated variants; we pull it with a
        // non-greedy match that stops at the next k=v key (for update,
        // `changed=` comes after) or end of string (for create).
        const pattern = log.entity ?? '—';
        if (log.action === 'override_deleted') {
          return { type, title: `Regra pessoal apagada: ${pattern}` };
        }
        const catMatch = log.error_detail?.match(/category=(.+?)(?: changed=|$)/);
        const category = catMatch ? catMatch[1] : null;
        const verb = log.action === 'override_created' ? 'criada' : 'actualizada';
        return {
          type,
          title: category
            ? `Regra pessoal ${verb}: ${pattern} → ${category}`
            : `Regra pessoal ${verb}: ${pattern}`,
        };
      }
      default:                       return { type, title: log.action };
    }
  }

  // ---- Sync events (action == null) ----
  // Rows with a parsed body are "despesa" type; the bodyless ones
  // (parse_error, circuit breaker, sync aborted) are "sistema".
  if (log.entity) {
    if (log.dry_run) {
      return {
        type: 'despesa',
        title: log.status === 'ok'
          ? 'Importaria nova despesa (simulação)'
          : log.status === 'duplicate'
            ? 'Já existia (simulação)'
            : `Falhou verificação${log.error_detail ? `: ${log.error_detail}` : ''}`,
      };
    }
    switch (log.status) {
      case 'ok':        return { type: 'despesa', title: 'Despesa importada' };
      case 'duplicate': return { type: 'despesa', title: 'Já existia (duplicado)' };
      case 'error':
        return { type: 'despesa', title: `Falhou ao guardar${log.error_detail ? `: ${log.error_detail}` : ''}` };
      default:          return { type: 'despesa', title: log.status };
    }
  }

  // Bodyless sync rows (parse_error, circuit breaker, sync aborted).
  if (log.status === 'parse_error') {
    return { type: 'sistema', title: `Email não reconhecido${log.error_detail ? `: ${log.error_detail}` : ''}` };
  }
  if (log.error_detail?.startsWith('circuit breaker')) {
    return { type: 'sistema', title: 'Sync abortada (parse errors em cadeia)' };
  }
  return { type: 'sistema', title: `Sync falhou${log.error_detail ? `: ${log.error_detail}` : ''}` };
}

// Groups consecutive expense rows (action == null && entity != null)
// that landed within BATCH_WINDOW_MS into a single batch entry.
//
// `expense_category_changed` rows (docs/Categories.md §13.2 #34) have
// `action != null` so they fall through to `{ kind: 'single' }` by
// design — each manual recategorisation surfaces as its own line for
// now. §13.5 proposes clustering adjacent recat rows into
// "N despesas recategorizadas manualmente" but that needs the batch
// renderer in CurveLogsPage.jsx to understand two batch flavours
// (sync vs recat), which is out of scope for PR #1. Revisit once
// users start complaining about flood.
//
// Input  : logs sorted newest-first by created_at (the API contract).
// Output : array of { kind: 'single', log } | { kind: 'batch', logs, summary, key }
//
// Why "consecutive" and not "any pair within the window": the API may
// page through unrelated rows that happen to be 4s apart but were not
// part of the same sync run. Requiring adjacency in the sorted stream
// is a cheap proxy for "same orchestrator pass".
//
// Known limitation — page-boundary splitting:
//   Pagination happens server-side (limit=30 by default) and this
//   helper runs on the page payload AFTER it lands in the client. A
//   cluster of 5 receipts that straddles the page-30 boundary will
//   surface as a 3-row batch on page 1 and a 2-row batch on page 2,
//   never as one 5-row batch. Fixing it means moving grouping
//   server-side and shipping mixed shapes through GET /api/curve/logs,
//   which is not worth it until real users complain. See
//   docs/CURVE_LOGS.md §6.6.
export function groupSyncBatches(logs) {
  const out = [];
  let i = 0;
  while (i < logs.length) {
    const cur = logs[i];
    const isExpenseRow = !cur.action && cur.entity;
    if (!isExpenseRow) {
      out.push({ kind: 'single', log: cur });
      i++;
      continue;
    }

    // Greedily extend the cluster while the next row is also an
    // expense row and within the window of the FIRST row in the
    // cluster (so a slow trickle of 6s gaps doesn't sneak in).
    const cluster = [cur];
    const anchorTs = new Date(cur.created_at).getTime();
    let j = i + 1;
    while (j < logs.length) {
      const next = logs[j];
      if (next.action || !next.entity) break;
      const nextTs = new Date(next.created_at).getTime();
      if (Math.abs(anchorTs - nextTs) > BATCH_WINDOW_MS) break;
      cluster.push(next);
      j++;
    }

    if (cluster.length === 1) {
      out.push({ kind: 'single', log: cur });
    } else {
      out.push({
        kind: 'batch',
        logs: cluster,
        summary: summariseBatch(cluster),
        key: cluster.map((l) => l._id).join(':'),
      });
    }
    i = j;
  }
  return out;
}

function summariseBatch(logs) {
  let ok = 0;
  let duplicates = 0;
  let errors = 0;
  let totalAmount = 0;
  for (const l of logs) {
    if (l.status === 'ok') ok++;
    else if (l.status === 'duplicate') duplicates++;
    else errors++;
    if (l.status === 'ok' && typeof l.amount === 'number') totalAmount += l.amount;
  }
  return { ok, duplicates, errors, totalAmount, count: logs.length };
}
