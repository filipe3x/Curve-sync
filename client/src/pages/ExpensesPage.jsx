import { useEffect, useState } from 'react';
import PageHeader from '../components/common/PageHeader';
import EmptyState from '../components/common/EmptyState';
import CategoryPickerPopover from '../components/common/CategoryPickerPopover';
import { MagnifyingGlassIcon, ChevronLeftIcon, ChevronRightIcon } from '../components/layout/Icons';
import * as api from '../services/api';

const PER_PAGE = 20;

export default function ExpensesPage() {
  const [expenses, setExpenses] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  // Category catalogue for the <CategoryPickerPopover>. Loaded once on
  // mount; the list is small (§5.5 assumes ≤ 30 entries) and static
  // within a page lifetime, so there's no reason to refetch per click.
  // Failures are silent — the popover's empty-state covers them.
  const [categories, setCategories] = useState([]);
  // Which row has the popover open. Single-open-at-a-time by design;
  // the popover is a focused modal-ish interaction and two of them on
  // screen would muddle the "click outside to dismiss" heuristic.
  const [pickerExpenseId, setPickerExpenseId] = useState(null);
  const [pickerSaving, setPickerSaving] = useState(false);
  // Inline toast. null = silent, { type: 'ok'|'error', text } otherwise.
  const [toast, setToast] = useState(null);

  const fetchExpenses = async () => {
    setLoading(true);
    try {
      const res = await api.getExpenses({
        page,
        limit: PER_PAGE,
        search,
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
  }, [page]);

  useEffect(() => {
    api
      .getCategories()
      .then((res) => setCategories(res.data ?? []))
      .catch(() => setCategories([]));
  }, []);

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

  // Auto-dismiss ok toasts; keep errors visible until the user acts.
  useEffect(() => {
    if (toast?.type !== 'ok') return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const handleSearch = (e) => {
    e.preventDefault();
    setPage(1);
    fetchExpenses();
  };

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  return (
    <>
      <PageHeader title="Despesas" description="Todas as despesas importadas" />

      {/* Inline toast — surfaces optimistic-update success / failure for
          the quick-edit popover (docs/Categories.md §12.8). Green on
          success auto-dismisses after 4 s; errors stay until the next
          action so the user can read the reason. */}
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
             escapes the last column. Toggle it off while the picker
             is open so the popover can render over the row below. */
          className={`animate-fade-in rounded-2xl border border-sand-200 bg-white ${
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
              {expenses.map((exp, i) => {
                const pickerOpen = pickerExpenseId === exp._id;
                return (
                  <tr
                    key={exp._id ?? i}
                    className="border-b border-sand-50 transition-colors duration-150 hover:bg-sand-50"
                  >
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
