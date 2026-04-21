/**
 * Full-page loading skeleton for /categories. Replaces the old
 * "A carregar…" one-liner in the `loading && !statsCurrent` early
 * return with a skeleton that mirrors the real master-detail layout
 * (distribution bar + list column + detail column) so the page
 * doesn't shift or flash when the data lands.
 *
 * Structure, in order (matches CategoriesPage render):
 *   1. Cycle-label placeholder — the thin line under the title that
 *      normally reads "Ciclo actual · dd MMM – dd MMM".
 *   2. DistributionBar silhouette — full-width h-3 bar, rounded-full,
 *      single pulsing block. A multi-segment fake bar would look
 *      like real data and mislead the eye.
 *   3. Grid (320px | 1fr):
 *      - Left aside: "Categorias" caption + total placeholder, six
 *        CategoryRow placeholders (icon dot + name + sub + EUR +
 *        delta pill).
 *      - Right section: icon pedestal + title + delta pill header,
 *        4-up KPI strip (compact variant), tab row, "As minhas
 *        regras" caption + input + 3-row list, "Catálogo global"
 *        caption + search input + 4-row list.
 *
 * Deterministic widths (no Math.random()) so re-renders don't flicker.
 *
 * The skeleton renders WITHOUT a `selectedRow`-vs-EmptyState branch:
 * by the time the data lands the page auto-selects the first row, so
 * showing the detail column as "data coming" is the honest preview.
 */

// Six placeholder rows for the left list. Widths tuned to look like
// natural category names ("Supermercado", "Restaurantes", "Combustível")
// and EUR totals in the €30–€800 range.
const LIST_ROW_WIDTHS = [
  { name: 148, sub: 108, total: 72 },
  { name: 112, sub: 96, total: 64 },
  { name: 176, sub: 120, total: 80 },
  { name: 132, sub: 100, total: 56 },
  { name: 160, sub: 112, total: 72 },
  { name: 124, sub: 92, total: 68 },
];

// Three override rows under "As minhas regras". Same shape as a real
// OverridesList row: truncated pattern + faint "regra pessoal" sub.
const OVERRIDE_ROW_WIDTHS = [
  { pattern: 160, sub: 84 },
  { pattern: 132, sub: 84 },
  { pattern: 200, sub: 84 },
];

// Four global-entity rows. Same shape as `<li>` in GlobalEntitiesList:
// entity name + "global · match c/ N despesas" sub.
const GLOBAL_ROW_WIDTHS = [
  { entity: 120, sub: 144 },
  { entity: 156, sub: 132 },
  { entity: 104, sub: 124 },
  { entity: 180, sub: 148 },
];

export default function CategoriesPageSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="A carregar categorias"
    >
      {/* Cycle label placeholder — slots in where PageHeader's
          description would normally land. Mirrors the `mt-1
          text-sm text-sand-500` rhythm so the title + sub pair
          lines up with the loaded version. */}
      <div className="-mt-6 mb-8 h-4 w-56 animate-pulse rounded-md bg-sand-100" />

      {/* DistributionBar silhouette */}
      <div className="mb-6 h-3 w-full animate-pulse rounded-full bg-sand-200" />

      {/* Grid: list | detail */}
      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        {/* ── Left column ── */}
        <aside className="overflow-hidden rounded-2xl border border-sand-200 bg-white">
          <header className="flex items-center justify-between gap-2 border-b border-sand-100 px-4 py-3">
            <div className="h-3 w-20 animate-pulse rounded-md bg-sand-100" />
            <div className="h-3 w-16 animate-pulse rounded-md bg-sand-100" />
          </header>
          <div>
            {LIST_ROW_WIDTHS.map((w, i) => (
              <div
                key={i}
                className="flex items-center justify-between gap-3 border-l-2 border-transparent px-4 py-3"
              >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  {/* Round icon swatch — matches the h-5 w-5 pedestal
                      on a real CategoryRow. */}
                  <div className="mt-0.5 h-5 w-5 flex-none animate-pulse rounded-full bg-sand-200" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div
                      className="h-3 animate-pulse rounded-md bg-sand-200"
                      style={{ width: `${w.name}px`, maxWidth: '100%' }}
                    />
                    <div
                      className="h-2.5 animate-pulse rounded-md bg-sand-100"
                      style={{ width: `${w.sub}px`, maxWidth: '100%' }}
                    />
                  </div>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <div
                    className="h-3 animate-pulse rounded-md bg-sand-200"
                    style={{ width: `${w.total}px` }}
                  />
                  <div className="h-4 w-10 animate-pulse rounded-lg bg-sand-100" />
                </div>
              </div>
            ))}
          </div>
        </aside>

        {/* ── Right column ── */}
        <section className="space-y-6">
          {/* Header: icon tile + title + delta pill */}
          <div className="flex items-center gap-3">
            <div className="h-7 w-7 flex-none animate-pulse rounded-xl bg-sand-200" />
            <div className="h-6 w-48 animate-pulse rounded-md bg-sand-200" />
            <div className="h-5 w-12 animate-pulse rounded-lg bg-sand-100" />
          </div>

          {/* KPI strip — 4 compact cards, same shell as AnimatedKPI
              variant="compact" (rounded-2xl, border, p-4). */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="rounded-2xl border border-sand-200 bg-white p-4"
              >
                <div className="h-2.5 w-16 animate-pulse rounded-md bg-sand-100" />
                <div className="mt-3 h-6 w-24 animate-pulse rounded-md bg-sand-200" />
              </div>
            ))}
          </div>

          {/* Tabs row — two pill buttons (Entidades / Despesas
              recentes). Only the active one has a filled background
              in the loaded state; we mirror that so the skeleton
              doesn't add visual weight the loaded version doesn't. */}
          <div className="flex gap-2 border-b border-sand-200">
            <div className="h-9 w-28 animate-pulse rounded-t-xl bg-sand-100" />
            <div className="h-9 w-40 animate-pulse rounded-t-xl bg-sand-50" />
          </div>

          {/* "As minhas regras" section */}
          <section className="space-y-3">
            <div className="h-2.5 w-28 animate-pulse rounded-md bg-sand-100" />
            {/* OverridesList add-form input placeholder — a single
                rounded-xl bar at the real input's height. */}
            <div className="h-11 w-full animate-pulse rounded-xl bg-sand-100" />
            <ul className="divide-y divide-sand-100 rounded-2xl border border-sand-200 bg-white">
              {OVERRIDE_ROW_WIDTHS.map((w, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between px-4 py-3"
                >
                  <div className="min-w-0 flex-1 space-y-2">
                    <div
                      className="h-3 animate-pulse rounded-md bg-sand-200"
                      style={{ width: `${w.pattern}px`, maxWidth: '100%' }}
                    />
                    <div
                      className="h-2.5 animate-pulse rounded-md bg-sand-100"
                      style={{ width: `${w.sub}px`, maxWidth: '100%' }}
                    />
                  </div>
                  <div className="h-5 w-14 animate-pulse rounded-lg bg-sand-100" />
                </li>
              ))}
            </ul>
          </section>

          {/* "Catálogo global" section */}
          <section className="space-y-3">
            <div className="h-2.5 w-24 animate-pulse rounded-md bg-sand-100" />
            {/* Search input placeholder */}
            <div className="h-11 w-full animate-pulse rounded-xl bg-sand-100" />
            <ul className="divide-y divide-sand-100 rounded-2xl border border-sand-200 bg-white">
              {GLOBAL_ROW_WIDTHS.map((w, i) => (
                <li
                  key={i}
                  className="flex items-center justify-between px-4 py-3"
                >
                  <div className="min-w-0 flex-1 space-y-2">
                    <div
                      className="h-3 animate-pulse rounded-md bg-sand-200"
                      style={{ width: `${w.entity}px`, maxWidth: '100%' }}
                    />
                    <div
                      className="h-2.5 animate-pulse rounded-md bg-sand-100"
                      style={{ width: `${w.sub}px`, maxWidth: '100%' }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </section>
      </div>
    </div>
  );
}
