/**
 * Curve Sync first-time setup wizard — container + state machine.
 *
 * Flow (see docs/EMAIL_AUTH.md §5.0.5 for the UX plan and
 *      docs/EMAIL_AUTH_MVP.md §4 for the API contract):
 *
 *   0. hero      → welcome + animated logo + "Começar"
 *   1. email     → user types email; we call /oauth/check-email
 *   2. trust     → show what we will access, ask consent
 *   3. code      → show DAG user code + URL + QR; poll /oauth/poll
 *   4. success   → tokens stored, show bound mailbox
 *   5. schedule  → opt into automatic sync + interval, write config
 *
 * Why a single file for the state machine (instead of a context or
 * reducer): the skeleton only has ~6 screens and a flat bag of data
 * (email, codeInfo, error). A useReducer here is overkill; plain
 * useState is easier to iterate on while the UX is still in flux.
 * The polish pass may refactor to a reducer once the shape stabilises.
 *
 * This file is intentionally thin on presentation: each step lives in
 * `components/setup/steps/<Step>Screen.jsx`. HeroScreen is the one
 * polished-in-detail reference; the remaining screens are strictly
 * functional (forms + buttons + clear error surfaces).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence } from 'motion/react';
import {
  checkOAuthEmail,
  startOAuth,
  pollOAuth,
  cancelOAuth,
  updateCurveConfig,
} from '../services/api.js';
import HeroScreen from '../components/setup/steps/HeroScreen.jsx';
import EmailScreen from '../components/setup/steps/EmailScreen.jsx';
import TrustScreen from '../components/setup/steps/TrustScreen.jsx';
import DeviceCodeScreen from '../components/setup/steps/DeviceCodeScreen.jsx';
import SuccessScreen from '../components/setup/steps/SuccessScreen.jsx';
import ScheduleScreen from '../components/setup/steps/ScheduleScreen.jsx';

const STEPS = ['hero', 'email', 'trust', 'code', 'success', 'schedule'];

export default function CurveSetupPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState('hero');
  const [email, setEmail] = useState('');
  const [provider, setProvider] = useState(null);
  const [codeInfo, setCodeInfo] = useState(null);
  const [pollStatus, setPollStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const pollTimer = useRef(null);

  // ----- Step navigation -----
  const goTo = useCallback((next) => {
    setError(null);
    setStep(next);
  }, []);

  // ----- Step 1 → 2: validate email via /check-email ------------------
  const handleCheckEmail = useCallback(
    async (typedEmail) => {
      setLoading(true);
      setError(null);
      try {
        const res = await checkOAuthEmail(typedEmail);
        setEmail(typedEmail);
        setProvider(res.provider);
        if (res.supported) {
          goTo('trust');
        } else {
          setError(
            'Este domínio ainda não suporta OAuth. Podes usar o formulário manual (App Password) na página de configuração.',
          );
        }
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    },
    [goTo],
  );

  // ----- Step 2 → 3: kick off the DAG ---------------------------------
  const handleStartAuth = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await startOAuth(email);
      setCodeInfo({
        userCode: res.userCode,
        verificationUri: res.verificationUri,
        expiresIn: res.expiresIn,
      });
      setPollStatus('pending');
      goTo('code');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [email, goTo]);

  // ----- Step 3 polling loop ------------------------------------------
  // Runs while step === 'code'. Clears itself on unmount / step change.
  useEffect(() => {
    if (step !== 'code') {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
      return;
    }
    const tick = async () => {
      try {
        const res = await pollOAuth();
        if (res.status === 'done') {
          setPollStatus('done');
          setEmail(res.email || email);
          goTo('success');
        } else if (res.status === 'error') {
          setPollStatus('error');
          setError(res.error || 'Falha na autorização.');
        } else if (res.status === 'none') {
          // Server forgot about us — the slot was cleared. Most
          // likely the user left the wizard open after a terminal
          // outcome. Bounce them back to the trust screen.
          setPollStatus('idle');
          setError('A sessão de autorização expirou. Tenta novamente.');
          goTo('trust');
        }
      } catch (e) {
        setPollStatus('error');
        setError(e.message);
      }
    };
    tick();
    pollTimer.current = setInterval(tick, 3000);
    return () => {
      if (pollTimer.current) {
        clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // ----- Step 3 cancel -------------------------------------------------
  const handleCancelAuth = useCallback(async () => {
    try {
      await cancelOAuth();
    } catch {
      // best effort — server may have already cleaned up
    }
    setCodeInfo(null);
    setPollStatus('idle');
    goTo('email');
  }, [goTo]);

  // ----- Step 5 finish: persist schedule + exit wizard ----------------
  const handleFinish = useCallback(
    async ({ syncEnabled, intervalMinutes }) => {
      setLoading(true);
      setError(null);
      try {
        await updateCurveConfig({
          sync_enabled: syncEnabled,
          sync_interval_minutes: intervalMinutes,
        });
        navigate('/curve/config');
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    },
    [navigate],
  );

  // ----- Skip wizard entirely ------------------------------------------
  const handleSkip = useCallback(() => {
    navigate('/curve/config');
  }, [navigate]);

  // ----- Render active step -------------------------------------------
  return (
    <main className="min-h-screen w-full bg-sand-50 text-sand-950">
      <AnimatePresence mode="wait">
        {step === 'hero' && (
          <HeroScreen
            key="hero"
            onStart={() => goTo('email')}
            onSkip={handleSkip}
          />
        )}
        {step === 'email' && (
          <EmailScreen
            key="email"
            initialEmail={email}
            loading={loading}
            error={error}
            onSubmit={handleCheckEmail}
            onBack={() => goTo('hero')}
            onUseAppPassword={handleSkip}
          />
        )}
        {step === 'trust' && (
          <TrustScreen
            key="trust"
            email={email}
            provider={provider}
            loading={loading}
            error={error}
            onContinue={handleStartAuth}
            onBack={() => goTo('email')}
          />
        )}
        {step === 'code' && (
          <DeviceCodeScreen
            key="code"
            codeInfo={codeInfo}
            pollStatus={pollStatus}
            error={error}
            onCancel={handleCancelAuth}
          />
        )}
        {step === 'success' && (
          <SuccessScreen
            key="success"
            email={email}
            onContinue={() => goTo('schedule')}
          />
        )}
        {step === 'schedule' && (
          <ScheduleScreen
            key="schedule"
            loading={loading}
            error={error}
            onFinish={handleFinish}
            onSkip={handleSkip}
          />
        )}
      </AnimatePresence>

      {/* Step indicator — bottom-centre, functional-only */}
      {step !== 'hero' && (
        <StepDots current={STEPS.indexOf(step)} total={STEPS.length} />
      )}
    </main>
  );
}

function StepDots({ current, total }) {
  return (
    <div className="fixed bottom-6 left-0 right-0 flex items-center justify-center gap-2">
      {Array.from({ length: total - 1 }).map((_, i) => {
        const idx = i + 1; // skip hero (idx 0) in the dot row
        const active = idx === current;
        const done = idx < current;
        return (
          <span
            key={idx}
            className={`h-1.5 rounded-full transition-all ${
              active
                ? 'w-6 bg-curve-700'
                : done
                  ? 'w-1.5 bg-curve-700/60'
                  : 'w-1.5 bg-sand-300'
            }`}
          />
        );
      })}
    </div>
  );
}
