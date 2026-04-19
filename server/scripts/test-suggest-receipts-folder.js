#!/usr/bin/env node
/**
 * Pure-logic smoke test for `suggestReceiptsFolder` — the heuristic
 * that pre-selects the most likely receipts folder on the wizard's
 * PickFolderScreen. Lives in a plain .js file next to the component
 * so Node can import it without a JSX loader.
 *
 * Usage:
 *   node server/scripts/test-suggest-receipts-folder.js
 */

import { suggestReceiptsFolder } from '../../client/src/components/setup/steps/folderHeuristic.js';

const results = [];
let failures = 0;

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

console.log('suggestReceiptsFolder smoke test\n');

test('empty / null → INBOX fallback', () => {
  assertEqual(suggestReceiptsFolder([]), 'INBOX', 'empty');
  assertEqual(suggestReceiptsFolder(null), 'INBOX', 'null');
  assertEqual(suggestReceiptsFolder(undefined), 'INBOX', 'undefined');
});

test('exact "Curve" match wins over INBOX', () => {
  const folders = ['INBOX', 'Drafts', 'Curve', 'Sent'];
  assertEqual(suggestReceiptsFolder(folders), 'Curve', 'Curve wins');
});

test('case-insensitive "curve" match', () => {
  const folders = ['INBOX', 'curve card', 'Sent'];
  assertEqual(suggestReceiptsFolder(folders), 'curve card', 'lowercase');
});

test('deepest Curve path wins over shallower', () => {
  const folders = [
    'INBOX',
    'Curve',
    'Finanças/Curve',
    'INBOX/Curve/Receipts',
    'Sent',
  ];
  // "INBOX/Curve/Receipts" is the longest path string
  assertEqual(
    suggestReceiptsFolder(folders),
    'INBOX/Curve/Receipts',
    'deepest curve',
  );
});

test('falls back to "receipt" / "recib" when no curve match', () => {
  const folders = ['INBOX', 'Sent', 'Drafts', 'Receipts'];
  assertEqual(suggestReceiptsFolder(folders), 'Receipts', 'receipts');

  const ptFolders = ['INBOX', 'Sent', 'Recibos'];
  assertEqual(suggestReceiptsFolder(ptFolders), 'Recibos', 'PT receipts');
});

test('"curve" match wins over "receipt" match', () => {
  const folders = ['Receipts', 'Curve', 'INBOX'];
  assertEqual(suggestReceiptsFolder(folders), 'Curve', 'curve > receipts');
});

test('INBOX fallback when no name matches', () => {
  const folders = ['INBOX', 'Sent', 'Drafts', 'Trash'];
  assertEqual(suggestReceiptsFolder(folders), 'INBOX', 'inbox fallback');
});

test('first folder fallback when even INBOX is missing', () => {
  const folders = ['Mail', 'Sent', 'Drafts'];
  assertEqual(suggestReceiptsFolder(folders), 'Mail', 'first-folder fallback');
});

test('case-insensitive INBOX match', () => {
  const folders = ['inbox', 'Sent'];
  assertEqual(suggestReceiptsFolder(folders), 'inbox', 'lowercase inbox');
});

console.log('');
if (failures === 0) {
  console.log(`all ${results.length} tests passed`);
  process.exit(0);
} else {
  console.log(`${failures} of ${results.length} tests failed`);
  process.exit(1);
}
