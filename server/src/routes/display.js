import { Router } from 'express';
import { computeDashboardStats } from '../services/expenseStats.js';

const router = Router();

// Portuguese month names — matches the short set used by the cycle
// trend chart and by the tooltip copy, so the e-ink display reads the
// same way as the web UI. Full names here (not Jan/Fev/Mar…) because
// e-ink devices have room to breathe and "Janeiro 2026" is cleaner
// than "Jan 2026" on a label-style header.
const MONTHS_PT_FULL = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
];

// Same conversion the dashboard trend card uses for its horizontal
// budget line — see `computeCycleHistory` and `docs/expense-tracking.md`
// → "Linha de orçamento…" for the rationale (average Gregorian month
// is 30.4375 days = ≈ 4.348 weeks, not 4).
const WEEKS_PER_MONTH = 30.4375 / 7;

/**
 * GET /api/display/summary
 *
 * Compact JSON snapshot for external displays (e-ink dashboards, smart
 * mirrors, home-automation panels). Returns the four readings a glance-
 * able screen typically wants: which cycle is active, how much has been
 * spent in it, what the monthly budget is, and the current savings
 * score.
 *
 * Authentication: standard Bearer token (same Session model the web UI
 * uses). Devices log in once via POST /api/auth/login, store the token,
 * and attach it as `Authorization: Bearer <token>` on every call.
 * Sessions currently last 1 day; if the device poll cadence is daily,
 * re-auth at the next refresh is expected. See docs/AUTH.md.
 *
 * Response shape (all fields guaranteed to exist; cycle is never null
 * because the default cycleDay = 22 is applied even when the user has
 * no CurveConfig yet):
 *
 *   {
 *     "cycle": {
 *       "month_label": "Abril 2026",      // pt-PT — labelled by the end
 *                                         // month of the cycle (where
 *                                         // most of its days fall)
 *       "month": "Abril",
 *       "year": 2026,
 *       "start": "2026-03-22",             // inclusive, ISO date
 *       "end":   "2026-04-21"              // inclusive, ISO date
 *     },
 *     "spent": 123.45,                     // EUR, cycle-to-date
 *     "budget": {
 *       "weekly":  73.75,                  // EUR (raw config value)
 *       "monthly": 321.00                  // EUR (weekly × 30.4375/7)
 *     },
 *     "savings_score": 8.1,                // 0–10, 1dp
 *     "currency": "EUR",
 *     "generated_at": "2026-04-19T14:32:10.123Z"
 *   }
 *
 * Rounding: amounts are rounded to 2 dp, score to 1 dp. `monthly`
 * budget is the same value shown on the dashboard trend chart's
 * reference line, so the two surfaces agree.
 */
router.get('/summary', async (req, res) => {
  try {
    const stats = await computeDashboardStats({ userId: req.userId });
    // `stats.cycle.end` is `YYYY-MM-DD`. Label the cycle by its END
    // month — a 22 Mar → 21 Abr cycle reads as "Abril" (where most of
    // its 30 days live), and the day-1 case (1 Abr → 30 Abr) also
    // labels cleanly as "Abril".
    const endDate = new Date(`${stats.cycle.end}T00:00:00Z`);
    const monthIdx = endDate.getUTCMonth();
    const year = endDate.getUTCFullYear();
    const monthName = MONTHS_PT_FULL[monthIdx];

    const monthlyBudget =
      Math.round(stats.weekly_budget * WEEKS_PER_MONTH * 100) / 100;

    res.json({
      cycle: {
        month_label: `${monthName} ${year}`,
        month: monthName,
        year,
        start: stats.cycle.start,
        end: stats.cycle.end,
      },
      spent: stats.month_total,
      budget: {
        weekly: stats.weekly_budget,
        monthly: monthlyBudget,
      },
      savings_score: stats.savings_score,
      currency: 'EUR',
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
