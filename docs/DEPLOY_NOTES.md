# DEPLOY_NOTES

Per-release banners surfaced by `scripts/deploy-prod.sh` during pre-flight.
Each entry explains **why** a release needs operator attention — not just
what changed (the commit log already covers that). Entries stay here until
the relevant SHA is older than the oldest server in production.

Format: one block per release that needs a heads-up. The pre-flight phase
prints every block whose heading starts with `## release:` so the operator
sees the full context before the deploy gate.

---

## release: Opção C — `Expense.date_at` (canonical)

**What changed**

- `Expense` schema gained a typed `date_at: Date` populated for every new
  insert (steps 1–4). The old string `date` field is still written.
- `server/scripts/analyze-expense-dates.js` is the canonical backfill that
  reads every legacy row, parses the human string, and writes `date_at`.
- Step 5 flips the default sort on `/expenses`, the dashboard «Despesas
  recentes» strip, and the `/categories` detail panel from `-date` to
  `-date_at`.

**Why the order matters**

Sorts on `-date` were lexical over a day-first string («06 April 2026
08:53:31»). Sorts on `-date_at` are typed Date sorts. Flipping the sort
before the backfill runs leaves rows with `date_at: null` falling to the
bottom of every descending list — visible regression, not data loss.

**Required sequence**

1. Deploy steps 1–4. New inserts already write `date_at`; nothing reads
   it yet. Zero impact for users.
2. **Run the backfill on prod** before deploying step 5:
   ```bash
   node server/scripts/analyze-expense-dates.js              # audit
   node server/scripts/analyze-expense-dates.js --write      # plan
   node server/scripts/analyze-expense-dates.js --write --yes # execute
   node server/scripts/analyze-expense-dates.js --write      # idempotency check
   ```
   The last invocation must report `rows to populate this run: 0` and
   `rows unparseable: 0` before continuing.
3. Deploy step 5 (sort flip). `deploy-prod.sh` detects this script in the
   diff and prompts before running it automatically — accept the prompt.

**Recovery if step 5 lands first**

Run the backfill ASAP. No data loss; the misordered rows reorder as soon
as `date_at` is populated. The auto-rollback in `deploy-prod.sh` catches
this only if `/api/health` actually fails — UX regressions don't trip it.

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
