/**
 * <WizardLayout> — shared chrome for steps 1–5.
 *
 * Keeps every functional step visually consistent (centered card on
 * a sand stage, title + optional subtitle, content slot, error slot,
 * action row at the bottom) so we don't have to re-style each one
 * individually. The HeroScreen intentionally bypasses this wrapper
 * because it's the polished reference.
 *
 * Slots:
 *   - eyebrow   uppercase label above the title (optional)
 *   - title     main heading (required)
 *   - subtitle  friendly explainer (optional)
 *   - children  the step body (form, QR, toggles, etc.)
 *   - error     string or null — rendered at the bottom of the card
 *   - actions   ReactNode — rendered after the body, above the error
 */
import Screen from './Screen.jsx';

export default function WizardLayout({
  eyebrow,
  title,
  subtitle,
  children,
  error,
  actions,
  id,
}) {
  return (
    <Screen id={id} className="min-h-screen w-full flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-xl">
        <div className="bg-white rounded-3xl border border-sand-200 shadow-sm p-8 md:p-10">
          {eyebrow && (
            <p className="uppercase tracking-[0.18em] text-xs font-medium text-sand-600 mb-3">
              {eyebrow}
            </p>
          )}
          <h1 className="text-2xl md:text-3xl font-semibold text-sand-950 leading-tight">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-3 text-base text-sand-700 leading-relaxed">
              {subtitle}
            </p>
          )}

          <div className="mt-6">{children}</div>

          {error && (
            <div
              role="alert"
              className="mt-4 rounded-xl border border-red-200 bg-red-50 text-red-800 px-4 py-3 text-sm"
            >
              {error}
            </div>
          )}

          {actions && <div className="mt-6 flex flex-wrap gap-3">{actions}</div>}
        </div>
      </div>
    </Screen>
  );
}
