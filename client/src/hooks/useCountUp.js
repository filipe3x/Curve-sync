import { useEffect, useState } from 'react';

// Tween a numeric value from 0 → `value` over `duration` ms using an
// ease-out-cubic curve. Drives the KPI strip on /categories (§9.8 #3
// of docs/Categories.md) — when the user clicks a different category,
// all four KPIs kick off a fresh rAF and re-animate in parallel, so
// the transition feels like a smooth refresh rather than a hard swap.
//
// `prefers-reduced-motion: reduce` disables the tween entirely and
// returns the target value immediately. The detection is done once
// per hook instance via `matchMedia` (cheap, no listener) because
// expense dashboards don't need live toggling — if the user flips
// the system setting they can reload the page.
export function useCountUp(value, duration = 800) {
  const [display, setDisplay] = useState(() => {
    // First paint respects reduced motion too — otherwise the user
    // briefly sees a 0 flash before the hook's effect runs and short-
    // circuits to the target.
    if (typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      return value;
    }
    return 0;
  });

  useEffect(() => {
    const reduced =
      typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      setDisplay(value);
      return undefined;
    }

    const start = performance.now();
    const from = 0;
    let raf;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      setDisplay(from + (value - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return display;
}
