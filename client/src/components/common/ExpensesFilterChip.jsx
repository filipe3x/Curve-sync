import { CalendarRangeIcon, XMarkIcon } from '../layout/Icons';
import { formatAbsoluteDate } from '../../utils/relativeDate';

/**
 * Active-filter pill for the /expenses page (ROADMAP §2.6.1). Rendered
 * above the table when at least one of `start` / `end` is present on
 * the URL. The three supported shapes:
 *
 *   start + end → "22 Mar 2026 → 21 Abr 2026"
 *   start only  → "A partir de 22 Mar 2026"
 *   end only    → "Até 21 Abr 2026"
 *
 * The `count` is the total number of rows the filter matched (already
 * computed server-side into `meta.total`), so the chip doubles as a
 * quick "how much did I spend in this window?" answer without the user
 * having to eyeball the table.
 *
 * aria-live="polite" is deliberate — screen readers announce the new
 * range when the user picks a different bar on the dashboard chart
 * without navigating back to read the chip.
 */

function rangeLabel({ start, end }) {
  if (start && end) {
    return `${formatAbsoluteDate(start)} → ${formatAbsoluteDate(end)}`;
  }
  if (start) return `A partir de ${formatAbsoluteDate(start)}`;
  if (end) return `Até ${formatAbsoluteDate(end)}`;
  // Callers are expected to gate on `start || end` before rendering,
  // but we fall through to a safe placeholder so a misuse during
  // refactor never renders the empty word `null`.
  return 'Sem intervalo';
}

export default function ExpensesFilterChip({ start, end, count, onClear }) {
  if (!start && !end) return null;

  const plural = count === 1 ? 'despesa' : 'despesas';

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-4 flex animate-slide-in-right items-center gap-3 rounded-2xl border border-sand-200 bg-sand-50 px-4 py-2.5 text-sm text-sand-700"
    >
      <CalendarRangeIcon className="h-4 w-4 shrink-0 text-sand-500" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-sand-900">{rangeLabel({ start, end })}</span>
        <span className="ml-2 text-xs text-sand-500">
          · {count.toLocaleString('pt-PT')} {plural}
        </span>
      </span>
      <button
        type="button"
        onClick={onClear}
        aria-label="Limpar filtro de datas"
        title="Limpar filtro de datas"
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sand-500 transition-colors hover:bg-sand-200 hover:text-sand-700 focus:outline-none focus:ring-2 focus:ring-curve-500/30"
      >
        <XMarkIcon className="h-4 w-4" />
      </button>
    </div>
  );
}
