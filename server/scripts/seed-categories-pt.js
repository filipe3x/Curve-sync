#!/usr/bin/env node
/**
 * Dev helper: seed the global category catalogue with common PT
 * entities so a fresh install has something to resolve against before
 * the admin writes anything by hand.
 *
 * Covers the §11.3 Fase 7 "optional seed script" item of
 * docs/Categories.md — the goal is onboarding velocity, not
 * exhaustive coverage. Five categories and ~15 entities is plenty
 * to make the first sync feel less empty.
 *
 * The seed is purely additive and idempotent:
 *   - Missing categories are inserted with `createdAt` / `updatedAt`
 *     stamps from the Mongoose schema timestamps.
 *   - Existing categories (match on case-insensitive `name`) get the
 *     missing entities appended via `$addToSet`. Already-present
 *     entries are silently skipped — the dedup key is `normalize()`
 *     from categoryResolver.js, same contract as the admin route
 *     (§5.2 + §8.3).
 *   - If one of the seeded entities already lives on a *different*
 *     category, it's reported as a conflict and NOT moved — the
 *     uniqueness invariant (§4.1) wins over the seed. The admin can
 *     resolve it by hand later.
 *
 * Safety:
 *   - Prints a briefing of what will change BEFORE acting.
 *   - Defaults to a dry-run. Pass `--apply` to actually write.
 *   - Never touches `icon_*` Paperclip fields — we only write the two
 *     shared fields (`name`, `entities`) that Embers also reads,
 *     matching the CLAUDE.md constraint.
 *
 * Usage:
 *   cd server && node scripts/seed-categories-pt.js            # dry-run
 *   cd server && node scripts/seed-categories-pt.js --apply    # commit
 *
 * Env:
 *   MONGODB_URI — same as the dev server (.env)
 */

import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import dotenv from 'dotenv';

import Category from '../src/models/Category.js';
import { normalize } from '../src/services/categoryResolver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: resolve(__dirname, '../.env') });

const MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/embers_db';

// The seed. Kept short on purpose — the goal is to unblock a new
// user's first sync with the retailers they're most likely to see on
// a Curve statement in Portugal, not to pre-fill every possible MCC.
//
// All strings land in `entities[]` verbatim (capitalisation preserved
// for the UI) — the resolver lowercases and strips accents at match
// time via `normalize()`, so "Pingo Doce" matches "PINGO DOCE SA" in
// an email's `entity` field without extra configuration.
const SEEDS = [
  {
    name: 'Groceries',
    entities: ['Continente', 'Lidl', 'Pingo Doce', 'Auchan', 'Mercadona'],
  },
  {
    name: 'Fuel',
    entities: ['Galp', 'BP', 'Repsol'],
  },
  {
    name: 'Transport',
    entities: ['Via Verde'],
  },
  {
    name: 'Payments',
    entities: ['MBWay'],
  },
];

function parseArgs(argv) {
  return { apply: argv.includes('--apply') };
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));

  console.log(`Connecting to ${MONGODB_URI}...`);
  await mongoose.connect(MONGODB_URI);

  // Pull the full catalogue once. The whole collection fits in
  // memory at MVP scale (dozens of rows) and we need a global view
  // anyway to detect cross-category entity conflicts.
  const existing = await Category.find().lean();
  const byNameCI = new Map(
    existing.map((c) => [c.name.toLowerCase(), c]),
  );

  // Flat map of `normalized entity → owning category`. First write
  // wins — deterministic for the `existing` iteration order, and at
  // our scale the collection shouldn't have duplicates across
  // categories (the admin route rejects them with 409 entity_conflict).
  const entityOwner = new Map();
  for (const cat of existing) {
    for (const e of cat.entities ?? []) {
      const norm = normalize(e);
      if (!norm || entityOwner.has(norm)) continue;
      entityOwner.set(norm, { id: String(cat._id), name: cat.name });
    }
  }

  const plan = []; // { op: 'create'|'extend', name, additions, conflicts, skipped }

  for (const seed of SEEDS) {
    const target = byNameCI.get(seed.name.toLowerCase());
    const additions = [];
    const conflicts = [];
    const skipped = [];
    for (const raw of seed.entities) {
      const norm = normalize(raw);
      if (!norm) continue;
      const owner = entityOwner.get(norm);
      if (owner) {
        const belongsHere =
          target && String(target._id) === owner.id;
        if (belongsHere) skipped.push(raw);
        else conflicts.push({ entity: raw, owner: owner.name });
        continue;
      }
      additions.push(raw);
      // Reserve the norm so the next seed entry doesn't schedule it
      // onto a second category in the same run.
      entityOwner.set(norm, {
        id: target ? String(target._id) : `__pending__${seed.name}`,
        name: seed.name,
      });
    }
    plan.push({
      op: target ? 'extend' : 'create',
      name: seed.name,
      targetId: target ? String(target._id) : null,
      additions,
      conflicts,
      skipped,
    });
  }

  // Briefing ──────────────────────────────────────────────────────
  console.log(`\n== Briefing (${apply ? 'APPLY' : 'dry-run'}) ==`);
  let totalAdditions = 0;
  let totalConflicts = 0;
  let totalCreated = 0;
  for (const row of plan) {
    const head =
      row.op === 'create'
        ? `+ create "${row.name}"`
        : `~ extend "${row.name}"`;
    console.log(`\n${head}`);
    if (row.additions.length > 0) {
      console.log(`    add: ${row.additions.join(', ')}`);
      totalAdditions += row.additions.length;
    }
    if (row.skipped.length > 0) {
      console.log(`    skip (already present): ${row.skipped.join(', ')}`);
    }
    if (row.conflicts.length > 0) {
      for (const c of row.conflicts) {
        console.log(
          `    CONFLICT: "${c.entity}" already on "${c.owner}" — left alone`,
        );
      }
      totalConflicts += row.conflicts.length;
    }
    if (row.op === 'create') totalCreated += 1;
  }

  console.log(
    `\nSummary: +${totalCreated} categories, +${totalAdditions} entities, ${totalConflicts} conflicts.`,
  );

  if (!apply) {
    console.log('\nDry-run — no writes performed. Re-run with --apply to commit.');
    return;
  }

  if (totalAdditions === 0 && totalCreated === 0) {
    console.log('\nNothing to do — catalogue already covers every seed entry.');
    return;
  }

  // Apply ─────────────────────────────────────────────────────────
  for (const row of plan) {
    if (row.op === 'create') {
      const created = await Category.create({
        name: row.name,
        entities: row.additions,
      });
      console.log(`  created "${row.name}" (${created._id}) +${row.additions.length}`);
    } else if (row.additions.length > 0) {
      await Category.updateOne(
        { _id: row.targetId },
        { $addToSet: { entities: { $each: row.additions } } },
      );
      console.log(`  extended "${row.name}" +${row.additions.length}`);
    }
  }

  console.log('\nDone.');
}

main()
  .catch((e) => {
    console.error('FATAL:', e.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect().catch(() => {}));
