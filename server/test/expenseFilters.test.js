/**
 * Unit tests for the non-disruptive filter helpers added to
 * `routes/expenses.js` in ROADMAP Fase 2.6. These cover the pure bits
 * (sort allowlist, regex escape) — the Mongo-side `$expr` date range
 * is exercised via integration by the frontend when it ships UI for
 * start/end.
 *
 * The helpers are not exported from expenses.js (they're internals),
 * so we re-implement them here as test fixtures matching the canonical
 * source. Any future edit to the route's `sanitiseSort` / `escapeRegex`
 * that breaks these assertions is the signal to port the edit here too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ────────── Canonical copy of the helpers from routes/expenses.js ──────────
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ALLOWED_SORT_FIELDS = new Set([
  'date_at',
  'date',
  'amount',
  'entity',
  'card',
  'created_at',
]);

function sanitiseSort(raw) {
  if (!raw || typeof raw !== 'string') return '-date_at';
  const desc = raw.startsWith('-');
  const field = desc ? raw.slice(1) : raw;
  if (!ALLOWED_SORT_FIELDS.has(field)) return '-date_at';
  return desc ? `-${field}` : field;
}
// ────────── Tests ──────────

test('sanitiseSort: default when omitted', () => {
  assert.equal(sanitiseSort(undefined), '-date_at');
  assert.equal(sanitiseSort(null), '-date_at');
  assert.equal(sanitiseSort(''), '-date_at');
});

test('sanitiseSort: allowlisted fields pass through (both directions)', () => {
  // date_at — the canonical typed chronological field, default since
  // Opção C step 5.
  assert.equal(sanitiseSort('date_at'), 'date_at');
  assert.equal(sanitiseSort('-date_at'), '-date_at');
  // `date` (raw string) stays in the allowlist for one or two
  // sprints of retro-compat with any client still sending it; step 6
  // drops it.
  assert.equal(sanitiseSort('date'), 'date');
  assert.equal(sanitiseSort('-date'), '-date');
  assert.equal(sanitiseSort('amount'), 'amount');
  assert.equal(sanitiseSort('-amount'), '-amount');
  assert.equal(sanitiseSort('entity'), 'entity');
  assert.equal(sanitiseSort('-entity'), '-entity');
  assert.equal(sanitiseSort('card'), 'card');
  assert.equal(sanitiseSort('-card'), '-card');
  assert.equal(sanitiseSort('created_at'), 'created_at');
  assert.equal(sanitiseSort('-created_at'), '-created_at');
});

test('sanitiseSort: non-allowlisted fields fall back to default', () => {
  assert.equal(sanitiseSort('user_id'), '-date_at');
  assert.equal(sanitiseSort('-user_id'), '-date_at');
  assert.equal(sanitiseSort('password'), '-date_at');
  assert.equal(sanitiseSort('{"$ne":null}'), '-date_at');
});

test('sanitiseSort: non-string inputs fall back', () => {
  assert.equal(sanitiseSort(42), '-date_at');
  assert.equal(sanitiseSort({}), '-date_at');
  assert.equal(sanitiseSort([]), '-date_at');
});

test('escapeRegex: passes through plain text unchanged', () => {
  assert.equal(escapeRegex('mercadona'), 'mercadona');
  assert.equal(escapeRegex('Café Central'), 'Café Central');
});

test('escapeRegex: neutralises regex metacharacters', () => {
  // A bad-faith caller shipping `.*` or catastrophic-backtracking
  // patterns like `(a+)+` must not be able to stall the server. Each
  // metachar should come out prefixed with a backslash.
  assert.equal(escapeRegex('.*'), '\\.\\*');
  assert.equal(escapeRegex('a+b'), 'a\\+b');
  assert.equal(escapeRegex('(a+)+'), '\\(a\\+\\)\\+');
  assert.equal(escapeRegex('[x]'), '\\[x\\]');
  assert.equal(escapeRegex('\\d'), '\\\\d');
  // The classic "catastrophic backtracking" probe — escaping must
  // prevent the `+` from actually becoming a quantifier.
  const re = new RegExp(escapeRegex('(a+)+$'), 'i');
  assert.equal(re.test('(a+)+$'), true);
  assert.equal(re.test('aaaaaa'), false);
});

test('escapeRegex: empty and non-string inputs coerce safely', () => {
  assert.equal(escapeRegex(''), '');
  assert.equal(escapeRegex(42), '42');
  assert.equal(escapeRegex(null), 'null');
});
