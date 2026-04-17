/**
 * Unit tests for `validateParsed` — the semantic-validation gate that
 * sits between the parser and `Expense.create` (ROADMAP Fase 2.4).
 *
 * The parser already throws ParseError for structurally-missing fields;
 * these tests lock down the second gate that catches values the parser
 * *accepted* but are nonsensical (blank after trim, NaN amount, date
 * Date.parse can't reconstruct, etc.).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateParsed } from '../src/services/emailParser.js';

function ok() {
  return {
    entity: 'Mercados',
    amount: 12.5,
    date: '06 April 2026 08:53:31',
    card: '**** 1234',
    digest: 'abc',
  };
}

test('happy path: realistic parsed expense passes', () => {
  const res = validateParsed(ok());
  assert.equal(res.ok, true);
});

test('negative amount (refund) is ACCEPTED — refunds are legitimate', () => {
  // This is a deliberate deviation from the ROADMAP wording
  // ("amount positivo") documented in emailParser.validateParsed.
  const res = validateParsed({ ...ok(), amount: -5 });
  assert.equal(res.ok, true);
});

test('entity: empty string is rejected', () => {
  const res = validateParsed({ ...ok(), entity: '' });
  assert.equal(res.ok, false);
  assert.equal(res.field, 'entity');
});

test('entity: whitespace-only is rejected', () => {
  const res = validateParsed({ ...ok(), entity: '   \t\n' });
  assert.equal(res.ok, false);
  assert.equal(res.field, 'entity');
});

test('entity: non-string is rejected', () => {
  const res = validateParsed({ ...ok(), entity: 42 });
  assert.equal(res.ok, false);
  assert.equal(res.field, 'entity');
});

test('amount: NaN is rejected', () => {
  const res = validateParsed({ ...ok(), amount: NaN });
  assert.equal(res.ok, false);
  assert.equal(res.field, 'amount');
});

test('amount: Infinity is rejected', () => {
  const res = validateParsed({ ...ok(), amount: Infinity });
  assert.equal(res.ok, false);
  assert.equal(res.field, 'amount');
});

test('amount: zero is rejected (not a real transaction)', () => {
  const res = validateParsed({ ...ok(), amount: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.field, 'amount');
  assert.match(res.reason, /zero/);
});

test('amount: string "12.50" is rejected (parser should have coerced)', () => {
  const res = validateParsed({ ...ok(), amount: '12.50' });
  assert.equal(res.ok, false);
  assert.equal(res.field, 'amount');
});

test('date: empty string is rejected', () => {
  const res = validateParsed({ ...ok(), date: '' });
  assert.equal(res.ok, false);
  assert.equal(res.field, 'date');
});

test('date: unparseable string is rejected', () => {
  const res = validateParsed({ ...ok(), date: 'not a real date' });
  assert.equal(res.ok, false);
  assert.equal(res.field, 'date');
  assert.match(res.reason, /Date\.parse failed/);
});

test('date: whitespace-only is rejected', () => {
  const res = validateParsed({ ...ok(), date: '   ' });
  assert.equal(res.ok, false);
  assert.equal(res.field, 'date');
});

test('parsed=null is rejected gracefully', () => {
  const res = validateParsed(null);
  assert.equal(res.ok, false);
  assert.equal(res.field, 'parsed');
});

test('parsed=undefined is rejected gracefully', () => {
  const res = validateParsed(undefined);
  assert.equal(res.ok, false);
  assert.equal(res.field, 'parsed');
});

test('missing card (optional) still passes', () => {
  // card is NOT a required field per the parser contract — missing it
  // weakens dedup but shouldn't block the row.
  const { card, ...rest } = ok();
  const res = validateParsed(rest);
  assert.equal(res.ok, true);
});
