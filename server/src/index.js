import 'dotenv/config';
import express from 'express';
import cors from 'cors';
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

app.use(cors());
app.use(express.json());

// Routes — auth is public, everything else requires a valid token
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
