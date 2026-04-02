import { useEffect, useState } from 'react';
import PageHeader from '../components/common/PageHeader';
import EmptyState from '../components/common/EmptyState';
import { ChevronLeftIcon, ChevronRightIcon } from '../components/layout/Icons';
import * as api from '../services/api';

const PER_PAGE = 30;

const STATUS_CLASSES = {
  ok: 'badge-ok',
  duplicate: 'badge-pending',
  parse_error: 'badge-error',
  error: 'badge-error',
};

export default function CurveLogsPage() {
  const [logs, setLogs] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api
      .getCurveLogs({ page, limit: PER_PAGE })
      .then((res) => {
        setLogs(res.data ?? []);
        setTotal(res.meta?.total ?? 0);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [page]);

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  return (
    <>
      <PageHeader
        title="Logs de Sincronização"
        description="Histórico de processamento de emails Curve"
      />

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
                <th className="px-5 py-3">Data</th>
                <th className="px-5 py-3">Estado</th>
                <th className="px-5 py-3">Entidade</th>
                <th className="px-5 py-3">Montante</th>
                <th className="px-5 py-3">Digest</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log, i) => (
                <tr
                  key={log._id ?? i}
                  className="border-b border-sand-50 transition-colors duration-150 hover:bg-sand-50"
                >
                  <td className="px-5 py-3 text-sand-500">
                    {log.created_at
                      ? new Date(log.created_at).toLocaleString('pt-PT')
                      : '—'}
                  </td>
                  <td className="px-5 py-3">
                    <span className={STATUS_CLASSES[log.status] ?? 'badge bg-sand-100 text-sand-600'}>
                      {log.status}
                    </span>
                  </td>
                  <td className="px-5 py-3 font-medium text-sand-900">
                    {log.entity ?? '—'}
                  </td>
                  <td className="px-5 py-3 text-sand-600">
                    {log.amount != null ? `€${Number(log.amount).toFixed(2)}` : '—'}
                  </td>
                  <td className="px-5 py-3">
                    <code className="rounded bg-sand-100 px-2 py-0.5 text-xs text-sand-500">
                      {log.digest ? log.digest.slice(0, 12) + '…' : '—'}
                    </code>
                  </td>
                </tr>
              ))}
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
