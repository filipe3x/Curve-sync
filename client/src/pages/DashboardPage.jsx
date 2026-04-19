import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../components/common/PageHeader';
import StatCard from '../components/common/StatCard';
import AnimatedKPI from '../components/common/AnimatedKPI';
import EmptyState from '../components/common/EmptyState';
import CategoryPickerPopover from '../components/common/CategoryPickerPopover';
import CategoryEditUndoBanner from '../components/common/CategoryEditUndoBanner';
import ExclusionUndoBanner from '../components/common/ExclusionUndoBanner';
import { ArrowPathIcon } from '../components/layout/Icons';
import CycleTrendSkeleton from '../components/dashboard/CycleTrendSkeleton';

// recharts pulls in ~120 kB gzip of d3-* — bigger than the whole rest
// of the dashboard combined. Splitting it into its own chunk means
// first paint (stat cards + recent expenses) stays fast; the trend
// chart streams in on the next tick. See ROADMAP §2.8 build-size note.
// The skeleton is NOT lazy — it's a few hundred bytes of JSX and it
// needs to be on the main chunk so the Suspense fallback can render
// instantly on first paint (lazy-loading the fallback would defeat
// the purpose).
const CycleTrendCard = lazy(
  () => import('../components/dashboard/CycleTrendCard'),
);
import { useToast } from '../contexts/ToastContext';
import { formatExpenseDate, formatAbsoluteDate } from '../utils/relativeDate';
import * as api from '../services/api';

// Per-entry auto-dismiss window for the undo banner. Matches the
// ExpensesPage constant so /expenses and / feel consistent when
// users jump between them.
const UNDO_WINDOW_MS = 6000;

// Portuguese relative time for the "Último sync" stat card. We use a
// tiny hand-rolled formatter instead of Intl.RelativeTimeFormat because
// the latter rounds in unhelpful ways ("há 1 minuto" for 59 s felt
// jumpy) and the three bands below cover every realistic sync cadence.
function formatRelativePt(iso) {
  if (!iso) return '—';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const diff = Math.max(0, Date.now() - then);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'há segundos';
  const min = Math.floor(sec / 60);
  if (min < 60) return `há ${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `há ${hr} h`;
  const days = Math.floor(hr / 24);
  return `há ${days} d`;
}

// EUR formatter for month totals — parity with the currency style used
// across /expenses so €€€ never rendered with mixed separators.
const EUR = new Intl.NumberFormat('pt-PT', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 2,
});

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
  const toast = useToast();
  const [syncing, setSyncing] = useState(false);
  const [recentExpenses, setRecentExpenses] = useState([]);
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [syncStatus, setSyncStatus] = useState(null);
  const [oauthStatus, setOauthStatus] = useState(null);
  // "Sem categoria" count over the current day-22 cycle. Backs the
  // dashboard stat card that deep-links to /curve/logs?tab=uncategorised
  // — see docs/Categories.md §10.5 / §11.3 Fase 7. `null` while
  // loading; a failed fetch falls through to `null` and the card
  // renders `—` the same way the other placeholders do, so the
  // dashboard never blocks on this endpoint.
  const [uncategorisedCount, setUncategorisedCount] = useState(null);
  // Category catalogue + popover state for the quick-edit chip on the
  // "Despesas recentes" table. Mirrors ExpensesPage so the same
  // component handles both entry points from docs/Categories.md §12.
  const [categories, setCategories] = useState([]);
  // Map `category_id -> icon_name` forwarded to the quick-edit
  // popover so each tile renders its Lucide glyph. Failures fall
  // through to an empty map — the popover's <CategoryIcon> falls
  // back to the Tag glyph per-tile, which keeps the picker usable
  // even if `/api/category-icons` is down.
  const [iconByCategory, setIconByCategory] = useState(() => new Map());
  const [pickerExpenseId, setPickerExpenseId] = useState(null);
  const [pickerSaving, setPickerSaving] = useState(false);
  // After the undo-banner refactor `categoryToast` only carries errors
  // (single-row quick-edit failures + undo-PUT failures). Successes
  // stage on `categoryEdits` instead so the user gets a short grace
  // window to reverse a wrong-row click.
  const [categoryToast, setCategoryToast] = useState(null);
  // Pending undo entries for single-row quick-edits. Mirrors the
  // ExpensesPage state so /expenses and / share a consistent feel.
  const [categoryEdits, setCategoryEdits] = useState([]);
  const editTimersRef = useRef(new Map());
  // ROADMAP §2.10.1 — single-expense "Remover do ciclo" from the
  // popover header. One-at-a-time (not per-row) so the user can
  // Anular as a whole; same shape + 6 s window as /expenses.
  const [exclusionUndo, setExclusionUndo] = useState(null);
  const exclusionUndoTimerRef = useRef(null);
  const [exclusionBusy, setExclusionBusy] = useState(false);
  // Short-lived inline message for the sync button — success summary
  // or non-banner error. The re-auth banner handles OAuth breakage;
  // this covers everything else (parse errors, IMAP folder gone, etc.)
  // and also confirms a successful recovery sync with a green ack.
  const [syncMessage, setSyncMessage] = useState(null);

  // Consolidated reload. Used on mount AND in handleSync.finally so
  // both paths hit the same six endpoints, in parallel, with
  // per-endpoint silent-failure. Pre-§2.11 the mount useEffect loaded
  // six things but `handleSync` only refreshed three, leaving the
  // KPI cards (which depend on getExpenses `meta`) stale until a
  // page reload. Centralising the fetches is what fixes that.
  //
  // Each branch swallows its own error because any one of these may
  // be slow / unreachable and the dashboard must still paint what it
  // can. `getExpenses` is the one exception: its failure also surfaces
  // the top-level error banner since it drives both the stats AND the
  // recent-expenses table.
  const loadDashboard = async () => {
    const [
      expensesRes,
      syncRes,
      oauthRes,
      uncatRes,
      catsRes,
      iconsRes,
    ] = await Promise.allSettled([
      api.getExpenses({ limit: 5, sort: '-date_at' }),
      api.getSyncStatus(),
      api.getOAuthStatus(),
      api.getUncategorisedStats(),
      api.getCategories(),
      api.getCategoryIcons(),
    ]);

    if (expensesRes.status === 'fulfilled') {
      setRecentExpenses(expensesRes.value.data ?? []);
      setStats(expensesRes.value.meta ?? null);
      setError(null);
    } else {
      setError('Não foi possível carregar dados.');
    }
    if (syncRes.status === 'fulfilled') setSyncStatus(syncRes.value);
    if (oauthRes.status === 'fulfilled') setOauthStatus(oauthRes.value);
    if (uncatRes.status === 'fulfilled') {
      setUncategorisedCount(uncatRes.value?.count ?? null);
    }
    if (catsRes.status === 'fulfilled') {
      setCategories(catsRes.value.data ?? []);
    }
    if (iconsRes.status === 'fulfilled') {
      const entries = (iconsRes.value.data ?? []).map((row) => [
        String(row.category_id),
        row.icon_name,
      ]);
      setIconByCategory(new Map(entries));
    }
  };

  useEffect(() => {
    loadDashboard();
  }, []);

  // ─── Undo-banner plumbing ───────────────────────────────────────
  // Mirrors ExpensesPage: per-entry timer map kept outside state, push
  // dedupes per expenseId (preserving the *original* prevCategory so
  // Anular always reverts to the true pre-edit state), scheduleEditDismiss
  // re-arms the ~6 s timer when the user re-edits the same row.
  const clearEditTimer = (id) => {
    const t = editTimersRef.current.get(id);
    if (t) {
      clearTimeout(t);
      editTimersRef.current.delete(id);
    }
  };
  const scheduleEditDismiss = (id) => {
    clearEditTimer(id);
    const t = setTimeout(() => {
      setCategoryEdits((prev) => prev.filter((e) => e.id !== id));
      editTimersRef.current.delete(id);
    }, UNDO_WINDOW_MS);
    editTimersRef.current.set(id, t);
  };
  const pushCategoryEdit = (entry) => {
    setCategoryEdits((prev) => {
      const existing = prev.find((e) => e.expenseId === entry.expenseId);
      if (existing) clearEditTimer(existing.id);
      const merged = existing
        ? {
            ...entry,
            prevCategoryId: existing.prevCategoryId,
            prevCategoryName: existing.prevCategoryName,
          }
        : entry;
      const rest = prev.filter((e) => e.expenseId !== entry.expenseId);
      return [...rest, merged];
    });
    scheduleEditDismiss(entry.id);
  };
  useEffect(() => {
    const timers = editTimersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  // Quick-edit save with optimistic update + rollback. Mirrors the
  // ExpensesPage helper; see docs/Categories.md §12.4. Success stages
  // an undo entry instead of firing a "saved" toast — the chip already
  // changed in place, so what the user actually needs is a short
  // grace window to catch a wrong-row click.
  const handleCategorySave = async (expenseId, newCategoryId) => {
    const prev = recentExpenses;
    const prevRow = prev.find((e) => e._id === expenseId);
    const entity = prevRow?.entity ?? '';
    const prevCategoryId = prevRow?.category_id ?? null;
    const prevCategoryName = prevRow?.category_name ?? null;
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
      pushCategoryEdit({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        expenseId,
        entity,
        prevCategoryId,
        prevCategoryName,
        nextCategoryName: res.data?.category_name ?? newCategoryName,
      });
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

  // Anular handler — optimistic revert + PUT back to prevCategoryId.
  // Symmetric with the forward save: rollback on failure, re-arm the
  // banner so the user can try again, and surface an error toast.
  const handleUndoCategoryEdit = async (entry) => {
    clearEditTimer(entry.id);
    setCategoryEdits((prev) =>
      prev.map((e) => (e.id === entry.id ? { ...e, undoing: true } : e)),
    );
    const prevRows = recentExpenses;
    setRecentExpenses((rows) =>
      rows.map((e) =>
        e._id === entry.expenseId
          ? {
              ...e,
              category_id: entry.prevCategoryId,
              category_name: entry.prevCategoryName,
            }
          : e,
      ),
    );
    try {
      const res = await api.updateExpenseCategory(
        entry.expenseId,
        entry.prevCategoryId,
      );
      setRecentExpenses((rows) =>
        rows.map((e) =>
          e._id === entry.expenseId ? { ...e, ...res.data } : e,
        ),
      );
      setCategoryEdits((prev) => prev.filter((e) => e.id !== entry.id));
    } catch (err) {
      setRecentExpenses(prevRows);
      setCategoryEdits((prev) =>
        prev.map((e) => (e.id === entry.id ? { ...e, undoing: false } : e)),
      );
      setCategoryToast({
        type: 'error',
        text: err?.message ?? 'Não foi possível anular a alteração.',
      });
      scheduleEditDismiss(entry.id);
    }
  };

  // ─── Exclusion banner plumbing (§2.10.1) ──────────────────────
  // Same timer-ref pattern as the category undo, but a single slot
  // because the banner is one-at-a-time.
  const clearExclusionTimer = () => {
    if (exclusionUndoTimerRef.current) {
      clearTimeout(exclusionUndoTimerRef.current);
      exclusionUndoTimerRef.current = null;
    }
  };
  const scheduleExclusionDismiss = () => {
    clearExclusionTimer();
    exclusionUndoTimerRef.current = setTimeout(() => {
      setExclusionUndo(null);
      exclusionUndoTimerRef.current = null;
    }, UNDO_WINDOW_MS);
  };
  useEffect(() => {
    return () => clearExclusionTimer();
  }, []);

  const handleToggleSingleCycle = async (exp) => {
    if (!exp?._id || exclusionBusy) return;
    const currentlyExcluded = exp.excluded === true;
    const direction = currentlyExcluded ? 'included' : 'excluded';
    const nextExcluded = !currentlyExcluded;
    const ids = [exp._id];
    const prev = recentExpenses;
    setRecentExpenses((rows) =>
      rows.map((e) =>
        e._id === exp._id ? { ...e, excluded: nextExcluded } : e,
      ),
    );
    setPickerExpenseId(null);
    setExclusionBusy(true);
    try {
      const call = currentlyExcluded
        ? api.includeExpenses
        : api.excludeExpenses;
      const res = await call(ids);
      const affected = res?.affected ?? 1;
      const skipped = res?.skipped ?? 0;
      const verbPast = currentlyExcluded ? 'reincluída' : 'excluída';
      const text = `Despesa ${exp.entity} ${verbPast} ${currentlyExcluded ? 'no' : 'do'} ciclo.`;
      setExclusionUndo({
        ids,
        direction,
        affected,
        skipped,
        text,
      });
      scheduleExclusionDismiss();
      // Refresh the KPI cards — `month_total` and `savings_score`
      // live in `stats` (meta from getExpenses), so the toggle has
      // to round-trip before the numbers on the dashboard reflect it.
      loadDashboard().catch(() => {});
    } catch (err) {
      setRecentExpenses(prev);
      setCategoryToast({
        type: 'error',
        text:
          err?.message ??
          (currentlyExcluded
            ? 'Não foi possível reincluir no ciclo.'
            : 'Não foi possível excluir do ciclo.'),
      });
    } finally {
      setExclusionBusy(false);
    }
  };

  const handleExclusionUndo = async () => {
    if (!exclusionUndo || exclusionBusy) return;
    clearExclusionTimer();
    const { ids, direction } = exclusionUndo;
    const prev = recentExpenses;
    const revertedExcluded = direction === 'included';
    setRecentExpenses((rows) =>
      rows.map((e) =>
        ids.includes(e._id) ? { ...e, excluded: revertedExcluded } : e,
      ),
    );
    setExclusionBusy(true);
    try {
      const call =
        direction === 'excluded' ? api.includeExpenses : api.excludeExpenses;
      await call(ids);
      setExclusionUndo(null);
      // Refresh the KPI cards + uncategorised count — the exclusion
      // flipped back, so the month total / savings score need to
      // pick up the restored expense without a page reload.
      loadDashboard().catch(() => {});
    } catch (err) {
      setRecentExpenses(prev);
      setCategoryToast({
        type: 'error',
        text: err?.message ?? 'Não foi possível anular.',
      });
      scheduleExclusionDismiss();
    } finally {
      setExclusionBusy(false);
    }
  };

  // Errors stay up until the next action so the user can read them;
  // there is no ok branch anymore (successes stage on categoryEdits).
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
      const text = res?.message ?? 'Sincronização concluída.';
      setSyncMessage({ type: 'ok', text });
      toast.success(text, { id: 'sync-result' });
    } catch (err) {
      // Non-banner errors (circuit breaker, folder missing, etc.)
      // still need an inline message so the user knows something
      // happened. OAuth-reauth errors also land here — the error
      // message is redundant with the banner but harmless, and it's
      // better than a silent click.
      const text = err?.message ?? 'Sincronização falhou.';
      setSyncMessage({ type: 'error', text });
      toast.error(text, { id: 'sync-result' });
    } finally {
      setSyncing(false);
      // Full refresh regardless of sync outcome. Success may have
      // imported new expenses (so month_total + savings_score change),
      // may have added "Sem categoria" rows, and must clear any
      // stale `last_sync_status='error'` that was lighting the
      // re-auth banner. Failure flips things the other way. Either
      // way, hitting all six endpoints keeps every card and the
      // recent-expenses table honest without a page reload.
      try {
        await loadDashboard();
      } catch {
        /* best-effort — the cards will catch up on next interaction */
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
          <button
            onClick={handleSync}
            disabled={syncing}
            aria-label={syncing ? 'A sincronizar…' : 'Sincronizar agora'}
            title={syncing ? 'A sincronizar…' : 'Sincronizar agora'}
            className="btn-primary"
          >
            {/*
              Icon bumped from h-4 to h-5 so it reads as a proper glyph
              (not a token) next to the button chrome. Mobile (< lg)
              hides the text entirely — the 40-px primary button keeps
              a tappable target without competing with the rail on the
              left. aria-label + title still expose the action name to
              assistive tech and desktop tooltips.
            */}
            <ArrowPathIcon
              className={`h-5 w-5 ${syncing ? 'animate-spin' : ''}`}
            />
            <span className="hidden lg:inline">
              {syncing ? 'A sincronizar…' : 'Sincronizar agora'}
            </span>
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

      {/* Stat cards — three numeric KPIs share AnimatedKPI so the
          numbers tween on every refresh (mount OR post-sync), not
          just first paint. Último sync stays on StatCard because its
          value is relative-time text, not a number. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <AnimatedKPI
          label="Despesas este mês"
          value={stats?.month_total}
          format={(v) => EUR.format(v)}
          sub={
            stats?.cycle?.start && stats?.cycle?.end
              ? `${stats.cycle.start} → ${stats.cycle.end}`
              : undefined
          }
        />
        {/*
          Savings Score — 0 to 10 on a log curve (see
          server/src/services/expenseStats.js → computeSavingsScore).
          `perfect` kicks in when the tween lands on exactly 10 and
          dresses the number in the shimmer/breathe combo defined in
          index.css. Sub-label reads as `{savings} / {budget}`
          (kept / possible); the tooltip carries the fuller
          explanation for desktop hover.
        */}
        <AnimatedKPI
          label="Savings Score"
          value={stats?.savings_score}
          format={(v) => v.toFixed(1)}
          sub={
            stats?.weekly_savings != null && stats?.weekly_budget
              ? `${EUR.format(stats.weekly_savings)} / ${EUR.format(stats.weekly_budget)}`
              : undefined
          }
          title="Score de 0 a 10 baseado no que poupaste esta semana face ao orçamento. Escala logarítmica — poupar pouco já dá score alto; gastar tudo colapsa para 0."
          accent
          perfect
        />
        {/*
          "Sem categoria" card — the one interactive stat on the
          dashboard. Wrapping AnimatedKPI in a Link rather than
          teaching the component about href keeps it dumb (it's also
          used on /categories). Deep-links to /curve/logs with the
          tab param so the user lands directly on the uncategorised
          bucket, scoped to the current day-22 cycle by the server.
         */}
        <Link
          to="/curve/logs?tab=uncategorised"
          className="block rounded-2xl transition-transform hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-amber-500/30"
        >
          <AnimatedKPI
            label="Sem categoria"
            value={uncategorisedCount}
            format={(v) => Math.round(v).toLocaleString('pt-PT')}
            sub="ciclo actual"
          />
        </Link>
        <StatCard
          label="Último sync"
          value={formatRelativePt(
            syncStatus?.last_sync_at ?? stats?.last_sync_at,
          )}
          sub={
            stats?.emails_processed != null
              ? `${stats.emails_processed.toLocaleString('pt-PT')} emails processados`
              : (syncStatus?.last_sync_status ?? stats?.last_sync_status)
          }
        />
      </div>

      {/* Recent expenses */}
      <section className="mt-8">
        <h2 className="mb-4 text-lg font-semibold text-sand-800">
          Despesas recentes
        </h2>

        {/* Quick-edit error toast — mirrors ExpensesPage so the two
            entry points surface identically (§12.8). Successes are
            rendered as an undo banner below instead of a toast. */}
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

        {/* Staging banner(s) for single-row quick-edits — same shape
            as the /expenses banner; each entry auto-dismisses after
            ~6 s unless the user clicks Anular. */}
        <CategoryEditUndoBanner
          edits={categoryEdits}
          onUndo={handleUndoCategoryEdit}
        />

        {/* ROADMAP §2.10.1 — "Remover do ciclo" undo banner. Fed by
            the mini button in the CategoryPickerPopover header on the
            "Despesas recentes" table below. */}
        <ExclusionUndoBanner
          entry={exclusionUndo}
          onUndo={handleExclusionUndo}
          busy={exclusionBusy}
        />

        {error && (
          <p className="mb-4 text-sm text-curve-600">{error}</p>
        )}

        {recentExpenses.length === 0 ? (
          <EmptyState
            title="Sem despesas"
            description="As despesas aparecerão aqui após a primeira sincronização."
          />
        ) : (
          <div
            /* `overflow-hidden` normally clips the table rows to the
               wrapper's rounded corners, but it also clips the
               CategoryPickerPopover that opens out of the last column.
               Toggle it off only while a picker is open so the popover
               can escape; the brief loss of corner masking is
               invisible because no row hover is in play during the
               edit. */
            className={`rounded-2xl border border-sand-200 bg-white ${
              pickerExpenseId ? '' : 'overflow-hidden'
            }`}
          >
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
                  const rowExcluded = exp.excluded === true;
                  // Per-cell dim instead of `opacity-*` on the <tr>
                  // — the row-level opacity creates a stacking context
                  // that trapped the CategoryPickerPopover and stole
                  // clicks on the cycle-toggle button (§2.10.1 bug).
                  // The category cell keeps full opacity so the chip
                  // and its popover stay fully interactive.
                  const dimCell = rowExcluded ? 'opacity-60' : '';
                  return (
                    <tr
                      key={exp._id ?? i}
                      title={
                        rowExcluded
                          ? 'Excluída do ciclo e do Savings Score'
                          : undefined
                      }
                      className={`border-b border-sand-50 transition-colors duration-150 ${
                        rowExcluded
                          ? 'bg-sand-50 hover:bg-sand-100'
                          : 'hover:bg-sand-50'
                      }`}
                      style={{ animationDelay: `${i * 60}ms` }}
                    >
                      <td className={`px-5 py-3 font-medium text-sand-900 ${dimCell}`}>
                        {exp.entity}
                      </td>
                      <td className={`px-5 py-3 text-curve-700 font-semibold ${dimCell}`}>
                        €{Number(exp.amount).toFixed(2)}
                      </td>
                      <td
                        className={`px-5 py-3 text-sand-500 ${dimCell}`}
                        title={formatAbsoluteDate(exp.date)}
                      >
                        <div className="flex items-center gap-2">
                          <span>{formatExpenseDate(exp.date)}</span>
                          {rowExcluded && (
                            <span className="badge bg-sand-200 text-sand-600">
                              excluída
                            </span>
                          )}
                        </div>
                      </td>
                      <td className={`px-5 py-3 text-sand-500 ${dimCell}`}>{exp.card}</td>
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
                            iconByCategory={iconByCategory}
                            saving={pickerSaving}
                            excluded={exp.excluded === true}
                            onSelect={(newId) =>
                              handleCategorySave(exp._id, newId)
                            }
                            onToggleCycle={() => handleToggleSingleCycle(exp)}
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

      {/* ROADMAP §2.8 — trend chart at the bottom of the dashboard.
          Fed by meta.cycle_history (server/src/services/expenseStats.js
          → computeCycleHistory) on the same /expenses call that
          powers the stat cards above. Card handles its own empty and
          low-data states (≤ 1 cycle → empty illustration, ≤ 6 cycles
          → toggle locked to 6m). Suspense fallback is a bare skeleton
          matching the card shell height — avoids CLS while the
          recharts chunk streams. */}
      {stats?.cycle_history && (
        <section className="mt-8">
          <Suspense fallback={<CycleTrendSkeleton />}>
            <CycleTrendCard history={stats.cycle_history} />
          </Suspense>
        </section>
      )}
    </>
  );
}
