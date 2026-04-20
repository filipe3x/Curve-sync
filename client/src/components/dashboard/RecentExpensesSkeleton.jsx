/**
 * Loading skeleton for the "Despesas recentes" table on the dashboard.
 * Renders the same wrapper + <thead> as the populated table plus five
 * placeholder rows so the section holds its shape on first paint.
 *
 * The empty-state ("Sem despesas") must never show while data is still
 * in flight — during loading `recentExpenses` is `[]`, which used to
 * trip the empty state and tell the user they had no expenses. This
 * skeleton replaces that lie.
 *
 * Column widths are picked to roughly match real values: entity names
 * (~160 px), EUR amounts (~56 px, short because "€XX.XX" is narrow),
 * dates (~96 px, matches "há 3 dias"), card labels (~120 px), and a
 * pill for the category chip (~80 px rounded).
 */

// Deterministic width sequence so the skeleton reads as "real data"
// without random flicker across re-renders. Each tuple is
// [entityW, amountW, dateW, cardW, pillW] in px.
const ROW_WIDTHS = [
  [150, 56, 88, 120, 80],
  [180, 64, 96, 110, 72],
  [130, 48, 80, 128, 88],
  [170, 56, 96, 120, 80],
  [140, 60, 88, 116, 76],
];

export default function RecentExpensesSkeleton() {
  return (
    <div
      className="overflow-hidden rounded-2xl border border-sand-200 bg-white"
      role="status"
      aria-busy="true"
      aria-label="A carregar despesas recentes"
    >
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
          {ROW_WIDTHS.map(([entityW, amountW, dateW, cardW, pillW], i) => (
            <tr key={i} className="border-b border-sand-50">
              <td className="px-5 py-3">
                <div
                  className="h-4 animate-pulse rounded-md bg-sand-200"
                  style={{ width: `${entityW}px`, maxWidth: '100%' }}
                />
              </td>
              <td className="px-5 py-3">
                <div
                  className="h-4 animate-pulse rounded-md bg-sand-200"
                  style={{ width: `${amountW}px`, maxWidth: '100%' }}
                />
              </td>
              <td className="px-5 py-3">
                <div
                  className="h-4 animate-pulse rounded-md bg-sand-100"
                  style={{ width: `${dateW}px`, maxWidth: '100%' }}
                />
              </td>
              <td className="px-5 py-3">
                <div
                  className="h-4 animate-pulse rounded-md bg-sand-100"
                  style={{ width: `${cardW}px`, maxWidth: '100%' }}
                />
              </td>
              <td className="px-5 py-3">
                <div
                  className="h-6 animate-pulse rounded-lg bg-sand-100"
                  style={{ width: `${pillW}px`, maxWidth: '100%' }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
