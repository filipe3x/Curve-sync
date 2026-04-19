#!/usr/bin/env bash
# deploy.config.sh — Production deploy template for Curve Sync
#
# Copy this file to deploy.config.local.sh and adjust to your VPS.
# deploy.config.local.sh is gitignored and overrides this one when present.

# ===== VPS =====
export VPS_USER="ember"
export VPS_HOST="embers.brasume.com"
export VPS_PORT="22"
# Repo root on the VPS — must already exist with `git clone` done once.
export VPS_PATH="/var/www/Curve-sync"

# ===== Process manager =====
# Options: pm2 | systemd
export PROCESS_MANAGER="pm2"
export PM2_APP_NAME="curvsync"
export SYSTEMD_SERVICE="curvsync"

# ===== Backend =====
# Curve Sync backend port. The Embers/sleep-routine pair on this VPS already
# uses :3001 — 3033 was chosen for Curve Sync; keep it in sync with the PORT
# line in server/.env on the VPS and with the Apache ProxyPass target.
export BACKEND_PORT="3033"
# Health check path served by Express
export HEALTH_PATH="/api/health"

# ===== Public URL =====
# The HTTPS origin nginx serves the SPA from. Must match CORS_ORIGIN in
# server/.env on the VPS — Express only honours one origin (or comma-list).
# Domain spelled "curvsync" (read as "cur · vsync", the IT term) — not a typo.
export PUBLIC_URL="https://curvsync.brasume.com"

# ===== Backups =====
# Tar of the deploy tree before each release; keep last N.
export ENABLE_BACKUP="true"
export BACKUP_DIR="/var/backups/Curve-sync"
export MAX_BACKUPS="5"

# ===== Deploy target =====
# Default branch/ref to deploy. Override with --ref=<sha> on the CLI.
export DEFAULT_REF="origin/main"
