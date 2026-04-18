import { Fragment, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import PageHeader from '../components/common/PageHeader';
import EmptyState from '../components/common/EmptyState';
import CategoryPickerPopover from '../components/common/CategoryPickerPopover';
import CategoryEditUndoBanner from '../components/common/CategoryEditUndoBanner';
import ExclusionUndoBanner from '../components/common/ExclusionUndoBanner';
import { ChevronLeftIcon, ChevronRightIcon } from '../components/layout/Icons';
import { useToast } from '../contexts/ToastContext';
import * as api from '../services/api';
import { describeLog, groupSyncBatches, parseResolutionDetail } from './curveLogsUtils';

const PER_PAGE = 30;

// Grace window (ms) during which the amber undo banner is visible
// before the category change becomes sticky. Matches the /expenses
// and / constants so all three "quick-edit" surfaces feel identical.
const UNDO_WINDOW_MS = 6000;

// The `param` shape is open: `type` still drives the sync/audit split,
// and individual tabs can add extra query params (e.g. `uncategorised`)
// that compose server-side. Keeping each tab declarative means the
// fetch layer stays a single URLSearchParams expansion.
const TABS = [
  { id: 'all',           label: 'Tudo',           params: {} },
  { id: 'sync',          label: 'Sincronizações', params: { type: 'sync' } },
  { id: 'audit',         label: 'Auditoria',      params: { type: 'audit' } },
  // "Sem categoria" — filtered view of sync `ok` rows where
  // `resolveCategoryDetailed` returned `source: null` (docs/Categories.md
  // §11.3 Fase 7). Hits the partial compound index added in the model
  // for sub-ms counts even at year-scale log volumes.
  { id: 'uncategorised', label: 'Sem categoria',  params: { uncategorised: 'true' } },
];

const TYPE_BADGE = {
  despesa:  'bg-curve-50 text-curve-800',
  sistema:  'bg-sand-100 text-sand-700',
  auth:     'bg-indigo-50 text-indigo-700',
  catalogo: 'bg-violet-50 text-violet-700',
};

const TYPE_LABEL = {
  despesa:  'Despesa',
  sistema:  'Sistema',
  auth:     'Auth',
  catalogo: 'Catálogo',
};

// Classification-path pill shown on sync `ok` rows. The three
// branches map 1:1 to the tier labels the orchestrator records in
// `error_detail` (docs/Categories.md §13, server's
// `formatResolutionDetail`):
//
//   override       — personal rule won           → violet (matches
//                    the Catálogo audit badge, since an override is
//                    a user-owned catalogue entry)
//   global         — curated catalogue won       → sand (neutral;
//                    the "default" path, nothing surprising to see)
//   uncategorised  — nothing matched             → amber (the call
//                    to action — matches the staging-edit banner on
//                    /expenses so the visual language lines up)
//
// The pill is intentionally tiny (text-[10px]) and sits on the
// secondary meta line so the primary title stays uncluttered for
// users who don't care about matching internals.
const RESOLUTION_STYLE = {
  override:      'bg-violet-50 text-violet-700',
  global:        'bg-sand-100 text-sand-600',
  uncategorised: 'bg-amber-50 text-amber-700',
};

const RESOLUTION_LABEL = {
  override:      'Regra pessoal',
  global:        'Catálogo',
  uncategorised: 'Sem categoria',
};

export default function CurveLogsPage() {
  const toast = useToast();
  // Deep-linkable tab state — `/curve/logs?tab=uncategorised` lands
  // directly on the filtered view, used by the dashboard's
  // "Sem categoria" stat card and by any sharable URL. Falls back to
  // 'all' when the query is absent or names an unknown tab.
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = TABS.some((t) => t.id === searchParams.get('tab'))
    ? searchParams.get('tab')
    : 'all';
  const [tab, setTab] = useState(initialTab);
  const [logs, setLogs] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  // ─── Quick-edit plumbing (uncategorised tab) ──────────────────────
  // Category catalogue + icon map for the popover. Silent failures —
  // a 500 here just means the popover opens empty, which is better
  // than blocking the whole Logs page on the catalogue fetch. Mirrors
  // the Dashboard + /expenses pattern.
  const [categories, setCategories] = useState([]);
  const [iconByCategory, setIconByCategory] = useState(() => new Map());
  // Which log row's pill was clicked — the popover renders next to
  // that row. `null` means no popover is open. Keyed by log._id
  // rather than expense_id so two logs pointing at the same expense
  // don't collide (unlikely but possible on retry syncs).
  const [pickerLogId, setPickerLogId] = useState(null);
  const [pickerSaving, setPickerSaving] = useState(false);
  // Pending undo entries — identical shape to Dashboard/ExpensesPage
  // so the <CategoryEditUndoBanner> contract is unchanged. We attach
  // an extra `prevLog` field so undo can re-insert the row into the
  // uncategorised list (the server-side filter is still honoured on
  // the next refetch, but optimistic state is what the user sees).
  const [categoryEdits, setCategoryEdits] = useState([]);
  const editTimersRef = useRef(new Map());
  // ROADMAP §2.10.1 — "Remover do ciclo" shortcut from the popover
  // header. On /curve/logs the row doesn't carry an `excluded` flag
  // (logs are historical records, not the expense itself), so there
  // is no optimistic list update — the banner is the only feedback.
  const [exclusionUndo, setExclusionUndo] = useState(null);
  const exclusionUndoTimerRef = useRef(null);
  const [exclusionBusy, setExclusionBusy] = useState(false);

  useEffect(() => {
    api
      .getCategories()
      .then((res) => setCategories(res.data ?? []))
      .catch(() => setCategories([]));
    api
      .getCategoryIcons()
      .then((res) => {
        const entries = (res.data ?? []).map((row) => [
          row.category_id,
          row.icon,
        ]);
        setIconByCategory(new Map(entries));
      })
      .catch(() => setIconByCategory(new Map()));
  }, []);

  useEffect(() => {
    setLoading(true);
    const tabDef = TABS.find((t) => t.id === tab);
    // Spread tab-specific params (type, uncategorised, ...) into the
    // base page/limit so a tab can contribute any filter without the
    // effect having to know which keys exist.
    const params = { page, limit: PER_PAGE, ...(tabDef?.params ?? {}) };
    api
      .getCurveLogs(params)
      .then((res) => {
        setLogs(res.data ?? []);
        setTotal(res.meta?.total ?? 0);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [page, tab]);

  // ─── Undo-banner timer helpers (parity with DashboardPage) ────────
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
      // Dedup per log._id so a double-click on the same pill only
      // holds one banner, and preserves the ORIGINAL prevLog for
      // Anular (so undo always reverts to the true pre-edit state).
      const existing = prev.find((e) => e.logId === entry.logId);
      if (existing) clearEditTimer(existing.id);
      const merged = existing
        ? { ...entry, prevLog: existing.prevLog }
        : entry;
      const rest = prev.filter((e) => e.logId !== entry.logId);
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

  // Quick-edit only fires on "real" expense log rows — sync `ok`
  // rows with a valid expense_id link. Audit entries, parse_errors,
  // duplicates and rows from before the expense_id field was added
  // fall out automatically.
  const isEditableLog = (log) =>
    log?.status === 'ok' && Boolean(log?.expense_id) && Boolean(log?.entity);

  // ─── Quick-edit save + undo ───────────────────────────────────────
  //
  // Works on ANY despesa log row (not just the uncategorised tab).
  // Behaviour per tab:
  //
  //   • tab === 'uncategorised'  → optimistic removal from the list
  //     (the row no longer matches the server filter once the
  //     expense gets a category). Undo re-inserts at the original
  //     position.
  //   • other tabs               → row stays visible (the log is a
  //     historical record of what happened at sync time; the pill
  //     still reads "global → X" because that's what got classified
  //     then). The undo banner is the feedback channel. A refresh
  //     of /expenses shows the live category.
  //
  // Derives prevCategoryId by looking up the resolution.categoryName
  // from the error_detail against the loaded categories catalogue —
  // lossy if two categories share a name but OK for the grace
  // window, and the server validates the id on the undo PUT anyway.
  const handleCategorySave = async (log, newCategoryId) => {
    if (!isEditableLog(log)) {
      toast.error('Este log não está associado a uma despesa.');
      setPickerLogId(null);
      return;
    }
    const resolution = parseResolutionDetail(log.error_detail);
    const prevCategoryName = resolution?.categoryName ?? null;
    const prevCategoryId = prevCategoryName
      ? categories.find((c) => c.name === prevCategoryName)?._id ?? null
      : null;
    // No-op: clicking the current category is a no-op in the
    // popover UX; defend here too in case the caller bypassed that.
    if (
      (newCategoryId == null && prevCategoryId == null) ||
      String(newCategoryId) === String(prevCategoryId)
    ) {
      setPickerLogId(null);
      return;
    }
    const newCategory = newCategoryId
      ? categories.find((c) => String(c._id) === String(newCategoryId))
      : null;
    const prevLog = log;
    const prevIndex = logs.findIndex((l) => l._id === log._id);
    const willRemove = tab === 'uncategorised' && newCategoryId != null;
    if (willRemove) {
      setLogs((rows) => rows.filter((l) => l._id !== log._id));
    }
    setPickerSaving(true);
    try {
      await api.updateExpenseCategory(log.expense_id, newCategoryId);
      pushCategoryEdit({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        logId: log._id,
        expenseId: log.expense_id,
        entity: log.entity ?? '',
        prevCategoryId,
        prevCategoryName,
        nextCategoryName: newCategory?.name ?? null,
        prevLog,
        prevIndex,
        wasRemoved: willRemove,
      });
      setPickerLogId(null);
    } catch (err) {
      if (willRemove) {
        setLogs((rows) => {
          if (rows.some((l) => l._id === prevLog._id)) return rows;
          const next = [...rows];
          next.splice(Math.max(0, prevIndex), 0, prevLog);
          return next;
        });
      }
      toast.error(
        err?.message ?? 'Não foi possível actualizar a categoria.',
        { id: 'logs-quick-edit' },
      );
    } finally {
      setPickerSaving(false);
    }
  };

  // ─── Exclusion shortcut (§2.10.1) ────────────────────────────
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

  const handleRemoveSingleFromCycle = async (log) => {
    if (!log?.expense_id || exclusionBusy) return;
    const ids = [log.expense_id];
    setPickerLogId(null);
    setExclusionBusy(true);
    try {
      const res = await api.excludeExpenses(ids);
      const affected = res?.affected ?? 1;
      const skipped = res?.skipped ?? 0;
      const text = `Despesa ${log.entity ?? ''} excluída do ciclo.`;
      setExclusionUndo({
        ids,
        direction: 'excluded',
        affected,
        skipped,
        text,
      });
      scheduleExclusionDismiss();
    } catch (err) {
      toast.error(
        err?.message ?? 'Não foi possível excluir do ciclo.',
        { id: 'logs-exclusion' },
      );
    } finally {
      setExclusionBusy(false);
    }
  };

  const handleExclusionUndo = async () => {
    if (!exclusionUndo || exclusionBusy) return;
    clearExclusionTimer();
    const { ids, direction } = exclusionUndo;
    setExclusionBusy(true);
    try {
      const call =
        direction === 'excluded' ? api.includeExpenses : api.excludeExpenses;
      await call(ids);
      setExclusionUndo(null);
    } catch (err) {
      toast.error(
        err?.message ?? 'Não foi possível anular.',
        { id: 'logs-exclusion-undo' },
      );
      scheduleExclusionDismiss();
    } finally {
      setExclusionBusy(false);
    }
  };

  const handleUndoCategoryEdit = async (entry) => {
    clearEditTimer(entry.id);
    setCategoryEdits((prev) =>
      prev.map((e) => (e.id === entry.id ? { ...e, undoing: true } : e)),
    );
    if (entry.wasRemoved) {
      setLogs((rows) => {
        if (rows.some((l) => l._id === entry.logId)) return rows;
        const next = [...rows];
        next.splice(Math.max(0, entry.prevIndex ?? rows.length), 0, entry.prevLog);
        return next;
      });
    }
    try {
      await api.updateExpenseCategory(entry.expenseId, entry.prevCategoryId);
      setCategoryEdits((prev) => prev.filter((e) => e.id !== entry.id));
    } catch (err) {
      if (entry.wasRemoved) {
        setLogs((rows) => rows.filter((l) => l._id !== entry.logId));
      }
      setCategoryEdits((prev) =>
        prev.map((e) => (e.id === entry.id ? { ...e, undoing: false } : e)),
      );
      toast.error(
        err?.message ?? 'Não foi possível anular a alteração.',
        { id: 'logs-quick-edit-undo' },
      );
      scheduleEditDismiss(entry.id);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const rows = groupSyncBatches(logs);

  return (
    <>
      <PageHeader
        title="Logs"
        description="Histórico de sincronizações e eventos da conta"
      />

      {/*
        Amber undo banner(s) for quick-edits from the resolution pill.
        Same component + semantics as the Dashboard and /expenses
        — clicking "Anular" within ~6 s reverts the expense to its
        previous category and (if we're on the uncategorised tab)
        re-inserts the log row at its original position.
      */}
      {categoryEdits.length > 0 && (
        <div className="mb-4">
          <CategoryEditUndoBanner
            edits={categoryEdits}
            onUndo={handleUndoCategoryEdit}
          />
        </div>
      )}

      {/* ROADMAP §2.10.1 — "Remover do ciclo" banner fed by the mini
          button in the resolution pill's popover header. */}
      <ExclusionUndoBanner
        entry={exclusionUndo}
        onUndo={handleExclusionUndo}
        busy={exclusionBusy}
      />

      <div className="mb-4 flex gap-1 rounded-xl border border-sand-200 bg-white p-1 text-sm">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => {
              setTab(t.id);
              setPage(1);
              // Keep the URL in sync so the tab is sharable and so a
              // browser-back from /categories lands back on the same
              // filter. Omit `?tab=all` to keep URLs clean for the
              // default view.
              if (t.id === 'all') {
                searchParams.delete('tab');
              } else {
                searchParams.set('tab', t.id);
              }
              setSearchParams(searchParams, { replace: true });
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
        // Tab-aware empty state — the generic "Sem logs" copy is right
        // for Tudo / Sincronizações / Auditoria, but lands wrong on
        // the uncategorised tab where "empty" is the success state
        // (everything got classified). The celebratory variant nudges
        // the user toward `/categories` in case they want to see *why*
        // everything matched.
        tab === 'uncategorised' ? (
          <EmptyState
            title="Tudo categorizado"
            description="Não há despesas sem categoria — todas as sincronizações recentes tocaram uma regra pessoal ou o catálogo global."
          />
        ) : (
          <EmptyState
            title="Sem logs"
            description="Os logs aparecerão após a primeira sincronização."
          />
        )
      ) : (
        // `overflow-visible` (not the default `hidden`) so the quick-edit
        // CategoryPickerPopover can drop below the last row without being
        // clipped at the table's bottom edge. The rounded-2xl corners
        // still look right because thead and the pagination strip only
        // use borders — no bleeding background fills to worry about.
        <div className="animate-fade-in overflow-visible rounded-2xl border border-sand-200 bg-white">
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
                  <BatchRow
                    key={row.key}
                    batch={row}
                    isEditable={isEditableLog}
                    pickerLogId={pickerLogId}
                    onOpenPicker={setPickerLogId}
                    onClosePicker={() => !pickerSaving && setPickerLogId(null)}
                    onPickCategory={handleCategorySave}
                    onRemoveFromCycle={handleRemoveSingleFromCycle}
                    categories={categories}
                    iconByCategory={iconByCategory}
                    pickerSaving={pickerSaving}
                  />
                ) : (
                  <SingleRow
                    key={row.log._id}
                    log={row.log}
                    isEditable={isEditableLog}
                    pickerLogId={pickerLogId}
                    onOpenPicker={setPickerLogId}
                    onClosePicker={() => !pickerSaving && setPickerLogId(null)}
                    onPickCategory={handleCategorySave}
                    onRemoveFromCycle={handleRemoveSingleFromCycle}
                    categories={categories}
                    iconByCategory={iconByCategory}
                    pickerSaving={pickerSaving}
                  />
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

function SingleRow({
  log,
  isEditable,
  pickerLogId,
  onOpenPicker,
  onClosePicker,
  onPickCategory,
  onRemoveFromCycle,
  categories,
  iconByCategory,
  pickerSaving,
}) {
  const { type, title, hideDetail, resolution } = describeLog(log);
  const isExpense = type === 'despesa' && log.entity;
  // `ok` sync rows now hold the resolution path in `error_detail`
  // (not an error). Hiding it from the generic `!isExpense` fallback
  // stops the raw "override → Mercados" text from double-rendering
  // alongside the pill on the SECOND line. The pill itself lives
  // inside the `isExpense` block below.
  const detailIsResolution = log.status === 'ok' && resolution != null;
  return (
    <tr className="border-b border-sand-50 transition-colors hover:bg-sand-50/60">
      <DateCell value={log.created_at} />
      <TypeCell type={type} />
      <td className="px-5 py-3">
        <div className="text-sand-900">{title}</div>
        {isExpense && (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-sand-500">
            <span>{log.entity}</span>
            {log.amount != null && <span>· €{Number(log.amount).toFixed(2)}</span>}
            {log.digest && (
              <>
                <span>·</span>
                <code className="font-mono text-[11px] text-sand-400">{log.digest.slice(0, 12)}…</code>
              </>
            )}
            {resolution && (
              <EditableResolutionPill
                log={log}
                resolution={resolution}
                editable={isEditable(log)}
                open={pickerLogId === log._id}
                onOpen={() => onOpenPicker(log._id)}
                onClose={onClosePicker}
                onPick={onPickCategory}
                onRemoveFromCycle={onRemoveFromCycle}
                categories={categories}
                iconByCategory={iconByCategory}
                saving={pickerSaving}
              />
            )}
            {log.dry_run && (
              <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-indigo-600">
                simulação
              </span>
            )}
          </div>
        )}
        {!isExpense && !hideDetail && !detailIsResolution && log.error_detail && !title.includes(log.error_detail) && (
          <div className="mt-0.5 break-all font-mono text-xs text-sand-400">{log.error_detail}</div>
        )}
      </td>
    </tr>
  );
}

function BatchRow({
  batch,
  isEditable,
  pickerLogId,
  onOpenPicker,
  onClosePicker,
  onPickCategory,
  onRemoveFromCycle,
  categories,
  iconByCategory,
  pickerSaving,
}) {
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
        batch.logs.map((log) => {
          // `ok` rows carry the classification path in `error_detail`.
          // We parse it inline here — batch children skip describeLog
          // on purpose (the batch only needs the summary), so we
          // reach into the shared parser directly to keep the two
          // row renderers consistent.
          const resolution =
            log.status === 'ok' ? parseResolutionDetail(log.error_detail) : null;
          // Only show the raw mono detail when it's NOT a resolution
          // string — on failure rows that's a real error message we
          // want to surface verbatim; on ok rows the pill replaces it.
          const showRawDetail = log.error_detail && !resolution;
          return (
            <tr key={log._id} className="border-b border-sand-50 bg-sand-50/40">
              <td className="px-5 py-2 pl-12 text-xs text-sand-400">
                {formatDate(log.created_at)}
              </td>
              <td className="px-5 py-2">
                <StatusDot status={log.status} />
              </td>
              <td className="px-5 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sand-800">{log.entity ?? '—'}</span>
                  {log.amount != null && (
                    <span className="text-sand-500">€{Number(log.amount).toFixed(2)}</span>
                  )}
                  {log.digest && (
                    <code className="font-mono text-[11px] text-sand-400">
                      {log.digest.slice(0, 12)}…
                    </code>
                  )}
                  {resolution && (
                    <EditableResolutionPill
                      log={log}
                      resolution={resolution}
                      editable={isEditable(log)}
                      open={pickerLogId === log._id}
                      onOpen={() => onOpenPicker(log._id)}
                      onClose={onClosePicker}
                      onPick={onPickCategory}
                      onRemoveFromCycle={onRemoveFromCycle}
                      categories={categories}
                      iconByCategory={iconByCategory}
                      saving={pickerSaving}
                    />
                  )}
                </div>
                {showRawDetail && (
                  <div className="mt-0.5 break-all font-mono text-[11px] text-curve-700">
                    {log.error_detail}
                  </div>
                )}
              </td>
            </tr>
          );
        })}
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

/**
 * ResolutionPill variant that becomes a quick-edit button when the
 * parent row is an editable despesa log (status='ok', expense_id set).
 * Read-only pill rendering is identical to the prior `ResolutionPill`
 * — the visual change only kicks in on hover / keyboard focus of the
 * button branch, so non-editable rows look exactly as before.
 *
 * Click opens a <CategoryPickerPopover> anchored to the pill via a
 * `relative` wrapper. The popover's `right-0 top-full w-80` default
 * means it extends to the LEFT of the pill and drops DOWN — fits
 * inside the detail cell on both mobile and desktop.
 */
function EditableResolutionPill({
  log,
  resolution,
  editable,
  open,
  onOpen,
  onClose,
  onPick,
  onRemoveFromCycle,
  categories,
  iconByCategory,
  saving,
}) {
  const style = RESOLUTION_STYLE[resolution.source] ?? RESOLUTION_STYLE.global;
  const label = RESOLUTION_LABEL[resolution.source] ?? resolution.source;
  const tooltip = resolution.categoryName
    ? `${resolution.source} → ${resolution.categoryName}`
    : resolution.source;

  const body = (
    <>
      {label}
      {resolution.categoryName && (
        <span className="ml-1 font-normal opacity-80">· {resolution.categoryName}</span>
      )}
    </>
  );

  if (!editable) {
    return (
      <span
        className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${style}`}
        title={tooltip}
      >
        {body}
      </span>
    );
  }

  // Build a synthetic `expense` for the popover so its "current"
  // highlight matches the row's resolution — picker looks up by
  // category_id, which we derive from the name via the loaded
  // catalogue. `_id` is passed as the log id only so the popover's
  // aria-label + copy read coherently; the actual write targets
  // `log.expense_id` inside handleCategorySave.
  const currentCategory = resolution.categoryName
    ? categories.find((c) => c.name === resolution.categoryName) ?? null
    : null;
  const expenseForPicker = {
    _id: log._id,
    entity: log.entity ?? '',
    category_id: currentCategory?._id ?? null,
    category_name: currentCategory?.name ?? null,
  };

  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          open ? onClose() : onOpen();
        }}
        title={`${tooltip} · clicar para alterar categoria`}
        aria-label={`Alterar categoria de ${log.entity ?? 'despesa'}`}
        className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium transition-all hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-curve-500/30 ${style}`}
      >
        {body}
      </button>
      {open && (
        <CategoryPickerPopover
          expense={expenseForPicker}
          categories={categories}
          iconByCategory={iconByCategory}
          saving={saving}
          onSelect={(newId) => onPick(log, newId)}
          onRemoveFromCycle={
            onRemoveFromCycle ? () => onRemoveFromCycle(log) : null
          }
          onCancel={onClose}
        />
      )}
    </span>
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
