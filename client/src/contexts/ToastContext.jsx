/**
 * Toast notifications (ROADMAP Fase 3.2).
 *
 * Minimal, zero-deps, motion/react-powered. Exposes a `useToast()` hook
 * with three shorthand helpers (`success` / `error` / `info`) plus the
 * canonical `show(opts)` for custom TTL, ids, and actions. The
 * ToastViewport renders all active toasts in a fixed-positioned stack
 * in the top-right corner (bottom-right on ≤ sm where the hamburger
 * topbar already occupies the top row).
 *
 * Design choices:
 *
 *  - **State lives in a Provider, not in zustand or a context-per-page**:
 *    toasts outlive their triggering page (e.g. "sync concluído" should
 *    survive the user navigating away to /expenses). The Provider is
 *    mounted once in main.jsx, above React Router.
 *
 *  - **No external lib**: sonner / react-hot-toast / radix-toast each
 *    ship 2–5 kB gzip and an API surface we don't need. The useful
 *    bits (enter/exit anim, auto-dismiss, aria-live) are 60 lines.
 *
 *  - **Accessible**: the viewport is `role="region"` with
 *    `aria-live="polite"` so screen readers announce new messages
 *    without interrupting current speech. Error toasts escalate to
 *    `aria-live="assertive"` via a second live region.
 *
 *  - **prefers-reduced-motion**: animations collapse to a
 *    near-instant fade via `useReducedMotion()` so users with the OS
 *    flag on don't get the slide-in/slide-out.
 *
 *  - **Auto-dismiss** is 4000 ms by default (5500 for errors so users
 *    can read them); pass `duration: 0` to opt out and require a manual
 *    close.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  CheckCircleIcon,
  ExclamationCircleIcon,
  InformationCircleIcon,
  XMarkIcon,
} from '../components/layout/Icons';

const ToastContext = createContext(null);

// Safety cap — toasts stack vertically, so > 4 at once means the
// viewport swallows the page underneath. Older entries fall off the
// bottom of the stack when a new one arrives above the cap.
const MAX_VISIBLE = 4;

const DEFAULTS = {
  info: { duration: 4000, tone: 'info' },
  success: { duration: 4000, tone: 'success' },
  error: { duration: 5500, tone: 'error' },
};

let idCounter = 0;
function nextId() {
  idCounter += 1;
  return `toast-${Date.now()}-${idCounter}`;
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timersRef = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const show = useCallback(
    (input) => {
      const { id: incomingId, text, tone = 'info', duration } = input || {};
      if (!text || typeof text !== 'string') return null;
      const resolvedDuration =
        typeof duration === 'number'
          ? duration
          : DEFAULTS[tone]?.duration ?? DEFAULTS.info.duration;
      const id = incomingId ?? nextId();

      setToasts((prev) => {
        // Dedup on explicit id — callers that pass `{ id: 'config-save' }`
        // get a single toast that updates in place instead of stacking
        // one per save.
        const withoutExisting = prev.filter((t) => t.id !== id);
        const next = [...withoutExisting, { id, text, tone }];
        if (next.length > MAX_VISIBLE) next.shift();
        return next;
      });

      // Reset any previous timer when an id collides.
      const previousTimer = timersRef.current.get(id);
      if (previousTimer) clearTimeout(previousTimer);
      if (resolvedDuration > 0) {
        timersRef.current.set(
          id,
          setTimeout(() => dismiss(id), resolvedDuration),
        );
      }
      return id;
    },
    [dismiss],
  );

  // Cleanup every pending timer on unmount — critical for StrictMode
  // double-mount and for HMR during dev.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  const api = useMemo(
    () => ({
      show,
      dismiss,
      info: (text, opts) => show({ ...DEFAULTS.info, ...opts, text, tone: 'info' }),
      success: (text, opts) =>
        show({ ...DEFAULTS.success, ...opts, text, tone: 'success' }),
      error: (text, opts) =>
        show({ ...DEFAULTS.error, ...opts, text, tone: 'error' }),
    }),
    [show, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Defensive fallback: if a component renders outside the Provider
    // (tests, Storybook, a forgotten import), return no-ops instead of
    // crashing. The warning helps catch the wiring bug.
    if (typeof console !== 'undefined') {
      // eslint-disable-next-line no-console
      console.warn('useToast called outside ToastProvider — falling back to no-op.');
    }
    const noop = () => null;
    return { show: noop, dismiss: noop, info: noop, success: noop, error: noop };
  }
  return ctx;
}

// ────────── Viewport ──────────

const TONE_CLASSES = {
  success: 'border-emerald-300 bg-emerald-50 text-emerald-900',
  error: 'border-curve-300 bg-curve-50 text-curve-900',
  info: 'border-sand-300 bg-white text-sand-900',
};

const TONE_ICON = {
  success: CheckCircleIcon,
  error: ExclamationCircleIcon,
  info: InformationCircleIcon,
};

const TONE_ICON_COLOR = {
  success: 'text-emerald-600',
  error: 'text-curve-700',
  info: 'text-sand-600',
};

function ToastViewport({ toasts, onDismiss }) {
  const reduceMotion = useReducedMotion();
  // Split into polite vs assertive so screen readers escalate errors
  // without constantly interrupting every info notice.
  const polite = toasts.filter((t) => t.tone !== 'error');
  const assertive = toasts.filter((t) => t.tone === 'error');

  const transitionEnter = reduceMotion
    ? { opacity: 1, y: 0 }
    : { opacity: 1, y: 0 };
  const transitionExit = reduceMotion
    ? { opacity: 0, y: 0 }
    : { opacity: 0, y: -12 };
  const transitionInitial = reduceMotion
    ? { opacity: 0, y: 0 }
    : { opacity: 0, y: -16 };

  const renderList = (list, liveness) => (
    <ol
      role="region"
      aria-live={liveness}
      aria-label={
        liveness === 'assertive' ? 'Notificações de erro' : 'Notificações'
      }
      className="flex flex-col gap-2"
    >
      <AnimatePresence initial={false}>
        {list.map((t) => {
          const Icon = TONE_ICON[t.tone] ?? InformationCircleIcon;
          return (
            <motion.li
              key={t.id}
              layout={!reduceMotion}
              initial={transitionInitial}
              animate={transitionEnter}
              exit={transitionExit}
              transition={{
                duration: reduceMotion ? 0.05 : 0.2,
                ease: 'easeOut',
              }}
              className={`flex w-full items-start gap-3 rounded-xl border px-4 py-3 shadow-sm ${
                TONE_CLASSES[t.tone] ?? TONE_CLASSES.info
              }`}
            >
              <Icon
                className={`mt-0.5 h-5 w-5 shrink-0 ${
                  TONE_ICON_COLOR[t.tone] ?? TONE_ICON_COLOR.info
                }`}
              />
              <p className="min-w-0 flex-1 text-sm leading-snug">{t.text}</p>
              <button
                type="button"
                onClick={() => onDismiss(t.id)}
                aria-label="Fechar notificação"
                className="-mr-1 rounded-md p-1 text-current/70 transition-colors hover:bg-white/60 hover:text-current"
              >
                <XMarkIcon className="h-4 w-4" />
              </button>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ol>
  );

  // pointer-events-none on the container, auto on children lets the
  // user interact with the page underneath between toasts (e.g. the
  // corner avatar or a dropdown) while still being able to dismiss.
  // Anchored top-right at every breakpoint — the 64 px nav rail on
  // the left of mobile would fight a top-center layout, and the
  // desktop sidebar wouldn't care either way.
  return (
    <div
      className="pointer-events-none fixed right-3 top-3 z-50 flex w-[calc(100%-5rem)] max-w-sm flex-col items-stretch gap-2 sm:right-4 sm:top-4 sm:w-auto sm:items-end"
      data-slot="toast-viewport"
    >
      <div className="pointer-events-auto flex w-full max-w-sm flex-col gap-2">
        {renderList(polite, 'polite')}
        {renderList(assertive, 'assertive')}
      </div>
    </div>
  );
}
