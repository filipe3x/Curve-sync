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
  // 204 No Content has an empty body — calling `.json()` on it
  // throws "Unexpected end of JSON input" in the browser. Several
  // handlers use 204 for successful mutations with nothing to return
  // (DELETE /api/category-overrides/:id is the canonical one), so
  // short-circuit here instead of making every caller special-case.
  if (res.status === 204) return null;
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

// Compact id-only fetch of every expense that matches the given
// filter (same params as getExpenses). The server enforces a hard
// ceiling of 500 rows — the client must check `total <= 500` on a
// previous paginated response before calling this, because a 400
// `bulk_too_large` comes back otherwise. Used by the /expenses
// "Seleccionar todas as N" multi-select flow (docs/Categories.md
// §12.x — batch-move).
export const getExpenseIds = (params) =>
  request(
    `/expenses?${new URLSearchParams({ ...(params ?? {}), fields: '_id' })}`,
  );

// Bulk-reassign `category_id` across up to 500 expenses owned by the
// caller. `category_id` accepts an ObjectId hex string or `null` to
// clear. Server rejects anything over 500 with a 400 `invalid_body`.
// Returns `{ moved, skipped, target_category_name }` where `skipped`
// covers rows that were already in the target category, ids the user
// doesn't own, or duplicates in the request payload.
export const bulkMoveExpenses = (ids, category_id) =>
  request('/expenses/bulk-category', {
    method: 'PUT',
    body: JSON.stringify({ ids, category_id }),
    // Worst case is 500 writes server-side. Generous timeout so the
    // UI doesn't surface a spurious "pedido expirou" on slow links.
    timeoutMs: 30_000,
  });

// Categories (read-only for users; admin-only entity DELETE below)
//
// `opts.withMatchCounts` attaches a per-category
// `entity_match_counts: { [entity]: N }` map to each returned row,
// counted against the caller's own expenses only. Used by
// /categories to label global entities with "N despesas" the same
// way personal overrides do (§8.4). The dashboard, /expenses and
// CategoryPickerPopover don't pass the flag — they only need the
// cheap id+name payload.
export const getCategories = (opts = {}) => {
  if (opts.withMatchCounts) {
    return request('/categories?with_match_counts=true');
  }
  return request('/categories');
};

// Admin-only catalogue surgery — removes a single entity string from
// a global category's `entities` array. See docs/Categories.md §13.2
// #27 for the audit contract. Returns 204 on success (short-circuits
// via the 204 branch in `request()`); server responds 403
// `admin_required` for non-admins and 404 for unknown id/entity.
//
// Case-sensitive match on the server — pass the entity string
// verbatim (no lowercasing, no trimming) so the DB's `$pull` hits.
export const deleteCategoryEntity = (categoryId, entity) =>
  request(
    `/categories/${categoryId}/entities/${encodeURIComponent(entity)}`,
    { method: 'DELETE' },
  );

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

// `cascade=true` triggers a post-delete re-resolve pass on the
// server: every expense owned by the caller is re-run through
// `resolveCategory` with the fresh (post-delete) context, and any
// whose verdict now differs is rewritten. This undoes the "stuck on
// the old category" effect that happens when a user apply-to-all's a
// rule and later deletes it. See routes/categoryOverrides.js for the
// full semantics — the cascade is equivalent to running apply-to-all
// on the rule that would have replaced this one (if any), and on
// failure leaves the rule deleted with partial cascade state that
// can be re-run safely.
export const deleteCategoryOverride = (id, { cascade = false } = {}) =>
  request(
    `/category-overrides/${id}${cascade ? '?cascade=true' : ''}`,
    {
      method: 'DELETE',
      // Cascade path scans every user expense — give it the same
      // 30s slack as apply-to-all so a large MVP-scale dataset
      // doesn't trip the default fetch timeout.
      timeoutMs: cascade ? 30_000 : undefined,
    },
  );

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
