import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../components/common/PageHeader';
import StatCard from '../components/common/StatCard';
import EmptyState from '../components/common/EmptyState';
import CategoryPickerPopover from '../components/common/CategoryPickerPopover';
import { ArrowPathIcon } from '../components/layout/Icons';
import * as api from '../services/api';

/**
 * Re-auth banner visibility rule (see docs/EMAIL_AUTH_MVP.md §8 items
 * 4 and 5). The banner fires when the user is on the OAuth branch AND
 * at least one of:
 *
 *   A) The OAuth cache is currently broken — `oauthStatus.provider` is
 *      set but `connected` is false. Happens when the cache was wiped
 *      (smoke test, manual DB edit, revoked consent, ~90 days of
 *      inactivity). This is the *before a sync runs* signal.
 *
 *   B) The last sync ended in `error`. Covers the *after a sync runs*
 *      signal — including cases where the cache was still readable at
 *      load time but the refresh token exchange failed at sync time.
 *
 * App Password failures deliberately do NOT trigger this banner: the
 * fix requires typing a new password, so the dashboard CTA (which
 * sends the user to /curve/setup) doesn't help. Those users land on
 * the config page instead.
 *
 * Pre-fix the gate ANDed both conditions (requiring `connected === true`
 * AND `last_sync_status === 'error'`), which was exactly inverted — the
 * banner fired only in the contradictory state of "connection is fine
 * but sync errored anyway". The --break smoke path was invisible as a
 * result.
 */
function needsReauth({ syncStatus, oauthStatus }) {
  if (!oauthStatus?.provider) return false;
  if (oauthStatus.connected === false) return true;
  if (syncStatus?.last_sync_status === 'error') return true;
  return false;
}

export default function DashboardPage() {
  const [syncing, setSyncing] = useState(false);
  const [recentExpenses, setRecentExpenses] = useState([]);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [syncStatus, setSyncStatus] = useState(null);
  const [oauthStatus, setOauthStatus] = useState(null);
  // Category catalogue + popover state for the quick-edit chip on the
  // "Despesas recentes" table. Mirrors ExpensesPage so the same
  // component handles both entry points from docs/Categories.md §12.
  const [categories, setCategories] = useState([]);
  const [pickerExpenseId, setPickerExpenseId] = useState(null);
  const [pickerSaving, setPickerSaving] = useState(false);
  const [categoryToast, setCategoryToast] = useState(null);
  // Short-lived inline message for the sync button — success summary
  // or non-banner error. The re-auth banner handles OAuth breakage;
  // this covers everything else (parse errors, IMAP folder gone, etc.)
  // and also confirms a successful recovery sync with a green ack.
  const [syncMessage, setSyncMessage] = useState(null);

  // Parallel reload helper — used on mount AND after every sync
  // attempt (success or failure). Keeping both statuses fresh is what
  // lets the re-auth banner appear/disappear without a page reload.
  const refreshStatuses = async () => {
    const [syncRes, oauthRes] = await Promise.allSettled([
      api.getSyncStatus(),
      api.getOAuthStatus(),
    ]);
    if (syncRes.status === 'fulfilled') setSyncStatus(syncRes.value);
    if (oauthRes.status === 'fulfilled') setOauthStatus(oauthRes.value);
  };

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
    refreshStatuses();

    // Category catalogue for the quick-edit popover — tiny payload,
    // failures are silent (popover just shows an empty state).
    api
      .getCategories()
      .then((res) => setCategories(res.data ?? []))
      .catch(() => setCategories([]));
  }, []);

  // Quick-edit save with optimistic update + rollback. Mirrors the
  // ExpensesPage helper; see docs/Categories.md §12.4.
  const handleCategorySave = async (expenseId, newCategoryId) => {
    const prev = recentExpenses;
    const newCategoryName = newCategoryId
      ? categories.find((c) => String(c._id) === String(newCategoryId))?.name ?? null
      : null;
    setRecentExpenses((rows) =>
      rows.map((e) =>
        e._id === expenseId
          ? { ...e, category_id: newCategoryId, category_name: newCategoryName }
          : e,
      ),
    );
    setPickerSaving(true);
    try {
      const res = await api.updateExpenseCategory(expenseId, newCategoryId);
      setRecentExpenses((rows) =>
        rows.map((e) => (e._id === expenseId ? { ...e, ...res.data } : e)),
      );
      setCategoryToast({ type: 'ok', text: 'Categoria actualizada.' });
      setPickerExpenseId(null);
    } catch (err) {
      setRecentExpenses(prev);
      setCategoryToast({
        type: 'error',
        text: err?.message ?? 'Não foi possível actualizar a categoria.',
      });
    } finally {
      setPickerSaving(false);
    }
  };

  useEffect(() => {
    if (categoryToast?.type !== 'ok') return;
    const t = setTimeout(() => setCategoryToast(null), 4000);
    return () => clearTimeout(t);
  }, [categoryToast]);

  const handleSync = async () => {
    setSyncing(true);
    setSyncMessage(null);
    let success = false;
    try {
      const res = await api.triggerSync();
      success = true;
      // Server returns `{ message, summary }` — mirror the string the
      // config page shows so the user gets the same feedback regardless
      // of where the sync was triggered from.
      setSyncMessage({
        type: 'ok',
        text: res?.message ?? 'Sincronização concluída.',
      });
    } catch (err) {
      // Non-banner errors (circuit breaker, folder missing, etc.)
      // still need an inline message so the user knows something
      // happened. OAuth-reauth errors also land here — the error
      // message is redundant with the banner but harmless, and it's
      // better than a silent click.
      setSyncMessage({
        type: 'error',
        text: err?.message ?? 'Sincronização falhou.',
      });
    } finally {
      setSyncing(false);
      // Refresh both statuses whatever the outcome:
      //   - On success: may have recovered from an earlier error, so
      //     the banner should disappear → we need fresh sync status.
      //     oauthStatus may also have changed if the user re-ran the
      //     wizard in another tab between mounts, so refresh that too.
      //   - On failure: the server flipped `last_sync_status='error'`
      //     and/or the OAuth cache is now known-broken, so refreshing
      //     both is what makes the banner light up in-place without
      //     requiring the user to reload the dashboard.
      try {
        await refreshStatuses();
      } catch {
        /* best-effort — the banner will catch up on next mount */
      }
      // Keep the message visible but slightly longer on success so
      // the user can read it. Error messages stay until the next
      // click because dismissing them silently would just recreate
      // the "no feedback" bug we're fixing.
      if (success) {
        setTimeout(() => setSyncMessage(null), 6000);
      }
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

      {/*
        Inline sync message — success summary or non-banner error.
        Rendered above the stat cards so it's the first thing the user
        sees after clicking "Sincronizar agora". OAuth-reauth errors
        still render here AND trigger the banner above; the redundancy
        is intentional (the banner explains what to do, the message
        explains what happened).
      */}
      {syncMessage && (
        <div
          className={`mb-5 rounded-2xl px-5 py-3 text-sm ${
            syncMessage.type === 'ok'
              ? 'bg-emerald-50 text-emerald-800'
              : 'bg-red-50 text-red-800'
          }`}
          role={syncMessage.type === 'error' ? 'alert' : 'status'}
        >
          {syncMessage.text}
        </div>
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

        {/* Quick-edit popover feedback — mirrors ExpensesPage so the
            two entry points surface identically (§12.8). */}
        {categoryToast && (
          <div
            className={`mb-4 animate-slide-in-right rounded-2xl px-4 py-3 text-sm ${
              categoryToast.type === 'ok'
                ? 'bg-emerald-50 text-emerald-800'
                : 'bg-red-50 text-curve-700'
            }`}
            role={categoryToast.type === 'error' ? 'alert' : 'status'}
          >
            {categoryToast.text}
          </div>
        )}

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
                {recentExpenses.map((exp, i) => {
                  const pickerOpen = pickerExpenseId === exp._id;
                  return (
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
                      <td className="relative px-5 py-3">
                        <button
                          type="button"
                          onClick={() => setPickerExpenseId(exp._id)}
                          className="rounded-lg text-left transition-colors hover:bg-sand-100 focus:outline-none focus:ring-2 focus:ring-curve-500/30"
                          aria-label={`Alterar categoria de ${exp.entity}`}
                        >
                          {exp.category_name ? (
                            <span className="badge bg-sand-100 text-sand-600">
                              {exp.category_name}
                            </span>
                          ) : (
                            <span className="px-2 text-sand-300">—</span>
                          )}
                        </button>
                        {pickerOpen && (
                          <CategoryPickerPopover
                            expense={exp}
                            categories={categories}
                            saving={pickerSaving}
                            onSelect={(newId) =>
                              handleCategorySave(exp._id, newId)
                            }
                            onCancel={() => {
                              if (pickerSaving) return;
                              setPickerExpenseId(null);
                            }}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
