import { Fragment, useEffect, useState } from 'react';
import PageHeader from '../components/common/PageHeader';
import EmptyState from '../components/common/EmptyState';
import { ChevronLeftIcon, ChevronRightIcon } from '../components/layout/Icons';
import * as api from '../services/api';
import { describeLog, groupSyncBatches } from './curveLogsUtils';

const PER_PAGE = 30;

const TABS = [
  { id: 'all',   label: 'Tudo',           param: undefined },
  { id: 'sync',  label: 'Sincronizações', param: 'sync' },
  { id: 'audit', label: 'Auditoria',      param: 'audit' },
];

const TYPE_BADGE = {
  despesa: 'bg-curve-50 text-curve-800',
  sistema: 'bg-sand-100 text-sand-700',
  auth:    'bg-indigo-50 text-indigo-700',
};

const TYPE_LABEL = {
  despesa: 'Despesa',
  sistema: 'Sistema',
  auth:    'Auth',
};

export default function CurveLogsPage() {
  const [tab, setTab] = useState('all');
  const [logs, setLogs] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const params = { page, limit: PER_PAGE };
    const tabDef = TABS.find((t) => t.id === tab);
    if (tabDef?.param) params.type = tabDef.param;
    api
      .getCurveLogs(params)
      .then((res) => {
        setLogs(res.data ?? []);
        setTotal(res.meta?.total ?? 0);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [page, tab]);

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const rows = groupSyncBatches(logs);

  return (
    <>
      <PageHeader
        title="Logs"
        description="Histórico de sincronizações e eventos da conta"
      />

      <div className="mb-4 flex gap-1 rounded-xl border border-sand-200 bg-white p-1 text-sm">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              setTab(t.id);
              setPage(1);
            }}
            className={`flex-1 rounded-lg px-3 py-1.5 font-medium transition-colors ${
              tab === t.id
                ? 'bg-curve-700 text-white'
                : 'text-sand-600 hover:bg-sand-100'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-curve-300 border-t-curve-700" />
        </div>
      ) : logs.length === 0 ? (
        <EmptyState
          title="Sem logs"
          description="Os logs aparecerão após a primeira sincronização."
        />
      ) : (
        <div className="animate-fade-in overflow-hidden rounded-2xl border border-sand-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-sand-100 text-left text-xs font-medium uppercase tracking-wide text-sand-400">
                <th className="px-5 py-3 w-44">Data</th>
                <th className="px-5 py-3 w-28">Tipo</th>
                <th className="px-5 py-3">Detalhe</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) =>
                row.kind === 'batch' ? (
                  <BatchRow key={row.key} batch={row} />
                ) : (
                  <SingleRow key={row.log._id} log={row.log} />
                ),
              )}
            </tbody>
          </table>

          {/* Pagination */}
          <div className="flex items-center justify-between border-t border-sand-100 px-5 py-3">
            <span className="text-xs text-sand-400">
              {total} log{total !== 1 ? 's' : ''}
            </span>
            <div className="flex items-center gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="rounded-lg p-1.5 text-sand-400 transition-colors hover:bg-sand-100 disabled:opacity-30"
              >
                <ChevronLeftIcon className="h-4 w-4" />
              </button>
              <span className="text-xs text-sand-500">
                {page} / {totalPages}
              </span>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="rounded-lg p-1.5 text-sand-400 transition-colors hover:bg-sand-100 disabled:opacity-30"
              >
                <ChevronRightIcon className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ---------- Row components ----------

function SingleRow({ log }) {
  const { type, title } = describeLog(log);
  const isExpense = type === 'despesa' && log.entity;
  return (
    <tr className="border-b border-sand-50 transition-colors hover:bg-sand-50/60">
      <DateCell value={log.created_at} />
      <TypeCell type={type} />
      <td className="px-5 py-3">
        <div className="text-sand-900">{title}</div>
        {isExpense && (
          <div className="mt-0.5 text-xs text-sand-500">
            {log.entity}
            {log.amount != null && <> · €{Number(log.amount).toFixed(2)}</>}
            {log.digest && (
              <> · <code className="font-mono text-[11px] text-sand-400">{log.digest.slice(0, 12)}…</code></>
            )}
            {log.dry_run && (
              <span className="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-indigo-600">
                simulação
              </span>
            )}
          </div>
        )}
        {!isExpense && log.error_detail && !title.includes(log.error_detail) && (
          <div className="mt-0.5 break-all font-mono text-xs text-sand-400">{log.error_detail}</div>
        )}
      </td>
    </tr>
  );
}

function BatchRow({ batch }) {
  const [open, setOpen] = useState(false);
  const { ok, duplicates, errors, totalAmount, count } = batch.summary;
  const first = batch.logs[0];

  // Stitch together a compact summary like "5 importadas · €124.50" /
  // " · 2 duplicadas · 1 erro". Skip zero counts so the text doesn't
  // shout about absences.
  const parts = [];
  if (ok) parts.push(`${ok} ${ok === 1 ? 'importada' : 'importadas'}`);
  if (duplicates) parts.push(`${duplicates} ${duplicates === 1 ? 'duplicada' : 'duplicadas'}`);
  if (errors) parts.push(`${errors} ${errors === 1 ? 'erro' : 'erros'}`);

  return (
    <Fragment>
      <tr
        onClick={() => setOpen((v) => !v)}
        className="cursor-pointer border-b border-sand-50 transition-colors hover:bg-sand-50/60"
      >
        <DateCell value={first.created_at} />
        <TypeCell type="despesa" />
        <td className="px-5 py-3">
          <div className="flex items-center gap-2 text-sand-900">
            <ChevronRightIcon
              className={`h-3.5 w-3.5 text-sand-400 transition-transform ${open ? 'rotate-90' : ''}`}
            />
            <span>
              {count} despesas processadas
              {first.dry_run && (
                <span className="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-indigo-600">
                  simulação
                </span>
              )}
            </span>
          </div>
          <div className="mt-0.5 pl-5 text-xs text-sand-500">
            {parts.join(' · ')}
            {ok > 0 && totalAmount > 0 && <> · €{totalAmount.toFixed(2)}</>}
          </div>
        </td>
      </tr>
      {open &&
        batch.logs.map((log) => (
          <tr key={log._id} className="border-b border-sand-50 bg-sand-50/40">
            <td className="px-5 py-2 pl-12 text-xs text-sand-400">
              {formatDate(log.created_at)}
            </td>
            <td className="px-5 py-2">
              <StatusDot status={log.status} />
            </td>
            <td className="px-5 py-2 text-xs">
              <span className="text-sand-800">{log.entity ?? '—'}</span>
              {log.amount != null && (
                <span className="ml-2 text-sand-500">€{Number(log.amount).toFixed(2)}</span>
              )}
              {log.digest && (
                <code className="ml-2 font-mono text-[11px] text-sand-400">
                  {log.digest.slice(0, 12)}…
                </code>
              )}
              {log.error_detail && (
                <div className="mt-0.5 break-all font-mono text-[11px] text-curve-700">
                  {log.error_detail}
                </div>
              )}
            </td>
          </tr>
        ))}
    </Fragment>
  );
}

// ---------- Atoms ----------

function DateCell({ value }) {
  return <td className="px-5 py-3 text-xs text-sand-500">{formatDate(value)}</td>;
}

function TypeCell({ type }) {
  return (
    <td className="px-5 py-3">
      <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${TYPE_BADGE[type] ?? TYPE_BADGE.sistema}`}>
        {TYPE_LABEL[type] ?? type}
      </span>
    </td>
  );
}

function StatusDot({ status }) {
  const colour =
    status === 'ok'
      ? 'bg-emerald-400'
      : status === 'duplicate'
        ? 'bg-amber-400'
        : 'bg-curve-500';
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${colour}`} />;
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('pt-PT');
}
