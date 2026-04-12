import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../components/common/PageHeader';
import StatCard from '../components/common/StatCard';
import EmptyState from '../components/common/EmptyState';
import { ArrowPathIcon } from '../components/layout/Icons';
import * as api from '../services/api';

/**
 * Re-auth banner visibility rule (see docs/EMAIL_AUTH_MVP.md §8 items
 * 4 and 5): we show it when the last sync ended in `error` AND the
 * user is on the OAuth branch. App Password failures surface on the
 * config page, not here, because the fix requires typing a new
 * password — the dashboard CTA doesn't help. OAuth failures instead
 * map cleanly to "run the wizard again", which is what this banner
 * links to.
 */
function needsReauth({ syncStatus, oauthStatus }) {
  if (!syncStatus || !oauthStatus) return false;
  if (syncStatus.last_sync_status !== 'error') return false;
  return Boolean(oauthStatus.connected && oauthStatus.provider);
}

export default function DashboardPage() {
  const [syncing, setSyncing] = useState(false);
  const [recentExpenses, setRecentExpenses] = useState([]);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [syncStatus, setSyncStatus] = useState(null);
  const [oauthStatus, setOauthStatus] = useState(null);

  useEffect(() => {
    api
      .getExpenses({ limit: 5, sort: '-date' })
      .then((res) => {
        setRecentExpenses(res.data ?? []);
        setStats(res.meta ?? null);
      })
      .catch(() => setError('Não foi possível carregar dados.'));

    // Fire both auth + sync status in parallel. Failures are
    // swallowed — the banner just stays hidden. The dashboard must
    // not become a hostage to /oauth/status being unreachable.
    Promise.allSettled([api.getSyncStatus(), api.getOAuthStatus()]).then(
      ([syncRes, oauthRes]) => {
        if (syncRes.status === 'fulfilled') setSyncStatus(syncRes.value);
        if (oauthRes.status === 'fulfilled') setOauthStatus(oauthRes.value);
      },
    );
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await api.triggerSync();
      // Refresh the status after the sync so the banner disappears
      // immediately on recovery without requiring a full page reload.
      try {
        setSyncStatus(await api.getSyncStatus());
      } catch {
        /* banner stays on stale state — acceptable */
      }
    } catch {
      /* toast later */
    } finally {
      setSyncing(false);
    }
  };

  const showReauth = needsReauth({ syncStatus, oauthStatus });

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Resumo da sincronização e despesas recentes"
        actions={
          <button onClick={handleSync} disabled={syncing} className="btn-primary">
            <ArrowPathIcon
              className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`}
            />
            {syncing ? 'A sincronizar…' : 'Sincronizar agora'}
          </button>
        }
      />

      {/*
        Re-auth banner — fires only when the last sync ended in `error`
        AND the user is connected via OAuth. Clicking the CTA takes
        them to the wizard, where re-running the DAG refreshes the
        token cache. See docs/EMAIL_AUTH_MVP.md §8 items 4-5.
      */}
      {showReauth && (
        <Link
          to="/curve/setup"
          className="mb-5 block rounded-2xl border border-curve-200 bg-curve-50 px-5 py-4 hover:bg-curve-100 transition-colors"
        >
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-curve-900">
                A ligação à conta Microsoft expirou
              </p>
              <p className="text-sm text-curve-800/80">
                A última sincronização falhou a autenticar com{' '}
                <code className="font-mono text-curve-900">
                  {oauthStatus?.email || 'a tua conta'}
                </code>
                . Abre o assistente para reautorizar — não perdes
                configuração nem histórico.
              </p>
            </div>
            <span className="shrink-0 text-sm font-medium text-curve-900 underline underline-offset-4">
              Reautorizar →
            </span>
          </div>
        </Link>
      )}

      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Despesas este mês"
          value={stats?.month_total != null ? `€${stats.month_total}` : '—'}
        />
        <StatCard
          label="Savings Score"
          value={stats?.savings_score != null ? stats.savings_score : '—'}
          accent
        />
        <StatCard
          label="Emails processados"
          value={stats?.emails_processed ?? '—'}
        />
        <StatCard
          label="Último sync"
          value={stats?.last_sync ?? '—'}
          sub={syncStatus?.last_sync_status ?? stats?.last_sync_status}
        />
      </div>

      {/* Recent expenses */}
      <section className="mt-8">
        <h2 className="mb-4 text-lg font-semibold text-sand-800">
          Despesas recentes
        </h2>

        {error && (
          <p className="mb-4 text-sm text-curve-600">{error}</p>
        )}

        {recentExpenses.length === 0 ? (
          <EmptyState
            title="Sem despesas"
            description="As despesas aparecerão aqui após a primeira sincronização."
          />
        ) : (
          <div className="overflow-hidden rounded-2xl border border-sand-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-sand-100 text-left text-xs font-medium uppercase tracking-wide text-sand-400">
                  <th className="px-5 py-3">Entidade</th>
                  <th className="px-5 py-3">Montante</th>
                  <th className="px-5 py-3">Data</th>
                  <th className="px-5 py-3">Cartão</th>
                  <th className="px-5 py-3">Categoria</th>
                </tr>
              </thead>
              <tbody>
                {recentExpenses.map((exp, i) => (
                  <tr
                    key={exp._id ?? i}
                    className="border-b border-sand-50 transition-colors duration-150 hover:bg-sand-50"
                    style={{ animationDelay: `${i * 60}ms` }}
                  >
                    <td className="px-5 py-3 font-medium text-sand-900">
                      {exp.entity}
                    </td>
                    <td className="px-5 py-3 text-curve-700 font-semibold">
                      €{Number(exp.amount).toFixed(2)}
                    </td>
                    <td className="px-5 py-3 text-sand-500">{exp.date}</td>
                    <td className="px-5 py-3 text-sand-500">{exp.card}</td>
                    <td className="px-5 py-3">
                      {exp.category_name ? (
                        <span className="badge bg-sand-100 text-sand-600">
                          {exp.category_name}
                        </span>
                      ) : (
                        <span className="text-sand-300">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
