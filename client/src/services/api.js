const BASE = '/api';

async function request(path, options = {}) {
  const token = localStorage.getItem('token');
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const { timeoutMs, ...fetchOpts } = options;
  let signal = fetchOpts.signal;
  let controller;
  if (timeoutMs && !signal) {
    controller = new AbortController();
    signal = controller.signal;
    setTimeout(() => controller.abort(), timeoutMs);
  }

  let res;
  try {
    res = await fetch(`${BASE}${path}`, { ...fetchOpts, headers, signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Pedido expirou — o servidor não respondeu a tempo.');
    }
    throw err;
  }

  if (res.status === 401 && !path.startsWith('/auth/')) {
    window.dispatchEvent(new Event('auth:logout'));
    throw new Error('Sessão expirada.');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

// Auth
export const login = (data) =>
  request('/auth/login', { method: 'POST', body: JSON.stringify(data) });

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
  request('/curve/test-connection', { method: 'POST', timeoutMs: 15_000 });

// Curve Sync
export const triggerSync = (params) =>
  request(`/curve/sync${params ? '?' + new URLSearchParams(params) : ''}`, {
    method: 'POST',
    timeoutMs: 120_000,
  });

// Curve OAuth wizard
export const checkOAuthEmail = (email) =>
  request('/curve/oauth/check-email', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });

// startOAuth blocks on the server until MSAL's deviceCodeCallback fires
// (<1 s usually, capped at 10 s by the server). Give it enough slack for
// cold-start + network + Azure latency before the frontend gives up.
export const startOAuth = (email) =>
  request('/curve/oauth/start', {
    method: 'POST',
    body: JSON.stringify({ email }),
    timeoutMs: 20_000,
  });

export const pollOAuth = () =>
  request('/curve/oauth/poll', { method: 'POST' });

export const cancelOAuth = () =>
  request('/curve/oauth/cancel', { method: 'POST' });

export const getOAuthStatus = () => request('/curve/oauth/status');

// Curve Logs
export const getCurveLogs = (params) =>
  request(`/curve/logs?${new URLSearchParams(params)}`);

// Autocomplete
export const autocomplete = (field) => request(`/autocomplete/${field}`);
