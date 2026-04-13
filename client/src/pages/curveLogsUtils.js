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
    const type = auth.includes(log.action) ? 'auth' : 'sistema';

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
// Input  : logs sorted newest-first by created_at (the API contract).
// Output : array of { kind: 'single', log } | { kind: 'batch', logs, summary, key }
//
// Why "consecutive" and not "any pair within the window": the API may
// page through unrelated rows that happen to be 4s apart but were not
// part of the same sync run. Requiring adjacency in the sorted stream
// is a cheap proxy for "same orchestrator pass".
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
