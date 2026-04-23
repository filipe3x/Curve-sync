/**
 * Suspense fallback for CycleTrendCard. Renders a bare chart silhouette
 * (12 placeholder bars + gridlines + header/footer) so the dashboard
 * holds its shape while the recharts chunk streams in.
 *
 * Why not reuse the card's "empty state"? That one is a user-facing
 * message ("Ainda sem histórico suficiente") with its own copy — a
 * loading state shouldn't read the same as a no-data state, or users
 * will double-take every time they open the page.
 *
 * The bars use a deterministic height sequence (not random) so the
 * skeleton looks identical on every mount and doesn't flicker if React
 * re-renders the fallback mid-stream.
 */

// Pre-computed heights (in %) for the 12 placeholder bars. Tuned to
// look like natural spending variance — not too uniform, not too spiky.
// Symmetric-ish so the skeleton reads as "a chart shape" at a glance
// rather than "a bar chart with specific data".
const SKELETON_HEIGHTS = [
  55, 38, 72, 48, 65, 42, 80, 58, 52, 68, 62, 75,
];

export default function CycleTrendSkeleton() {
  return (
    <div
      className="card"
      role="status"
      aria-busy="true"
      aria-label="A carregar gráfico de evolução"
    >
      {/* Header silhouette — title block + right-aligned toggle pill.
          Mirrors the real card's header layout so there's no shift
          when the chart lands. */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="h-5 w-48 animate-pulse rounded-md bg-sand-200" />
          <div className="h-3 w-64 max-w-full animate-pulse rounded-md bg-sand-100" />
        </div>
        <div className="h-8 w-36 animate-pulse rounded-full bg-sand-100" />
      </div>

      {/* Chart silhouette — 12 bars over a dashed baseline. Each bar
          is its own flex child with a fixed height % so they align at
          the bottom; the `animate-pulse` on the parent gives the whole
          block the shimmer (bars + baseline move together). */}
      <div
        className="relative h-64 w-full animate-pulse"
        aria-hidden="true"
      >
        {/* Y-axis ticks — three faint lines at 1/4, 1/2, 3/4 height
            to anchor the eye. Positioned absolutely so they don't
            disturb the bar row flex. */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute left-0 right-0 top-1/4 border-t border-dashed border-sand-200" />
          <div className="absolute left-0 right-0 top-1/2 border-t border-dashed border-sand-200" />
          <div className="absolute left-0 right-0 top-3/4 border-t border-dashed border-sand-200" />
        </div>
        {/* Bar row — pl-12 matches the real chart's Y-axis width (48 px)
            so the left edges of the bars line up after the chunk lands. */}
        <div className="absolute inset-0 flex items-end gap-1.5 pl-12 pb-6">
          {SKELETON_HEIGHTS.map((h, i) => (
            <div
              key={i}
              className="flex-1 rounded-t-md bg-sand-200"
              style={{ height: `${h}%` }}
            />
          ))}
        </div>
        {/* Bottom axis line */}
        <div className="absolute bottom-6 left-12 right-0 border-t border-sand-200" />
      </div>

      {/* Footer silhouette — legend dot + average text. Keeps the
          card's total height matching the loaded version so the stuff
          below the card on the page doesn't shift. */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="h-3 w-32 animate-pulse rounded-md bg-sand-100" />
        <div className="h-3 w-40 animate-pulse rounded-md bg-sand-100" />
      </div>
    </div>
  );
}
