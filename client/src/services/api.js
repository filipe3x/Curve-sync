const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

// Expenses
export const getExpenses = (params) =>
  request(`/expenses?${new URLSearchParams(params)}`);

export const createExpense = (data) =>
  request('/expenses', { method: 'POST', body: JSON.stringify(data) });

// Categories (read-only)
export const getCategories = () => request('/categories');

// Curve Config
export const getCurveConfig = () => request('/curve/config');

export const updateCurveConfig = (data) =>
  request('/curve/config', { method: 'PUT', body: JSON.stringify(data) });

export const testConnection = () =>
  request('/curve/test-connection', { method: 'POST' });

// Curve Sync
export const triggerSync = () =>
  request('/curve/sync', { method: 'POST' });

// Curve Logs
export const getCurveLogs = (params) =>
  request(`/curve/logs?${new URLSearchParams(params)}`);

// Autocomplete
export const autocomplete = (field) => request(`/autocomplete/${field}`);
