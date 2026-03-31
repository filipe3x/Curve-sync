import { useEffect, useState } from 'react';
import PageHeader from '../components/common/PageHeader';
import EmptyState from '../components/common/EmptyState';
import { MagnifyingGlassIcon, ChevronLeftIcon, ChevronRightIcon } from '../components/layout/Icons';
import * as api from '../services/api';

const PER_PAGE = 20;

export default function ExpensesPage() {
  const [expenses, setExpenses] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

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

  const handleSearch = (e) => {
    e.preventDefault();
    setPage(1);
    fetchExpenses();
  };

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  return (
    <>
      <PageHeader title="Despesas" description="Todas as despesas importadas" />

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
        <div className="animate-fade-in overflow-hidden rounded-2xl border border-sand-200 bg-white">
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
              {expenses.map((exp, i) => (
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
