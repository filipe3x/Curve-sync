import Sidebar from './Sidebar';

/**
 * App shell — composes the (responsive) sidebar with the route outlet.
 *
 * Responsive strategy (ROADMAP Fase 3.1):
 *
 *  - **Narrow (< lg / 1024 px)**: Sidebar is a slim 64 px icon rail,
 *    always visible on the left. The "CS" badge anchors the top; the
 *    five nav icons stack vertically below it; logout sits at the
 *    bottom. No hamburger, no drawer, no topbar — every destination
 *    is one tap away.
 *  - **Wide (≥ lg)**: same Sidebar component expands to 256 px and
 *    reveals the "Curve Sync" wordmark + text labels + user email.
 *
 * `min-w-0` on the `<main>` column is load-bearing: without it, wide
 * tables (`/expenses`, `/curve/logs`) push the viewport sideways on
 * mobile because flex items default to `min-width: auto`.
 */
export default function Shell({ children }) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
          <div className="mx-auto max-w-6xl animate-fade-in">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
