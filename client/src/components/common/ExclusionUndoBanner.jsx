/**
 * <ExclusionUndoBanner>
 *
 * One-at-a-time undo banner for the ROADMAP §2.10 cycle-exclusion
 * toggle. Rendered on `/expenses`, `/` (dashboard) and `/curve/logs`
 * after the user flips the exclusion state of one or more expenses —
 * either via the action-bar bulk toggle or via the single-expense
 * mini-button inside the `CategoryPickerPopover` header (§2.10.1).
 *
 * Shape parity with the sibling `CategoryEditUndoBanner` is
 * intentional but the semantics differ: category edits stack
 * top-to-bottom (one entry per expense), exclusion toggles are
 * one-at-a-time because a bulk "excluir 10" is semantically one
 * action the user wants to Anular as a whole.
 *
 * @param {Object}   props
 * @param {Object|null} props.entry  Current pending toggle, or null.
 *   Shape: `{ ids, direction: 'excluded'|'included', affected,
 *   skipped, text }`. Only `text` is read here — the parent owns the
 *   rest for its own PUT/DELETE plumbing.
 * @param {Function} props.onUndo    `() => void`. Fired by Anular.
 * @param {boolean}  [props.busy]    Parent-controlled busy state;
 *   disables Anular while the inverse call is in flight.
 */
export default function ExclusionUndoBanner({ entry, onUndo, busy = false }) {
  if (!entry) return null;
  return (
    <div
      className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-sand-200 bg-white px-4 py-3 text-sm shadow-sm"
      role="status"
    >
      <span className="text-sand-700">{entry.text}</span>
      <button
        type="button"
        onClick={onUndo}
        disabled={busy}
        className="rounded-lg px-3 py-1 text-xs font-medium text-curve-700 transition-colors hover:bg-curve-50 disabled:opacity-50"
      >
        Anular
      </button>
    </div>
  );
}
