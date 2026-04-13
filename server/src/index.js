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

// OAuth DAG start is intentionally rate-limited tighter than the rest
// of the API. `POST /api/curve/oauth/start` kicks off a Microsoft
// Device Authorization Grant, which:
//   - holds an in-memory flow slot with a 15 min TTL per user,
//   - consumes Azure AD quota against our single public-client app_id,
//   - cannot be meaningfully retried at sub-hour cadence by a real human.
// Anything faster than a handful per hour is either a frontend bug or
// a script hammering the endpoint. The spec in
// docs/EMAIL_AUTH_MVP.md §4 PR 5 calls for 5/hour explicitly.
const oauthStartLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,                    // 5 DAG kickoffs per hour per IP
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
