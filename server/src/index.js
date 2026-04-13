import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { connectDB } from './config/db.js';
import expensesRouter from './routes/expenses.js';
import categoriesRouter from './routes/categories.js';
import curveRouter from './routes/curve.js';
import autocompleteRouter from './routes/autocomplete.js';
import authRouter from './routes/auth.js';
import { authenticate } from './middleware/auth.js';
import CurveConfig from './models/CurveConfig.js';
import { startScheduler } from './services/scheduler.js';

const app = express();
const PORT = process.env.PORT || 3001;

// CORS — restrict to CORS_ORIGIN in production, open in development
const corsOrigin = process.env.CORS_ORIGIN;
app.use(cors(corsOrigin ? { origin: corsOrigin.split(','), credentials: true } : {}));
app.use(express.json());

// Rate limiting — strict on login, relaxed on general API
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                   // 10 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas tentativas de login. Tenta novamente em 15 minutos.' },
});

// Registration is rarer than login (a brand-new user only goes through
// /register once) and is a tempting target for scripted account-spam
// or credential-stuffing reconnaissance against the email-collision
// branch. 5/hour per IP matches the OAuth start limiter's tight half:
// generous enough for a household onboarding a couple of accounts in
// parallel, tight enough that mass registration is uninteresting. The
// limiter runs BEFORE the route handler so a 429 short-circuits the
// User.create + Session.create writes cleanly. There is no per-user
// half of a hybrid scheme here — by definition there is no req.userId
// at registration time, so the IP layer is the only knob available.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,                    // 5 registrations per hour per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error:
      'Demasiadas tentativas de registo. Tenta novamente daqui a uma hora.',
  },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,            // 100 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados pedidos. Tenta novamente em breve.' },
});

// Sync rate limiter — per-IP ceiling in a hybrid scheme. This bucket
// is the "shared NAT" layer: it catches the multi-account DDoS variant
// where an attacker spins up N users behind one IP to sidestep the
// tighter per-user cap (which alone would let each synthetic account
// burn its own 3/min). The real per-account abuse guard is
// `perUserSyncLimiter` in routes/curve.js, which runs AFTER the
// `authenticate` middleware so it can key on req.userId. Keep this
// one loose enough that a household with three legitimate users
// behind the same router doesn't trip on each other.
const syncLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,             // 10 syncs per minute, per IP — shared NAT ceiling
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados pedidos de sync. Aguarda um momento.' },
});

// OAuth DAG start — per-IP ceiling in a hybrid scheme, mirroring the
// /sync split. `POST /api/curve/oauth/start` kicks off a Microsoft
// Device Authorization Grant, which:
//   - holds an in-memory `pendingDags` slot with a 15 min TTL per user
//     (see services/oauthWizard.js),
//   - consumes Azure AD quota against our single public-client app_id,
//   - writes a `CurveConfig` stub + an `oauth_start` audit row,
//   - cannot be meaningfully retried at sub-hour cadence by a real human.
//
// This bucket is the shared-NAT layer: it caps an IP regardless of how
// many synthetic accounts a caller spins up, protecting the shared
// Azure quota from multi-account abuse. The real per-account abuse
// guard is `perUserOauthStartLimiter` in routes/curveOAuth.js, which
// runs after `authenticate` so it can key on req.userId. Keep this
// one at ~3× the per-user cap so a household with three legitimate
// users onboarding in parallel doesn't trip on each other.
//
// 15/hour derives from 3 × 5/hour; `docs/EMAIL_AUTH_MVP.md` §4 PR 5
// originally spec'd the blanket 5/hour per-IP cap, which assumed a
// single human per IP — this hybrid relaxes the ceiling for shared
// NATs without loosening the per-account guard.
const oauthStartLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 15,                   // 15 DAG kickoffs per hour per IP — shared NAT ceiling
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error:
      'Demasiados pedidos de autorização. Tenta novamente daqui a uma hora.',
  },
});

// Routes — auth is public, everything else requires a valid token.
// Order matters: express-rate-limit runs for every middleware whose
// path prefix matches, so mount the most specific limiters BEFORE the
// catch-all apiLimiter. That way /oauth/start counts against both its
// own 5/h bucket and the 100/min bucket, and whichever fires first
// wins — which is what we want.
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/register', registerLimiter);
app.use('/api/curve/oauth/start', oauthStartLimiter);
app.use('/api/curve/sync', syncLimiter);
app.use('/api', apiLimiter);
app.use('/api/auth', authRouter);
app.use('/api/expenses', authenticate, expensesRouter);
app.use('/api/categories', authenticate, categoriesRouter);
app.use('/api/curve', authenticate, curveRouter);
app.use('/api/autocomplete', authenticate, autocompleteRouter);

// Health check
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Start
connectDB().then(async () => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });

  // Auto-start scheduler if any config has sync_enabled
  try {
    const hasEnabled = await CurveConfig.exists({ sync_enabled: true });
    if (hasEnabled) {
      startScheduler();
    }
  } catch (err) {
    console.warn(`Scheduler auto-start check failed: ${err.message}`);
  }
});
