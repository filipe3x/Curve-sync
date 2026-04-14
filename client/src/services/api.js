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

// Self-service registration. Mirrors the login response shape on
// success ({ token, user }) so the caller can hand it straight to
// AuthContext.login() for auto-login.
export const register = (data) =>
  request('/auth/register', { method: 'POST', body: JSON.stringify(data) });

// Expenses
export const getExpenses = (params) =>
  request(`/expenses?${new URLSearchParams(params)}`);

export const createExpense = (data) =>
  request('/expenses', { method: 'POST', body: JSON.stringify(data) });

// Single-expense quick-edit path (docs/Categories.md §12.7). Accepts
// a category_id or null to clear the association. Returns the
// enriched expense (`{ data: { ...expense, category_name } }`).
export const updateExpenseCategory = (id, category_id) =>
  request(`/expenses/${id}/category`, {
    method: 'PUT',
    body: JSON.stringify({ category_id }),
  });

// Categories (read-only)
export const getCategories = () => request('/categories');

// Spend aggregate over a cycle. `cycle` defaults to the day-22 current
// cycle; pass `'previous'` for the one-back view, or `{start, end}`
// for an explicit YYYY-MM-DD range. See docs/Categories.md §8.6 for
// the response shape — the response always has `totals: []` and
// `grand_total: 0` for users with no expenses in the window.
export const getCategoryStats = ({ cycle, start, end } = {}) => {
  const params = new URLSearchParams();
  if (start && end) {
    params.set('start', start);
    params.set('end', end);
  } else if (cycle) {
    params.set('cycle', cycle);
  }
  const qs = params.toString();
  return request(`/categories/stats${qs ? `?${qs}` : ''}`);
};

// Category overrides — personal matching rules. All four calls are
// user-scoped on the server (docs/Categories.md §7.3): the caller only
// ever sees or mutates their own rows, regardless of role. 404 from
// update/delete means "not yours or not there" — the server refuses
// to distinguish to avoid leaking existence.
export const getCategoryOverrides = () => request('/category-overrides');

export const createCategoryOverride = (data) =>
  request('/category-overrides', {
    method: 'POST',
    body: JSON.stringify(data),
  });

export const updateCategoryOverride = (id, data) =>
  request(`/category-overrides/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });

export const deleteCategoryOverride = (id) =>
  request(`/category-overrides/${id}`, { method: 'DELETE' });

// Apply-to-all: retroactively re-run the resolver against every
// expense owned by the caller and rewrite `category_id` wherever the
// new verdict differs. See docs/Categories.md §6 and §8.5.
//
// - `dryRun: true` returns a preview with `matched`, `updated: 0`,
//   and up to 10 `samples` (entity + date + current/new category
//   names). Safe to call on every save to drive the "Aplicar a N
//   despesas passadas" CTA in the UI.
// - `dryRun: false` (default) writes through `reassignCategoryBulk`
//   and emits an `apply_to_all` audit row.
//
// 404 override_not_found covers missing and cross-user ids (§7.5).
// The server scopes every query to `req.userId`, so the caller never
// needs to pass `user_id` from the client.
export const applyCategoryOverride = (id, { dryRun = false } = {}) =>
  request(`/category-overrides/${id}/apply-to-all`, {
    method: 'POST',
    body: JSON.stringify({ dry_run: dryRun }),
    // Bulk re-validation over every user expense is not bounded by
    // a coarse filter in the MVP (§6.6 — full scan was simpler than
    // a provably permissive regex). Give the request enough slack
    // for a ~10k-expense scan without tripping the default fetch
    // timeout.
    timeoutMs: 30_000,
  });

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

// Lightweight poll for the dashboard: returns running/last_sync_at/
// last_sync_status/last_email_at so the UI can drive the re-auth
// banner + "a sincronizar agora" badge without pulling the full config.
export const getSyncStatus = () => request('/curve/sync/status');

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
