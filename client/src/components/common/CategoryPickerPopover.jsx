import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarOff, CalendarCheck } from 'lucide-react';
import { MagnifyingGlassIcon } from '../layout/Icons';
import { CategoryIcon } from './CategoryIcon';

/**
 * <CategoryPickerPopover>
 *
 * Single-expense quick-edit popover (docs/Categories.md §12.2-§12.4)
 * AND bulk-move popover (docs/Categories.md §12.x — batch-move) for
 * the /expenses multi-select flow.
 *
 * Trigger (single): click on a category chip in the /expenses or /
 *   table.
 * Trigger (bulk):   click on "Mover para…" in the sticky action bar
 *   that appears when ≥1 row is selected on /expenses.
 *
 * Action (single): reassigns one expense via
 *   PUT /api/expenses/:id/category.
 * Action (bulk):   reassigns up to 500 expenses via
 *   PUT /api/expenses/bulk-category.
 *
 * The popover itself doesn't know which endpoint will be hit — it
 * just calls `onSelect(categoryId | null)` and the parent does the
 * right request. The only thing that changes between the two modes
 * is the header label and the "current" highlight:
 *
 *   - Single mode (`expense` prop present): title reads "Alterar
 *     categoria" and the current category is highlighted. Clicking
 *     it is a no-op.
 *   - Bulk mode (`context={ kind: 'bulk', count: N }`): title reads
 *     "Mover N despesas para…" and no tile is highlighted because the
 *     selection is typically a mix of categories. Every click fires
 *     a write — including clicking a category that some of the
 *     selected rows already have (the server's `skipped` field keeps
 *     the toast honest).
 *
 * Interaction model — click-to-save:
 *   A single click on any category tile (or the "Sem categoria" row)
 *   immediately calls `onSelect` so the parent can fire the PUT. The
 *   old Cancelar/Guardar footer was removed because the two-step flow
 *   turned a tiny interaction into four deliberate actions (open →
 *   search → pick → confirm). With click-to-save the parent still
 *   controls optimistic update + toast + rollback on failure, and the
 *   popover disables all tiles while `saving` is truthy so a slow
 *   network can't accidentally fire a second write.
 *
 * Focus + dismissal:
 *   - Mount focuses the search input.
 *   - `Escape` or click outside calls `onCancel`.
 *   - In single mode, clicking the current category is a no-op.
 *
 * Props:
 *   @param {Object} [expense]
 *     Single mode only. The expense whose chip was clicked. Needs
 *     `_id`, `entity`, and optionally `category_id` + `category_name`
 *     for the current highlight.
 *   @param {Object} [context]
 *     Bulk mode only. `{ kind: 'bulk', count: Number }`. When set,
 *     `expense` is ignored (and typically omitted by the caller).
 *   @param {Array}  categories
 *     Pre-loaded category catalogue. The parent page calls
 *     `api.getCategories()` once on mount and passes the list in —
 *     avoids a round-trip per click.
 *   @param {Function} onSelect(categoryId | null)
 *     Called immediately when the user clicks any tile other than the
 *     currently-selected one (single mode) or any tile at all (bulk
 *     mode). The parent handles the PUT, optimistic update and
 *     rollback.
 *   @param {Function} onCancel()
 *     Called on Escape, click-outside, or the × button.
 *   @param {boolean} [saving]
 *     Parent-controlled busy state. The popover disables every tile
 *     and shows an inline "A guardar…" indicator while truthy.
 *   @param {Map<string,string>} [iconByCategory]
 *     Optional map `category_id -> icon_name` so each tile renders a
 *     Lucide glyph instead of the first-letter fallback circle. Missing
 *     entries (or missing map entirely) fall through to the fallback
 *     `<CategoryIcon>` behaviour (Tag glyph), so callers that haven't
 *     loaded icons yet still render cleanly. The map is pulled from
 *     `GET /api/category-icons` by the parent page (ExpensesPage /
 *     DashboardPage) and passed in to avoid a per-popover round-trip.
 *   @param {Function} [onToggleCycle]
 *     Single-mode only. When provided, renders a mini toggle button to
 *     the left of the × close in the header (ROADMAP §2.10.1). The
 *     button is symmetric:
 *       - `excluded === false` → curve-red `CalendarOff`, tooltip
 *         «Remover do ciclo — não conta para Savings Score (reversível)»
 *       - `excluded === true`  → emerald `CalendarCheck`, tooltip
 *         «Incluir no ciclo — volta a contar para Savings Score»
 *     Click fires `onToggleCycle()`; the parent inspects the current
 *     `excluded` flag and calls either `api.excludeExpenses` or
 *     `api.includeExpenses`, then surfaces `<ExclusionUndoBanner>`.
 *     Hidden in bulk mode (the action bar already has the bulk toggle).
 *   @param {boolean} [excluded]
 *     Mirror of `expense.excluded`. Flips the toggle's icon, colour
 *     and tooltip so the popover never advertises a no-op.
 */
export default function CategoryPickerPopover({
  expense,
  context,
  categories,
  onSelect,
  onCancel,
  saving = false,
  iconByCategory = null,
  onToggleCycle = null,
  excluded = false,
}) {
  const panelRef = useRef(null);
  const searchRef = useRef(null);
  const [query, setQuery] = useState('');

  const isBulk = context?.kind === 'bulk';
  // Bulk selection spans multiple expenses, typically with mixed
  // categories — a single-category highlight would be misleading, so
  // we simply don't highlight anything in bulk mode.
  const currentId = isBulk
    ? null
    : expense?.category_id
      ? String(expense.category_id)
      : null;
  const title = isBulk
    ? `Mover ${context.count} ${context.count === 1 ? 'despesa' : 'despesas'} para…`
    : 'Alterar categoria';

  // Focus the search box on mount — users landing in the popover via a
  // click expect to type-to-filter immediately. Restore focus to the
  // opener on dismiss is handled by the parent via <button> focus
  // inheritance (the popover lives inside the same cell, so
  // `document.activeElement` naturally returns to the chip button).
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Dismiss on Escape + click outside. Both paths call onCancel so the
  // parent can close the popover uniformly.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel?.();
      }
    };
    const onPointerDown = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        onCancel?.();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    // `mousedown` fires before any click handlers inside the popover,
    // which is what we want: clicking a chip inside the panel should
    // not count as "click outside".
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [onCancel]);

  // Client-side filter. The catalogue is tiny (§5.5 assumes ≤30
  // globals), so a simple includes() beats any fancy matcher.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter((c) => c.name.toLowerCase().includes(q));
  }, [categories, query]);

  // Click-to-save entry point used by every tile + the "Sem categoria"
  // row. Guards against: (a) parent-declared busy state while a PUT is
  // in flight, and (b) clicking the current selection in single mode
  // (a pointless no-op write). In bulk mode the current-click guard
  // is dropped because there is no single "current" — the server will
  // honestly report `skipped` for any selected rows that were already
  // in the target category.
  const handlePick = (id) => {
    if (saving) return;
    if (!isBulk && id === currentId) return;
    onSelect?.(id);
  };

  // ROADMAP §2.10.1 — liquid-glass skin when the anchor expense is
  // already excluded. Calibrated so you can READ through the glass:
  //   • Gradient bg with ~40-55 % opacity so the table rows behind
  //     (entity, amount, date) remain legible through the panel.
  //   • `backdrop-blur-md` (12 px) — enough to soften the text
  //     behind without dissolving it; stronger blurs hid content
  //     entirely and sacrificed the whole point of letting you
  //     peek back to what you're looking at.
  //   • `backdrop-saturate-150` — bumps colours that DO come through
  //     so the glass reads as "optical" rather than a faded wash.
  //   • `border-white/40` + `ring-1 ring-inset ring-white/30` form
  //     a frosted edge; the inset ring acts as a soft specular
  //     highlight on the inside lip of the pane.
  //   • Warm curve-tinted drop shadow keeps the excluded popover
  //     feeling a touch hotter than its neutral sibling.
  // All inner controls (search, chip tiles, Sem categoria) keep
  // their own solid backgrounds so readability inside never competes
  // with the translucency outside.
  const glassClass = excluded
    ? 'bg-gradient-to-br from-white/55 via-white/45 to-curve-50/40 backdrop-blur-md backdrop-saturate-150 border-white/40 ring-1 ring-inset ring-white/30 shadow-[0_20px_40px_-12px_rgba(212,99,63,0.20)]'
    : 'bg-white border-sand-200 shadow-lg';
  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Alterar categoria"
      className={`absolute right-0 top-full z-30 mt-2 w-80 rounded-2xl border p-4 animate-fade-in ${glassClass}`}
      // Keep clicks inside the popover from bubbling up to the table
      // row — the row's hover state should not flicker while the user
      // navigates inside the picker.
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-sand-900">
          {title}
        </h3>
        <div className="flex items-center gap-1">
          {/* ROADMAP §2.10.1 — symmetric cycle toggle. One button,
              two faces: curve-red CalendarOff for "remover", emerald
              CalendarCheck for "incluir". The parent owns which API
              to call (POST vs DELETE /exclusions) based on the same
              `excluded` flag we use here to pick the icon. Kept
              distinct from the × close (icon + colour) so it never
              reads as a second dismiss. Hidden in bulk mode — the
              /expenses action bar already has the multi-select
              equivalent. */}
          {onToggleCycle && !isBulk && (
            <button
              type="button"
              aria-label={excluded ? 'Incluir no ciclo' : 'Remover do ciclo'}
              title={
                excluded
                  ? 'Incluir no ciclo — volta a contar para Savings Score'
                  : 'Remover do ciclo — não conta para Savings Score (reversível)'
              }
              onClick={() => {
                if (saving) return;
                onToggleCycle();
              }}
              disabled={saving}
              className={`rounded-full p-1 transition-colors disabled:opacity-40 ${
                excluded
                  ? 'text-emerald-500 hover:bg-emerald-50 hover:text-emerald-700'
                  : 'text-curve-500 hover:bg-curve-50 hover:text-curve-700'
              }`}
            >
              {excluded ? (
                <CalendarCheck className="h-4 w-4" strokeWidth={2} />
              ) : (
                <CalendarOff className="h-4 w-4" strokeWidth={2} />
              )}
            </button>
          )}
          <button
            type="button"
            aria-label="Fechar"
            onClick={onCancel}
            disabled={saving}
            className="rounded-full p-1 text-sand-400 transition-colors hover:bg-sand-100 hover:text-sand-700 disabled:opacity-40"
          >
            {/* inline × — lighter than pulling heroicons for one glyph */}
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18 18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="relative mb-3">
        <MagnifyingGlassIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sand-400" />
        <input
          ref={searchRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Procurar…"
          className="input pl-10 text-sm"
          disabled={saving}
        />
      </div>

      {/* Chip grid */}
      {categories.length === 0 ? (
        <p className="py-6 text-center text-xs text-sand-400">
          Sem categorias — pede ao admin para criar.
        </p>
      ) : filtered.length === 0 ? (
        <p className="py-6 text-center text-xs text-sand-400">
          Nenhuma categoria corresponde a "{query}".
        </p>
      ) : (
        <div className="grid max-h-64 grid-cols-3 gap-2 overflow-y-auto pb-1">
          {filtered.map((cat, i) => {
            const id = String(cat._id);
            const isCurrent = currentId === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => handlePick(id)}
                disabled={saving}
                className={`flex aspect-square flex-col items-center justify-center gap-1 rounded-xl border p-2 text-center transition-all duration-150 active:scale-[0.97] animate-fade-in disabled:cursor-not-allowed disabled:opacity-50 ${
                  isCurrent
                    ? 'border-curve-400 bg-curve-50 ring-2 ring-curve-500'
                    : 'border-sand-200 bg-sand-50 hover:bg-sand-100'
                }`}
                style={{ animationDelay: `${i * 30}ms` }}
              >
                <span
                  className={`flex h-7 w-7 items-center justify-center rounded-full ${
                    isCurrent
                      ? 'bg-curve-500 text-white'
                      : 'bg-sand-200 text-sand-700'
                  }`}
                  aria-hidden
                >
                  <CategoryIcon
                    name={iconByCategory?.get(id) ?? null}
                    className="h-4 w-4"
                  />
                </span>
                <span className="line-clamp-2 text-[11px] font-medium leading-tight text-sand-900">
                  {cat.name}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* "Sem categoria" row — matches the §12.9 uncategorised path.
          Offered as an explicit action because the grid itself cannot
          represent "nothing". */}
      {categories.length > 0 && (
        <button
          type="button"
          onClick={() => handlePick(null)}
          disabled={saving}
          className={`mt-2 w-full rounded-lg border px-3 py-2 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            currentId === null
              ? 'border-curve-400 bg-curve-50 text-curve-800 ring-1 ring-curve-500'
              : 'border-sand-200 bg-white text-sand-500 hover:bg-sand-50'
          }`}
        >
          Sem categoria
        </button>
      )}

      {/* Busy indicator — replaces the old footer Guardar spinner. */}
      {saving && (
        <div className="mt-3 flex items-center justify-center gap-2 text-xs text-sand-500">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-sand-300 border-t-sand-600" />
          A guardar…
        </div>
      )}
    </div>
  );
}
