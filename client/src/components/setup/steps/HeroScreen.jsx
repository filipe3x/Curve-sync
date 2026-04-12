/**
 * Ecrã 0 — Hero / boas-vindas.
 *
 * The only detailed screen in the MVP skeleton. The remaining steps
 * are deliberately functional (form + button) so we can iterate on
 * design without throwing away working wiring.
 *
 * Composition:
 *   - Fullscreen sand-50 stage, centred content
 *   - Animated "Curve Sync" handwritten logo (CurveSyncLogo)
 *   - Eyebrow tagline + welcoming copy in PT-pt
 *   - Three reassurance pills (seguro / privado / desligável)
 *   - Primary CTA "Começar" → advances to step 1 (email)
 *   - Subtle "saltar por agora" secondary link → closes the wizard
 *     and returns the user to the existing /curve/config page
 *
 * Motion rhythm (top → bottom):
 *   1. Logo reveals (text → infinity ribbon draws) — driven by
 *      CurveSyncLogo's internal timeline, ~2.5 s total
 *   2. Tagline fades up at +0.8 s
 *   3. Copy paragraph fades up at +1.1 s
 *   4. Reassurance pills stagger in at +1.4 s / +1.55 s / +1.7 s
 *   5. CTA button fades up and "heart-beats" gently at +2.0 s
 *
 * This file is the reference for the motion grammar used in the
 * polish pass — other steps can copy its stagger helper once the
 * backlog is tackled.
 */
import { motion, useReducedMotion } from 'motion/react';
import { ShieldCheck, Lock, PowerOff } from 'lucide-react';
import CurveSyncLogo from '../CurveSyncLogo.jsx';

const fadeUp = {
  hidden: { opacity: 0, y: 14 },
  visible: { opacity: 1, y: 0 },
};

export default function HeroScreen({ onStart, onSkip }) {
  const reduced = useReducedMotion();
  const t = (delay) =>
    reduced
      ? { duration: 0 }
      : { duration: 0.6, ease: 'easeOut', delay };

  return (
    <div className="min-h-screen w-full flex items-center justify-center px-6 py-12 bg-gradient-to-b from-sand-50 via-sand-50 to-sand-100">
      <div className="w-full max-w-2xl flex flex-col items-center text-center">
        {/* Logo */}
        <CurveSyncLogo
          className="w-full max-w-md md:max-w-lg text-sand-950 mb-6"
          animate={!reduced}
        />

        {/* Eyebrow tagline */}
        <motion.p
          className="uppercase tracking-[0.2em] text-xs font-medium text-sand-600 mb-3"
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          transition={t(0.8)}
        >
          Bem-vindo
        </motion.p>

        {/* Welcome copy */}
        <motion.h1
          className="text-2xl md:text-3xl font-semibold text-sand-950 max-w-xl leading-tight"
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          transition={t(1.0)}
        >
          Vamos ligar a tua conta de email em três passos.
        </motion.h1>

        <motion.p
          className="mt-4 text-base md:text-lg text-sand-700 max-w-lg leading-relaxed"
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          transition={t(1.15)}
        >
          O Curve Sync lê os recibos que o Curve Card te envia e regista-os
          como despesas, sem precisares de levantar um dedo. Só precisas
          de dar acesso uma vez — prometemos ser rápidos e discretos.
        </motion.p>

        {/* Reassurance pills */}
        <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
          {[
            { icon: ShieldCheck, label: 'Seguro' },
            { icon: Lock, label: 'Só leitura' },
            { icon: PowerOff, label: 'Desligas quando quiseres' },
          ].map((pill, i) => {
            const Icon = pill.icon;
            return (
              <motion.span
                key={pill.label}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white border border-sand-200 text-sand-800 text-sm shadow-sm"
                variants={fadeUp}
                initial="hidden"
                animate="visible"
                transition={t(1.4 + i * 0.15)}
              >
                <Icon className="w-4 h-4 text-sand-600" strokeWidth={1.75} />
                {pill.label}
              </motion.span>
            );
          })}
        </div>

        {/* Primary CTA */}
        <motion.button
          type="button"
          onClick={onStart}
          className="mt-10 inline-flex items-center justify-center gap-2 px-8 py-3.5 rounded-full bg-curve-700 text-white font-medium text-base shadow-lg shadow-curve-900/10 hover:bg-curve-800 active:scale-[0.98] transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-curve-500/25"
          variants={fadeUp}
          initial="hidden"
          animate={
            reduced
              ? 'visible'
              : {
                  opacity: 1,
                  y: 0,
                  // Gentle heart-beat on arrival, then settle.
                  scale: [1, 1.03, 1],
                }
          }
          transition={
            reduced
              ? { duration: 0 }
              : {
                  duration: 0.6,
                  ease: 'easeOut',
                  delay: 2.0,
                  scale: {
                    duration: 1.6,
                    ease: 'easeInOut',
                    delay: 2.6,
                    times: [0, 0.5, 1],
                  },
                }
          }
        >
          Começar
        </motion.button>

        {/* Secondary "skip for now" */}
        <motion.button
          type="button"
          onClick={onSkip}
          className="mt-4 text-sm text-sand-600 hover:text-sand-900 underline underline-offset-4 decoration-sand-300 hover:decoration-sand-700 transition-colors"
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          transition={t(2.2)}
        >
          Saltar por agora
        </motion.button>
      </div>
    </div>
  );
}
