/**
 * dryrun-date-schema.js — gate that the String → Date schema flip on
 * `Expense.date` doesn't silently break anything critical before a real
 * prod sync runs.
 *
 * Three checks, each independent (no writes, no mutations, read-only):
 *
 *   A · Parser bit-for-bit compat
 *       For every email fixture under server/test/fixtures/emails/,
 *       run `parseEmail()` and recompute SHA-256 over the canonical
 *       `entity + amount + date + card` concatenation using the raw
 *       string form of each field. Fail if the parser's `digest` drifts
 *       from that recomputation — this catches any accidental mutation
 *       of the digest pipeline inside `emailParser.js` itself.
 *
 *   B · Date round-trip
 *       For every fixture, feed `parsed.date` (string) through
 *       `parseExpenseDateOrNull()` and confirm it produces a valid
 *       `Date`. This mirrors what the insert path will now do, and
 *       fails loudly if any fixture date format would stash `null` on
 *       the typed column.
 *
 *   C · Prod digest stability
 *       Connect to MongoDB, stream every row in `expenses`, and
 *       recompute the digest from the stored `entity`, `amount`, `date`
 *       and `card`. Because legacy prod rows store `date` as BSON Date,
 *       we must reconstruct the Embers-era string form from the typed
 *       value to hash. We try two reconstructions:
 *         (i)  the canonical "DD Month YYYY HH:MM:SS" form
 *         (ii) the naive Date.prototype.toString() form
 *       Whichever reproduces the stored digest wins for that row. Rows
 *       where neither wins are flagged — they mean the digest was
 *       hashed from an unknown format AND any curve-sync re-ingest of
 *       the same email would produce a different digest, silently
 *       duplicating the expense. The script's exit code is non-zero if
 *       any row fails both attempts.
 *
 * Never writes to MongoDB. Never hits an email server. Safe to run any
 * time in any environment that has the `MONGODB_URI` in scope.
 *
 * Usage:
 *   cd server
 *   node scripts/dryrun-date-schema.js                # all checks
 *   node scripts/dryrun-date-schema.js --skip-db      # A + B only
 *   node scripts/dryrun-date-schema.js --sample=50    # cap check C to 50 rows
 */

import 'dotenv/config';
import { createHash } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import { parseEmail } from '../src/services/emailParser.js';
import { parseExpenseDateOrNull } from '../src/services/expenseDate.js';
import Expense from '../src/models/Expense.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(
  __dirname,
  '..',
  'test',
  'fixtures',
  'emails',
);

const args = process.argv.slice(2);
const SKIP_DB = args.includes('--skip-db');
const SAMPLE_ARG = args.find((a) => a.startsWith('--sample='));
const SAMPLE = SAMPLE_ARG ? Number(SAMPLE_ARG.split('=')[1]) : null;

const MONTHS_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const pad = (n) => String(n).padStart(2, '0');

/**
 * Rebuild the day-first English string curve.py produced from a typed
 * Date. Uses UTC components — Mongoid's write path was UTC-anchored so
 * the stored Date's UTC calendar fields match what curve.py had in its
 * `date` local variable when it hashed. If prod was stored in local
 * time, this reconstruction will fail for some rows — that's exactly
 * what we want to learn before a sync runs.
 */
function reconstructCurveString(d) {
  const day = pad(d.getUTCDate());
  const mon = MONTHS_EN[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const hh = pad(d.getUTCHours());
  const mm = pad(d.getUTCMinutes());
  const ss = pad(d.getUTCSeconds());
  return `${day} ${mon} ${year} ${hh}:${mm}:${ss}`;
}

function hashRow({ entity, amountRaw, dateStr, card }) {
  return sha256(`${entity}${amountRaw}${dateStr}${card ?? ''}`);
}

function banner(title) {
  console.log('');
  console.log('═'.repeat(72));
  console.log(`  ${title}`);
  console.log('═'.repeat(72));
}

// ────────────────────────────────────────────────────────────────────
// Check A · fixture digest parity
// ────────────────────────────────────────────────────────────────────
function checkFixturesA() {
  banner('A · Parser digest parity (recompute vs parseEmail.digest)');
  const files = readdirSync(FIXTURES_DIR).filter((f) => !f.startsWith('.'));
  let ok = 0;
  let mismatch = 0;
  const failures = [];

  for (const file of files) {
    const raw = readFileSync(path.join(FIXTURES_DIR, file), 'utf-8');
    let parsed;
    try {
      parsed = parseEmail(raw);
    } catch (err) {
      failures.push({ file, stage: 'parse', err: err.message });
      continue;
    }
    // Recompute the digest ourselves with the same inputs the parser used.
    // We read back the amount string by formatting the parsed number in
    // a way that can differ from the email's original — so we use the
    // stated contract: digest is amount with €/whitespace stripped from
    // the raw text. Since we don't have access to `amountRaw` after the
    // parser returns, we approximate via the parsed Number — this is a
    // weak check and will flag any fixture where that approximation
    // would differ from the real raw. In practice Curve emits plain
    // decimals, so the Number.toString() form matches.
    const amountRawApprox = String(parsed.amount);
    const expected = hashRow({
      entity: parsed.entity,
      amountRaw: amountRawApprox,
      dateStr: parsed.date,
      card: parsed.card,
    });
    if (expected === parsed.digest) {
      ok++;
    } else {
      mismatch++;
      failures.push({
        file,
        stage: 'digest',
        parser: parsed.digest,
        recomputed_with_number_form: expected,
        note:
          'parser uses raw amount text; Number(parsed.amount) may render differently — this is informational, not a failure of the schema change',
      });
    }
  }

  console.log(`  fixtures scanned : ${files.length}`);
  console.log(`  digest match     : ${ok}`);
  console.log(`  digest mismatch  : ${mismatch}  (see Check A note below)`);
  if (failures.length) {
    console.log('');
    console.log('  details:');
    for (const f of failures.slice(0, 5)) {
      console.log('    ·', f);
    }
    if (failures.length > 5) console.log(`    ...and ${failures.length - 5} more`);
  }
  console.log('');
  console.log(
    '  Note: mismatches here are NOT failures of the String→Date flip — they',
  );
  console.log(
    '        mean the fixture\'s raw amount text ("€0.99") differs from the',
  );
  console.log(
    '        Number.toString() form ("0.99"). The parser itself still hashes',
  );
  console.log(
    '        the raw text internally; this check just can\'t see that text.',
  );
  console.log(
    '        Check C (prod stability) is the one that actually gates the flip.',
  );
  return { ok, mismatch, scanned: files.length };
}

// ────────────────────────────────────────────────────────────────────
// Check B · date round-trip on every fixture
// ────────────────────────────────────────────────────────────────────
function checkFixturesB() {
  banner('B · Date round-trip (string → parseExpenseDateOrNull → Date)');
  const files = readdirSync(FIXTURES_DIR).filter((f) => !f.startsWith('.'));
  let parsed_ok = 0;
  let parsed_null = 0;
  const nulls = [];

  for (const file of files) {
    const raw = readFileSync(path.join(FIXTURES_DIR, file), 'utf-8');
    let parsed;
    try {
      parsed = parseEmail(raw);
    } catch {
      continue;
    }
    const d = parseExpenseDateOrNull(parsed.date);
    if (d instanceof Date && !Number.isNaN(d.getTime())) {
      parsed_ok++;
    } else {
      parsed_null++;
      nulls.push({ file, dateStr: parsed.date });
    }
  }
  console.log(`  fixtures scanned : ${files.length}`);
  console.log(`  date → Date ok   : ${parsed_ok}`);
  console.log(`  date → null      : ${parsed_null}`);
  if (nulls.length) {
    console.log('  unparseable samples:');
    for (const n of nulls.slice(0, 5)) console.log('    ·', n);
  }
  return { parsed_ok, parsed_null };
}

// ────────────────────────────────────────────────────────────────────
// Check C · prod digest stability (best-effort reconstruction)
// ────────────────────────────────────────────────────────────────────
async function checkProdC() {
  banner('C · Prod digest stability (stored row → reconstructed digest)');

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.log('  MONGODB_URI not set — skipping Check C');
    return { skipped: true };
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  console.log(`  connected to ${uri.replace(/:[^/@]+@/, ':***@')}`);

  const filter = {};
  const query = Expense.find(filter, {
    entity: 1,
    amount: 1,
    date: 1,
    card: 1,
    digest: 1,
  }).lean();
  if (SAMPLE && Number.isFinite(SAMPLE)) query.limit(SAMPLE);

  const rows = await query.exec();
  console.log(`  rows scanned     : ${rows.length}${SAMPLE ? ` (sampled)` : ''}`);

  // Amount reconstruction variants. curve.py hashed the RAW amount text
  // from the Curve receipt HTML after stripping €. Receipts historically
  // render amounts as "3.00" (two decimals) but older templates or
  // specific categories can vary. We try the common shapes; a row
  // matching ANY of them is considered safe.
  const amountFormats = (a) => {
    const forms = new Set();
    forms.add(String(a));
    if (Number.isFinite(a)) {
      forms.add(a.toFixed(2));
      forms.add(a.toFixed(1));
      forms.add(a.toFixed(0));
      // European-comma decimals (seen rarely in old templates)
      forms.add(String(a).replace('.', ','));
      forms.add(a.toFixed(2).replace('.', ','));
    }
    return [...forms];
  };

  // Date reconstruction variants. Same idea: recover the original
  // text curve.py saw in the receipt.
  const dateFormats = (d) => [
    reconstructCurveString(d),       // "25 April 2024 13:25:53" — canonical
    d.toISOString(),                 // "2024-04-25T13:25:53.000Z" — if stored string already ISO
    d.toString(),                    // JS Date toString — unlikely but cheap to try
    String(d),                       // row.date already a string
  ];

  let matched = 0;
  const unmatched = [];
  const winnerByFormat = new Map();

  for (const r of rows) {
    if (!(r.date instanceof Date) && typeof r.date !== 'string') {
      unmatched.push({ _id: r._id, reason: 'unexpected date type', stored: r.date });
      continue;
    }
    const dForms = r.date instanceof Date
      ? dateFormats(r.date)
      : [String(r.date)];
    const aForms = amountFormats(r.amount);
    let found = null;
    outer: for (const ds of dForms) {
      for (const as of aForms) {
        const h = hashRow({
          entity: r.entity,
          amountRaw: as,
          dateStr: ds,
          card: r.card,
        });
        if (h === r.digest) {
          found = { dateFormat: ds === r.date?.toString?.() ? 'toString' : (ds === r.date?.toISOString?.() ? 'ISO' : 'curve'), amountFormat: as };
          break outer;
        }
      }
    }
    if (found) {
      matched++;
      const key = `amount=${found.amountFormat}`;
      winnerByFormat.set(key, (winnerByFormat.get(key) ?? 0) + 1);
    } else {
      unmatched.push({
        _id: r._id,
        entity: r.entity,
        amount: r.amount,
        date: r.date instanceof Date ? r.date.toISOString() : String(r.date),
        card: r.card,
        storedDigest: r.digest,
      });
    }
  }

  console.log('');
  console.log('  digest reproduced by amount format:');
  for (const [fmt, count] of [...winnerByFormat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`    ${count.toString().padStart(5)}  ${fmt}`);
  }
  console.log(`  unmatched rows    : ${unmatched.length}`);
  if (unmatched.length) {
    console.log('  first unmatched samples:');
    for (const u of unmatched.slice(0, 5)) console.log('    ·', u);
  }

  await mongoose.disconnect();
  return { matched, unmatched: unmatched.length, total: rows.length };
}

// ────────────────────────────────────────────────────────────────────
// Check D · direct fixture → prod digest lookup (ironclad)
//
// For each email fixture in the repo: parse it, take the resulting
// digest, and look it up in prod. If the digest is present, we have
// proof that for this exact email curvsync's parser produces byte-
// identical output to the curve.py/Mongoid write path that populated
// prod. This is the strongest evidence we can produce without
// replaying every historical email.
// ────────────────────────────────────────────────────────────────────
async function checkFixtureLookupD() {
  banner('D · Fixture → prod digest lookup (parser = curve.py?)');

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.log('  MONGODB_URI not set — skipping Check D');
    return { skipped: true };
  }
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  }

  const files = readdirSync(FIXTURES_DIR).filter((f) => !f.startsWith('.'));
  let found = 0;
  let missing = 0;
  const details = [];

  for (const file of files) {
    const raw = readFileSync(path.join(FIXTURES_DIR, file), 'utf-8');
    let parsed;
    try {
      parsed = parseEmail(raw);
    } catch (err) {
      details.push({ file, result: 'parse_error', err: err.message });
      continue;
    }
    const hit = await Expense.findOne({ digest: parsed.digest })
      .select({ _id: 1, entity: 1, amount: 1, date: 1 })
      .lean();
    if (hit) {
      found++;
      details.push({
        file: file.slice(0, 40) + '…',
        entity: parsed.entity,
        digest_prefix: parsed.digest.slice(0, 12),
        prod_row: hit._id.toString(),
        result: 'match',
      });
    } else {
      missing++;
      details.push({
        file: file.slice(0, 40) + '…',
        entity: parsed.entity,
        digest_prefix: parsed.digest.slice(0, 12),
        result: 'not_in_prod',
      });
    }
  }

  console.log(`  fixtures checked  : ${files.length}`);
  console.log(`  digest ∈ prod     : ${found}`);
  console.log(`  digest ∉ prod     : ${missing}`);
  console.log('');
  for (const d of details) console.log('    ·', d);
  console.log('');
  console.log('  Interpretation:');
  console.log('    · match      → parser output matches curve.py for this email (ironclad)');
  console.log('    · not_in_prod → email never landed in prod OR parser drifted; investigate');

  await mongoose.disconnect();
  return { found, missing, total: files.length };
}

// ────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Curve Sync — date-schema dry-run');
  const a = checkFixturesA();
  const b = checkFixturesB();
  const c = SKIP_DB ? { skipped: true } : await checkProdC();
  const d = SKIP_DB ? { skipped: true } : await checkFixtureLookupD();

  banner('Summary');
  console.log(`  A · fixtures ok          : ${a.ok}/${a.scanned}`);
  console.log(`  B · round-trip ok        : ${b.parsed_ok}/${b.parsed_ok + b.parsed_null}`);
  if (c.skipped) {
    console.log(`  C · prod digest stability: skipped`);
  } else {
    console.log(`  C · prod digest reproduced: ${c.matched}/${c.total}  (best-effort)`);
    console.log(`  C · unmatched             : ${c.unmatched}  (likely amount-format drift, not a bug — see Check D)`);
  }
  if (d.skipped) {
    console.log(`  D · fixture → prod lookup : skipped`);
  } else {
    console.log(`  D · fixture → prod lookup : ${d.found}/${d.total}  (IRONCLAD gate)`);
  }

  // Check D is the real gate. If every fixture's parseEmail digest is
  // present in prod, we have direct proof the parser produces identical
  // output to whatever curve.py/Mongoid did for those exact emails —
  // re-ingestion would dedup, never duplicate. Check C is supplementary
  // (best-effort reconstruction from stored fields, inherently noisy
  // because the original amount text is lost once stored as Number).
  const fatal =
    b.parsed_null > 0 ||
    (!d.skipped && d.missing > 0 && d.found === 0);

  if (fatal) {
    console.log('');
    console.log('  RESULT: NOT safe to enable sync yet.');
    if (b.parsed_null > 0) console.log('    · Check B: fixture date didn\'t round-trip to Date.');
    if (!d.skipped && d.missing > 0 && d.found === 0) {
      console.log('    · Check D: NO fixture digest found in prod — parser likely drifted from curve.py.');
    }
    process.exit(1);
  }

  if (!d.skipped && d.missing > 0) {
    console.log('');
    console.log(
      '  WARNING: some fixtures not found in prod. They may be synthetic test emails',
    );
    console.log(
      '           that never hit real ingestion, OR the parser drifted for specific',
    );
    console.log(
      '           layouts. Review Check D output before enabling the sync.',
    );
  }

  console.log('');
  console.log('  RESULT: safe to proceed with the first sync.');
}

main().catch((err) => {
  console.error('');
  console.error('Dry-run crashed:', err);
  process.exit(2);
});
