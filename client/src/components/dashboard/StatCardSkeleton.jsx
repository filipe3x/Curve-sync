/**
 * Loading skeleton for the dashboard KPI cards (Despesas este mês,
 * Savings Score, Sem categoria, Último sync). Mirrors the real
 * StatCard / AnimatedKPI shell — same `card` class, same vertical
 * rhythm — so swapping the skeleton for the populated card doesn't
 * shift layout.
 *
 * Three pulsing bars:
 *   - caption line (short, light)
 *   - value line   (bigger, darker — stands in for the 2xl number)
 *   - sub line     (medium, light)
 *
 * Kept in the dashboard folder, not /common, because it's shaped to
 * the dashboard's specific KPI strip — other pages use compact
 * variants that would need their own skeleton.
 */
export default function StatCardSkeleton() {
  return (
    <div
      className="card"
      role="status"
      aria-busy="true"
      aria-label="A carregar indicador"
    >
      <div className="h-3 w-24 animate-pulse rounded-md bg-sand-100" />
      <div className="mt-3 h-7 w-32 animate-pulse rounded-md bg-sand-200" />
      <div className="mt-2 h-3 w-40 max-w-full animate-pulse rounded-md bg-sand-100" />
    </div>
  );
}
