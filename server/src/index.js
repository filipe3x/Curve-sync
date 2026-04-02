import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { connectDB } from './config/db.js';
import expensesRouter from './routes/expenses.js';
import categoriesRouter from './routes/categories.js';
import curveRouter from './routes/curve.js';
import autocompleteRouter from './routes/autocomplete.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Routes
app.use('/api/expenses', expensesRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/curve', curveRouter);
app.use('/api/autocomplete', autocompleteRouter);

// Health check
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

// Start
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
