/**
 * The handwritten "Curve Sync" signature with an infinity ribbon that
 * loops around both ends, tipped by arrowheads that echo the sync-refresh
 * icon used throughout the app.
 *
 * Phase 1 (this file) — a functional, animatable SVG:
 *   - Single `<motion.text>` rendering in Caveat (handwritten font)
 *   - Single `<motion.path>` sweeping an infinity-ribbon around the text
 *   - `pathLength: 0 → 1` reveal when `animate` is true
 *   - Arrow markers at both ends reference the existing ArrowPathIcon
 *     visual language (sync-circle arrowheads)
 *
 * Phase 2 (backlog — see docs/WIZARD_POLISH_BACKLOG.md):
 *   - Hand-tuned cubic path so the ribbon's left arrow kisses the top
 *     of the "C" glyph and the right arrow kisses the tail of the "c"
 *   - Optional ink-bleed tail, subtle jitter, draw-then-pulse sequence
 *   - Dark-mode ink colour variants
 *
 * Props:
 *   - className   Tailwind sizing classes (w-/h-/max-w- / text-*)
 *   - animate     false → render the final state with no motion
 *   - ariaLabel   screen-reader label (defaults to "Curve Sync")
 */
import { motion } from 'motion/react';

export default function CurveSyncLogo({
  className = '',
  animate = true,
  ariaLabel = 'Curve Sync',
}) {
  const initialPath = animate ? { pathLength: 0, opacity: 0 } : false;
  const animatePath = { pathLength: 1, opacity: 1 };
  const pathTransition = animate
    ? { duration: 2.2, ease: [0.43, 0.13, 0.23, 0.96], delay: 0.35 }
    : { duration: 0 };

  const initialText = animate ? { opacity: 0, y: 10 } : false;
  const animateText = { opacity: 1, y: 0 };
  const textTransition = animate
    ? { duration: 0.7, ease: 'easeOut', delay: 0.15 }
    : { duration: 0 };

  return (
    <svg
      className={className}
      viewBox="0 0 640 240"
      fill="none"
      role="img"
      aria-label={ariaLabel}
    >
      <defs>
        <marker
          id="curve-sync-arrowhead"
          viewBox="0 0 10 10"
          refX="7"
          refY="5"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
      </defs>

      {/*
        The text sits in the middle of the viewBox. Using inline
        fontFamily (not Tailwind's font-handwritten) because Tailwind's
        font classes don't apply to SVG <text> elements via className.
      */}
      <motion.text
        x="320"
        y="155"
        textAnchor="middle"
        fontFamily="Caveat, 'Segoe Script', 'Comic Sans MS', cursive"
        fontSize="150"
        fontWeight="600"
        fill="currentColor"
        initial={initialText}
        animate={animateText}
        transition={textTransition}
      >
        Curve Sync
      </motion.text>

      {/*
        Infinity ribbon — one continuous cubic sweep that starts at the
        top-left of the text (near the capital C), loops down and under,
        crosses the middle, loops over the tail of the lowercase c, and
        ends mid-right. Both endpoints wear the sync arrowhead marker.

        This path is intentionally geometric rather than pixel-perfect —
        the polish pass in docs/WIZARD_POLISH_BACKLOG.md §2 replaces it
        with a hand-tuned version after we see the skeleton in browser.
      */}
      <motion.path
        d="M 120 70
           C  40  70,  30 200, 150 200
           C 270 200, 340  40, 470  60
           C 580  75, 600 200, 500 200"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
        markerStart="url(#curve-sync-arrowhead)"
        markerEnd="url(#curve-sync-arrowhead)"
        initial={initialPath}
        animate={animatePath}
        transition={pathTransition}
      />
    </svg>
  );
}
