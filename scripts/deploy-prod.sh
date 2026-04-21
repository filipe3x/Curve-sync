#!/usr/bin/env bash
# ------------------------------------------------------------------
# deploy-prod.sh — Production deploy entry point for Curve Sync
#
# Phases (ROADMAP §3.9):
#   1. Pre-flight  — banner, commit diff since last deploy, server state,
#                    canonical migration warnings from docs/DEPLOY_NOTES.md
#   2. Gate        — interactive CONFIRM=yes (or --yes) before mutating prod
#   3. Pull+build  — git fetch + checkout target ref, npm ci, vite build
#   4. Migrations  — runs server/scripts/migrate-* + analyze-expense-dates.js
#                    when the diff or DEPLOY_NOTES touches them
#   5. Restart     — pm2 restart + curl /api/health
#   6. Rollback    — auto-revert to PREVIOUS_REF if health check fails
#
# Target: Ubuntu 16.04 (Xenial) — old apt, no `nvm use --lts`. Assumes
# node/npm + git + pm2 (or systemd) already installed on the VPS, and that
# $VPS_PATH is a working git checkout with origin pointing at this repo.
#
# Usage:
#   ./scripts/deploy-prod.sh                  # plan + interactive confirm
#   ./scripts/deploy-prod.sh --yes            # plan + auto-confirm
#   ./scripts/deploy-prod.sh --ref=<sha>      # deploy a specific commit
#   ./scripts/deploy-prod.sh --skip-migrations
#   ./scripts/deploy-prod.sh --skip-build
#   ./scripts/deploy-prod.sh --rollback       # revert to previous ref
#   ./scripts/deploy-prod.sh --dry-run        # preflight only, no ssh writes
# ------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB_DIR="$SCRIPT_DIR/deploy-lib"

# ---- Colours / log helpers (sourced by lib scripts too) ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[ OK ]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail()    { echo -e "${RED}[FAIL]${NC} $*"; }
section() { echo ""; echo -e "${CYAN}===== $* =====${NC}"; }
export -f info success warn fail section
export RED GREEN YELLOW BLUE CYAN NC

# ---- Config ----
if [[ ! -f "$SCRIPT_DIR/deploy.config.sh" ]]; then
  fail "scripts/deploy.config.sh missing"
  exit 1
fi
# shellcheck source=deploy.config.sh
source "$SCRIPT_DIR/deploy.config.sh"
if [[ -f "$SCRIPT_DIR/deploy.config.local.sh" ]]; then
  # shellcheck source=deploy.config.local.sh
  source "$SCRIPT_DIR/deploy.config.local.sh"
fi

# ---- Args ----
ASSUME_YES=false
SKIP_MIGRATIONS=false
SKIP_BUILD=false
ROLLBACK=false
DRY_RUN=false
TARGET_REF="${DEFAULT_REF:-origin/main}"

for arg in "$@"; do
  case "$arg" in
    --yes)              ASSUME_YES=true ;;
    --skip-migrations)  SKIP_MIGRATIONS=true ;;
    --skip-build)       SKIP_BUILD=true ;;
    --rollback)         ROLLBACK=true ;;
    --dry-run)          DRY_RUN=true ;;
    --ref=*)            TARGET_REF="${arg#--ref=}" ;;
    --help|-h)
      sed -n '2,30p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) fail "Unknown arg: $arg"; exit 1 ;;
  esac
done

export VPS_USER VPS_HOST VPS_PORT VPS_PATH
export PROCESS_MANAGER PM2_APP_NAME SYSTEMD_SERVICE
export BACKEND_PORT HEALTH_PATH
export ENABLE_BACKUP BACKUP_DIR MAX_BACKUPS
export TARGET_REF ASSUME_YES SKIP_MIGRATIONS SKIP_BUILD DRY_RUN
export PROJECT_DIR

# ---- SSH wrapper used by every lib script ----
ssh_run() {
  # Quote-safe remote bash: pass the script via stdin as a heredoc.
  ssh -p "$VPS_PORT" -o BatchMode=yes -o ConnectTimeout=10 \
    "$VPS_USER@$VPS_HOST" "bash -se" <<<"$1"
}
ssh_run_tty() {
  ssh -t -p "$VPS_PORT" -o ConnectTimeout=10 \
    "$VPS_USER@$VPS_HOST" "$@"
}
export -f ssh_run ssh_run_tty

# ---- Lib loader ----
for lib in preflight gate pull-build migrations restart rollback; do
  if [[ ! -f "$LIB_DIR/$lib.sh" ]]; then
    fail "Missing $LIB_DIR/$lib.sh"
    exit 1
  fi
  # shellcheck source=/dev/null
  source "$LIB_DIR/$lib.sh"
done

# ---- Rollback short-circuit ----
if [[ "$ROLLBACK" == true ]]; then
  do_rollback_only
  exit 0
fi

# ---- Pipeline ----
section "1/5 · Pre-flight"
PREVIOUS_REF=""
do_preflight   # sets PREVIOUS_REF
export PREVIOUS_REF

if [[ "$DRY_RUN" == true ]]; then
  warn "Dry-run mode — stopping after pre-flight."
  exit 0
fi

section "2/5 · Gate"
do_gate

section "3/5 · Pull + build"
do_pull_build

if [[ "$SKIP_MIGRATIONS" == true ]]; then
  warn "Skipping migrations (--skip-migrations)"
else
  section "4/5 · Migrations"
  do_migrations
fi

section "5/5 · Restart + health check"
if ! do_restart; then
  fail "Health check failed — initiating rollback"
  do_rollback "$PREVIOUS_REF"
  exit 1
fi

success "Deploy complete · $VPS_HOST is on $TARGET_REF"
echo ""
echo "  Next: tail logs"
if [[ "$PROCESS_MANAGER" == "pm2" ]]; then
  echo "    ssh $VPS_USER@$VPS_HOST -- pm2 logs $PM2_APP_NAME --lines 50"
else
  echo "    ssh $VPS_USER@$VPS_HOST -- journalctl -u $SYSTEMD_SERVICE -n 50 -f"
fi
