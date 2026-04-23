/**
 * <Screen> — the motion-wrapped container every wizard step mounts
 * inside. Gives every screen the same "glide in / glide out" rhythm
 * without repeating boilerplate in each step file.
 *
 * - `AnimatePresence` handles exit animations when the parent swaps
 *   keys (i.e. the wizard's step advances).
 * - Respects `prefers-reduced-motion` via the standard Motion hook.
 * - Children are free to render their own `<motion.*>` sub-elements
 *   for staggered reveals; this wrapper just handles page-level swap.
 *
 * Why a separate component: so the polish pass can centrally tweak
 * easing curves, durations, and blur-in effects without hunting
 * through every step file.
 */
import { motion, useReducedMotion } from 'motion/react';

export default function Screen({ children, className = '', id }) {
  const reduced = useReducedMotion();

  const variants = reduced
    ? {
        initial: { opacity: 1 },
        animate: { opacity: 1 },
        exit: { opacity: 1 },
      }
    : {
        initial: { opacity: 0, y: 16 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: -16 },
      };

  return (
    <motion.section
      key={id}
      className={className}
      variants={variants}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={{ duration: 0.45, ease: [0.22, 0.61, 0.36, 1] }}
    >
      {children}
    </motion.section>
  );
}
