import { useEffect, useMemo, useRef, useState } from 'react';
import PageHeader from '../components/common/PageHeader';
import EmptyState from '../components/common/EmptyState';
import CategoryPickerPopover from '../components/common/CategoryPickerPopover';
import { MagnifyingGlassIcon, ChevronLeftIcon, ChevronRightIcon } from '../components/layout/Icons';
import * as api from '../services/api';

const PER_PAGE = 20;
// Server-side cap on the bulk-move endpoint. The client mirrors it so
// we can disable "Seleccionar todas as N" up-front when the filter
// matches more than this, instead of failing with a 400 after the
// fact. docs/Categories.md §12.x — batch-move.
const BULK_MAX = 500;

export default function ExpensesPage() {
  const [expenses, setExpenses] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  // `appliedSearch` is the query that was last submitted via the
  // search form — it drives the actual fetch and the "Seleccionar
  // todas as N" API call. `search` is just the input buffer.
  const [appliedSearch, setAppliedSearch] = useState('');
  const [loading, setLoading] = useState(true);
  // Category catalogue for the <CategoryPickerPopover>. Loaded once on
  // mount; the list is small (§5.5 assumes ≤ 30 entries) and static
  // within a page lifetime, so there's no reason to refetch per click.
  // Failures are silent — the popover's empty-state covers them.
  const [categories, setCategories] = useState([]);
  // Which row has the single-row popover open. Single-open-at-a-time
  // by design; the popover is a focused modal-ish interaction and two
  // of them on screen would muddle the "click outside to dismiss"
  // heuristic.
  const [pickerExpenseId, setPickerExpenseId] = useState(null);
  const [pickerSaving, setPickerSaving] = useState(false);
  // ─── Multi-select / batch-move state ────────────────────────────
  // `Set<expense_id>` for row-level selection. Persists across page
  // turns and filter changes — only explicit "Limpar" wipes it.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  // Anchor id for shift-click range selection on the current page.
  // Null if the user hasn't clicked any checkbox yet, or after a
  // filter change (range selection only makes sense within a
  // consistent visible list).
  const [lastAnchorId, setLastAnchorId] = useState(null);
  // Bulk popover mounted above the table when the user clicks
  // "Mover para…" in the action bar.
  const [bulkPickerOpen, setBulkPickerOpen] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  // Inline toast. null = silent, { type: 'ok'|'error', text } otherwise.
  const [toast, setToast] = useState(null);

  const fetchExpenses = async (overrideSearch) => {
    setLoading(true);
    try {
      const effectiveSearch =
        overrideSearch !== undefined ? overrideSearch : appliedSearch;
      const res = await api.getExpenses({
        page,
        limit: PER_PAGE,
        search: effectiveSearch,
        sort: '-date',
      });
      setExpenses(res.data ?? []);
      setTotal(res.meta?.total ?? 0);
    } catch {
      /* handled by empty state */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchExpenses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, appliedSearch]);

  useEffect(() => {
    api
      .getCategories()
      .then((res) => setCategories(res.data ?? []))
      .catch(() => setCategories([]));
  }, []);

  // Shift-click range support: when the user clicks a checkbox with
  // Shift held, we select every row between the anchor and the
  // clicked row inclusive (within the current visible page). If no
  // anchor exists, fall back to a single toggle.
  const toggleRow = (id, event) => {
    const rangeMode = event?.shiftKey && lastAnchorId;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (rangeMode) {
        const anchorIdx = expenses.findIndex((e) => e._id === lastAnchorId);
        const targetIdx = expenses.findIndex((e) => e._id === id);
        if (anchorIdx >= 0 && targetIdx >= 0) {
          const [lo, hi] =
            anchorIdx <= targetIdx
              ? [anchorIdx, targetIdx]
              : [targetIdx, anchorIdx];
          for (let i = lo; i <= hi; i++) next.add(expenses[i]._id);
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setLastAnchorId(id);
  };

  // Master checkbox in the thead — selects/deselects all rows on the
  // CURRENT page only. "Seleccionar todas as N" across pages is a
  // separate explicit link that appears in the action bar banner.
  const pageIds = useMemo(() => expenses.map((e) => e._id), [expenses]);
  const pageFullySelected =
    pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const pagePartiallySelected =
    !pageFullySelected && pageIds.some((id) => selectedIds.has(id));

  const toggleAllOnPage = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (pageFullySelected) {
        // Deselect the page's rows from the wider selection.
        for (const id of pageIds) next.delete(id);
      } else {
        for (const id of pageIds) next.add(id);
      }
      return next;
    });
  };

  // Gmail-style "Seleccionar todas as N que correspondem ao filtro".
  // Fires a compact id-only fetch against the same filter as the
  // current list and replaces the selection with the result. Guarded
  // by the BULK_MAX client check so we never hit the 400 on the
  // server — if total is over the cap, the action bar shows a
  // warning instead of the link.
  const selectAllMatching = async () => {
    if (total > BULK_MAX) return;
    try {
      const res = await api.getExpenseIds({
        search: appliedSearch,
        sort: '-date',
      });
      setSelectedIds(new Set(res.ids ?? []));
      setLastAnchorId(null);
    } catch (err) {
      setToast({
        type: 'error',
        text: err?.message ?? 'Não foi possível seleccionar todas.',
      });
    }
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
    setLastAnchorId(null);
    setBulkPickerOpen(false);
  };

  // Quick-edit save: optimistic update first, then PUT, then rollback
  // on failure. Matches the flow described in docs/Categories.md §12.4
  // (default "inofensivo" path). `category_id` may be null to clear.
  const handleCategorySave = async (expenseId, newCategoryId) => {
    const prev = expenses;
    // Optimistic: swap the chip name immediately. We don't know the
    // new category_name locally yet, so look it up from the catalogue
    // and fall back to `—` for null.
    const newCategoryName = newCategoryId
      ? categories.find((c) => String(c._id) === String(newCategoryId))?.name ?? null
      : null;
    setExpenses((rows) =>
      rows.map((e) =>
        e._id === expenseId
          ? { ...e, category_id: newCategoryId, category_name: newCategoryName }
          : e,
      ),
    );
    setPickerSaving(true);
    try {
      const res = await api.updateExpenseCategory(expenseId, newCategoryId);
      // Authoritative update from the server — mostly to keep
      // `updated_at` in sync and catch the edge case where the name
      // lookup missed (race with a category being renamed elsewhere).
      setExpenses((rows) =>
        rows.map((e) => (e._id === expenseId ? { ...e, ...res.data } : e)),
      );
      setToast({ type: 'ok', text: 'Categoria actualizada.' });
      setPickerExpenseId(null);
    } catch (err) {
      // Rollback to the pre-click snapshot so the chip reverts.
      setExpenses(prev);
      setToast({
        type: 'error',
        text: err?.message ?? 'Não foi possível actualizar a categoria.',
      });
    } finally {
      setPickerSaving(false);
    }
  };

  // Batch move: optimistic update on the VISIBLE rows of the current
  // page, then PUT the entire selection (which may include ids from
  // other pages), then reconcile with the server response. Rollback
  // on failure. `categoryId` may be null to clear.
  const handleBulkMove = async (categoryId) => {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    if (ids.length > BULK_MAX) {
      setToast({
        type: 'error',
        text: `Só é possível mover ${BULK_MAX} despesas de cada vez.`,
      });
      return;
    }
    const prev = expenses;
    const newCategoryName = categoryId
      ? categories.find((c) => String(c._id) === String(categoryId))?.name ?? null
      : null;
    // Optimistic: repaint the visible rows that are in the selection.
    // Rows outside the current page still flip on the server but are
    // invisible here — a refetch after success catches them if the
    // user paginates back.
    setExpenses((rows) =>
      rows.map((e) =>
        selectedIds.has(e._id)
          ? { ...e, category_id: categoryId, category_name: newCategoryName }
          : e,
      ),
    );
    setBulkSaving(true);
    try {
      const res = await api.bulkMoveExpenses(ids, categoryId);
      const { moved, skipped, target_category_name } = res;
      const targetName = target_category_name ?? 'Sem categoria';
      const movedNoun = moved === 1 ? 'despesa movida' : 'despesas movidas';
      const text =
        skipped > 0
          ? `${moved} ${movedNoun} para ${targetName}. ${skipped} ignorada${skipped === 1 ? '' : 's'} (já estavam nessa categoria).`
          : `${moved} ${movedNoun} para ${targetName}.`;
      setToast({ type: 'ok', text });
      setBulkPickerOpen(false);
      clearSelection();
    } catch (err) {
      setExpenses(prev);
      setToast({
        type: 'error',
        text: err?.message ?? 'Não foi possível mover as despesas.',
      });
    } finally {
      setBulkSaving(false);
    }
  };

  // Auto-dismiss ok toasts; keep errors visible until the user acts.
  useEffect(() => {
    if (toast?.type !== 'ok') return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const handleSearch = (e) => {
    e.preventDefault();
    setPage(1);
    setAppliedSearch(search);
  };

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  const selectionHasRowsBeyondPage =
    selectedIds.size > 0 && selectedIds.size > pageIds.filter((id) => selectedIds.has(id)).length;
  // Hint banner trigger: the user just marked the whole visible page
  // and there are more matching rows off-screen. Hidden once the
  // selection already spans beyond this page (presumably they already
  // clicked the expand link, or built a manual cross-page selection).
  const showSelectAllHint =
    pageFullySelected && total > pageIds.length && !selectionHasRowsBeyondPage;

  return (
    <>
      <PageHeader title="Despesas" description="Todas as despesas importadas" />

      {/* Inline toast — surfaces optimistic-update success / failure for
          both the single-row quick-edit popover (§12.8) and the bulk
          move action. Green on success auto-dismisses after 4 s;
          errors stay until the next action so the user can read the
          reason. */}
      {toast && (
        <div
          className={`mb-4 animate-slide-in-right rounded-2xl px-4 py-3 text-sm ${
            toast.type === 'ok'
              ? 'bg-emerald-50 text-emerald-800'
              : 'bg-red-50 text-curve-700'
          }`}
          role={toast.type === 'error' ? 'alert' : 'status'}
        >
          {toast.text}
        </div>
      )}

      {/* Search bar */}
      <form onSubmit={handleSearch} className="mb-6 flex gap-3">
        <div className="relative flex-1">
          <MagnifyingGlassIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sand-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Pesquisar por entidade, cartão…"
            className="input pl-10"
          />
        </div>
        <button type="submit" className="btn-secondary">
          Pesquisar
        </button>
      </form>

      {/* Multi-select action bar — only mounted when there's a
          selection. Gmail-style: count + clear + "Mover para…" primary
          action, with an optional hint row underneath offering to
          expand the current-page selection into "all N matching the
          filter". The hint collapses once the selection already spans
          beyond this page. */}
      {selectedIds.size > 0 && (
        <div className="mb-4 animate-slide-in-right rounded-2xl border border-curve-200 bg-curve-50 px-4 py-3 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-medium text-curve-800">
              {selectedIds.size}{' '}
              {selectedIds.size === 1 ? 'despesa seleccionada' : 'despesas seleccionadas'}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={clearSelection}
                disabled={bulkSaving}
                className="rounded-lg px-3 py-1.5 text-sm text-sand-600 transition-colors hover:bg-white disabled:opacity-50"
              >
                Limpar
              </button>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setBulkPickerOpen((v) => !v)}
                  disabled={bulkSaving}
                  className="btn-primary px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Mover para…
                </button>
                {bulkPickerOpen && (
                  <CategoryPickerPopover
                    context={{ kind: 'bulk', count: selectedIds.size }}
                    categories={categories}
                    saving={bulkSaving}
                    onSelect={(newId) => handleBulkMove(newId)}
                    onCancel={() => {
                      if (bulkSaving) return;
                      setBulkPickerOpen(false);
                    }}
                  />
                )}
              </div>
            </div>
          </div>
          {showSelectAllHint && (
            <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-curve-100 pt-2 text-xs text-sand-600">
              <span>
                Todas as {pageIds.length} desta página estão seleccionadas.
              </span>
              {total <= BULK_MAX ? (
                <button
                  type="button"
                  onClick={selectAllMatching}
                  className="font-medium text-curve-700 underline-offset-2 hover:underline"
                >
                  Seleccionar todas as {total} que correspondem ao filtro
                </button>
              ) : (
                <span className="text-curve-700">
                  Só é possível mover {BULK_MAX} de cada vez — {total}{' '}
                  correspondem ao filtro. Refina a pesquisa.
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-curve-300 border-t-curve-700" />
        </div>
      ) : expenses.length === 0 ? (
        <EmptyState title="Sem resultados" description="Tenta ajustar a pesquisa." />
      ) : (
        <div
          /* `overflow-hidden` clips the CategoryPickerPopover that
             escapes the last column. Toggle it off while either the
             single-row or the bulk picker is open so the popover can
             render over the row below. */
          className={`animate-fade-in rounded-2xl border border-sand-200 bg-white ${
            pickerExpenseId || bulkPickerOpen ? '' : 'overflow-hidden'
          }`}
        >
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-sand-100 text-left text-xs font-medium uppercase tracking-wide text-sand-400">
                <th className="w-10 px-5 py-3">
                  <input
                    type="checkbox"
                    aria-label={
                      pageFullySelected
                        ? 'Limpar selecção desta página'
                        : 'Seleccionar todas desta página'
                    }
                    checked={pageFullySelected}
                    ref={(el) => {
                      if (el) el.indeterminate = pagePartiallySelected;
                    }}
                    onChange={toggleAllOnPage}
                    className="h-4 w-4 cursor-pointer rounded border-sand-300 text-curve-600 focus:ring-curve-500"
                  />
                </th>
                <th className="px-5 py-3">Entidade</th>
                <th className="px-5 py-3">Montante</th>
                <th className="px-5 py-3">Data</th>
                <th className="px-5 py-3">Cartão</th>
                <th className="px-5 py-3">Categoria</th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((exp, i) => {
                const pickerOpen = pickerExpenseId === exp._id;
                const rowSelected = selectedIds.has(exp._id);
                // When there's an active selection, disable the
                // single-row quick-edit so the two flows don't compete
                // for the same `category_id`. The chip is still
                // visible, just no longer clickable.
                const chipDisabled = selectedIds.size > 0;
                return (
                  <tr
                    key={exp._id ?? i}
                    className={`border-b border-sand-50 transition-colors duration-150 ${
                      rowSelected ? 'bg-curve-50' : 'hover:bg-sand-50'
                    }`}
                  >
                    <td className="px-5 py-3">
                      <input
                        type="checkbox"
                        aria-label={`Seleccionar ${exp.entity}`}
                        checked={rowSelected}
                        onChange={(e) => toggleRow(exp._id, e.nativeEvent)}
                        onClick={(e) => {
                          // React's onChange doesn't carry shiftKey
                          // reliably across browsers; the native
                          // `click` event does. We stash the modifier
                          // on the synthetic event's nativeEvent and
                          // read it in `toggleRow`.
                          e.nativeEvent.shiftKey = e.shiftKey;
                        }}
                        className="h-4 w-4 cursor-pointer rounded border-sand-300 text-curve-600 focus:ring-curve-500"
                      />
                    </td>
                    <td className="px-5 py-3 font-medium text-sand-900">
                      {exp.entity}
                    </td>
                    <td className="px-5 py-3 font-semibold text-curve-700">
                      €{Number(exp.amount).toFixed(2)}
                    </td>
                    <td className="px-5 py-3 text-sand-500">{exp.date}</td>
                    <td className="px-5 py-3 text-sand-500">{exp.card}</td>
                    <td className="relative px-5 py-3">
                      <button
                        type="button"
                        onClick={() => !chipDisabled && setPickerExpenseId(exp._id)}
                        disabled={chipDisabled}
                        className={`rounded-lg text-left transition-colors focus:outline-none focus:ring-2 focus:ring-curve-500/30 ${
                          chipDisabled
                            ? 'cursor-default opacity-60'
                            : 'hover:bg-sand-100'
                        }`}
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

          {/* Pagination */}
          <div className="flex items-center justify-between border-t border-sand-100 px-5 py-3">
            <span className="text-xs text-sand-400">
              {total} despesa{total !== 1 ? 's' : ''}
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
