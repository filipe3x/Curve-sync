import { useEffect, useMemo, useRef, useState } from 'react';
import { MagnifyingGlassIcon } from '../layout/Icons';

/**
 * <CategoryPickerPopover>
 *
 * Single-expense quick-edit popover (docs/Categories.md §12.2-§12.4).
 *
 * Trigger: click on a category chip in the /expenses or / table.
 * Action:  reassigns a single expense to a different category via
 *          PUT /api/expenses/:id/category. No entity-wide checkbox
 *          in this PR — the opt-in path of §12.5 lands with the
 *          override/apply-to-all phase.
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
 *   - Clicking the current category is a no-op (no wasted round-trip).
 *
 * Props:
 *   @param {Object} expense
 *     The expense whose chip was clicked. Needs `_id`, `entity`, and
 *     optionally `category_id` + `category_name` for the current
 *     highlight.
 *   @param {Array}  categories
 *     Pre-loaded category catalogue. The parent page calls
 *     `api.getCategories()` once on mount and passes the list in —
 *     avoids a round-trip per click.
 *   @param {Function} onSelect(categoryId | null)
 *     Called immediately when the user clicks any tile other than the
 *     currently-selected one. The parent handles the PUT, optimistic
 *     update and rollback.
 *   @param {Function} onCancel()
 *     Called on Escape, click-outside, or the × button.
 *   @param {boolean} [saving]
 *     Parent-controlled busy state. The popover disables every tile
 *     and shows an inline "A guardar…" indicator while truthy.
 */
export default function CategoryPickerPopover({
  expense,
  categories,
  onSelect,
  onCancel,
  saving = false,
}) {
  const panelRef = useRef(null);
  const searchRef = useRef(null);
  const [query, setQuery] = useState('');

  const currentId = expense?.category_id ? String(expense.category_id) : null;

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
  // in flight, and (b) clicking the current selection, which would
  // fire a pointless no-op write.
  const handlePick = (id) => {
    if (saving) return;
    if (id === currentId) return;
    onSelect?.(id);
  };

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Alterar categoria"
      className="absolute right-0 top-full z-30 mt-2 w-80 rounded-2xl border border-sand-200 bg-white p-4 shadow-lg animate-fade-in"
      // Keep clicks inside the popover from bubbling up to the table
      // row — the row's hover state should not flicker while the user
      // navigates inside the picker.
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-sand-900">
          Alterar categoria
        </h3>
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
                  className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold uppercase ${
                    isCurrent
                      ? 'bg-curve-500 text-white'
                      : 'bg-sand-200 text-sand-700'
                  }`}
                  aria-hidden
                >
                  {cat.name.slice(0, 1)}
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
