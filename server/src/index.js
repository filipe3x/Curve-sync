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

// Sync rate limiter — keeps a single user (or, in shared-NAT setups,
// a whole household) from hammering the IMAP+parse pipeline. Each
// sync opens a TLS XOAUTH2 IMAP session, runs SEARCH UNSEEN SINCE,
// fetches + parses every match, writes dedup digests + audit rows,
// and updates stats. 3/min is far above any realistic human cadence
// while still leaving room for a quick "did it work?" double-click.
//
// TODO (post-MVP, multi-user): switch to a hybrid scheme — keep this
// per-IP bucket as a loose "shared NAT" ceiling (e.g. 10/min so a
// household with three users behind the same router doesn't trip on
// each other) AND add a tighter per-user bucket (e.g. 3/min keyed on
// req.userId) as the real abuse guard.
//
//   const sharedIpLimiter = rateLimit({ windowMs: 60_000, max: 10 });
//   const perUserLimiter  = rateLimit({
//     windowMs: 60_000,
//     max: 3,
//     keyGenerator: (req) => req.userId || req.ip,
//   });
//
// Blocker right now: this limiter is mounted at line 76, BEFORE the
// `authenticate` middleware applied to /api/curve at line 81. At
// limiter execution time `req.userId` is still undefined, so a
// `keyGenerator` that reads it would silently degrade to an
// all-anonymous-users-share-one-bucket footgun. To enable the
// per-user variant we'd need to either:
//
//   (a) move the per-user limiter INTO curveRouter, attached to the
//       POST /sync handler in routes/curve.js so it runs AFTER the
//       sub-router's auth middleware, OR
//   (b) explicitly chain `authenticate` before the limiter here:
//         app.use('/api/curve/sync', authenticate, perUserLimiter);
//       which double-authenticates (once here, once in the curve
//       sub-router) but keeps all rate-limit config in one file.
//
// Option (a) is cleaner; option (b) keeps this file as the single
// source of truth for rate budgets. Pick when fase 2 (Gmail +
// proper multi-user) actually ships.
const syncLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 3,              // 3 syncs per minute, per IP (see TODO above)
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
