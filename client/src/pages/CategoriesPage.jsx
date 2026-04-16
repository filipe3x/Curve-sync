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
//
// The regex has three capture groups (year, month, day), so the
// destructuring must skip four slots (match[0] = full string, then the
// year) before reaching month + day. An earlier version dropped only
// the full match and ended up reading the year as the month — which
// rendered "Ciclo actual · 3 – 4" instead of "22 Mar – 21 Abr".
function prettyDate(iso) {
  if (!iso) return '';
  const [, , m, d] = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/) ?? [];
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

// Client-side mirror of `services/categoryResolver.js :: normalize`.
// Kept byte-for-byte compatible so the autocomplete "is this entity
// already covered by an override?" check uses the same comparison key
// the server does when it actually matches at sync time. Do not
// diverge — if the server rules change, this must follow.
function normalizeEntity(raw) {
  if (!raw) return '';
  return String(raw)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Does any of the caller's overrides already claim `entity`? Replicates
// the three match-type branches from `categoryResolver.js :: matches`
// so the autocomplete preview matches what the sync would decide.
// Called for every candidate entity on every keystroke, so it must
// stay allocation-light — no regex, no array building.
function entityCoveredByOverride(entity, overrides) {
  const norm = normalizeEntity(entity);
  if (!norm) return false;
  for (const o of overrides) {
    const p = o.pattern_normalized;
    if (!p) continue;
    switch (o.match_type) {
      case 'exact':
        if (norm === p) return true;
        break;
      case 'starts_with':
        if (norm === p || norm.startsWith(p + ' ')) return true;
        break;
      case 'contains':
      default:
        if (norm.includes(p)) return true;
        break;
    }
  }
  return false;
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
  entitySuggestions = [],
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
  // Autocomplete dropdown: `open` gates visibility (set on focus +
  // typing, cleared on blur / pick / Escape), `highlightIdx` tracks the
  // keyboard-selected row. `-1` means "nothing highlighted" so arrow-up
  // can wrap to the last entry on the first press.
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const mine = overrides.filter((o) => o.category_id === categoryId);

  // Available entities for the autocomplete = caller's distinct expense
  // entities MINUS anything already covered by an existing override.
  // The "already covered" check is purely local (no round-trip), using
  // the same match logic the server runs at sync time (see
  // `entityCoveredByOverride`).
  //
  // The filter runs once per change of `entitySuggestions`/`overrides`,
  // not on every keystroke — the query filter below is cheap and
  // operates on the already-pruned list.
  const availableEntities = useMemo(() => {
    if (!entitySuggestions.length) return [];
    return entitySuggestions.filter(
      (e) => e && !entityCoveredByOverride(e, overrides),
    );
  }, [entitySuggestions, overrides]);

  // Accent-insensitive `includes` filter. `availableEntities` is
  // already ordered by most-recent expense first on the server side
  // (see routes/autocomplete.js), so the loop just preserves that
  // order and picks the first 8 hits — "I bought something yesterday"
  // always wins over "I bought something in 2023". Empty input shows
  // the top 8 most-recent entries so users can browse before
  // committing to a prefix.
  const filteredSuggestions = useMemo(() => {
    if (!availableEntities.length) return [];
    const needle = normalizeEntity(pattern);
    if (!needle) return availableEntities.slice(0, 8);
    const hits = [];
    for (const e of availableEntities) {
      const norm = normalizeEntity(e);
      if (!norm) continue;
      if (norm.includes(needle)) hits.push(e);
      if (hits.length >= 8) break;
    }
    return hits;
  }, [availableEntities, pattern]);

  // Keep the highlight inside bounds whenever the candidate list
  // changes — otherwise typing a prefix that shrinks the list would
  // leave the highlight pointing at a stale (now out-of-range) index
  // and the Enter key would submit whatever row replaced it.
  useEffect(() => {
    if (highlightIdx >= filteredSuggestions.length) setHighlightIdx(-1);
  }, [filteredSuggestions, highlightIdx]);

  // Click-to-create: picking a suggestion immediately hands the
  // entity off to `onCreate` instead of just filling the input. The
  // two-click flow (pick → Adicionar) made no sense when the user
  // had already explicitly chosen a valid, unused entity from the
  // dropdown — the parent's apply-to-all banner still runs after
  // creation, so the apply flow is unchanged.
  const pickSuggestion = async (entity) => {
    if (busy) return;
    setOpen(false);
    setHighlightIdx(-1);
    if (error) setError(null);
    await onCreate({ pattern: entity.trim() });
    setPattern('');
  };

  const handleKeyDown = (e) => {
    // Only intercept navigation keys while the dropdown is open and
    // actually has candidates — otherwise Enter must keep its "submit
    // the form" default.
    if (!open || filteredSuggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx((i) => (i + 1) % filteredSuggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx((i) =>
        i <= 0 ? filteredSuggestions.length - 1 : i - 1,
      );
    } else if (e.key === 'Enter' && highlightIdx >= 0) {
      e.preventDefault();
      pickSuggestion(filteredSuggestions[highlightIdx]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setHighlightIdx(-1);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!pattern.trim()) {
      setError('Preenche o nome da entidade primeiro.');
      return;
    }
    setError(null);
    setOpen(false);
    await onCreate({ pattern: pattern.trim() });
    setPattern('');
  };

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="relative flex gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            value={pattern}
            onChange={(e) => {
              setPattern(e.target.value);
              setOpen(true);
              setHighlightIdx(-1);
              if (error) setError(null);
            }}
            onFocus={() => setOpen(true)}
            // Delay the close so a click on a suggestion row (which
            // blurs the input) still registers its onMouseDown before
            // the dropdown disappears.
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            onKeyDown={handleKeyDown}
            placeholder={`Nova regra pessoal para ${categoryName ?? 'esta categoria'}…`}
            className="input w-full"
            disabled={busy}
            autoComplete="off"
            role="combobox"
            aria-expanded={open && filteredSuggestions.length > 0}
            aria-autocomplete="list"
            aria-controls="override-entity-suggestions"
          />
          {open && filteredSuggestions.length > 0 && (
            <ul
              id="override-entity-suggestions"
              role="listbox"
              className="absolute left-0 right-0 top-full z-20 mt-1 max-h-60 overflow-y-auto rounded-xl border border-sand-200 bg-white py-1 shadow-lg animate-fade-in"
            >
              {filteredSuggestions.map((entity, i) => {
                const isActive = i === highlightIdx;
                return (
                  <li
                    key={entity}
                    role="option"
                    aria-selected={isActive}
                    // `onMouseDown` (not `onClick`) fires before the
                    // input's `onBlur`, which is what lets the click
                    // beat the delayed-close timer above.
                    onMouseDown={(ev) => {
                      ev.preventDefault();
                      pickSuggestion(entity);
                    }}
                    onMouseEnter={() => setHighlightIdx(i)}
                    className={`cursor-pointer px-3 py-2 text-sm transition-colors ${
                      isActive
                        ? 'bg-curve-50 text-curve-800'
                        : 'text-sand-800 hover:bg-sand-50'
                    }`}
                  >
                    {entity}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
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
            para fazer categorização futura dessas despesas.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-sand-100 rounded-2xl border border-sand-200 bg-white">
          {mine.map((o) => {
            // `matched_count` is server-provided (see
            // routes/categoryOverrides.js :: countMatchesPerRule).
            // Fall back to `null` → hidden subtitle suffix so the row
            // still renders cleanly if a cached response predates
            // the field. The "match c/" prefix is deliberate — the
            // number is "how wide is this rule's net against my
            // expenses", not "how many are already sitting in the
            // target category" (§8.4, §9.5.2). The previous
            // "N despesas" reading implied ownership and was
            // misleading when two rules overlapped or when the rule
            // had never been apply-to-all'd.
            const count = o.matched_count;
            const countLabel =
              count == null
                ? null
                : count === 1
                  ? 'match c/ 1 despesa'
                  : `match c/ ${count} despesas`;
            return (
              <li
                key={o.id}
                className="flex items-center justify-between px-4 py-3"
              >
                <div>
                  <p className="text-sm font-medium text-sand-900">{o.pattern}</p>
                  <p className="text-xs text-sand-400">
                    {o.match_type} · prioridade {o.priority}
                    {countLabel && <> · {countLabel}</>}
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
            );
          })}
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
//
// `counts` is an optional `{ [entity]: N }` map — how many of the
// caller's expenses each global entity catches right now, computed
// server-side via `GET /api/categories?with_match_counts=true`
// (see §8.4 + server/src/routes/categories.js). Always scoped to the
// caller's own expenses, never the platform total. Missing keys and
// missing maps both degrade to "no subtitle count" so pre-feature
// callers render unchanged.
function GlobalEntitiesList({
  entities,
  counts = null,
  isAdmin = false,
  busy = false,
  onDelete,
}) {
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
      <ul className="max-h-96 overflow-y-auto divide-y divide-sand-100 rounded-2xl border border-sand-200 bg-white">
        {filtered.map((entity) => {
          // Same semantics as the override row subtitle (§9.5.2):
          // "match c/ 1 despesa" vs "match c/ N despesas", omitted
          // entirely when the count is null/undefined so pre-feature
          // consumers stay visually unchanged. The "match c/" prefix
          // is deliberate — the number is the rule's net width, not
          // "how many are catalogued inside this bucket" (§8.4).
          const count = counts?.[entity];
          const countLabel =
            count == null
              ? null
              : count === 1
                ? 'match c/ 1 despesa'
                : `match c/ ${count} despesas`;
          return (
          <li
            key={entity}
            className="flex items-center justify-between px-4 py-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-sand-900">
                {entity}
              </p>
              <p className="text-xs text-sand-400">
                global
                {countLabel && <> · {countLabel}</>}
              </p>
            </div>
            {isAdmin && (
              <button
                type="button"
                onClick={() => onDelete?.(entity)}
                disabled={busy}
                title="Remover esta entidade do catálogo global"
                className="rounded-lg px-2 py-1 text-xs font-medium text-sand-500 hover:bg-sand-100 hover:text-curve-700"
              >
                Apagar
              </button>
            )}
          </li>
          );
        })}
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

// Three-way dialog for the delete-override flow. The user lands here
// after clicking Apagar on a personal rule and must choose between:
//   - Cancelar                    → no-op, rule stays
//   - Apagar (manter despesas)    → delete rule, leave `category_id`
//                                   on past expenses untouched
//   - Apagar e re-catalogar       → delete rule AND trigger a
//                                   post-delete re-resolve pass on
//                                   the server (cascade=true), so
//                                   any expense that was stuck on
//                                   the old category gets re-
//                                   catalogued by the remaining
//                                   resolver context
//
// The third option is important because without it a user who
// apply-to-all's a rule and later deletes it ends up with expenses
// frozen on the old category — the symptom that motivated this dialog.
function DeleteOverrideDialog({ target, onCancel, onConfirm, busy }) {
  if (!target) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-sand-950/30 p-4 animate-fade-in"
      role="dialog"
      aria-modal="true"
    >
      <div className="card w-full max-w-md">
        <h2 className="text-lg font-semibold text-sand-900">
          Apagar regra "{target.pattern}"?
        </h2>
        <p className="mt-2 text-sm text-sand-600">
          A regra será removida. Escolhe o que fazer com as despesas
          passadas que tinham sido catalogadas por esta regra.
        </p>
        <ul className="mt-4 space-y-2 text-xs text-sand-600">
          <li>
            <strong className="text-sand-800">Manter despesas:</strong>{' '}
            as despesas passadas mantêm a categoria actual. Próximas
            sincronizações deixam de usar esta regra.
          </li>
          <li>
            <strong className="text-sand-800">Re-catalogar:</strong>{' '}
            as despesas passadas voltam a ser avaliadas pelas restantes
            regras — catálogo global, outras regras pessoais — ou
            ficam sem categoria.
          </li>
        </ul>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
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
            className="btn-secondary"
            onClick={() => onConfirm(false)}
            disabled={busy}
          >
            Apagar (manter despesas)
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => onConfirm(true)}
            disabled={busy}
          >
            {busy ? 'A aplicar…' : 'Apagar e re-catalogar'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Admin-only confirmation for removing a single entity from a global
// category's `entities` array. Matches the visual language of
// DeleteOverrideDialog above — same backdrop, same `card` panel, same
// btn-secondary/btn-primary footer — so the admin surgery slice stays
// consistent with the rest of the /categories screen instead of the
// ugly native `window.confirm` modal this replaced.
function DeleteGlobalEntityDialog({ target, onCancel, onConfirm, busy }) {
  if (!target) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-sand-950/30 p-4 animate-fade-in"
      role="dialog"
      aria-modal="true"
    >
      <div className="card w-full max-w-md">
        <h2 className="text-lg font-semibold text-sand-900">
          Remover "{target.entity}" do catálogo global?
        </h2>
        <p className="mt-2 text-sm text-sand-600">
          A entidade será apagada de{' '}
          <strong className="text-sand-800">{target.categoryName}</strong>.
          Próximas sincronizações deixam de a associar automaticamente a
          esta categoria.
        </p>
        <p className="mt-3 text-xs text-sand-500">
          As despesas passadas que já usavam esta entidade mantêm a
          categoria actual — a remoção não é retroactiva.
        </p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
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
            disabled={busy}
          >
            {busy ? 'A remover…' : 'Remover entidade'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ApplyConfirmDialog({
  preview,
  entry,
  onCancel,
  onConfirm,
  onCancelRule,
  busy,
}) {
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
        {entry && (
          <p className="mt-1 text-xs uppercase tracking-wide text-sand-400">
            Regra "{entry.pattern}" → {entry.category_name}
          </p>
        )}
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
        <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
          {/* Escape hatch on the left side so it visually separates
              from Cancelar/Confirmar — a three-way decision needs a
              three-way layout, not three adjacent pills that look
              the same. Only rendered when the caller passes an
              `onCancelRule` handler (it will always do so today, but
              the prop is optional for future reuse of this dialog
              outside the apply-to-all flow). */}
          {entry && onCancelRule && (
            <button
              type="button"
              className="rounded-lg px-3 py-2 text-sm font-medium text-curve-700 hover:bg-curve-50 disabled:opacity-50"
              onClick={() => onCancelRule(entry)}
              disabled={busy}
              title="Apagar esta regra — útil se foi criada por engano"
            >
              Anular regra
            </button>
          )}
          <div className="ml-auto flex gap-2">
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
  // Full list of distinct `entity` strings across the caller's
  // expenses, used to power the override-form autocomplete. Fetched
  // once alongside the other page-level data so switching between
  // categories doesn't re-hit /autocomplete — the list is the same
  // regardless of which category is selected.
  const [entitySuggestions, setEntitySuggestions] = useState([]);
  const [selectedId, setSelectedId] = useState(null); // category_id or '__null__'
  const [tab, setTab] = useState('entities'); // 'entities' | 'recent'
  const [loading, setLoading] = useState(true);
  const [overrideBusy, setOverrideBusy] = useState(false);
  // Stack of pending apply-to-all banners, one per freshly-created
  // override that had `matched > 0` at creation time. Each entry is
  // `{ id, pattern, category_name, matched }` — `matched` is a
  // snapshot from the create-time dry-run, good enough for the
  // banner count; `handleApplyPreview` re-fetches a fresh dry-run
  // before opening the confirm dialog so the confirmation number
  // is always current.
  //
  // History: this was a single `pendingOverrideId` string. Creating a
  // second rule while the banner was still up silently overwrote the
  // first rule's id, so clicking Aplicar applied only the second
  // rule. The array form keeps every pending rule visible and
  // actionable until the user explicitly clicks Aplicar or Ignorar
  // on each banner.
  const [pendingApplies, setPendingApplies] = useState([]);
  // When the confirm dialog is open, `applyPreview` carries
  // `{ entry, preview }` — `entry` is the pendingApplies row being
  // applied (so the confirm handler knows which override id to call
  // and which entry to remove on success), `preview` is the fresh
  // dry-run response from the server (matched, samples, …).
  const [applyPreview, setApplyPreview] = useState(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [toast, setToast] = useState(null);
  // Separate busy flag for the admin global-entity DELETE — the button
  // lives in GlobalEntitiesList alongside the personal-override list,
  // but the two paths are independent and shouldn't share a lock.
  const [globalEntityBusy, setGlobalEntityBusy] = useState(false);
  // Override pending a delete decision (opens DeleteOverrideDialog).
  // `null` when no dialog is shown; the full override object while the
  // user picks between keep-past-expenses and cascade-re-resolve.
  const [deleteTarget, setDeleteTarget] = useState(null);
  // Global-entity pending an admin delete confirmation. `null` when no
  // dialog is shown; `{ categoryId, categoryName, entity }` while the
  // admin is deciding. Separate from `deleteTarget` because the two
  // flows have different consequences and can coexist.
  const [deleteEntityTarget, setDeleteEntityTarget] = useState(null);

  const refreshAll = async () => {
    setLoading(true);
    try {
      const [cats, statsC, statsP, ovs, ents] = await Promise.all([
        api.getCategories({ withMatchCounts: true }),
        api.getCategoryStats({ cycle: 'current' }),
        api.getCategoryStats({ cycle: 'previous' }).catch(() => ({ data: { totals: [] } })),
        api.getCategoryOverrides(),
        // Autocomplete is a nice-to-have — a failure here must not
        // break the page, so swallow and fall back to an empty list
        // (which the form handles as "just a plain text input").
        api.autocomplete('entity').catch(() => ({ data: [] })),
      ]);
      setCategories(cats.data ?? []);
      setStatsCurrent(statsC.data);
      setStatsPrevious(statsP.data ?? { totals: [] });
      setOverrides(ovs.data ?? []);
      setEntitySuggestions(ents.data ?? []);
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
        // Per-global-entity match counts, user-scoped. Populated by
        // GET /api/categories?with_match_counts=true — each key is the
        // raw entity string, each value is the number of the caller's
        // own expenses the rule catches right now. Missing (or
        // partially missing) keys degrade gracefully to "no count"
        // in GlobalEntitiesList.
        global_entity_counts: c.entity_match_counts ?? {},
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
        global_entity_counts: {},
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

      // Peek at the apply-to-all impact immediately so the banner
      // only appears when there's actually something to apply. The
      // zero-match case is common when a user re-creates a rule
      // that used to exist (stuck `category_id` from a prior
      // apply-to-all) — in that state the banner + modal were
      // offering a no-op Confirmar button, which is the symptom
      // the user reported.
      try {
        const preview = await api.applyCategoryOverride(res.data.id, {
          dryRun: true,
        });
        const matched = preview.data?.matched ?? 0;
        if (matched > 0) {
          // Push, never overwrite. Two rules created in quick
          // succession produce two stacked banners — the user sees
          // both and decides per-entry.
          setPendingApplies((prev) => [
            ...prev,
            {
              id: res.data.id,
              pattern: res.data.pattern,
              category_name: res.data.category_name ?? selectedRow.category_name,
              matched,
            },
          ]);
          setToast({
            type: 'ok',
            text: `Regra criada. ${matched} ${matched === 1 ? 'despesa pode' : 'despesas podem'} ser re-catalogadas.`,
          });
        } else {
          setToast({
            type: 'ok',
            text: 'Regra pessoal criada. Nenhuma despesa passada é afectada.',
          });
        }
      } catch {
        // Preview fetch failing should not block rule creation.
        // Fall back to the pre-fix behaviour (banner appears, user
        // decides whether to click it) so the apply path is still
        // reachable — the alternative of silently hiding the banner
        // would be worse if the preview route is temporarily down.
        // `matched: null` skips the count in the banner copy.
        setPendingApplies((prev) => [
          ...prev,
          {
            id: res.data.id,
            pattern: res.data.pattern,
            category_name: res.data.category_name ?? selectedRow.category_name,
            matched: null,
          },
        ]);
        setToast({ type: 'ok', text: 'Regra pessoal criada.' });
      }
    } catch (err) {
      setToast({ type: 'error', text: err.message ?? 'Erro a criar regra.' });
    } finally {
      setOverrideBusy(false);
    }
  };

  // Open the delete dialog. The actual API call lives in
  // `handleDeleteOverrideConfirm` — we split so the dialog can
  // surface the three-way choice (cancel / keep / cascade) that
  // the user reported needing.
  //
  // Why the cascade exists: a user who apply-to-all's a rule
  // "lidl" → Groceries writes Groceries onto every Lidl expense.
  // Deleting the rule afterwards does NOT unwind those writes —
  // the `category_id` column stays frozen until another write
  // touches it. Without the cascade, re-creating the same rule
  // later shows "0 despesas" in the apply preview, which is
  // confusing and the symptom the user reported.
  const handleRequestDeleteOverride = (id) => {
    const override = overrides.find((o) => o.id === id);
    if (override) setDeleteTarget(override);
  };

  // Invoked from the dialog. `cascade` is `true` when the user picks
  // "Apagar e re-catalogar", `false` when they pick "Apagar (manter)".
  // Cancel dismisses via `setDeleteTarget(null)` without ever calling
  // this.
  const handleDeleteOverrideConfirm = async (cascade) => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setOverrideBusy(true);
    try {
      await api.deleteCategoryOverride(id, { cascade });
      setOverrides((prev) => prev.filter((o) => o.id !== id));
      // Drop any still-pending banner for this rule — the rule is
      // gone, there's nothing left to apply. Works for both cascade
      // and non-cascade deletes because the banner operates on the
      // rule's id, not on the side-effect.
      setPendingApplies((prev) => prev.filter((e) => e.id !== id));
      setToast({
        type: 'ok',
        text: cascade
          ? 'Regra apagada. Despesas passadas re-catalogadas.'
          : 'Regra pessoal apagada.',
      });
      setDeleteTarget(null);
      // Cascade rewrites category_id on arbitrary expenses, so the
      // totals and distribution bar must reload. The non-cascade path
      // only drops the row from the overrides list and needs no
      // server re-fetch.
      if (cascade) await refreshAll();
    } catch (err) {
      setToast({ type: 'error', text: err.message ?? 'Erro a apagar regra.' });
    } finally {
      setOverrideBusy(false);
    }
  };

  // Admin-only: remove a single entity from the global catalogue.
  //
  // Two-step flow: the row's Apagar button calls
  // `handleRequestDeleteGlobalEntity`, which opens the
  // DeleteGlobalEntityDialog. The dialog's Confirmar button then
  // calls `handleDeleteGlobalEntityConfirm` below, which does the
  // actual DELETE + optimistic update + rollback. This replaces the
  // ugly native `window.confirm` prompt that ignored the site design.
  //
  // Re-categorisation of past expenses that referenced this entity is
  // deliberately NOT triggered here — existing expenses keep their
  // `category_id` because resolveCategory is only consulted on new
  // sync, never retroactively by DELETE. If the user wants retroactive
  // cleanup they can still apply the resolver via an override +
  // apply-to-all.
  const handleRequestDeleteGlobalEntity = (categoryId, categoryName, entity) => {
    if (!isAdmin) return;
    setDeleteEntityTarget({ categoryId, categoryName, entity });
  };

  const handleDeleteGlobalEntityConfirm = async () => {
    if (!deleteEntityTarget) return;
    const { categoryId, entity } = deleteEntityTarget;

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
      setDeleteEntityTarget(null);
    } catch (err) {
      // Restore on failure. The server's 403/404/500 all land here.
      setCategories(snapshot);
      setToast({ type: 'error', text: err.message ?? 'Erro a remover entidade.' });
    } finally {
      setGlobalEntityBusy(false);
    }
  };

  // Clicking "Aplicar" on a banner opens the preview dialog for
  // *that* specific entry. `entry` is the pendingApplies row —
  // passing it in (instead of reading from a "current" ref)
  // makes every call site explicit about which rule it's acting
  // on, which is the whole point of this refactor.
  const handleApplyPreview = async (entry) => {
    if (!entry) return;
    setApplyBusy(true);
    try {
      const res = await api.applyCategoryOverride(entry.id, {
        dryRun: true,
      });
      setApplyPreview({ entry, preview: res.data });
    } catch (err) {
      setToast({ type: 'error', text: err.message ?? 'Erro no preview.' });
    } finally {
      setApplyBusy(false);
    }
  };

  // Invoked from the confirm dialog. Reads the entry off
  // `applyPreview.entry` so it always applies the same rule the user
  // previewed, even if a new rule was created in the meantime and
  // appended to `pendingApplies`.
  const handleApplyConfirm = async () => {
    const entry = applyPreview?.entry;
    if (!entry) return;
    setApplyBusy(true);
    try {
      const res = await api.applyCategoryOverride(entry.id, {
        dryRun: false,
      });
      setToast({
        type: 'ok',
        text: `${res.data.updated} ${res.data.updated === 1 ? 'despesa re-catalogada' : 'despesas re-catalogadas'}.`,
      });
      setApplyPreview(null);
      // Drop just *this* entry from the stack — other pending
      // banners stay up waiting for their own Aplicar/Ignorar.
      setPendingApplies((prev) => prev.filter((e) => e.id !== entry.id));
      // Refresh stats silently so the totals reflect the reassignment.
      await refreshAll();
    } catch (err) {
      setToast({ type: 'error', text: err.message ?? 'Erro a aplicar.' });
    } finally {
      setApplyBusy(false);
    }
  };

  // Dismiss a banner without applying. Keeps every other pending
  // banner in place — only the entry the user actually clicked gets
  // removed.
  const handleIgnorePending = (entryId) => {
    setPendingApplies((prev) => prev.filter((e) => e.id !== entryId));
  };

  // Third banner option: "Anular regra" — escape hatch for a fresh
  // rule the user just realised is wrong (wrong pattern, wrong
  // category, fat-fingered the input). Deletes the override outright
  // and drops the banner. `cascade: false` is always safe because the
  // banner is only ever shown BEFORE the user clicked Aplicar — so
  // no `category_id` was ever written from this rule. If the user had
  // already applied and then reopened the banner via some future
  // surface, the cascade decision would live in the delete dialog,
  // not here.
  //
  // Also closes the confirm dialog if it happened to be open for
  // this same entry — prevents the dialog from hanging on a now-
  // deleted rule id.
  const handleCancelPendingRule = async (entry) => {
    if (!entry) return;
    setOverrideBusy(true);
    try {
      await api.deleteCategoryOverride(entry.id, { cascade: false });
      setOverrides((prev) => prev.filter((o) => o.id !== entry.id));
      setPendingApplies((prev) => prev.filter((e) => e.id !== entry.id));
      if (applyPreview?.entry?.id === entry.id) setApplyPreview(null);
      setToast({ type: 'ok', text: `Regra "${entry.pattern}" anulada.` });
    } catch (err) {
      setToast({ type: 'error', text: err.message ?? 'Erro a anular regra.' });
    } finally {
      setOverrideBusy(false);
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

              {/* Apply-to-all banners — one per pending rule. Stacked
                  so creating two rules in quick succession keeps both
                  actionable; each banner names its own rule so the
                  user knows exactly what Aplicar/Ignorar will touch. */}
              {pendingApplies.length > 0 && (
                <div className="space-y-2">
                  {pendingApplies.map((entry) => (
                    <div
                      key={entry.id}
                      className="flex items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 animate-fade-in"
                    >
                      <span className="min-w-0">
                        Regra <strong>"{entry.pattern}"</strong>
                        {entry.category_name && (
                          <> → {entry.category_name}</>
                        )}
                        {entry.matched != null && (
                          <>
                            {' '}
                            · match c/{' '}
                            <strong>
                              {entry.matched}{' '}
                              {entry.matched === 1 ? 'despesa' : 'despesas'}
                            </strong>
                          </>
                        )}
                        . Aplicar a despesas passadas?
                      </span>
                      <div className="flex shrink-0 gap-2">
                        {/* "Anular regra" = delete the override
                            outright. Destructive but safe: the
                            banner is only shown pre-apply, so no
                            `category_id` was ever written from this
                            rule. Styled red-ish to telegraph that
                            it's not the same as Ignorar. */}
                        <button
                          type="button"
                          className="rounded-lg px-3 py-1.5 text-xs font-medium text-curve-700 hover:bg-curve-50 disabled:opacity-50"
                          onClick={() => handleCancelPendingRule(entry)}
                          disabled={applyBusy || overrideBusy}
                          title="Apagar esta regra — útil se foi criada por engano"
                        >
                          Anular regra
                        </button>
                        <button
                          type="button"
                          className="btn-secondary !py-1.5 !px-3 text-xs"
                          onClick={() => handleIgnorePending(entry.id)}
                          disabled={applyBusy || overrideBusy}
                        >
                          Ignorar
                        </button>
                        <button
                          type="button"
                          className="btn-primary !py-1.5 !px-3 text-xs"
                          onClick={() => handleApplyPreview(entry)}
                          disabled={applyBusy || overrideBusy}
                        >
                          {applyBusy ? 'A calcular…' : 'Aplicar'}
                        </button>
                      </div>
                    </div>
                  ))}
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
                        entitySuggestions={entitySuggestions}
                        categoryId={selectedRow.category_id}
                        categoryName={selectedRow.category_name}
                        onCreate={handleCreateOverride}
                        onDelete={handleRequestDeleteOverride}
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
                        counts={selectedRow.global_entity_counts}
                        isAdmin={isAdmin}
                        busy={globalEntityBusy}
                        onDelete={(entity) =>
                          handleRequestDeleteGlobalEntity(
                            selectedRow.category_id,
                            selectedRow.category_name,
                            entity,
                          )
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
        preview={applyPreview?.preview ?? null}
        entry={applyPreview?.entry ?? null}
        onCancel={() => setApplyPreview(null)}
        onConfirm={handleApplyConfirm}
        onCancelRule={handleCancelPendingRule}
        busy={applyBusy || overrideBusy}
      />

      <DeleteOverrideDialog
        target={deleteTarget}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={handleDeleteOverrideConfirm}
        busy={overrideBusy}
      />

      <DeleteGlobalEntityDialog
        target={deleteEntityTarget}
        onCancel={() => {
          if (globalEntityBusy) return;
          setDeleteEntityTarget(null);
        }}
        onConfirm={handleDeleteGlobalEntityConfirm}
        busy={globalEntityBusy}
      />
    </div>
  );
}
