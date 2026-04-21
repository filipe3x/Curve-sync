# DEPLOY_NOTES

Per-release banners surfaced by `scripts/deploy-prod.sh` during pre-flight.
Each entry explains **why** a release needs operator attention — not just
what changed (the commit log already covers that). Entries stay here until
the relevant SHA is older than the oldest server in production.

Format: one block per release that needs a heads-up. The pre-flight phase
prints every block whose heading starts with `## release:` so the operator
sees the full context before the deploy gate.

---

## release: `Expense.date` typed as BSON `Date` (drop `date_at`)

**What changed**

- `Expense.date` in the Mongoose schema flipped from `String` to `Date`.
  Every new insert (sync orchestrator and `POST /api/expenses`) now goes
  through `parseExpenseDate()` before `Expense.create`, so the collection
  holds a uniformly typed chronological field — the same contract
  Embers' Mongoid already enforces via `field :date, type: DateTime`.
- `Expense.date_at` (the sibling typed column added during the original
  Opção C migration) is removed from the schema, its partial index
  retired, and every reader flipped back to `-date`. The column was a
  workaround for the String-typed `date` — once `date` itself is typed,
  the companion is redundant.
- The digest pipeline in `emailParser.js` is unchanged. It still hashes
  the original raw email string, keeping dedup against Embers-era rows
  bit-for-bit compatible with `curve.py`.

**Why the order matters**

Inserting Strings alongside Embers' Dates breaks BSON ordering:
`String < Date`, so Mongoid's `search_query` in `embers/models/expense.rb`
uses `{ :$gte => Date }` and would silently miss every String row. Users
would stop seeing Curve Sync expenses on `embers.brasume.com` without any
error surfaced. The dev dump already exhibited this mix (63 String + 13
Date); production was clean (1302 Date) only because every historical
insert flowed through Mongoid.

**Required sequence**

1. Deploy the code (schema flip + reader flips + insert parsers). No
   schema migration is needed in prod — the 1302 legacy rows are
   already typed Date, and `date_at` being removed from the schema
   just stops new inserts from populating it (existing orphan
   `date_at` values on disk are harmless, ignored on read).
2. Before enabling the first sync, run the dry-run guard to confirm
   every stored digest is reproducible — if any row fails, a future
   re-ingest of the same email would create a duplicate:
   ```bash
   cd /var/www/Curve-sync/server
   node scripts/dryrun-date-schema.js
   ```
   Expected outcome: `RESULT: safe to proceed with the first sync.`
3. (Dev only) Convert any lingering `date: String` rows to `Date`:
   ```bash
   node server/scripts/analyze-expense-dates.js              # audit
   node server/scripts/analyze-expense-dates.js --write      # plan
   node server/scripts/analyze-expense-dates.js --write --yes # execute
   ```
   In prod this is a no-op by design — the audit reports zero String
   rows and exits without writing.
4. (Optional cleanup, prod) Drop the orphan `date_at` column + retired
   index once the release is stable. Pure cosmetic — functional state
   is already correct:
   ```js
   // mongo $MONGO_AUTH embers_db
   db.expenses.updateMany({}, { $unset: { date_at: '' } });
   db.expenses.dropIndex('user_id_1_date_at_-1');
   ```

**Recovery**

Rollback is reverting the code commit. No data migration to undo: the
`date` field is already typed Date in every prod row, which is what both
old and new code expect — the flip is a reader change, not a data
change. If the dry-run guard from step 2 reports unreproducible digests,
do NOT enable the sync; investigate the offending rows first.

---

<!--
Template for future entries — copy into a new `## release:` block above
this comment, keep oldest at the bottom, drop entries once every prod box
is past the relevant SHA.

## release: <short title>

**What changed**

- Bullet 1
- Bullet 2

**Why the order matters**

One paragraph on the data/code dependency that requires operator attention.

**Required sequence**

1. Step 1
2. Step 2

**Recovery**

What to do if the order goes wrong.
-->
