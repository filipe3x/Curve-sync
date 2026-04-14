import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../components/common/PageHeader';
import EmptyState from '../components/common/EmptyState';
import { PlusIcon, MagnifyingGlassIcon } from '../components/layout/Icons';
import { useCountUp } from '../hooks/useCountUp';
import { useAuth } from '../contexts/AuthContext';
import * as api from '../services/api';

/**
 * /categories — master-detail category management screen.
 *
 * User mode only for PR #5 (Fase 4 of docs/Categories.md §11.3). The
 * admin branch (+ Categoria, editable header, global entity CRUD) lands
 * in Fase 5 on the same component, gated by `user.role === 'admin'`.
 *
 * Data sources:
 *   - GET /api/categories         — full read-only catalogue
 *   - GET /api/categories/stats   — current + previous day-22 cycle
 *                                   aggregates (§8.6)
 *   - GET /api/category-overrides — caller's personal rules (§8.4)
 *   - GET /api/expenses           — last 10 expenses when a category is
 *                                   selected and the user flips to the
 *                                   "Despesas recentes" tab (§9.6)
 *
 * Motion: all the §9.8 pieces that don't depend on historical data —
 * stagger on the list, scaleX grow on the distribution bar, count-up
 * on KPIs, cross-fade on key-change. Spark chart (6 cycles) and mini
 * ring chart (3-cycle average) are deferred because they need a
 * history endpoint that doesn't exist yet.
 */

// Deterministic palette for category swatches. Kept in sync with
// tokens from `tailwind.config.js` (curve + sand extended palettes)
// and a handful of default Tailwind colours that read well on white.
// The hash is a tiny sum-of-charCodes — good enough for stable colour
// assignment across reloads without importing a dep.
const SWATCH_PALETTE = [
  '#a03d27', // curve-700
  '#d4633f', // curve-500
  '#6d6054', // sand-800
  '#0284c7', // sky-600
  '#16a34a', // green-600
  '#d97706', // amber-600
  '#7c3aed', // violet-600
  '#0891b2', // cyan-600
  '#dc2626', // red-600
  '#4d7c0f', // lime-700
];

function swatchColor(seed) {
  if (!seed) return '#bfb39e'; // sand-400 for uncategorised
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return SWATCH_PALETTE[Math.abs(h) % SWATCH_PALETTE.length];
}

// Format a cents-precision EUR amount with the comma-decimal
// convention used elsewhere in the app.
function formatEUR(value) {
  const n = Number.isFinite(value) ? value : 0;
  return n.toLocaleString('pt-PT', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// "2026-03-22" → "22 Mar" for the cycle subtitle. Falls back to the
// raw string if the input doesn't parse.
function prettyDate(iso) {
  if (!iso) return '';
  const [, m, d] = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/) ?? [];
  if (!d) return iso;
  const months = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  return `${Number(d)} ${months[Number(m) - 1] ?? ''}`.trim();
}

// Compute the +/- percent delta between the current and previous cycle
// totals for a single category, or return `null` when there's no
// comparable baseline (first cycle, or previous was zero). `null` is
// rendered as the neutral "±0" badge by `<DeltaBadge>`.
function percentDelta(current, previous) {
  if (!previous || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

// ─────────────────────────────────────────────────────────────────────
// Small presentational components (single-use, kept inside this file
// so the /categories screen lands as one reviewable unit)
// ─────────────────────────────────────────────────────────────────────

function DistributionBar({ segments, grandTotal, selectedId, onSelect }) {
  if (!segments.length || grandTotal <= 0) {
    return (
      <div className="flex h-12 items-center justify-center rounded-2xl border border-dashed border-sand-300 bg-sand-50 text-xs text-sand-500">
        Ainda sem despesas neste ciclo
      </div>
    );
  }
  return (
    <div
      className="flex h-3 w-full overflow-hidden rounded-full bg-sand-100"
      role="img"
      aria-label="Distribuição por categoria"
    >
      {segments.map((s, i) => {
        const pct = (s.total / grandTotal) * 100;
        const dim =
          selectedId && selectedId !== (s.category_id ?? '__null__') ? 0.4 : 1;
        return (
          <button
            key={s.category_id ?? '__null__'}
            type="button"
            onClick={() =>
              onSelect(s.category_id ?? '__null__')
            }
            title={`${s.category_name ?? 'Sem categoria'} · ${formatEUR(s.total)} · ${pct.toFixed(1)}%`}
            className="h-full origin-left animate-grow-x transition-opacity duration-200"
            style={{
              flexBasis: `${pct}%`,
              backgroundColor: swatchColor(s.category_id),
              opacity: dim,
              animationDelay: `${i * 60}ms`,
              animationFillMode: 'forwards',
              transform: 'scaleX(0)',
            }}
          />
        );
      })}
    </div>
  );
}

function DeltaBadge({ delta }) {
  if (delta === null || Number.isNaN(delta)) {
    return (
      <span className="inline-flex items-center rounded-lg bg-sand-100 px-2 py-0.5 text-xs font-medium text-sand-500">
        —
      </span>
    );
  }
  const rounded = Math.round(delta);
  const sign = rounded > 0 ? '+' : '';
  const tone =
    rounded > 5
      ? 'bg-amber-50 text-amber-700'
      : rounded < -5
        ? 'bg-emerald-50 text-emerald-700'
        : 'bg-sand-100 text-sand-500';
  return (
    <span className={`inline-flex items-center rounded-lg px-2 py-0.5 text-xs font-medium ${tone}`}>
      {sign}
      {rounded}%
    </span>
  );
}

function CategoryRow({ row, index, selected, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-3 border-l-2 px-4 py-3 text-left transition-colors duration-200 animate-fade-in-up ${
        selected
          ? 'border-curve-700 bg-curve-50'
          : 'border-transparent hover:bg-sand-50'
      }`}
      style={{ animationDelay: `${index * 60}ms`, animationFillMode: 'backwards' }}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span
          className="mt-1.5 h-2.5 w-2.5 flex-none rounded-full"
          style={{ backgroundColor: swatchColor(row.category_id) }}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-sand-900">
            {row.category_name ?? 'Sem categoria'}
          </p>
          <p className="mt-0.5 text-xs text-sand-400">
            {row.entity_count} entidades · {row.expense_count} despesas
          </p>
        </div>
      </div>
      <div className="flex flex-col items-end gap-1 text-right">
        <span className="text-sm font-semibold text-curve-700">
          {formatEUR(row.total)}
        </span>
        <DeltaBadge delta={row.delta} />
      </div>
    </button>
  );
}

function AnimatedKPI({ label, value, format }) {
  const tweened = useCountUp(value, 800);
  return (
    <div className="rounded-2xl border border-sand-200 bg-white p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-sand-400">
        {label}
      </p>
      <p className="mt-2 text-xl font-semibold text-sand-900" data-count-up>
        {format(tweened)}
      </p>
    </div>
  );
}

function OverridesList({
  overrides,
  categoryId,
  categoryName,
  onCreate,
  onDelete,
  busy,
}) {
  const [pattern, setPattern] = useState('');
  // Inline validation error for the "Adicionar" button. The button is
  // NOT disabled on empty input anymore — a silently disabled button
  // looked like a dead click to users. Now clicking (or hitting Enter)
  // with an empty field surfaces the message below the form.
  const [error, setError] = useState(null);
  const mine = overrides.filter((o) => o.category_id === categoryId);

  const submit = async (e) => {
    e.preventDefault();
    if (!pattern.trim()) {
      setError('Preenche o nome da entidade primeiro.');
      return;
    }
    setError(null);
    await onCreate({ pattern: pattern.trim() });
    setPattern('');
  };

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="flex gap-2">
        <input
          type="text"
          value={pattern}
          onChange={(e) => {
            setPattern(e.target.value);
            if (error) setError(null);
          }}
          placeholder={`Nova regra pessoal para ${categoryName ?? 'esta categoria'}…`}
          className="input flex-1"
          disabled={busy}
        />
        <button
          type="submit"
          className="btn-primary"
          disabled={busy}
        >
          <PlusIcon className="h-4 w-4" />
          Adicionar
        </button>
      </form>
      {error && (
        <p className="-mt-2 text-xs text-curve-700" role="alert">
          {error}
        </p>
      )}

      {mine.length === 0 ? (
        <div className="rounded-2xl border-2 border-dashed border-sand-200 py-8 text-center">
          <p className="text-sm text-sand-500">
            Ainda não tens regras pessoais para esta categoria.
          </p>
          <p className="mt-1 text-xs text-sand-400">
            Adiciona um padrão (e.g. <span className="font-mono">lidl</span>)
            para reescrever a categorização futura.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-sand-100 rounded-2xl border border-sand-200 bg-white">
          {mine.map((o) => (
            <li
              key={o.id}
              className="flex items-center justify-between px-4 py-3"
            >
              <div>
                <p className="text-sm font-medium text-sand-900">{o.pattern}</p>
                <p className="text-xs text-sand-400">
                  {o.match_type} · prioridade {o.priority}
                </p>
              </div>
              <button
                type="button"
                onClick={() => onDelete(o.id)}
                disabled={busy}
                className="rounded-lg px-2 py-1 text-xs font-medium text-sand-500 hover:bg-sand-100 hover:text-curve-700"
              >
                Apagar
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The global entities panel is read-only for regular users but gains a
// per-row "Apagar" action when the caller is an admin. The minimal
// admin surgery slice (PR #6) only wires up entity DELETE — category
// create/rename/delete and batch entity-add land later. When
// `isAdmin` is false the component behaves exactly as it did in PR #5.
function GlobalEntitiesList({ entities, isAdmin = false, busy = false, onDelete }) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    if (!q) return entities;
    const needle = q.toLowerCase();
    return entities.filter((e) => e.toLowerCase().includes(needle));
  }, [entities, q]);

  if (!entities.length) {
    return (
      <div className="rounded-2xl border-2 border-dashed border-sand-200 py-8 text-center text-sm text-sand-500">
        Esta categoria ainda não tem entidades no catálogo global.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-2.5 h-5 w-5 text-sand-400" />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Procurar entidades…"
          className="input pl-10"
        />
      </div>
      <ul className="max-h-72 overflow-y-auto divide-y divide-sand-100 rounded-2xl border border-sand-200 bg-white">
        {filtered.map((entity) => (
          <li
            key={entity}
            className="flex items-center justify-between gap-3 px-4 py-2.5"
          >
            <span className="truncate text-sm text-sand-800">{entity}</span>
            <div className="flex flex-shrink-0 items-center gap-2">
              <span className="inline-flex items-center rounded-lg bg-sand-100 px-2 py-0.5 text-[11px] font-medium text-sand-500">
                global
              </span>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => onDelete?.(entity)}
                  disabled={busy}
                  title="Remover esta entidade do catálogo global"
                  className="rounded-lg px-2 py-1 text-xs font-medium text-sand-500 transition-colors hover:bg-sand-100 hover:text-curve-700 disabled:opacity-40"
                >
                  Apagar
                </button>
              )}
            </div>
          </li>
        ))}
        {!filtered.length && (
          <li className="px-4 py-3 text-sm text-sand-400">
            Nada corresponde a "{q}".
          </li>
        )}
      </ul>
    </div>
  );
}

function RecentExpenses({ categoryId }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const param =
      categoryId === '__null__' || categoryId === null
        ? 'null'
        : categoryId;
    api
      .getExpenses({
        page: 1,
        limit: 10,
        sort: '-date',
        category_id: param,
      })
      .then((res) => {
        if (!cancelled) setRows(res.data ?? []);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [categoryId]);

  if (loading) {
    return (
      <div className="animate-pulse rounded-2xl border border-sand-200 bg-white p-6 text-sm text-sand-400">
        A carregar despesas recentes…
      </div>
    );
  }

  if (!rows.length) {
    return (
      <EmptyState
        title="Sem despesas nesta categoria"
        description="Ainda não há movimentos associados a esta categoria."
      />
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-sand-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-sand-50 text-xs uppercase tracking-wide text-sand-400">
          <tr>
            <th className="px-4 py-2 text-left">Data</th>
            <th className="px-4 py-2 text-left">Entidade</th>
            <th className="px-4 py-2 text-right">Montante</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-sand-100">
          {rows.map((r) => (
            <tr key={r._id}>
              <td className="px-4 py-2 text-sand-500">{r.date}</td>
              <td className="px-4 py-2 text-sand-900">{r.entity}</td>
              <td className="px-4 py-2 text-right font-medium text-curve-700">
                {formatEUR(r.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-sand-100 px-4 py-3 text-right">
        <Link
          to="/expenses"
          className="text-xs font-medium text-curve-700 hover:underline"
        >
          Ver todas →
        </Link>
      </div>
    </div>
  );
}

function ApplyConfirmDialog({ preview, onCancel, onConfirm, busy }) {
  if (!preview) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-sand-950/30 p-4 animate-fade-in"
      role="dialog"
      aria-modal="true"
    >
      <div className="card w-full max-w-md">
        <h2 className="text-lg font-semibold text-sand-900">
          Aplicar a despesas passadas?
        </h2>
        <p className="mt-2 text-sm text-sand-600">
          Vão ser re-catalogadas <strong>{preview.matched}</strong>{' '}
          {preview.matched === 1 ? 'despesa' : 'despesas'} tuas.
        </p>
        {preview.samples?.length > 0 && (
          <ul className="mt-4 max-h-56 space-y-1 overflow-y-auto rounded-xl border border-sand-200 bg-sand-50 p-3 text-xs">
            {preview.samples.map((s) => (
              <li key={s._id} className="flex justify-between gap-3">
                <span className="truncate text-sand-700">{s.entity}</span>
                <span className="text-sand-400">
                  {s.current_category ?? '—'} → {s.new_category ?? '—'}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            className="btn-secondary"
            onClick={onCancel}
            disabled={busy}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={onConfirm}
            disabled={busy || preview.matched === 0}
          >
            {busy ? 'A aplicar…' : 'Confirmar aplicação'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Page component
// ─────────────────────────────────────────────────────────────────────

export default function CategoriesPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [categories, setCategories] = useState([]);
  const [statsCurrent, setStatsCurrent] = useState(null);
  const [statsPrevious, setStatsPrevious] = useState(null);
  const [overrides, setOverrides] = useState([]);
  const [selectedId, setSelectedId] = useState(null); // category_id or '__null__'
  const [tab, setTab] = useState('entities'); // 'entities' | 'recent'
  const [loading, setLoading] = useState(true);
  const [overrideBusy, setOverrideBusy] = useState(false);
  const [pendingOverrideId, setPendingOverrideId] = useState(null); // for "aplicar" banner
  const [applyPreview, setApplyPreview] = useState(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [toast, setToast] = useState(null);
  // Separate busy flag for the admin global-entity DELETE — the button
  // lives in GlobalEntitiesList alongside the personal-override list,
  // but the two paths are independent and shouldn't share a lock.
  const [globalEntityBusy, setGlobalEntityBusy] = useState(false);

  const refreshAll = async () => {
    setLoading(true);
    try {
      const [cats, statsC, statsP, ovs] = await Promise.all([
        api.getCategories(),
        api.getCategoryStats({ cycle: 'current' }),
        api.getCategoryStats({ cycle: 'previous' }).catch(() => ({ data: { totals: [] } })),
        api.getCategoryOverrides(),
      ]);
      setCategories(cats.data ?? []);
      setStatsCurrent(statsC.data);
      setStatsPrevious(statsP.data ?? { totals: [] });
      setOverrides(ovs.data ?? []);
    } catch (err) {
      setToast({ type: 'error', text: err.message ?? 'Erro a carregar categorias.' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Build the master list: every category gets a row even if it has
  // no expenses this cycle (so the user can still see it and add a
  // rule), plus a synthetic "Sem categoria" bucket when there are
  // uncategorised expenses to surface.
  const rows = useMemo(() => {
    if (!statsCurrent) return [];
    const byId = new Map(
      (statsCurrent.totals ?? []).map((t) => [t.category_id ?? '__null__', t]),
    );
    const prevById = new Map(
      (statsPrevious?.totals ?? []).map((t) => [t.category_id ?? '__null__', t]),
    );
    const baseRows = categories.map((c) => {
      const id = c._id.toString();
      const cur = byId.get(id);
      const prev = prevById.get(id);
      return {
        category_id: id,
        category_name: c.name,
        total: cur?.total ?? 0,
        expense_count: cur?.expense_count ?? 0,
        entity_count: cur?.entity_count ?? 0,
        delta: percentDelta(cur?.total ?? 0, prev?.total ?? 0),
        global_entities: c.entities ?? [],
      };
    });
    // Add the uncategorised row only if it has any weight in either
    // cycle — avoids a permanent empty "Sem categoria" row on the
    // happy path.
    const uncCur = byId.get('__null__');
    const uncPrev = prevById.get('__null__');
    if (uncCur || uncPrev) {
      baseRows.push({
        category_id: null,
        category_name: 'Sem categoria',
        total: uncCur?.total ?? 0,
        expense_count: uncCur?.expense_count ?? 0,
        entity_count: uncCur?.entity_count ?? 0,
        delta: percentDelta(uncCur?.total ?? 0, uncPrev?.total ?? 0),
        global_entities: [],
      });
    }
    // Sort descending by current total so the distribution bar and
    // the list both render in impact order.
    baseRows.sort((a, b) => b.total - a.total);
    return baseRows;
  }, [statsCurrent, statsPrevious, categories]);

  // Default selection: pick the heaviest category once data lands,
  // or the first entry if every category is at zero.
  useEffect(() => {
    if (selectedId || !rows.length) return;
    const first = rows[0];
    setSelectedId(first.category_id ?? '__null__');
  }, [rows, selectedId]);

  const selectedRow = useMemo(
    () =>
      rows.find(
        (r) => (r.category_id ?? '__null__') === selectedId,
      ) ?? null,
    [rows, selectedId],
  );

  const grandTotal = statsCurrent?.grand_total ?? 0;
  const cycleLabel = statsCurrent?.cycle
    ? `${prettyDate(statsCurrent.cycle.start)} – ${prettyDate(statsCurrent.cycle.end)}`
    : '';

  // ── override helpers ────────────────────────────────────────────────

  const handleCreateOverride = async ({ pattern }) => {
    if (!selectedRow?.category_id) return;
    setOverrideBusy(true);
    try {
      const res = await api.createCategoryOverride({
        category_id: selectedRow.category_id,
        pattern,
        match_type: 'contains',
      });
      setOverrides((prev) => [...prev, res.data]);
      setPendingOverrideId(res.data.id);
      setToast({ type: 'ok', text: 'Regra pessoal criada.' });
    } catch (err) {
      setToast({ type: 'error', text: err.message ?? 'Erro a criar regra.' });
    } finally {
      setOverrideBusy(false);
    }
  };

  const handleDeleteOverride = async (id) => {
    setOverrideBusy(true);
    try {
      await api.deleteCategoryOverride(id);
      setOverrides((prev) => prev.filter((o) => o.id !== id));
      if (pendingOverrideId === id) setPendingOverrideId(null);
      setToast({ type: 'ok', text: 'Regra pessoal apagada.' });
    } catch (err) {
      setToast({ type: 'error', text: err.message ?? 'Erro a apagar regra.' });
    } finally {
      setOverrideBusy(false);
    }
  };

  // Admin-only: remove a single entity from the global catalogue.
  // Confirms via `window.confirm` — the whole admin slice is minimal
  // and a full modal would bloat the PR. Optimistically mutates the
  // local `categories` state so the row disappears immediately, then
  // rolls back on server error. Re-categorisation of past expenses
  // that referenced this entity is deliberately NOT triggered here —
  // existing expenses keep their `category_id` because resolveCategory
  // is only consulted on new sync, never retroactively by DELETE.
  // If the user wants retroactive cleanup they can still apply the
  // resolver via an override + apply-to-all.
  const handleDeleteGlobalEntity = async (categoryId, entity) => {
    if (!isAdmin) return;
    const ok = window.confirm(
      `Remover "${entity}" do catálogo global?\n\nAs despesas existentes que usam esta entidade mantêm a categoria actual — apenas novas sincronizações deixam de a associar automaticamente.`,
    );
    if (!ok) return;

    setGlobalEntityBusy(true);
    // Snapshot for rollback on failure.
    const snapshot = categories;
    setCategories((prev) =>
      prev.map((c) =>
        c._id.toString() === categoryId
          ? { ...c, entities: (c.entities ?? []).filter((e) => e !== entity) }
          : c,
      ),
    );
    try {
      await api.deleteCategoryEntity(categoryId, entity);
      setToast({ type: 'ok', text: `Entidade "${entity}" removida.` });
    } catch (err) {
      // Restore on failure. The server's 403/404/500 all land here.
      setCategories(snapshot);
      setToast({ type: 'error', text: err.message ?? 'Erro a remover entidade.' });
    } finally {
      setGlobalEntityBusy(false);
    }
  };

  const handleApplyPreview = async () => {
    if (!pendingOverrideId) return;
    setApplyBusy(true);
    try {
      const res = await api.applyCategoryOverride(pendingOverrideId, {
        dryRun: true,
      });
      setApplyPreview(res.data);
    } catch (err) {
      setToast({ type: 'error', text: err.message ?? 'Erro no preview.' });
    } finally {
      setApplyBusy(false);
    }
  };

  const handleApplyConfirm = async () => {
    if (!pendingOverrideId) return;
    setApplyBusy(true);
    try {
      const res = await api.applyCategoryOverride(pendingOverrideId, {
        dryRun: false,
      });
      setToast({
        type: 'ok',
        text: `${res.data.updated} ${res.data.updated === 1 ? 'despesa re-catalogada' : 'despesas re-catalogadas'}.`,
      });
      setApplyPreview(null);
      setPendingOverrideId(null);
      // Refresh stats silently so the totals reflect the reassignment.
      await refreshAll();
    } catch (err) {
      setToast({ type: 'error', text: err.message ?? 'Erro a aplicar.' });
    } finally {
      setApplyBusy(false);
    }
  };

  // Auto-dismiss success toasts. Errors stay until replaced.
  useEffect(() => {
    if (toast?.type !== 'ok') return;
    const id = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(id);
  }, [toast]);

  // ── render ──────────────────────────────────────────────────────────

  if (loading && !statsCurrent) {
    return (
      <div className="mx-auto max-w-6xl">
        <PageHeader title="Categorias" description="A carregar…" />
      </div>
    );
  }

  if (!categories.length) {
    return (
      <div className="mx-auto max-w-6xl">
        <PageHeader title="Categorias" />
        <EmptyState
          title="Ainda não há categorias"
          description="Contacta o administrador para criar o primeiro conjunto."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Categorias"
        description={cycleLabel ? `Ciclo actual · ${cycleLabel}` : undefined}
      />

      {/* Toast */}
      {toast && (
        <div
          className={`mb-4 rounded-xl px-4 py-2 text-sm animate-slide-in-right ${
            toast.type === 'ok'
              ? 'bg-emerald-50 text-emerald-700'
              : 'bg-red-50 text-curve-800'
          }`}
        >
          {toast.text}
        </div>
      )}

      {/* Distribution bar */}
      <div className="mb-6">
        <DistributionBar
          segments={rows.filter((r) => r.total > 0)}
          grandTotal={grandTotal}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </div>

      {/* Grid: list | detail */}
      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        {/* Left column — list */}
        <aside className="overflow-hidden rounded-2xl border border-sand-200 bg-white">
          <header className="flex items-center justify-between border-b border-sand-100 px-4 py-3">
            <span className="text-xs font-medium uppercase tracking-wide text-sand-400">
              Categorias
            </span>
            <span className="text-xs text-sand-500">
              {formatEUR(grandTotal)}
            </span>
          </header>
          <div className="max-h-[70vh] overflow-y-auto">
            {rows.map((row, i) => (
              <CategoryRow
                key={row.category_id ?? '__null__'}
                row={row}
                index={i}
                selected={(row.category_id ?? '__null__') === selectedId}
                onClick={() =>
                  setSelectedId(row.category_id ?? '__null__')
                }
              />
            ))}
          </div>
        </aside>

        {/* Right column — detail */}
        <section
          key={selectedId ?? 'none'}
          className="space-y-6 animate-fade-in"
        >
          {selectedRow ? (
            <>
              <div className="flex items-center gap-3">
                <span
                  className="h-3 w-3 rounded-full"
                  style={{ backgroundColor: swatchColor(selectedRow.category_id) }}
                />
                <h2 className="text-xl font-semibold text-sand-900">
                  {selectedRow.category_name}
                </h2>
                <DeltaBadge delta={selectedRow.delta} />
              </div>

              {/* KPI strip */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <AnimatedKPI
                  label="Total do ciclo"
                  value={selectedRow.total}
                  format={formatEUR}
                />
                <AnimatedKPI
                  label="Despesas"
                  value={selectedRow.expense_count}
                  format={(n) => Math.round(n).toString()}
                />
                <AnimatedKPI
                  label="Entidades"
                  value={selectedRow.entity_count}
                  format={(n) => Math.round(n).toString()}
                />
                <AnimatedKPI
                  label="Média por despesa"
                  value={
                    selectedRow.expense_count
                      ? selectedRow.total / selectedRow.expense_count
                      : 0
                  }
                  format={formatEUR}
                />
              </div>

              {/* Apply-to-all banner */}
              {pendingOverrideId && (
                <div className="flex items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 animate-fade-in">
                  <span>
                    Regra alterada. Aplicar a despesas passadas?
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn-secondary !py-1.5 !px-3 text-xs"
                      onClick={() => setPendingOverrideId(null)}
                      disabled={applyBusy}
                    >
                      Ignorar
                    </button>
                    <button
                      type="button"
                      className="btn-primary !py-1.5 !px-3 text-xs"
                      onClick={handleApplyPreview}
                      disabled={applyBusy}
                    >
                      {applyBusy ? 'A calcular…' : 'Aplicar'}
                    </button>
                  </div>
                </div>
              )}

              {/* Tabs */}
              <div className="flex gap-2 border-b border-sand-200">
                <button
                  type="button"
                  onClick={() => setTab('entities')}
                  className={`rounded-t-xl px-4 py-2 text-sm font-medium transition-colors ${
                    tab === 'entities'
                      ? 'bg-sand-100 text-sand-900'
                      : 'text-sand-500 hover:text-sand-800'
                  }`}
                >
                  Entidades
                </button>
                <button
                  type="button"
                  onClick={() => setTab('recent')}
                  className={`rounded-t-xl px-4 py-2 text-sm font-medium transition-colors ${
                    tab === 'recent'
                      ? 'bg-sand-100 text-sand-900'
                      : 'text-sand-500 hover:text-sand-800'
                  }`}
                >
                  Despesas recentes
                </button>
              </div>

              {tab === 'entities' ? (
                <div className="space-y-6">
                  {/* Personal overrides — only for real categories,
                      not the synthetic uncategorised bucket */}
                  {selectedRow.category_id && (
                    <section>
                      <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-sand-400">
                        As minhas regras
                      </h3>
                      <OverridesList
                        overrides={overrides}
                        categoryId={selectedRow.category_id}
                        categoryName={selectedRow.category_name}
                        onCreate={handleCreateOverride}
                        onDelete={handleDeleteOverride}
                        busy={overrideBusy}
                      />
                    </section>
                  )}

                  {/* Read-only global entities */}
                  {selectedRow.category_id && (
                    <section>
                      <h3 className="mb-3 text-xs font-medium uppercase tracking-wide text-sand-400">
                        Catálogo global
                      </h3>
                      <GlobalEntitiesList
                        entities={selectedRow.global_entities}
                        isAdmin={isAdmin}
                        busy={globalEntityBusy}
                        onDelete={(entity) =>
                          handleDeleteGlobalEntity(selectedRow.category_id, entity)
                        }
                      />
                    </section>
                  )}
                </div>
              ) : (
                <RecentExpenses categoryId={selectedRow.category_id} />
              )}
            </>
          ) : (
            <EmptyState
              title="Selecciona uma categoria"
              description="Escolhe uma linha à esquerda para ver os detalhes."
            />
          )}
        </section>
      </div>

      <ApplyConfirmDialog
        preview={applyPreview}
        onCancel={() => setApplyPreview(null)}
        onConfirm={handleApplyConfirm}
        busy={applyBusy}
      />
    </div>
  );
}
