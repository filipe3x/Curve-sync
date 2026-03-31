# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Curve Sync is a standalone service (Vite + React frontend, Express/Fastify backend, MongoDB) that automates expense tracking by parsing Curve Card email receipts. It shares the same MongoDB instance as the Embers platform but runs independently.

## Target Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vite + React |
| Backend | Express or Fastify (Node.js) |
| Database | MongoDB (shared with Embers) |
| ODM | Mongoose |
| Email parsing | cheerio (port of Python BeautifulSoup logic) |
| Filesystem/Email | fs/promises or direct IMAP (imapclient) |
| Scheduler | node-cron |
| Hashing | Node.js native `crypto` (SHA-256) |

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

## Reference Files

All files under `docs/embers-reference/` are **read-only references** from the Embers platform. Do not modify them — they exist to document the original implementation:

- `curve.py` — Original email parser (Python/BeautifulSoup)
- `models/*.rb` — Mongoid schemas (source of truth for field names and types)
- `controllers/*.rb` — API logic for expenses and categories
- `frontend/` — React components and API service layer from Embers

Key documentation:
- `docs/MONGODB_SCHEMA.md` — Complete schema with Mongoose equivalents, relationships, indexes, and consistency rules
- `docs/expense-tracking.md` — Full system documentation including savings score, monthly cycle logic, TODOs, and proposed standalone architecture

## API Endpoints (Target)

- `GET/POST /api/expenses` — List and create expenses
- `GET /api/categories` — Read-only category listing
- `GET/PUT /api/curve/config` — IMAP sync configuration
- `POST /api/curve/sync` — Trigger manual email sync
- `GET /api/curve/logs` — Processing audit trail
- `POST /api/curve/test-connection` — Validate IMAP connectivity
- `GET /api/autocomplete/:field` — Distinct values for card/entity/category
