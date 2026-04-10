# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Curve Sync is a standalone service (Vite + React frontend, Express/Fastify backend, MongoDB) that automates expense tracking by parsing Curve Card email receipts. It shares the same MongoDB instance as the Embers platform but runs independently.

## Commands

```bash
npm run install:all    # Install all deps (root + client + server)
npm run dev            # Start both client (Vite :5173) and server (Express :3001)
npm run dev:client     # Frontend only
npm run dev:server     # Backend only
npm run build          # Production build (client)
npm run start          # Start server in production mode
```

Server env: copy `server/.env.example` to `server/.env` and set `MONGODB_URI`.

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vite + React + Tailwind CSS |
| Backend | Express (Node.js) |
| Database | MongoDB (shared with Embers) |
| ODM | Mongoose |
| Email parsing | cheerio (port of Python BeautifulSoup logic) |
| Scheduler | node-cron |
| Hashing | Node.js native `crypto` (SHA-256) |
| CSS | Tailwind with custom `curve` (red-brown) and `sand` (warm grey) palettes |

## Architecture

### MongoDB Collection Access Rules

- **`users`** — READ-ONLY (owned by Embers)
- **`categories`** — READ-ONLY (owned by Embers)
- **`expenses`** — READ + INSERT only (never UPDATE/DELETE existing records)
- **`curve_configs`** — Full CRUD (owned by this service, per-user IMAP settings)
- **`curve_logs`** — INSERT + READ (audit trail, TTL 90 days)

### Mongoose Compatibility with Embers (Mongoid)

These rules are critical to avoid breaking the shared database:

- Use `{ timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }` (snake_case, not camelCase)
- Set explicit collection names to prevent Mongoose auto-pluralization
- Store relationships as `<name>_id` ObjectId fields (e.g., `user_id`, `category_id`, `config_id`)
- Never modify the schema of existing `users`, `categories`, or `expenses` collections

### Expense Deduplication

Expenses use a SHA-256 digest of `entity + amount + date + card` as a unique index. This prevents duplicate inserts when reprocessing the same emails. The same logic exists in the original `curve.py` and must be replicated exactly.

### Custom Monthly Cycle

The expense system uses day 22 as the month start (aligned with bank pay cycles), not day 1. All monthly reports and filters must respect this: if `date.day >= 22`, the cycle started on the 22nd of that month; otherwise it started on the 22nd of the previous month.

### Savings Score

Weekly budget = EUR 295/4. Score formula: `score = (log(weekly_savings + 1) / log(budget + 1)) * 10`, returning a 0-10 scale.

### Email Parsing Pipeline

The original `curve.py` (in `docs/embers-reference/`) extracts fields from Curve Card HTML emails using CSS selectors: `entity` from `td.u-bold`, `amount` (EUR) from second `td.u-bold`, `date` from `td.u-greySmaller.u-padding__top--half`, `card` from penultimate `td.u-padding__top--half`. The standalone version should port this to cheerio with fallback selectors for resilience.

## Project Structure

```
client/                 # Vite + React + Tailwind frontend
  src/
    components/layout/  # Shell, Sidebar, Icons
    components/common/  # PageHeader, StatCard, EmptyState
    pages/              # DashboardPage, ExpensesPage, CurveConfigPage, CurveLogsPage
    services/api.js     # All API calls (fetch wrapper)
server/                 # Express backend
  src/
    models/             # Mongoose: Expense, Category, User (RO), CurveConfig, CurveLog
    routes/             # expenses, categories, curve, autocomplete
    services/           # expense.js (digest, auto-category)
    config/db.js        # MongoDB connection
docs/                   # Architecture docs + read-only Embers reference
```

## Reference Files

All files under `docs/embers-reference/` are **read-only references** from the Embers platform. Do not modify them — they exist to document the original implementation:

- `curve.py` — Original email parser (Python/BeautifulSoup)
- `models/*.rb` — Mongoid schemas (source of truth for field names and types)
- `controllers/*.rb` — API logic for expenses and categories
- `frontend/` — React components and API service layer from Embers

Key documentation:
- `docs/EMAIL.md` — **Email pipeline implementation guide**: current state, TODOs, dev strategy, reference selectors, architecture diagram
- `docs/MONGODB_SCHEMA.md` — Complete schema with Mongoose equivalents, relationships, indexes, and consistency rules
- `docs/expense-tracking.md` — Full system documentation including savings score, monthly cycle logic, TODOs, and proposed standalone architecture

## Dev Database

A full MongoDB dump of the shared Embers database can be placed at `dev/db/embers-dump.tar.gz` for local development. The data is bogus/test accounts — safe to commit.

### Setup

```bash
# 1. Export (on the server running MongoDB)
mongodump --db=embers_db_dev --out=/tmp/mongodump
tar czf embers-dump.tar.gz -C /tmp/mongodump embers_db_dev

# 2. Place the file
cp embers-dump.tar.gz dev/db/

# 3. Import into local MongoDB
tar xzf dev/db/embers-dump.tar.gz -C /tmp
mongorestore --db=embers_db_dev /tmp/embers_db_dev --drop
```

### What it contains

| Collection | Used by | Dev relevance |
|------------|---------|---------------|
| `users` | Embers (owner) | `email`, `encrypted_password`, `salt` — needed to test auth (MU-1) |
| `categories` | Embers (owner) | Category list for auto-assignment |
| `expenses` | Both | Existing expenses for testing queries and dedup |
| `sessions` | Embers (owner) | Session tokens — needed to test session validation |
| `curve_configs` | Curve Sync | IMAP config per user |
| `curve_logs` | Curve Sync | Audit trail |

### Inspecting BSON files without MongoDB

When `mongorestore` is not available, inspect `.bson` files directly via the `bson` npm package:

```bash
npm install --no-save bson
tar xzf dev/db/embers-dump.tar.gz -C /tmp
```

```javascript
const fs = require('fs');
const { BSON } = require('bson');

function readBson(file) {
  const buf = fs.readFileSync(file);
  const docs = [];
  let offset = 0;
  while (offset < buf.length) {
    const size = buf.readInt32LE(offset);
    docs.push(BSON.deserialize(buf.slice(offset, offset + size)));
    offset += size;
  }
  return docs;
}

const users = readBson('/tmp/embers_db_dev/users.bson');
console.log(users);
```

### Important

- The data is test/bogus accounts — safe to track in git
- The `MONGODB_URI` in `server/.env` should point to the local instance where the dump was restored
- The `users` collection contains `encrypted_password` and `salt` fields using the Embers custom SHA-256 hash: `SHA256("password--salt")` — this is what MU-1 auth will validate against

## API Endpoints (Target)

- `GET/POST /api/expenses` — List and create expenses
- `GET /api/categories` — Read-only category listing
- `GET/PUT /api/curve/config` — IMAP sync configuration
- `POST /api/curve/sync` — Trigger manual email sync
- `GET /api/curve/logs` — Processing audit trail
- `POST /api/curve/test-connection` — Validate IMAP connectivity
- `GET /api/autocomplete/:field` — Distinct values for card/entity/category
