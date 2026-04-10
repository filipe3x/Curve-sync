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

const syncLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 3,              // 3 syncs per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados pedidos de sync. Aguarda um momento.' },
});

// Routes — auth is public, everything else requires a valid token
app.use('/api/auth/login', loginLimiter);
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
