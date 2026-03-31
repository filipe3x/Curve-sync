import { useEffect, useState } from 'react';
import PageHeader from '../components/common/PageHeader';
import StatCard from '../components/common/StatCard';
import EmptyState from '../components/common/EmptyState';
import { ArrowPathIcon } from '../components/layout/Icons';
import * as api from '../services/api';

export default function DashboardPage() {
  const [syncing, setSyncing] = useState(false);
  const [recentExpenses, setRecentExpenses] = useState([]);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .getExpenses({ limit: 5, sort: '-date' })
      .then((res) => {
        setRecentExpenses(res.data ?? []);
        setStats(res.meta ?? null);
      })
      .catch(() => setError('Não foi possível carregar dados.'));
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await api.triggerSync();
    } catch {
      /* toast later */
    } finally {
      setSyncing(false);
    }
  };

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
          sub={stats?.last_sync_status}
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
