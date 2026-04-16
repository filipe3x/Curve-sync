import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../components/common/PageHeader';
import EmptyState from '../components/common/EmptyState';
import { PlusIcon, MagnifyingGlassIcon } from '../components/layout/Icons';
import { useCountUp } from '../hooks/useCountUp';
import { useAuth } from '../contexts/AuthContext';
import * as api from '../services/api';
import { CategoryIcon } from '../components/common/CategoryIcon';
import {
  IconPickerGrid,
  IconPickerDialog,
} from '../components/common/IconPickerPopover';

/**
 * /categories — master-detail category management screen.
 *
 * User mode landed with Fase 4 (PR #5); the admin branch lands in
 * Fase 5 on the same component, gated by `user.role === 'admin'`.
 * The gate is purely UX-level — the server is the real enforcement
 * boundary via `requireAdmin` on every admin catalogue route. Admin
 * adds, on top of the shared user surface:
 *   - `+ Categoria` button in the master pane header (opens the
 *     CreateCategoryDialog with name + optional entity seed).
 *   - Inline rename of the selected category in the detail header
 *     (blur / Enter commits, Esc cancels). Piped through
 *     `api.updateCategory` → `PUT /api/categories/:id`.
 *   - Delete button in the detail header; 409 `category_in_use`
 *     responses populate the DeleteCategoryDialog's "blocked" mode
 *     with the expense + override reference counts so the admin
 *     sees why it refused (docs/Categories.md §11.4 risk #3).
 *   - Batch-add of entities above the read-only global catalogue
 *     list (AddGlobalEntitiesForm), committing via
 *     `POST /api/categories/:id/entities` and pushing an
 *     admin-kind pending-apply banner on success.
 *   - Admin branch of the apply-to-all stack: pending entries with
 *     `kind: 'admin'` call `api.applyCategoryToAll` instead of the
 *     personal variant, show "Entidades adicionadas a <cat>" copy,
 *     and hide the "Anular regra" escape hatch (undo lives on the
 *     per-entity DELETE button, not a whole-batch rollback).
 *
 * Icon picker (`curve_category_icons`): a Curve-Sync-owned mapping
 * `category_id → icon_name` (PascalCase Lucide component), wired to
 * `GET/PUT/DELETE /api/category-icons` and rendered via
 * `<CategoryIcon>` + `<IconPickerDialog>`. Kept separate from
 * Embers' Paperclip `icon_*` fields on the shared `categories` row —
 * those stay untouched (CLAUDE.md "never modify the schema of
 * categories"). Three surfaces:
 *   - master list rows          — glyph inside the swatch dot
 *   - detail header             — glyph inside a larger swatch
 *   - CreateCategoryDialog      — inline picker at creation time
 * Regular users see the glyphs; only admins can change them via the
 * detail-header "Ícone" button (server-enforced via requireAdmin).
 *
 * Data sources:
 *   - GET /api/categories         — full read-only catalogue
 *   - GET /api/categories/stats   — current + previous day-22 cycle
 *                                   aggregates (§8.6)
 *   - GET /api/category-overrides — caller's personal rules (§8.4)
 *   - GET /api/category-icons     — Curve-Sync-owned icon mapping
 *                                   (§Categories.md, `CategoryIcon.js`)
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

function CategoryRow({ row, index, selected, iconName, onClick }) {
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
        {/* Swatch dot doubles as an icon pedestal — the Lucide glyph
            sits white-on-color inside a small circle. Uncategorised
            rows (no category_id) skip the glyph so the synthetic
            "Sem categoria" bucket reads as "empty" rather than
            "tagged with Tag". */}
        {row.category_id ? (
          <span
            className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full text-white"
            style={{ backgroundColor: swatchColor(row.category_id) }}
          >
            <CategoryIcon name={iconName ?? null} className="h-3 w-3" />
          </span>
        ) : (
          <span
            className="mt-1.5 h-2.5 w-2.5 flex-none rounded-full"
            style={{ backgroundColor: swatchColor(row.category_id) }}
          />
        )}
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

// Admin-only: batch-add entity strings to a global category. The form
// splits on commas and newlines, so the admin can paste "galp, bp,
// repsol" OR type one per line and hit Enter. Trimmed, blank-dropped,
// and forwarded to `onSubmit(entities)` which is expected to call
// `api.addCategoryEntities`.
//
// The 409 `entity_conflict` path renders inline under the form: the
// parent re-throws the augmented Error (`err.body.conflicts`) so this
// component can list the collisions ("<entity> está em <other>") and
// tell the admin to either remove them from the other category first
// or edit the input and retry. The whole batch is aborted on any
// conflict — the server explicitly refuses to half-apply (§8.3).
//
// On success the input clears; on any error the draft is preserved so
// the admin can fix-and-retry without re-typing. The parent handles
// the apply-to-all banner (pushed after a successful add, keyed off
// `{ kind: 'admin' }` — see pendingApplies).
function AddGlobalEntitiesForm({ categoryId, categoryName, onSubmit, busy }) {
  const [text, setText] = useState('');
  const [conflicts, setConflicts] = useState([]);
  const [error, setError] = useState(null);

  const parseEntities = (raw) =>
    raw
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);

  const clearFeedback = () => {
    if (error) setError(null);
    if (conflicts.length) setConflicts([]);
  };

  const submit = async (e) => {
    e.preventDefault();
    const entities = parseEntities(text);
    if (!entities.length) {
      setError('Indica pelo menos uma entidade.');
      return;
    }
    setError(null);
    setConflicts([]);
    try {
      await onSubmit(entities);
      setText('');
    } catch (err) {
      if (err?.message === 'entity_conflict' && err?.body?.conflicts) {
        setConflicts(err.body.conflicts);
      } else if (err?.message === 'invalid_entities') {
        setError('Uma ou mais entidades são inválidas.');
      } else if (err?.message === 'category_not_found') {
        setError('Categoria não encontrada — recarrega a página.');
      } else {
        setError(err?.message ?? 'Erro a adicionar entidades.');
      }
    }
  };

  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex gap-2">
        <input
          type="text"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            clearFeedback();
          }}
          placeholder={`Nova entidade para ${categoryName ?? 'esta categoria'}…`}
          className="input flex-1"
          disabled={busy}
          aria-label="Adicionar entidade ao catálogo global"
        />
        <button
          type="submit"
          className="btn-primary"
          disabled={busy || !text.trim()}
        >
          <PlusIcon className="h-4 w-4" />
          Adicionar
        </button>
      </div>
      <p className="text-xs text-sand-400">
        Várias de uma vez? Separa com vírgulas ou quebras de linha.
      </p>
      {error && (
        <p className="text-xs text-curve-700" role="alert">
          {error}
        </p>
      )}
      {conflicts.length > 0 && (
        <div
          className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
          role="alert"
        >
          <p className="font-medium">
            {conflicts.length === 1
              ? 'Esta entidade já está atribuída a outra categoria:'
              : `${conflicts.length} entidades já estão atribuídas a outras categorias:`}
          </p>
          <ul className="mt-1 space-y-0.5">
            {conflicts.map((c) => (
              <li key={c.entity}>
                <strong>{c.entity}</strong> está em{' '}
                <em>{c.category_name}</em>
              </li>
            ))}
          </ul>
          <p className="mt-2">
            Remove-a de lá antes de a trazer para aqui — o catálogo não
            permite duplicados entre categorias.
          </p>
        </div>
      )}
    </form>
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

// Admin-only: create a new global catalogue category. Name is
// required; entities is an optional newline-separated list that lets
// the admin seed the category with a starter pattern set in a single
// click. An inline `<IconPickerGrid>` field lets the admin pick the
// category glyph up front — the parent drops the selection into a
// follow-up `PUT /api/category-icons/:id` after the POST succeeds,
// so both writes land together from the user's point of view.
// Leaving the picker untouched is fine: the renderer falls back to
// the Tag glyph until an admin later sets one via the detail
// header's "Ícone" button.
//
// Error handling is split between the dialog and the parent:
//   - `error` prop renders inline under the form (used for
//     `name_taken` and any other code that the server returns).
//   - Network / unexpected failures surface via the global toast
//     stack, handled by the parent's `handleCreateCategoryConfirm`.
//
// The controlled name / entitiesText / icon state resets when the
// dialog closes (via `open` prop falling to false) so reopening
// always lands on a fresh form instead of the last-submitted values.
function CreateCategoryDialog({ open, busy, error, onCancel, onConfirm }) {
  const [name, setName] = useState('');
  const [entitiesText, setEntitiesText] = useState('');
  // Icon picked in the inline grid. `null` means "don't write an
  // icon" — the parent skips the follow-up PUT and the renderer
  // falls back to the Tag default. Clicking the same tile twice
  // toggles back to null so the admin can "unpick" without
  // cancelling the whole dialog.
  const [iconName, setIconName] = useState(null);

  useEffect(() => {
    if (!open) {
      setName('');
      setEntitiesText('');
      setIconName(null);
    }
  }, [open]);

  if (!open) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;
    // Newline-separated list → string[]. Empty lines and whitespace-
    // only lines are dropped; the server normalises and dedupes
    // further via normaliseEntityInput() in routes/categories.js.
    const entities = entitiesText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    onConfirm({ name: trimmedName, entities, iconName });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-sand-950/30 p-4 animate-fade-in"
      role="dialog"
      aria-modal="true"
    >
      <form
        onSubmit={handleSubmit}
        className="card max-h-[90vh] w-full max-w-md overflow-y-auto"
      >
        <h2 className="text-lg font-semibold text-sand-900">
          Nova categoria
        </h2>
        <p className="mt-2 text-sm text-sand-600">
          Cria uma categoria no catálogo global. As entidades que
          indicares ficam disponíveis para todos os users.
        </p>
        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-sand-500">
              Nome
            </span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              required
              placeholder="Ex.: Transportes"
              className="input mt-1"
              disabled={busy}
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-sand-500">
              Entidades (opcional) — uma por linha
            </span>
            <textarea
              value={entitiesText}
              onChange={(e) => setEntitiesText(e.target.value)}
              rows={4}
              placeholder={'galp\nbp\nrepsol'}
              className="input mt-1 font-mono text-xs"
              disabled={busy}
            />
          </label>
          <div>
            <span className="text-xs font-medium uppercase tracking-wide text-sand-500">
              Ícone (opcional)
            </span>
            <div className="mt-2 rounded-xl border border-sand-200 bg-sand-50 p-3">
              {/* Click-to-toggle: picking the currently-selected tile
                  clears the selection so the admin can back out of a
                  mistaken pick without cancelling the whole dialog.
                  Leaving the field blank is a valid final state —
                  parent skips the follow-up PUT and the renderer falls
                  back to the Tag default. */}
              <IconPickerGrid
                value={iconName}
                onChange={(name) =>
                  setIconName((prev) => (prev === name ? null : name))
                }
                busy={busy}
              />
            </div>
          </div>
        </div>
        {error && (
          <p className="mt-3 text-sm text-curve-700" role="alert">
            {error}
          </p>
        )}
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
            type="submit"
            className="btn-primary"
            disabled={busy || !name.trim()}
          >
            {busy ? 'A criar…' : 'Criar categoria'}
          </button>
        </div>
      </form>
    </div>
  );
}

// Admin-only: delete a global catalogue category. Two visual modes:
//
//   1. Confirmation — `block` is null. The dialog asks "Apagar X?"
//      with a Cancelar / Apagar footer.
//   2. Blocked (409 category_in_use) — `block` carries
//      `{ expenses_count, overrides_count }` from the server's refusal
//      body. The dialog swaps to a read-only message listing the
//      reference counts and tells the admin to move rows manually
//      before retrying. The "mover tudo para ___" picker is
//      deliberately out of scope for the Fase 5 slice (Phase 7 or
//      later, docs/Categories.md §11.4 risk #3 — "Admin tem de
//      resolver antes").
//
// The parent toggles between modes by setting `deleteCategoryBlock`
// after a 409 response. Cancelling the dialog clears both `target`
// and `block` so reopening lands on the fresh confirmation mode.
function DeleteCategoryDialog({ target, block, busy, onCancel, onConfirm }) {
  if (!target) return null;
  const isBlocked = Boolean(block);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-sand-950/30 p-4 animate-fade-in"
      role="dialog"
      aria-modal="true"
    >
      <div className="card w-full max-w-md">
        <h2 className="text-lg font-semibold text-sand-900">
          {isBlocked
            ? `Não é possível apagar "${target.name}"`
            : `Apagar "${target.name}"?`}
        </h2>
        {isBlocked ? (
          <>
            <p className="mt-2 text-sm text-sand-600">
              Esta categoria ainda está a ser usada e não pode ser
              apagada do catálogo global.
            </p>
            <ul className="mt-3 space-y-1 text-sm text-sand-700">
              {block.expenses_count > 0 && (
                <li>
                  <strong>{block.expenses_count}</strong>{' '}
                  {block.expenses_count === 1
                    ? 'despesa aponta'
                    : 'despesas apontam'}{' '}
                  para esta categoria.
                </li>
              )}
              {block.overrides_count > 0 && (
                <li>
                  <strong>{block.overrides_count}</strong>{' '}
                  {block.overrides_count === 1
                    ? 'regra pessoal aponta'
                    : 'regras pessoais apontam'}{' '}
                  para esta categoria.
                </li>
              )}
            </ul>
            <p className="mt-4 text-xs text-sand-500">
              Move as despesas para outra categoria e apaga as regras
              pessoais antes de tentar de novo.
            </p>
            <div className="mt-6 flex justify-end">
              <button
                type="button"
                className="btn-primary"
                onClick={onCancel}
              >
                Fechar
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="mt-2 text-sm text-sand-600">
              A categoria <strong>{target.name}</strong> será removida
              do catálogo global. As entidades deixam de ser
              associadas automaticamente em sincronizações futuras.
            </p>
            <p className="mt-3 text-xs text-sand-500">
              A remoção não é retroactiva — despesas passadas mantêm a
              categoria actual.
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
                {busy ? 'A apagar…' : 'Apagar categoria'}
              </button>
            </div>
          </>
        )}
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
  // Admin entries (from batch-add on the global catalogue) don't have
  // a `pattern` — they carry `category_name` + `entities[]` instead.
  // The subtitle, hit-count copy and the Anular-regra escape hatch
  // all branch on `kind` so the two flows share this dialog without a
  // parallel component.
  const isAdmin = entry?.kind === 'admin';
  const skipped = preview.skipped_personal ?? 0;
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
            {isAdmin ? (
              <>Catálogo global · {entry.category_name}</>
            ) : (
              <>Regra "{entry.pattern}" → {entry.category_name}</>
            )}
          </p>
        )}
        <p className="mt-2 text-sm text-sand-600">
          Vão ser re-catalogadas <strong>{preview.matched}</strong>{' '}
          {preview.matched === 1 ? 'despesa' : 'despesas'}
          {isAdmin ? ' de todos os utilizadores' : ' tuas'}.
        </p>
        {isAdmin && skipped > 0 && (
          // "Personal is sacred" footnote — tells the admin that some
          // rows they might have expected to catch were already
          // claimed by an owner's personal override, and stay put.
          <p className="mt-2 text-xs text-sand-500">
            {skipped === 1
              ? '1 despesa fica como está — há uma regra pessoal a redireccioná-la.'
              : `${skipped} despesas ficam como estão — há regras pessoais a redireccioná-las.`}
          </p>
        )}
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
              the same. Only rendered for personal entries; admin
              batch-adds have no single-rule undo (the equivalent is
              the per-entity Apagar button in GlobalEntitiesList). */}
          {entry && !isAdmin && onCancelRule && (
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
  // ── Fase 5 admin state ──────────────────────────────────────────
  // Create-category dialog: `createDialogOpen` toggles visibility,
  // `createBusy` locks the form during the POST, `createError` is an
  // inline pt-PT message rendered under the form (used for known
  // server codes like `name_taken`). Non-admins never flip any of
  // these — the button that opens the dialog is admin-gated.
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState(null);
  // Inline header rename: a single busy flag is enough because the
  // input itself is uncontrolled (we read `nameInputRef.current.value`
  // at commit time). The input remounts when the detail section
  // re-keys on `selectedId`, so stale drafts cannot leak between
  // categories.
  const [renameBusy, setRenameBusy] = useState(false);
  const nameInputRef = useRef(null);
  // Delete-category dialog: `deleteCategoryTarget` holds
  // `{ id, name }` while the dialog is open; `deleteCategoryBlock`
  // is populated with `{ expenses_count, overrides_count }` when the
  // server answers 409 `category_in_use`, flipping the dialog into
  // its read-only "move rows first" mode. `deleteCategoryBusy` locks
  // the primary action while the DELETE round trip is in flight.
  const [deleteCategoryTarget, setDeleteCategoryTarget] = useState(null);
  const [deleteCategoryBlock, setDeleteCategoryBlock] = useState(null);
  const [deleteCategoryBusy, setDeleteCategoryBusy] = useState(false);
  // ── Icon state ─────────────────────────────────────────────────
  // `iconByCategory` is a `category_id -> icon_name` map populated
  // from `GET /api/category-icons` alongside the other page data.
  // Used in the master list rows (CategoryRow), the detail header,
  // and forwarded to the popover flow. Missing entries fall through
  // to <CategoryIcon>'s Tag fallback, so a 500 on this endpoint
  // only costs the custom glyphs — the page still renders.
  const [iconByCategory, setIconByCategory] = useState(() => new Map());
  // Admin-only detail-header picker. `open` toggles the
  // <IconPickerDialog>; `busy` locks both the dialog and the opener
  // button while a PUT/DELETE round-trips. The picker is controlled
  // — the current icon comes from `iconByCategory.get(selectedId)`
  // so parallel edits from another tab would be reflected on next
  // refresh without a stale draft.
  const [iconDialogOpen, setIconDialogOpen] = useState(false);
  const [iconBusy, setIconBusy] = useState(false);

  const refreshAll = async () => {
    setLoading(true);
    try {
      const [cats, statsC, statsP, ovs, ents, icons] = await Promise.all([
        api.getCategories({ withMatchCounts: true }),
        api.getCategoryStats({ cycle: 'current' }),
        api.getCategoryStats({ cycle: 'previous' }).catch(() => ({ data: { totals: [] } })),
        api.getCategoryOverrides(),
        // Autocomplete is a nice-to-have — a failure here must not
        // break the page, so swallow and fall back to an empty list
        // (which the form handles as "just a plain text input").
        api.autocomplete('entity').catch(() => ({ data: [] })),
        // Icons, same treatment — a 500 just leaves every row with
        // the Tag fallback glyph, no user-visible error.
        api.getCategoryIcons().catch(() => ({ data: [] })),
      ]);
      setCategories(cats.data ?? []);
      setStatsCurrent(statsC.data);
      setStatsPrevious(statsP.data ?? { totals: [] });
      setOverrides(ovs.data ?? []);
      setEntitySuggestions(ents.data ?? []);
      const iconEntries = (icons.data ?? []).map((row) => [
        String(row.category_id),
        row.icon_name,
      ]);
      setIconByCategory(new Map(iconEntries));
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
          // both and decides per-entry. `kind: 'personal'` is the
          // discriminator that tells the apply handlers to call
          // `applyCategoryOverride` (user-scoped), as opposed to the
          // `kind: 'admin'` sibling pushed by `handleAddGlobalEntities`
          // which goes through `applyCategoryToAll` (cross-user).
          setPendingApplies((prev) => [
            ...prev,
            {
              kind: 'personal',
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
            kind: 'personal',
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

  // ── Fase 5 admin handlers ──────────────────────────────────────
  //
  // Create a new global category. `entities` is an optional starter
  // list — when non-empty we drop the pending-apply banner for it in
  // the next commit (Commit 3 of the Fase 5 slice); for now a fresh
  // category with seed entities just lands silently and refreshes
  // the list. Known error codes translated to inline pt-PT:
  //   name_taken        — case-insensitive collision on `name`
  //   name_required     — UI normally blocks submit on empty names,
  //                       so this is defence-in-depth
  //   invalid_entities  — UI normally normalises, ditto
  const handleCreateCategoryConfirm = async ({ name, entities, iconName }) => {
    setCreateBusy(true);
    setCreateError(null);
    try {
      const res = await api.createCategory({
        name,
        entities: entities.length ? entities : undefined,
      });
      // Follow-up PUT to write the chosen icon — fire-and-forget from
      // the dialog's point of view. A failure here would leave the
      // category created without an icon (recoverable via the detail
      // header picker), so we log to the toast but still close the
      // dialog and keep the happy path visible. `refreshAll` below
      // will reconcile whatever landed on the server.
      if (iconName) {
        try {
          await api.setCategoryIcon(res.data._id.toString(), iconName);
        } catch (iconErr) {
          setToast({
            type: 'error',
            text:
              iconErr.message === 'invalid_icon_name'
                ? 'Ícone inválido — a categoria foi criada sem ícone.'
                : 'Categoria criada, mas falhou a guardar o ícone.',
          });
        }
      }
      await refreshAll();
      // Auto-select the newly created category so the admin lands
      // straight on its detail pane and can keep editing without
      // scrolling the master list.
      setSelectedId(res.data._id.toString());
      setCreateDialogOpen(false);
      // Only push the success toast if we didn't already push an
      // icon-write failure above. `setToast` is last-write-wins, so
      // an unconditional call here would swallow the icon error.
      setToast((prev) =>
        prev?.type === 'error'
          ? prev
          : { type: 'ok', text: `Categoria "${res.data.name}" criada.` },
      );
    } catch (err) {
      // Surface known error codes as human copy, unknown ones
      // verbatim. The inline message stays under the form so the
      // admin can edit and retry without closing the dialog.
      const code = err.message;
      if (code === 'name_taken') {
        setCreateError(`Já existe uma categoria com o nome "${name}".`);
      } else if (code === 'name_required') {
        setCreateError('O nome é obrigatório.');
      } else if (code === 'invalid_entities') {
        setCreateError('Uma ou mais entidades são inválidas.');
      } else {
        setCreateError(err.message ?? 'Erro a criar categoria.');
      }
    } finally {
      setCreateBusy(false);
    }
  };

  // Inline rename commit. Triggered by blur or Enter on the detail
  // header input; Esc restores the old name before firing blur, so
  // this is a no-op in the "discarded" case (newName === old).
  //
  // The input is uncontrolled — we read `nameInputRef.current.value`
  // instead of threading a controlled `renameDraft` through the
  // parent. Simpler, and the detail section's `key={selectedId}`
  // already takes care of resetting to the canonical form on
  // category switches (React remounts the whole subtree).
  //
  // On failure we reset the input back to the current name so the
  // visual state doesn't look like the rename succeeded. The toast
  // carries the error code; `name_taken` and `name_required` are
  // translated to pt-PT the same way the create dialog does.
  const handleRenameCategory = async () => {
    const input = nameInputRef.current;
    if (!input || !selectedRow?.category_id) return;
    const newName = input.value.trim();
    if (!newName || newName === selectedRow.category_name) {
      // Blank or unchanged — restore the canonical form so the
      // input doesn't keep an empty/whitespace value.
      input.value = selectedRow.category_name;
      return;
    }
    setRenameBusy(true);
    try {
      await api.updateCategory(selectedRow.category_id, { name: newName });
      await refreshAll();
      setToast({
        type: 'ok',
        text: `Categoria renomeada para "${newName}".`,
      });
    } catch (err) {
      input.value = selectedRow.category_name;
      const code = err.message;
      const msg =
        code === 'name_taken'
          ? `Já existe uma categoria com o nome "${newName}".`
          : code === 'name_required'
            ? 'O nome é obrigatório.'
            : err.message ?? 'Erro a renomear categoria.';
      setToast({ type: 'error', text: msg });
    } finally {
      setRenameBusy(false);
    }
  };

  // Open the delete-category dialog for the currently-selected row.
  // Guarded on admin + real category_id (not the synthetic "Sem
  // categoria" bucket). The actual DELETE happens in
  // `handleDeleteCategoryConfirm`; this two-step split mirrors the
  // override / entity delete flow so the dialog can surface the 409
  // `category_in_use` path without racing the click.
  const handleRequestDeleteCategory = () => {
    if (!isAdmin || !selectedRow?.category_id) return;
    setDeleteCategoryBlock(null);
    setDeleteCategoryTarget({
      id: selectedRow.category_id,
      name: selectedRow.category_name,
    });
  };

  // Commit the category delete. The 409 path populates
  // `deleteCategoryBlock` which re-renders the dialog in its
  // blocked/read-only mode (counts + "move rows first" copy). Every
  // other error lands as a toast and closes the dialog. The
  // success path refreshes the whole page and defaults the
  // selection back to whatever `rows[0]` is — the auto-select
  // effect (L1047-1051 area) handles this because `selectedId`
  // becomes stale after refreshAll removes the deleted category
  // from the cached list.
  const handleDeleteCategoryConfirm = async () => {
    if (!deleteCategoryTarget) return;
    const { id, name } = deleteCategoryTarget;
    setDeleteCategoryBusy(true);
    try {
      await api.deleteCategory(id);
      await refreshAll();
      // Reset selection so the auto-select effect picks the heaviest
      // remaining row. Setting to null triggers the effect branch
      // that picks `rows[0]` on the next render.
      setSelectedId(null);
      setDeleteCategoryTarget(null);
      setDeleteCategoryBlock(null);
      setToast({ type: 'ok', text: `Categoria "${name}" apagada.` });
    } catch (err) {
      if (err.message === 'category_in_use' && err.body) {
        // Flip the dialog into blocked mode. The admin reads the
        // counts and clicks Fechar — no retry path from this state,
        // they have to move the referencing rows first.
        setDeleteCategoryBlock({
          expenses_count: err.body.expenses_count ?? 0,
          overrides_count: err.body.overrides_count ?? 0,
        });
      } else {
        setToast({
          type: 'error',
          text: err.message ?? 'Erro a apagar categoria.',
        });
        setDeleteCategoryTarget(null);
      }
    } finally {
      setDeleteCategoryBusy(false);
    }
  };

  const handleCloseDeleteCategoryDialog = () => {
    if (deleteCategoryBusy) return;
    setDeleteCategoryTarget(null);
    setDeleteCategoryBlock(null);
  };

  // Admin-only: set the icon for the currently-selected category.
  // Optimistic — the new value lands in `iconByCategory` immediately
  // so the list row + detail header repaint before the PUT settles.
  // Snapshot + rollback on failure keeps the UI honest when the
  // server refuses (403 for regular users, 400 `invalid_icon_name`
  // for a whitelist drift, 404 if the category vanished between
  // open and click).
  //
  // Same-name re-pick is a no-op (server-side §13.4 also suppresses
  // the audit row) — we still short-circuit the request here to save
  // a round-trip and spare the detail header a flicker.
  const handlePickIcon = async (iconName) => {
    if (!isAdmin || !selectedRow?.category_id || !iconName) return;
    const categoryId = selectedRow.category_id;
    const previous = iconByCategory.get(categoryId) ?? null;
    if (previous === iconName) {
      setIconDialogOpen(false);
      return;
    }
    setIconBusy(true);
    // Optimistic write to the local map — new Map() to keep React
    // reference-equality happy.
    setIconByCategory((prev) => {
      const next = new Map(prev);
      next.set(categoryId, iconName);
      return next;
    });
    try {
      await api.setCategoryIcon(categoryId, iconName);
      setIconDialogOpen(false);
      setToast({ type: 'ok', text: 'Ícone actualizado.' });
    } catch (err) {
      // Rollback. `previous === null` means "no entry existed" — we
      // delete the key so the UI is indistinguishable from pre-click.
      setIconByCategory((prev) => {
        const next = new Map(prev);
        if (previous === null) next.delete(categoryId);
        else next.set(categoryId, previous);
        return next;
      });
      const msg =
        err.message === 'invalid_icon_name'
          ? 'Ícone inválido.'
          : err.message === 'admin_required'
            ? 'Apenas admins podem alterar ícones.'
            : err.message ?? 'Erro a guardar ícone.';
      setToast({ type: 'error', text: msg });
    } finally {
      setIconBusy(false);
    }
  };

  // Admin-only: clear the currently-selected category's icon. Same
  // optimistic + rollback shape as `handlePickIcon`. Idempotent on
  // the server — clearing an already-empty row just returns 204,
  // but we short-circuit before the request for consistency with
  // the same-name guard above.
  const handleClearIcon = async () => {
    if (!isAdmin || !selectedRow?.category_id) return;
    const categoryId = selectedRow.category_id;
    const previous = iconByCategory.get(categoryId) ?? null;
    if (previous === null) {
      setIconDialogOpen(false);
      return;
    }
    setIconBusy(true);
    setIconByCategory((prev) => {
      const next = new Map(prev);
      next.delete(categoryId);
      return next;
    });
    try {
      await api.clearCategoryIcon(categoryId);
      setIconDialogOpen(false);
      setToast({ type: 'ok', text: 'Ícone removido.' });
    } catch (err) {
      setIconByCategory((prev) => {
        const next = new Map(prev);
        next.set(categoryId, previous);
        return next;
      });
      const msg =
        err.message === 'admin_required'
          ? 'Apenas admins podem alterar ícones.'
          : err.message ?? 'Erro a remover ícone.';
      setToast({ type: 'error', text: msg });
    } finally {
      setIconBusy(false);
    }
  };

  // Admin batch-add of global entities. Called from
  // AddGlobalEntitiesForm with the parsed string[] — conflicts are
  // re-thrown verbatim so the form can render `err.body.conflicts`
  // inline (see the form component above for the translation logic).
  //
  // Success path has two side effects:
  //   1. Refresh the categories list so the new entities show up in
  //      GlobalEntitiesList below the form (and their per-entity
  //      match counts come back from the server).
  //   2. Dry-run apply-to-all immediately so we can push an admin-
  //      kind pending-apply banner when the added entities would
  //      catch historical expenses across users. The banner mirrors
  //      the personal variant's shape, keyed off `kind: 'admin'` so
  //      `handleApplyPreview` / `handleApplyConfirm` know to route
  //      through `applyCategoryToAll` instead of the per-override
  //      endpoint. No "Anular regra" escape hatch in the admin
  //      banner — undo for the batch lives in the per-entity
  //      `Apagar` button of GlobalEntitiesList (§11.4, agreed in the
  //      Phase 5 design chat).
  //
  // Re-throws EVERY error so the form's catch can decide which codes
  // render inline (entity_conflict, invalid_entities) vs which land
  // in the toast stack via a parent-level catch. The toast here is
  // success-only.
  const handleAddGlobalEntities = async (entities) => {
    if (!selectedRow?.category_id) return;
    const { category_id: categoryId, category_name: categoryName } =
      selectedRow;
    setGlobalEntityBusy(true);
    try {
      const res = await api.addCategoryEntities(categoryId, entities);
      // Patch the local categories cache in place so the new entries
      // show up under GlobalEntitiesList without waiting for a full
      // refresh. The server returns the canonical post-add document,
      // so we just replace the whole record for this category.
      setCategories((prev) =>
        prev.map((c) =>
          c._id.toString() === categoryId
            ? { ...c, entities: res.data.entities ?? c.entities }
            : c,
        ),
      );
      setToast({
        type: 'ok',
        text:
          entities.length === 1
            ? `Entidade "${entities[0]}" adicionada.`
            : `${entities.length} entidades adicionadas.`,
      });

      // Dry-run apply-to-all so the banner only appears when there's
      // something to actually apply. `matched === 0` is the common
      // "brand new category, no historical expenses yet" case — the
      // banner would be a dead click in that state. Same degradation
      // strategy as the personal variant: if the preview fails, push
      // the banner anyway with `matched: null` so the admin can
      // still try Aplicar on the real path.
      try {
        const preview = await api.applyCategoryToAll(categoryId, {
          dryRun: true,
        });
        const matched = preview.data?.matched ?? 0;
        if (matched > 0) {
          setPendingApplies((prev) => [
            ...prev,
            {
              kind: 'admin',
              id: `admin:${categoryId}:${Date.now()}`,
              category_id: categoryId,
              category_name: categoryName,
              entities,
              matched,
            },
          ]);
        }
      } catch {
        setPendingApplies((prev) => [
          ...prev,
          {
            kind: 'admin',
            id: `admin:${categoryId}:${Date.now()}`,
            category_id: categoryId,
            category_name: categoryName,
            entities,
            matched: null,
          },
        ]);
      }
    } finally {
      setGlobalEntityBusy(false);
    }
  };

  // Clicking "Aplicar" on a banner opens the preview dialog for
  // *that* specific entry. `entry` is the pendingApplies row —
  // passing it in (instead of reading from a "current" ref)
  // makes every call site explicit about which rule it's acting
  // on, which is the whole point of this refactor.
  //
  // Branches on `entry.kind`:
  //   - `'personal'` → `applyCategoryOverride(entry.id)` (user-scoped,
  //     returns preview w/ matched + samples)
  //   - `'admin'`    → `applyCategoryToAll(entry.category_id)`
  //     (cross-user, returns matched + skipped_personal; no samples
  //     field, which the ApplyConfirmDialog already guards for with
  //     `preview.samples?.length > 0`).
  const handleApplyPreview = async (entry) => {
    if (!entry) return;
    setApplyBusy(true);
    try {
      const res =
        entry.kind === 'admin'
          ? await api.applyCategoryToAll(entry.category_id, {
              dryRun: true,
            })
          : await api.applyCategoryOverride(entry.id, {
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
  // appended to `pendingApplies`. Same `kind`-branch as the preview.
  const handleApplyConfirm = async () => {
    const entry = applyPreview?.entry;
    if (!entry) return;
    setApplyBusy(true);
    try {
      const res =
        entry.kind === 'admin'
          ? await api.applyCategoryToAll(entry.category_id, {
              dryRun: false,
            })
          : await api.applyCategoryOverride(entry.id, {
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
          description={
            isAdmin
              ? 'Cria a primeira categoria para começar.'
              : 'Contacta o administrador para criar o primeiro conjunto.'
          }
        >
          {isAdmin && (
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setCreateError(null);
                setCreateDialogOpen(true);
              }}
            >
              + Criar categoria
            </button>
          )}
        </EmptyState>
        <CreateCategoryDialog
          open={createDialogOpen}
          busy={createBusy}
          error={createError}
          onCancel={() => {
            if (createBusy) return;
            setCreateDialogOpen(false);
            setCreateError(null);
          }}
          onConfirm={handleCreateCategoryConfirm}
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
          <header className="flex items-center justify-between gap-2 border-b border-sand-100 px-4 py-3">
            <span className="text-xs font-medium uppercase tracking-wide text-sand-400">
              Categorias
            </span>
            <div className="flex items-center gap-3">
              <span className="text-xs text-sand-500">
                {formatEUR(grandTotal)}
              </span>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => {
                    setCreateError(null);
                    setCreateDialogOpen(true);
                  }}
                  className="inline-flex items-center gap-1 rounded-lg bg-curve-50 px-2 py-1 text-xs font-medium text-curve-700 hover:bg-curve-100"
                  title="Criar nova categoria"
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                  Categoria
                </button>
              )}
            </div>
          </header>
          <div className="max-h-[70vh] overflow-y-auto">
            {rows.map((row, i) => (
              <CategoryRow
                key={row.category_id ?? '__null__'}
                row={row}
                index={i}
                selected={(row.category_id ?? '__null__') === selectedId}
                iconName={
                  row.category_id
                    ? iconByCategory.get(row.category_id) ?? null
                    : null
                }
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
                {/* Larger icon pedestal in the detail header — 28px
                    tile so the glyph is the dominant visual instead
                    of the old 12px colour dot. The uncategorised
                    bucket (no category_id) still uses the plain dot
                    so the synthetic row doesn't pretend to have an
                    icon. */}
                {selectedRow.category_id ? (
                  <span
                    className="flex h-7 w-7 flex-none items-center justify-center rounded-xl text-white"
                    style={{
                      backgroundColor: swatchColor(selectedRow.category_id),
                    }}
                  >
                    <CategoryIcon
                      name={
                        iconByCategory.get(selectedRow.category_id) ?? null
                      }
                      className="h-4 w-4"
                    />
                  </span>
                ) : (
                  <span
                    className="h-3 w-3 rounded-full"
                    style={{ backgroundColor: swatchColor(selectedRow.category_id) }}
                  />
                )}
                {isAdmin && selectedRow.category_id ? (
                  // Uncontrolled — the ref reads the canonical value at
                  // commit time and the `<section key={selectedId}>`
                  // wrapper remounts the whole subtree on category
                  // switches, so a stale draft can't leak across rows.
                  // Enter commits via blur; Escape restores the
                  // original name and blurs.
                  <input
                    ref={nameInputRef}
                    defaultValue={selectedRow.category_name}
                    onBlur={handleRenameCategory}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        e.currentTarget.blur();
                      } else if (e.key === 'Escape') {
                        e.currentTarget.value = selectedRow.category_name;
                        e.currentTarget.blur();
                      }
                    }}
                    disabled={renameBusy}
                    aria-label="Nome da categoria"
                    className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-xl font-semibold text-sand-900 hover:border-sand-200 focus:border-curve-300 focus:bg-white focus:outline-none"
                  />
                ) : (
                  <h2 className="text-xl font-semibold text-sand-900">
                    {selectedRow.category_name}
                  </h2>
                )}
                <DeltaBadge delta={selectedRow.delta} />
                {isAdmin && selectedRow.category_id && (
                  <>
                    <button
                      type="button"
                      onClick={() => setIconDialogOpen(true)}
                      disabled={iconBusy}
                      className="rounded-lg px-2 py-1 text-xs font-medium text-sand-500 hover:bg-sand-100 hover:text-curve-700"
                      title="Escolher ícone para esta categoria"
                    >
                      Ícone
                    </button>
                    <button
                      type="button"
                      onClick={handleRequestDeleteCategory}
                      disabled={renameBusy || deleteCategoryBusy}
                      className="rounded-lg px-2 py-1 text-xs font-medium text-sand-500 hover:bg-sand-100 hover:text-curve-700"
                      title="Apagar esta categoria do catálogo global"
                    >
                      Apagar
                    </button>
                  </>
                )}
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
                  user knows exactly what Aplicar/Ignorar will touch.
                  `entry.kind` discriminates personal (per-override)
                  from admin (cross-user global-entity add) — the
                  copy, the "Anular regra" escape hatch, and the
                  underlying apply endpoint all branch on it. */}
              {pendingApplies.length > 0 && (
                <div className="space-y-2">
                  {pendingApplies.map((entry) => {
                    const isAdminEntry = entry.kind === 'admin';
                    return (
                    <div
                      key={entry.id}
                      className="flex items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 animate-fade-in"
                    >
                      <span className="min-w-0">
                        {isAdminEntry ? (
                          <>
                            Entidades adicionadas a{' '}
                            <strong>{entry.category_name}</strong>
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
                            . Aplicar a todos os utilizadores?
                          </>
                        ) : (
                          <>
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
                          </>
                        )}
                      </span>
                      <div className="flex shrink-0 gap-2">
                        {/* "Anular regra" is personal-only — admin
                            batch-adds have no single-rule undo, the
                            per-entity `Apagar` button in
                            GlobalEntitiesList takes that role. Styled
                            red-ish to telegraph that it's not the
                            same as Ignorar. */}
                        {!isAdminEntry && (
                          <button
                            type="button"
                            className="rounded-lg px-3 py-1.5 text-xs font-medium text-curve-700 hover:bg-curve-50 disabled:opacity-50"
                            onClick={() => handleCancelPendingRule(entry)}
                            disabled={applyBusy || overrideBusy}
                            title="Apagar esta regra — útil se foi criada por engano"
                          >
                            Anular regra
                          </button>
                        )}
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
                  );
                  })}
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

                  {/* Catálogo global — read-only for users; admins
                      get the batch-add form above the list so they
                      can extend the catalogue without opening a
                      separate modal. Uses the same apply-to-all
                      banner stack as the personal override path,
                      but via `kind: 'admin'` entries that route
                      through `applyCategoryToAll`. */}
                  {selectedRow.category_id && (
                    <section className="space-y-3">
                      <h3 className="text-xs font-medium uppercase tracking-wide text-sand-400">
                        Catálogo global
                      </h3>
                      {isAdmin && (
                        <AddGlobalEntitiesForm
                          categoryId={selectedRow.category_id}
                          categoryName={selectedRow.category_name}
                          onSubmit={handleAddGlobalEntities}
                          busy={globalEntityBusy}
                        />
                      )}
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

      <CreateCategoryDialog
        open={createDialogOpen}
        busy={createBusy}
        error={createError}
        onCancel={() => {
          if (createBusy) return;
          setCreateDialogOpen(false);
          setCreateError(null);
        }}
        onConfirm={handleCreateCategoryConfirm}
      />

      <DeleteCategoryDialog
        target={deleteCategoryTarget}
        block={deleteCategoryBlock}
        busy={deleteCategoryBusy}
        onCancel={handleCloseDeleteCategoryDialog}
        onConfirm={handleDeleteCategoryConfirm}
      />

      {/* Admin icon picker — only mounted while open so the Escape /
          click-outside listeners aren't armed on every /categories
          visit. Wired to the currently-selected category id; guards
          on `isAdmin` + real category_id (not the synthetic "Sem
          categoria" bucket) are duplicated in handlePickIcon /
          handleClearIcon so the handlers are safe even if the gate
          changes. */}
      {iconDialogOpen && isAdmin && selectedRow?.category_id && (
        <IconPickerDialog
          value={iconByCategory.get(selectedRow.category_id) ?? null}
          onSelect={handlePickIcon}
          onClear={handleClearIcon}
          onCancel={() => {
            if (iconBusy) return;
            setIconDialogOpen(false);
          }}
          busy={iconBusy}
        />
      )}
    </div>
  );
}
