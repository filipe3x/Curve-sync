import { useEffect, useRef, useState } from 'react';

// Tween a numeric value toward `value` over `duration` ms using an
// ease-out-cubic curve. Drives the KPI strip on /categories (§9.8 #3
// of docs/Categories.md) and the numeric stat cards on /. On first
// paint the tween starts from 0 so the cards feel alive on mount; on
// every subsequent change the tween starts from the *previous* value
// instead of resetting to 0, otherwise a post-sync refresh would make
// `8.1 → 8.3` visibly regress through 0 before climbing back (ROADMAP
// §2.11).
//
// `prefers-reduced-motion: reduce` disables the tween entirely and
// returns the target value immediately. The detection is done once
// per hook instance via `matchMedia` (cheap, no listener) — if the
// user flips the system setting mid-session they can reload the page.
export function useCountUp(value, duration = 800) {
  const reduced =
    typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const [display, setDisplay] = useState(() => (reduced ? value : 0));

  // The value we were showing before the current `value` prop landed.
  // Used as the `from` of the tween on updates — flat 0 only on first
  // paint (initialised via the ref's constructor arg).
  const fromRef = useRef(reduced ? value : 0);

  useEffect(() => {
    if (reduced) {
      setDisplay(value);
      fromRef.current = value;
      return undefined;
    }

    const start = performance.now();
    const from = fromRef.current;
    let raf;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      const current = from + (value - from) * eased;
      setDisplay(current);
      if (t < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        fromRef.current = value;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration, reduced]);

  return display;
}
