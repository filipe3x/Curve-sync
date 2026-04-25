# DEPLOY_NOTES

Per-release banners surfaced by `scripts/deploy-prod.sh` during pre-flight.
Each entry explains **why** a release needs operator attention — not just
what changed (the commit log already covers that). Entries stay here until
the relevant SHA is older than the oldest server in production.

Format: one block per release that needs a heads-up. The pre-flight phase
prints every block whose heading starts with `## release:` so the operator
sees the full context before the deploy gate.

---

## release: `Expense.date` sourced from MIME `Date:` envelope (was: body string)

**What changed**

- `imapReader.fetchUnseen()` now requests `envelope: true` and yields
  `{ uid, source, envelopeDate }`. The orchestrator writes
  `envelopeDate` straight into `expense.date` — the body string still
  feeds the digest, entity, amount, and card, but never the stored
  Date.
- Frontend (`client/src/utils/relativeDate.js`) renders with the
  standard browser-TZ getters (`getHours()`, `getMinutes()`, …). A
  Lisbon viewer sees 15:40 for a 15:40 Lisbon transaction, a Madrid
  viewer sees 16:40, a NY viewer sees 10:40.
- `services/expenseDate.js` keeps `parseExpenseDate()` for the manual
  `POST /api/expenses` route and the legacy
  `analyze-expense-dates.js` script, but it is no longer the
  authoritative producer for sync inserts.
- New script `server/scripts/migrate-expense-date-from-imap.js`
  corrects rows ingested under the old contract by re-fetching their
  envelope from IMAP. Dry-runs by default; `--apply --yes` to write;
  `--last-cycles=N` / `--since=ISO` to scope by transaction date.

**Why the change**

The Curve email body's date string is a locale-formatted wall clock
whose timezone **varies per merchant** — verified live: Celeiro
emits Europe/Lisbon, Continente and Vodafone emit CEST, Apple emits
US Eastern, Aliexpress emits UTC+2. Any single-TZ interpretation of
the body is wrong for some fraction of receipts. The MIME `Date:`
header is consistently `+0000` UTC and is the only field we can
trust as the transaction moment. The previous "body as wall clock"
convention also broke the moment the production VPS moved to
America/Los_Angeles — `Date.parse(body)` started reading the
numerals as PDT-local and storing them 7-8 h ahead of UTC.

**Operator action**

1. Standard deploy (`pm2 restart curvsync`). New ingest is correct
   from the moment the orchestrator picks up the new code.
2. Run the migration to backfill recent rows. Recommended scope:
   ```
   node server/scripts/migrate-expense-date-from-imap.js --last-cycles=2
   node server/scripts/migrate-expense-date-from-imap.js --last-cycles=2 --apply --yes
   ```
   Older rows (out_of_range) keep their existing wall-clock-as-UTC
   values — the cosmetic 1-2 h drift in WEST never caused a complaint
   and the cycle aggregations are day-level so the drift doesn't
   move them.
3. Updated Curve Receipts (subject prefixed "Updated Curve Receipt: …")
   are auto-skipped by the migration via the `--update-threshold-h=12`
   guard — the envelope on a re-emission is the resend time, not the
   transaction moment.

See `CLAUDE.md → Expense Date Timezone Invariant` for the full
contract.

---

## release: `Expense.date` typed as BSON `Date` (drop `date_at`)

> **Superseded for the sync path** by the later "envelope.date as
> source of truth" change. `Expense.date` is still BSON `Date`, but
> `parseExpenseDate()` is no longer the authoritative producer for
> sync inserts — the orchestrator writes `envelope.date` from the
> MIME header directly. `parseExpenseDate()` survives as a fallback
> and as the producer for the manual `POST /api/expenses` route. See
> `CLAUDE.md → Expense Date Timezone Invariant` for the current
> contract and `server/scripts/migrate-expense-date-from-imap.js` for
> the migration that re-sources historical rows from the envelope.

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
