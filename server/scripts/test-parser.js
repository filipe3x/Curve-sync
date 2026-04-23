#!/usr/bin/env node
/**
 * Smoke test for server/src/services/emailParser.js against real fixtures.
 *
 * Companion to validate-fixtures.js:
 *   - validate-fixtures.js = zero-dep ground-truth reference (regex-based)
 *   - test-parser.js       = runs the production cheerio-based parser
 *
 * Both should produce identical entity / amount / date / card / digest for
 * the same inputs. When they diverge, investigate the production parser.
 *
 * Usage:
 *   node server/scripts/test-parser.js [directory]
 *
 * Exit code: 1 if any fixture produces a ParseError (missing required
 * field), 0 otherwise. Warnings don't affect exit code but are printed.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { parseEmail, ParseError } from '../src/services/emailParser.js';

const fixtureDir = process.argv[2] || 'server/test/fixtures/emails';

let files;
try {
  files = readdirSync(fixtureDir)
    .filter((f) => {
      try {
        return statSync(join(fixtureDir, f)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
} catch (e) {
  console.error(`Error reading directory "${fixtureDir}": ${e.message}`);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`No files found in ${fixtureDir}`);
  process.exit(1);
}

console.log(
  `Testing emailParser on ${files.length} fixture(s) from ${fixtureDir}\n`,
);

let okCount = 0;
let withWarnings = 0;
let parseErrorCount = 0;
let fatalCount = 0;

for (const f of files) {
  const label = f.length > 60 ? f.slice(0, 57) + '...' : f;
  try {
    // Read as latin1 so byte values are preserved for the QP decoder
    const raw = readFileSync(join(fixtureDir, f), 'latin1');
    const result = parseEmail(raw);
    console.log(`[OK]   ${label}`);
    console.log(`       entity: ${result.entity}`);
    console.log(`       amount: ${result.amount}`);
    console.log(`       date:   ${result.date}`);
    console.log(`       card:   ${result.card || '(missing)'}`);
    console.log(`       digest: ${result.digest.slice(0, 16)}...`);
    if (result.warnings.length > 0) {
      console.log(`       warnings:`);
      for (const w of result.warnings) console.log(`         - ${w}`);
      withWarnings++;
    }
    console.log();
    okCount++;
  } catch (e) {
    if (e instanceof ParseError) {
      console.log(`[PARSE_ERROR] ${label}`);
      console.log(`       field:   ${e.field}`);
      console.log(`       message: ${e.message}`);
      if (e.attempted) {
        console.log(`       tried:   ${e.attempted.join(', ')}`);
      }
      console.log();
      parseErrorCount++;
    } else {
      // Unexpected exception — parser should never throw non-ParseError.
      // If this fires, it's a bug in emailParser.js (not an email problem).
      console.log(`[FATAL] ${label}`);
      console.log(`       ${e.message}`);
      if (e.stack) console.log(e.stack);
      console.log();
      fatalCount++;
    }
  }
}

console.log(
  `Summary: ${okCount} ok (${withWarnings} with warnings), ` +
    `${parseErrorCount} parse_error, ${fatalCount} fatal, ` +
    `${files.length} total`,
);
process.exit(parseErrorCount + fatalCount > 0 ? 1 : 0);
