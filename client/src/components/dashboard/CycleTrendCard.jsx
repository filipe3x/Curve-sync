import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useNavigate } from 'react-router-dom';

/**
 * Dashboard trend chart — per-cycle total spend with inter-cycle delta
 * cues, a trailing 3-cycle moving average, and a budget reference line.
 * ROADMAP §2.8. Data shape is whatever the `/api/expenses` meta's
 * `cycle_history` payload returns (see
 * `server/src/services/expenseStats.js → computeCycleHistory`).
 *
 * UX decisions (worth writing down because they shape the whole card):
 *
 * - **Colour cue is not the only signal.** Each bar is green when the
 *   user spent less than the previous cycle and curve-red when they
 *   spent more — but the tooltip also carries `↑ / ↓` arrows and a
 *   plain-language delta so the card degrades well for colour-blind
 *   users. The first bar (no previous cycle) stays sand-neutral.
 *
 * - **The in-progress cycle fades.** The most recent bar — the one
 *   containing `now` — renders at lower opacity and gets a dashed
 *   border via a pattern fill, because its total is still moving. This
 *   is the single most useful affordance when a user is trying to read
 *   "am I on track this month?".
 *
 * - **Toggle defaults follow the data.** 12m by default. If the user
 *   only has ≤ 6 cycles of history, the toggle snaps to 6m and the
 *   12m/24m buttons are disabled — there's no point offering a
 *   window bigger than the data.
 *
 * - **Budget line is a reference, not a target.** Dashed horizontal
 *   line at `weekly_budget × 4.33` (≈ monthly equivalent). Bars that
 *   cross it read naturally as overspend without us having to add
 *   text.
 */

const MONTHS_PT = [
  'Jan',
  'Fev',
  'Mar',
  'Abr',
  'Mai',
  'Jun',
  'Jul',
  'Ago',
  'Set',
  'Out',
  'Nov',
  'Dez',
];

const EUR = new Intl.NumberFormat('pt-PT', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 2,
});

// Compact EUR formatter for the Y axis — "€250" not "€250,00" so the
// tick labels fit at 11 px without clipping. Integer rounding is fine
// at axis scale.
function shortEur(v) {
  return `€${Math.round(Number(v ?? 0))}`;
}

function parseISOUtc(iso) {
  return new Date(`${iso}T00:00:00Z`);
}

// Axis label: "22 Mar". Short enough to fit 24 bars on a typical card,
// unambiguous enough to tell neighbouring cycles apart.
function shortCycleLabel(cycleStart) {
  const d = parseISOUtc(cycleStart);
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${day} ${MONTHS_PT[d.getUTCMonth()]}`;
}

// Tooltip label: "22 Mar → 21 Abr 2026". Carries the year on the end
// side only — the start side inherits it by proximity and keeps the
// line compact.
function fullCycleWindowLabel(cycleStart, cycleEnd) {
  const s = parseISOUtc(cycleStart);
  const e = parseISOUtc(cycleEnd);
  const sStr = `${s.getUTCDate()} ${MONTHS_PT[s.getUTCMonth()]}`;
  const eStr = `${e.getUTCDate()} ${MONTHS_PT[e.getUTCMonth()]} ${e.getUTCFullYear()}`;
  return `${sStr} → ${eStr}`;
}

// Tailwind tokens resolved to concrete hex so recharts (which doesn't
// know about our theme) renders consistently. Mirrors
// `client/tailwind.config.js`.
const COLORS = {
  curve600: '#c04e30',
  curve700: '#a03d27',
  emerald500: '#10b981',
  emerald600: '#059669',
  sand200: '#e6e1d8',
  sand300: '#d4ccbd',
  sand400: '#bfb39e',
  sand500: '#b0a089',
  sand600: '#a08e77',
  sand700: '#857563',
  sand900: '#5a5046',
};

function colorForDelta(delta) {
  if (delta == null) return COLORS.sand400;
  if (delta < 0) return COLORS.emerald500;
  return COLORS.curve600;
}

function TrendBadge({ trend }) {
  if (!trend) return null;
  const cfg = {
    down: {
      label: '↓',
      className: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/70',
    },
    up: {
      label: '↑',
      className: 'bg-curve-50 text-curve-700 ring-1 ring-curve-200/70',
    },
    stable: {
      label: '→',
      className: 'bg-sand-50 text-sand-700 ring-1 ring-sand-200/70',
    },
  }[trend.direction] ?? {
    label: '·',
    className: 'bg-sand-50 text-sand-700 ring-1 ring-sand-200/70',
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${cfg.className}`}
      title={trend.text}
    >
      <span aria-hidden="true">{cfg.label}</span>
      <span>{trend.text}</span>
    </span>
  );
}

function CycleTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const deltaText =
    row.delta_absolute == null
      ? 'Primeiro ciclo'
      : `${row.delta_absolute < 0 ? '↓' : '↑'} ${EUR.format(
          Math.abs(row.delta_absolute),
        )}${row.delta_pct != null ? ` · ${row.delta_pct > 0 ? '+' : ''}${row.delta_pct.toFixed(1)} %` : ''}`;
  const deltaColor =
    row.delta_absolute == null
      ? 'text-sand-500'
      : row.delta_absolute < 0
        ? 'text-emerald-700'
        : 'text-curve-700';

  return (
    <div
      className="rounded-2xl border border-sand-200 bg-white px-4 py-3 text-xs shadow-lg"
      style={{ minWidth: 220 }}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="font-semibold text-sand-900">
          {fullCycleWindowLabel(row.cycle_start, row.cycle_end)}
        </p>
        {row.in_progress && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
            em curso
          </span>
        )}
      </div>
      <p className="mt-2 text-base font-semibold text-sand-900">
        {EUR.format(row.total)}
        <span className="ml-2 text-xs font-normal text-sand-500">
          ({row.expense_count} {row.expense_count === 1 ? 'despesa' : 'despesas'})
        </span>
      </p>
      <p className={`mt-0.5 ${deltaColor}`}>
        {deltaText}
        {row.delta_absolute != null && (
          <span className="text-sand-500"> vs ciclo anterior</span>
        )}
      </p>
      {(row.top_entity || row.top_category) && (
        <div className="mt-2 space-y-0.5 border-t border-sand-100 pt-2 text-sand-600">
          {row.top_entity && (
            <p>
              <span className="text-sand-400">Top entidade</span>{' '}
              <span className="font-medium text-sand-800">
                {row.top_entity.name}
              </span>{' '}
              · {EUR.format(row.top_entity.total)}
            </p>
          )}
          {row.top_category && (
            <p>
              <span className="text-sand-400">Categoria dominante</span>{' '}
              <span className="font-medium text-sand-800">
                {row.top_category.name}
              </span>{' '}
              · {row.top_category.pct} %
            </p>
          )}
        </div>
      )}
      <p className="mt-2 text-[10px] text-sand-400">
        Clica para abrir /expenses neste ciclo
      </p>
    </div>
  );
}

// localStorage key for the user's preferred window size. Any code
// that reads/writes the chart toggle goes through the helpers below —
// they tolerate a disabled / quota-exceeded / SSR-absent `localStorage`
// without throwing, so a sandboxed iframe or Safari Private Mode can
// still render the chart (they just lose the persistence benefit).
const STORAGE_KEY = 'cycle-trend-window';
const VALID_SIZES = [6, 12, 24];

// Tailwind's `sm` breakpoint is 640 px, so "mobile" for our purposes
// is anything below that. At < 640 px the card has ~327 px of plot
// area (24 px padding × 2 for the card, 48 px for the Y-axis), which
// fits 6 bars comfortably and 12 bars crowded — 24 bars collapse into
// 11-px slivers that can't carry a label, so we cap rendering and
// hide the 24m option entirely on narrow viewports.
const MOBILE_QUERY = '(max-width: 639px)';
const MOBILE_MAX_BARS = 12;

// Minimal media-query hook. Lives here (not in hooks/) because nothing
// else in the app needs it yet — promote to a shared hook the first
// time a second consumer appears. SSR-safe via the `matchMedia`
// optional-chain, even though this project is CSR-only (belt and
// braces for the eventual Vite SSR migration or component-test
// environment).
function useMediaQuery(query) {
  const getMatches = () => {
    const mql = globalThis.matchMedia?.(query);
    return mql ? mql.matches : false;
  };
  const [matches, setMatches] = useState(getMatches);
  useEffect(() => {
    const mql = globalThis.matchMedia?.(query);
    if (!mql) return undefined;
    const onChange = (event) => setMatches(event.matches);
    // `addEventListener('change', ...)` is supported on every browser
    // we care about (Safari 14+, Chrome 67+). The older
    // `addListener`/`removeListener` pair is not wired here — if we
    // ever need to support pre-2020 Safari, swap it in.
    mql.addEventListener('change', onChange);
    setMatches(mql.matches); // sync if the query changed between
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

function readStoredSize() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const parsed = Number(raw);
    if (VALID_SIZES.includes(parsed)) return parsed;
  } catch {
    /* localStorage unavailable — ignore */
  }
  return null;
}

function writeStoredSize(size) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, String(size));
  } catch {
    /* best-effort; a failed write shouldn't crash the toggle click */
  }
}

export default function CycleTrendCard({ history }) {
  const navigate = useNavigate();
  const isMobile = useMediaQuery(MOBILE_QUERY);

  const allCycles = history?.cycles ?? [];
  const available = allCycles.length;

  // Initial window resolution, in order of precedence:
  //   1. User's explicit persisted preference (localStorage).
  //   2. Viewport-aware heuristic:
  //      - Mobile  → always 6m, regardless of data volume. 12 bars at
  //        375 px is already crowded; respecting desktop's "12m when
  //        history > 6" would crush the chart on a phone.
  //      - Desktop → ≤ 6 cycles → 6m, otherwise 12m.
  // The persisted value may be *larger* than `available` (user saved
  // 24m, then lost most of their data) or than what the viewport can
  // render (saved 24m on desktop, opened on mobile). `effectiveSize`
  // below clamps both cases on every render, so the chart always
  // paints the right number of bars. `size` is preserved verbatim so
  // that when history grows back or the user rotates to landscape
  // their 24m preference resurfaces automatically.
  const [size, setSize] = useState(() => {
    const stored = readStoredSize();
    if (stored != null) return stored;
    if (isMobile) return 6;
    return available <= 6 ? 6 : 12;
  });

  // Size may drift when the parent re-renders with a longer/shorter
  // history or when the viewport rotates. Re-derive what's actually
  // renderable without mutating state unless the user explicitly
  // picks something out of range.
  const effectiveSize = useMemo(() => {
    if (available === 0) return 0;
    if (available <= 6) return Math.min(6, available);
    // Mobile clamps to 12 even if `size` is 24 — 24 bars at 375 px
    // collapse to unreadable slivers. The raw preference stays in
    // state so desktop restores the full 24 once the viewport grows.
    const target = isMobile ? Math.min(size, MOBILE_MAX_BARS) : size;
    return Math.min(target, available);
  }, [available, size, isMobile]);

  // Wrapping setSize — every click-through-to-change goes through
  // here so localStorage and state stay in sync. The `disabled` gate
  // on the button itself prevents invalid values from reaching this
  // handler, but we re-check against `VALID_SIZES` as defence in depth
  // (callers evolve; a stray `setSize(NaN)` would silently poison the
  // storage key for next mount).
  const handlePickSize = (opt) => {
    if (!VALID_SIZES.includes(opt)) return;
    setSize(opt);
    writeStoredSize(opt);
  };

  const visible = useMemo(
    () => allCycles.slice(-effectiveSize),
    [allCycles, effectiveSize],
  );

  // Bar label visibility scales with the number of bars — 6 bars have
  // enough room to carry the delta pct above the top; 24 bars don't,
  // so we hide it there and lean on the tooltip.
  const showBarDeltas = visible.length <= 8;

  // Empty state mirrors the /categories page: empty illustration +
  // copy, no chart rendering. One-cycle histories also fall into this
  // bucket because a single bar with no delta tells the user nothing
  // about trend — the promise of the card is comparison, not absolute
  // levels.
  if (available <= 1) {
    return (
      <div className="card animate-fade-in-up">
        <header className="mb-4">
          <h3 className="text-lg font-semibold text-sand-800">
            Evolução por ciclo
          </h3>
          <p className="mt-1 text-xs text-sand-500">
            Regressa daqui a um ciclo para veres a tua tendência.
          </p>
        </header>
        <div className="flex h-40 items-center justify-center rounded-xl bg-sand-50 text-sm text-sand-400">
          Ainda sem histórico suficiente
        </div>
      </div>
    );
  }

  // 24m is hidden on mobile (not disabled) — listing an option the
  // user can never meaningfully pick just clutters the toggle. The
  // stored preference stays 24 if they set it on desktop; viewport
  // clamping handles the render.
  const toggleOptions = isMobile ? [6, 12] : [6, 12, 24];
  const budget = history.monthly_budget;
  const average = history.average;

  // Pre-compute the sr-only table rows once; screen readers get the
  // same information as the chart without us needing recharts' own
  // a11y plumbing.
  const srRows = visible;

  return (
    <div className="card animate-fade-in-up">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-lg font-semibold text-sand-800">
              Evolução por ciclo
            </h3>
            <TrendBadge trend={history.trend} />
          </div>
          <p className="mt-1 text-xs text-sand-500">
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: COLORS.emerald500 }}
                aria-hidden="true"
              />
              Gastaste menos que no ciclo anterior
            </span>
            <span className="mx-2 text-sand-300">·</span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: COLORS.curve600 }}
                aria-hidden="true"
              />
              Gastaste mais
            </span>
          </p>
        </div>

        <div
          className="inline-flex shrink-0 rounded-full bg-sand-100 p-1 text-xs"
          role="group"
          aria-label="Janela temporal"
        >
          {toggleOptions.map((opt) => {
            const disabled = opt > available;
            const active = effectiveSize === opt;
            return (
              <button
                key={opt}
                type="button"
                onClick={() => !disabled && handlePickSize(opt)}
                disabled={disabled}
                aria-pressed={active}
                className={`rounded-full px-3 py-1 font-medium transition-colors ${
                  active
                    ? 'bg-white text-sand-900 shadow-sm'
                    : disabled
                      ? 'cursor-not-allowed text-sand-300'
                      : 'text-sand-600 hover:text-sand-900'
                }`}
                title={
                  disabled
                    ? `Precisas de ${opt} ciclos de histórico`
                    : `Últimos ${opt} ciclos`
                }
              >
                {opt}m
              </button>
            );
          })}
        </div>
      </header>

      <div
        role="img"
        aria-label={`Gráfico de evolução de despesas nos últimos ${visible.length} ciclos`}
        className="h-64 w-full"
      >
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={visible}
            margin={{ top: showBarDeltas ? 24 : 12, right: 8, left: 0, bottom: 0 }}
            onClick={(state) => {
              // recharts passes `activePayload` on any click inside
              // the chart; the bar click handler below also fires.
              // Keeping the navigation in one place avoids double-
              // navigating when both fire.
              const p = state?.activePayload?.[0]?.payload;
              if (!p) return;
              navigate(
                `/expenses?start=${encodeURIComponent(p.cycle_start)}&end=${encodeURIComponent(p.cycle_end)}`,
              );
            }}
          >
            <defs>
              {/* Diagonal hatch pattern for the in-progress bar — a
                  strong but unobtrusive "this is still moving" cue
                  that works without colour. */}
              <pattern
                id="cycle-in-progress"
                patternUnits="userSpaceOnUse"
                width="6"
                height="6"
                patternTransform="rotate(45)"
              >
                <rect width="6" height="6" fill={COLORS.sand200} />
                <line
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="6"
                  stroke={COLORS.sand400}
                  strokeWidth="2"
                />
              </pattern>
            </defs>
            <CartesianGrid
              stroke={COLORS.sand200}
              strokeDasharray="3 3"
              vertical={false}
            />
            <XAxis
              dataKey="cycle_start"
              tickFormatter={shortCycleLabel}
              tick={{ fontSize: 11, fill: COLORS.sand600 }}
              tickLine={false}
              axisLine={{ stroke: COLORS.sand200 }}
              interval="preserveStartEnd"
              minTickGap={16}
            />
            <YAxis
              tickFormatter={shortEur}
              tick={{ fontSize: 11, fill: COLORS.sand500 }}
              tickLine={false}
              axisLine={false}
              width={48}
            />
            <Tooltip
              content={<CycleTooltip />}
              cursor={{ fill: COLORS.sand100, fillOpacity: 0.4 }}
            />

            {/* Monthly-equivalent budget — a soft horizontal anchor.
                Labelled inline on the right side so the user can tell
                it apart from the moving-average line. */}
            {Number.isFinite(budget) && budget > 0 && (
              <ReferenceLine
                y={budget}
                stroke={COLORS.sand400}
                strokeDasharray="5 4"
                ifOverflow="extendDomain"
                label={{
                  value: `Orçamento ${shortEur(budget)}`,
                  position: 'insideTopRight',
                  fill: COLORS.sand600,
                  fontSize: 10,
                }}
              />
            )}

            <Bar
              dataKey="total"
              radius={[6, 6, 0, 0]}
              isAnimationActive
              animationDuration={700}
              cursor="pointer"
            >
              {visible.map((row, i) => (
                <Cell
                  key={`cell-${row.cycle_start}-${i}`}
                  fill={
                    row.in_progress
                      ? 'url(#cycle-in-progress)'
                      : colorForDelta(row.delta_absolute)
                  }
                  fillOpacity={row.in_progress ? 0.85 : 1}
                  stroke={row.in_progress ? COLORS.sand500 : undefined}
                  strokeDasharray={row.in_progress ? '3 2' : undefined}
                  strokeWidth={row.in_progress ? 1 : 0}
                />
              ))}
            </Bar>

            {/* Moving-average trend line — only for histories with at
                least 3 complete cycles; recharts skips nulls cleanly. */}
            <Line
              type="monotone"
              dataKey="moving_avg_3"
              stroke={COLORS.sand700}
              strokeWidth={1.75}
              dot={false}
              activeDot={{ r: 3, fill: COLORS.sand900 }}
              isAnimationActive
              animationDuration={700}
              connectNulls={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <footer className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-sand-500">
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-0.5 w-5 rounded-full"
            style={{ backgroundColor: COLORS.sand700 }}
            aria-hidden="true"
          />
          Média móvel (3 ciclos)
        </span>
        {Number.isFinite(average) && average > 0 && (
          <span>
            Média dos ciclos completos:{' '}
            <span className="font-medium text-sand-800">
              {EUR.format(average)}
            </span>
          </span>
        )}
      </footer>

      {/* Screen-reader-only table with the same data — recharts renders
          SVG that isn't discoverable by assistive tech. */}
      <table className="sr-only">
        <caption>
          Totais por ciclo nos últimos {visible.length} ciclos
        </caption>
        <thead>
          <tr>
            <th>Início</th>
            <th>Fim</th>
            <th>Total</th>
            <th>Variação</th>
          </tr>
        </thead>
        <tbody>
          {srRows.map((row) => (
            <tr key={row.cycle_start}>
              <td>{row.cycle_start}</td>
              <td>{row.cycle_end}</td>
              <td>{EUR.format(row.total)}</td>
              <td>
                {row.delta_absolute == null
                  ? '—'
                  : `${row.delta_absolute < 0 ? 'menos' : 'mais'} ${EUR.format(Math.abs(row.delta_absolute))}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
