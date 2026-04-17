import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import { Bars3Icon } from './Icons';

/**
 * App shell — composes the sidebar navigation with the route outlet.
 *
 * Responsive behaviour (ROADMAP Fase 3.1):
 *
 *  - **Desktop (≥ lg / 1024px)**: sidebar is a docked flex child on the
 *    left, always visible. No topbar, no drawer, no backdrop.
 *  - **Mobile (< lg)**: sidebar collapses into a slide-in drawer
 *    triggered by a hamburger button in a slim top bar. Backdrop +
 *    Escape key + route change close the drawer. Body scroll locks
 *    while the drawer is open to avoid the double-scroll wobble
 *    when the user swipes on iOS.
 *
 * The drawer uses Tailwind `translate-x` + `transition-transform`
 * instead of `motion/react` for a reason: we never animate the whole
 * App tree, and introducing AnimatePresence here would rerun the
 * pages below on every open/close. A CSS transform is instant, cheap,
 * and gives us `prefers-reduced-motion` for free (when the user has
 * the OS flag on, browsers short-circuit transforms of `0.3s` to 0).
 */
export default function Shell({ children }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  // Close the drawer whenever the route changes. Without this, tapping
  // a NavLink on mobile leaves the drawer open on top of the newly
  // loaded page. The onNavigate prop on Sidebar also closes synchronously
  // for the instant-feedback case; this effect is the fallback for
  // anywhere the route changes without a NavLink tap (browser back,
  // a <Link> elsewhere in the shell, etc.).
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname, location.search]);

  // Escape closes the drawer. Only attached while open to avoid
  // swallowing Escape from pages that use it for their own dialogs.
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  // Body scroll lock while drawer is open (mobile only). Restoring the
  // original value on cleanup avoids stomping on a page that set its
  // own overflow rule (shouldn't happen today, but defensive).
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [drawerOpen]);

  return (
    <div className="flex min-h-screen">
      {/* Mobile topbar — hidden at ≥ lg where the sidebar is always
          visible. Sticky so the menu stays one tap away when the user
          scrolls through long pages like /expenses. */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-sand-200 bg-white/95 px-4 backdrop-blur lg:hidden">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Abrir menu"
          aria-expanded={drawerOpen}
          className="rounded-lg p-2 text-sand-700 transition-colors hover:bg-sand-100 active:bg-sand-200"
        >
          <Bars3Icon className="h-6 w-6" />
        </button>
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-curve-700">
            <span className="text-xs font-bold text-white">CS</span>
          </div>
          <span className="text-base font-semibold text-sand-900">
            Curve Sync
          </span>
        </div>
      </header>

      {/* Desktop sidebar — static docked column. Hidden below lg
          because the drawer below covers mobile. */}
      <div className="hidden lg:flex">
        <Sidebar />
      </div>

      {/* Mobile drawer — backdrop + slide-in panel. `pointer-events-none`
          while closed keeps links below the drawer interactive; the
          child elements flip back to `auto` when the drawer opens. */}
      <div
        className={`fixed inset-0 z-40 lg:hidden ${
          drawerOpen ? '' : 'pointer-events-none'
        }`}
        aria-hidden={!drawerOpen}
      >
        {/* Backdrop. Fades in/out with the drawer. */}
        <div
          onClick={() => setDrawerOpen(false)}
          className={`absolute inset-0 bg-sand-950/40 transition-opacity duration-200 ${
            drawerOpen ? 'opacity-100' : 'opacity-0'
          }`}
        />
        {/* Drawer panel. Translates from off-screen left. `shadow-xl`
            while open gives depth against the backdrop on bright
            mobile screens. */}
        <div
          className={`absolute inset-y-0 left-0 w-64 transform bg-white shadow-xl transition-transform duration-200 ${
            drawerOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
          role="dialog"
          aria-label="Menu de navegação"
          aria-modal="true"
        >
          <Sidebar
            onNavigate={() => setDrawerOpen(false)}
            onClose={() => setDrawerOpen(false)}
          />
        </div>
      </div>

      {/* Route outlet. The `min-w-0` on the flex child prevents long
          horizontal content (tables, code blocks) from pushing the
          viewport sideways on mobile — flex items default to
          `min-width: auto` which lets children exceed the container. */}
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
