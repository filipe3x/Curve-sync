#!/usr/bin/env node
/**
 * Standalone CLI to validate Curve email fixtures.
 * Zero dependencies — uses only Node.js stdlib (fs, path, crypto).
 *
 * Usage:
 *   node server/scripts/validate-fixtures.js [directory]
 *
 * Default directory: server/test/fixtures/emails/
 *
 * Mirrors the logic of docs/embers-reference/curve.py:
 *   - finds the '<!doctype html>' marker
 *   - decodes quoted-printable -> UTF-8
 *   - extracts entity / amount / date / card using the same selectors
 *   - computes SHA-256 digest (entity + amount + date + card)
 *
 * This script is a ground-truth tool: run it to manually verify the
 * parsed values against the raw emails. Once server/src/services/emailParser.js
 * exists, both should produce identical output for the same fixtures.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

// ---------- Quoted-printable decoder ----------
// Decodes MIME quoted-printable to a UTF-8 string.
// Handles soft line breaks (=\n, =\r\n) and hex escapes (=XX).
function decodeQuopri(input) {
  const bytes = [];
  let i = 0;
  while (i < input.length) {
    const ch = input.charCodeAt(i);
    if (ch === 0x3d /* = */) {
      const next = input.charCodeAt(i + 1);
      // soft line break: =\n
      if (next === 0x0a) { i += 2; continue; }
      // soft line break: =\r\n
      if (next === 0x0d && input.charCodeAt(i + 2) === 0x0a) { i += 3; continue; }
      // hex escape: =XX
      const hex = input.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16));
        i += 3;
        continue;
      }
    }
    bytes.push(ch & 0xff);
    i++;
  }
  return Buffer.from(bytes).toString('utf-8');
}

// ---------- Minimal HTML entity decoder ----------
function decodeEntities(str) {
  return str
    .replace(/&nbsp;/g, ' ')
    .replace(/&euro;/gi, '€')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

// ---------- HTML helpers ----------
function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Extract every <td>...</td> along with its class list.
 * Returns array of { classes: string[], content: string }.
 * Regex-based — sufficient for known Curve email templates, not a full HTML parser.
 */
function extractTds(html) {
  const regex = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi;
  const tds = [];
  let m;
  while ((m = regex.exec(html)) !== null) {
    const classMatch = m[1].match(/class\s*=\s*"([^"]*)"/i);
    const classes = classMatch ? classMatch[1].split(/\s+/).filter(Boolean) : [];
    tds.push({ classes, content: m[2] });
  }
  return tds;
}

// ---------- Parser (mirrors curve.py selectors exactly) ----------
function parseEmail(html) {
  const tds = extractTds(html);

  // entity = first td.u-bold
  // amount = second td.u-bold (next sibling in curve.py, equivalent here)
  const bolds = tds.filter((t) => t.classes.includes('u-bold'));
  if (bolds.length < 2) {
    throw new Error(`Expected >=2 td.u-bold, got ${bolds.length}`);
  }
  const entity = stripTags(bolds[0].content);
  const amount = stripTags(bolds[1].content).replace(/€/g, '').trim();

  // date = first td with BOTH u-greySmaller AND u-padding__top--half
  const dateTd = tds.find(
    (t) =>
      t.classes.includes('u-greySmaller') &&
      t.classes.includes('u-padding__top--half'),
  );
  if (!dateTd) {
    throw new Error('Missing td.u-greySmaller.u-padding__top--half');
  }
  const date = stripTags(dateTd.content);

  // card = penultimate td.u-padding__top--half (includes the date td in the list)
  const paddingTds = tds.filter((t) => t.classes.includes('u-padding__top--half'));
  if (paddingTds.length < 2) {
    throw new Error(`Expected >=2 td.u-padding__top--half, got ${paddingTds.length}`);
  }
  const card = stripTags(paddingTds[paddingTds.length - 2].content);

  const digest = createHash('sha256')
    .update(entity + amount + date + card)
    .digest('hex');

  return { entity, amount, date, card, digest };
}

// ---------- Main ----------
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

console.log(`Parsing ${files.length} fixture(s) from ${fixtureDir}\n`);

let okCount = 0;
let failCount = 0;

for (const f of files) {
  const label = f.length > 60 ? f.slice(0, 57) + '...' : f;
  try {
    // read as latin1 so byte values are preserved for the quopri decoder
    const raw = readFileSync(join(fixtureDir, f), 'latin1');
    const start = raw.indexOf('<!doctype html>');
    if (start === -1) {
      console.log(`[FAIL] ${label}`);
      console.log(`       no '<!doctype html>' marker found`);
      console.log();
      failCount++;
      continue;
    }
    const html = decodeQuopri(raw.slice(start));
    const { entity, amount, date, card, digest } = parseEmail(html);
    console.log(`[OK]   ${label}`);
    console.log(`       entity: ${entity}`);
    console.log(`       amount: ${amount}`);
    console.log(`       date:   ${date}`);
    console.log(`       card:   ${card}`);
    console.log(`       digest: ${digest.slice(0, 16)}...`);
    console.log();
    okCount++;
  } catch (e) {
    console.log(`[FAIL] ${label}`);
    console.log(`       ${e.message}`);
    console.log();
    failCount++;
  }
}

console.log(`Summary: ${okCount} ok, ${failCount} failed, ${files.length} total`);
process.exit(failCount > 0 ? 1 : 0);
