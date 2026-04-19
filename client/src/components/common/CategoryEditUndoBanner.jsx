/**
 * <CategoryEditUndoBanner>
 *
 * Amber undo banner(s) rendered after a single-expense category
 * quick-edit on `/expenses` or `/`. Replaces the old green
 * "Categoria actualizada." toast — the chip changed in place, so
 * the success message only adds noise; what users actually want is
 * a short grace window to reverse the click if they moved the
 * wrong row.
 *
 * Visual language mirrors the apply-to-all banner on `/categories`
 * (amber-200 border, amber-50 fill, amber-800 text, rounded-2xl,
 * right-aligned action pills) so the two "staging" surfaces feel
 * related and the user doesn't have to learn a new vocabulary.
 *
 * Stack semantics: the parent page owns the list of pending undo
 * entries — multiple rapid edits stack top-to-bottom, newest at the
 * bottom. The parent dedupes per-expense on push (only the latest
 * edit of a given expense has an active banner) so a user who
 * fat-fingers the same row twice doesn't end up with two banners
 * whose "Anular" buttons fight over the same expense.
 *
 * Each entry has its own parent-managed auto-dismiss timer —
 * usually ~6 s. Clicking "Anular" fires `onUndo(entry)` which is
 * the parent's reversal path (optimistic restore + PUT back to
 * `prevCategoryId`). The banner itself never mutates anything.
 *
 * @param {Object} props
 * @param {Array<{
 *   id: string,
 *   expenseId: string,
 *   entity: string,
 *   prevCategoryId: string|null,
 *   prevCategoryName: string|null,
 *   nextCategoryName: string|null,
 *   undoing?: boolean,
 * }>} props.edits  Pending entries, oldest first.
 * @param {Function} props.onUndo  `(entry) => void`
 */
export default function CategoryEditUndoBanner({ edits, onUndo }) {
  if (!edits?.length) return null;
  return (
    <div className="mb-4 space-y-2">
      {edits.map((edit) => {
        const fromName = edit.prevCategoryName ?? 'Sem categoria';
        const toName = edit.nextCategoryName ?? 'Sem categoria';
        return (
          <div
            key={edit.id}
            className="flex items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 animate-fade-in"
            role="status"
          >
            <span className="min-w-0">
              Despesa <strong>{edit.entity}</strong>{' '}
              <span aria-hidden>→</span>{' '}
              <strong>{toName}</strong> actualizada.{' '}
              <span className="text-amber-700/80">(era {fromName})</span>
            </span>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                onClick={() => onUndo(edit)}
                disabled={edit.undoing}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
                title={`Voltar a ${fromName}`}
              >
                {edit.undoing ? 'A anular…' : 'Anular'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
