import { useEffect, useRef } from 'react';
import { ICON_CATALOGUE, CategoryIcon } from './CategoryIcon';

/**
 * <IconPickerGrid>
 *
 * Pure inline grid of all whitelisted Lucide icons, grouped by theme
 * (`ICON_CATALOGUE` in `CategoryIcon.jsx`). No modal chrome —
 * designed to drop straight into whatever container the caller
 * provides (the CreateCategoryDialog embeds it as a field; the
 * CategoriesPage detail header wraps it in `<IconPickerDialog>` to
 * get a floating panel + Esc-to-dismiss).
 *
 * Single click on a tile fires `onChange(iconName)`. The component
 * is controlled — it doesn't track selection internally; the parent
 * is expected to pass the currently-selected name back via `value`
 * so the highlight updates. A `null` value (no icon picked yet, or
 * "remove") shows no highlight at all.
 *
 * `busy` disables every tile (used while a PUT /api/category-icons
 * is in flight from the parent). No internal spinner — callers
 * render their own inline "A guardar…" if they want to.
 *
 * Layout trade-off: five columns at full width gives readable
 * tile labels without forcing horizontal scroll on the ~240px
 * content area of a typical dialog/popover. Each tile is
 * aspect-square so the grid scales uniformly across the 37 icons
 * in the registry.
 *
 * @param {Object} props
 * @param {string|null} [props.value]   Currently-selected icon name
 * @param {Function}    props.onChange  `(iconName) => void`
 * @param {boolean}     [props.busy]    Disable all tiles
 */
export function IconPickerGrid({ value, onChange, busy = false }) {
  return (
    <div className="space-y-3">
      {ICON_CATALOGUE.map((group) => (
        <div key={group.label}>
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-sand-400">
            {group.label}
          </div>
          <div className="grid grid-cols-5 gap-1.5">
            {group.icons.map((icon) => {
              const isCurrent = value === icon.name;
              return (
                <button
                  key={icon.name}
                  type="button"
                  onClick={() => onChange?.(icon.name)}
                  disabled={busy}
                  title={icon.label}
                  aria-label={icon.label}
                  aria-pressed={isCurrent}
                  className={`flex aspect-square items-center justify-center rounded-lg border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    isCurrent
                      ? 'border-curve-400 bg-curve-50 text-curve-700 ring-2 ring-curve-500'
                      : 'border-sand-200 bg-white text-sand-700 hover:bg-sand-50'
                  }`}
                >
                  <CategoryIcon
                    name={icon.name}
                    className="h-5 w-5"
                  />
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * <IconPickerDialog>
 *
 * Modal wrapper around `<IconPickerGrid>` with title, close button,
 * and an optional "Remover" CTA (wired via `onClear` to trigger
 * `DELETE /api/category-icons/:id` on the server). Click-outside
 * and Esc both call `onCancel` so the dismissal paths are uniform.
 *
 * Selection semantics — click a tile and `onSelect(iconName)` fires
 * immediately. The dialog does NOT auto-close on select because the
 * parent typically wants to show an optimistic highlight while the
 * PUT is in flight + a spinner; the parent closes explicitly via
 * `onCancel` once the write settles.
 *
 * The `busy` prop is forwarded to the grid AND disables the
 * Remover button, so users can't queue up a clear + a set in
 * quick succession while a previous write is still pending.
 *
 * @param {Object}      props
 * @param {string|null} [props.value]    Current icon name
 * @param {Function}    props.onSelect   `(iconName) => void`
 * @param {Function}    [props.onClear]  Optional — shows the
 *                                       Remover button when passed
 * @param {Function}    props.onCancel   Dismiss (Esc / outside / ×)
 * @param {boolean}     [props.busy]     Disable all controls
 */
export function IconPickerDialog({
  value,
  onSelect,
  onClear,
  onCancel,
  busy = false,
}) {
  const panelRef = useRef(null);

  // Dismiss on Escape + click outside. Same pattern as the other
  // popovers in this codebase (CategoryPickerPopover,
  // ConfirmDialog) — keeps keyboard + pointer parity so dismissal
  // feels consistent across the admin surface.
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
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-sand-950/30 p-4 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label="Escolher ícone"
    >
      <div
        ref={panelRef}
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-sand-200 bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-sand-900">
            Escolher ícone
          </h2>
          <button
            type="button"
            aria-label="Fechar"
            onClick={onCancel}
            disabled={busy}
            className="rounded-full p-1 text-sand-400 transition-colors hover:bg-sand-100 hover:text-sand-700 disabled:opacity-40"
          >
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

        <IconPickerGrid value={value} onChange={onSelect} busy={busy} />

        {/* Remover is optional — only present when the parent passes
            `onClear`. For CreateCategoryDialog (fresh category, no
            icon yet) the parent omits it; for CategoriesPage detail
            on an existing category with an icon, the parent wires
            it to DELETE /api/category-icons/:id. */}
        {onClear && (
          <div className="mt-5 flex justify-between">
            <button
              type="button"
              onClick={onClear}
              disabled={busy || !value}
              className="rounded-lg px-3 py-2 text-sm font-medium text-curve-700 hover:bg-curve-50 disabled:opacity-50"
              title={
                value
                  ? 'Voltar ao ícone por omissão'
                  : 'Nenhum ícone definido'
              }
            >
              Remover ícone
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
