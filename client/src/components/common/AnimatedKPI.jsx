import { useCountUp } from '../../hooks/useCountUp';

/**
 * KPI card that tweens its numeric value via `useCountUp`. Shared by
 * the dashboard and /categories (ROADMAP §2.11) so both entry points
 * animate identically — first paint fades 0 → value, every update
 * thereafter tweens from the *previous* value so a post-sync refresh
 * never visibly regresses to 0.
 *
 * Props:
 *   - `label`:   small uppercase caption above the number
 *   - `value`:   the numeric target. `null` / `undefined` render `—`
 *                without starting a tween (the first real value will
 *                animate from 0 just like a cold mount)
 *   - `format`:  `(n) => string` — receives the *tweened* intermediate
 *                value, so currency/decimal formatting happens inside
 *   - `sub`:     optional line under the number
 *   - `accent`:  keeps parity with StatCard — renders the value in
 *                `curve-700` instead of `sand-900`
 *   - `title`:   native tooltip
 *   - `perfect`: opt-in "perfect 10" celebration (shimmer + breathe
 *                + halo). Only activates once the tween has *landed*
 *                on the perfect value (see below) so an in-flight
 *                tween doesn't flash the effect mid-climb.
 *
 * The "perfect" trigger is `value === 10` AND `Math.abs(tweened - 10)
 * < 0.05`; that second clause gates the visual until the ease-out
 * settles, otherwise the shimmer kicks in at ~7.2 as the rAF walks
 * past on its way up, which defeats the "you earned this" feel.
 */
export default function AnimatedKPI({
  label,
  value,
  format,
  sub,
  accent = false,
  title,
  perfect = false,
  variant = 'default',
}) {
  // When value is null/undefined pass 0 so the hook still runs in a
  // quiet state; the render branch below skips format(tweened) and
  // shows `—` instead. This keeps the number of hooks stable across
  // renders (rules-of-hooks).
  const tweened = useCountUp(value ?? 0, 800);

  const showPerfect =
    perfect
    && value === 10
    && Math.abs(tweened - 10) < 0.05;

  const valueClass = showPerfect
    ? 'kpi-perfect'
    : accent
      ? 'text-curve-700'
      : 'text-sand-900';

  // `default` = dashboard-size card (p-6, text-2xl, caption at 12px).
  // `compact` = the /categories KPI strip (p-4, text-xl, caption at
  // 11px), kept visually identical to the old local component so
  // promoting didn't regress the master-detail layout.
  const isCompact = variant === 'compact';
  const shellClass = isCompact
    ? 'rounded-2xl border border-sand-200 bg-white p-4'
    : 'card animate-fade-in-up';
  const labelClass = isCompact
    ? 'text-[11px] font-medium uppercase tracking-wide text-sand-400'
    : 'text-xs font-medium uppercase tracking-wide text-sand-400';
  const valueSizeClass = isCompact ? 'text-xl' : 'text-2xl';

  return (
    <div className={shellClass} title={title}>
      <p className={labelClass}>{label}</p>
      <p
        className={`mt-2 ${valueSizeClass} font-semibold ${valueClass}`}
        data-count-up
      >
        {value == null ? '—' : format(tweened)}
      </p>
      {sub && <p className="mt-1 text-xs text-sand-400">{sub}</p>}
    </div>
  );
}
