#!/usr/bin/env bash
# ------------------------------------------------------------------
# check-services.sh — Verify MongoDB and (optionally) Embers Rails
#
# READ-ONLY: This script does NOT install, start, or modify anything.
# It checks if services are running and reports their status.
#
# Usage:
#   ./scripts/check-services.sh                   # Check MongoDB only
#   ./scripts/check-services.sh --with-embers      # Also check Embers Rails
#   EMBERS_PATH=/path/to/embers ./scripts/check-services.sh --with-embers
#
# Exit codes:
#   0  All required services are running
#   1+ Number of issues found
# ------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

WITH_EMBERS=false

for arg in "$@"; do
  case "$arg" in
    --with-embers) WITH_EMBERS=true ;;
    --help)
      head -15 "$0" | grep '^#' | sed 's/^# \?//'
      exit 0
      ;;
  esac
done

success() { echo -e "${GREEN}[ OK ]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail()    { echo -e "${RED}[FAIL]${NC} $*"; }
info()    { echo -e "${BLUE}[INFO]${NC} $*"; }

ERRORS=0

# --- Load MONGODB_URI from .env ---
MONGODB_URI=""
if [[ -f "$PROJECT_DIR/server/.env" ]]; then
  MONGODB_URI=$(grep -oP '(?<=MONGODB_URI=).+' "$PROJECT_DIR/server/.env" 2>/dev/null || echo "")
fi
MONGODB_URI="${MONGODB_URI:-mongodb://localhost:27017/embers_db}"

MONGO_HOST=$(echo "$MONGODB_URI" | grep -oP '(?<=://).+?(?=/|$)' | head -1)
MONGO_HOST="${MONGO_HOST:-localhost:27017}"

echo ""
echo "========================================"
echo "  Service Health Check"
echo "========================================"

# ------------------------------------------------------------------
# 1. MongoDB
# ------------------------------------------------------------------
echo ""
echo -e "${CYAN}--- MongoDB ---${NC}"

# Is the process running?
if pgrep -x mongod &>/dev/null; then
  MONGO_PID=$(pgrep -x mongod | head -1)
  success "mongod process running (PID: $MONGO_PID)"
elif command -v systemctl &>/dev/null && systemctl is-active --quiet mongod 2>/dev/null; then
  success "mongod service active"
else
  fail "mongod is NOT running"
  warn "  Start: sudo systemctl start mongod"
  ERRORS=$((ERRORS + 1))
fi

# Can we connect?
if command -v mongosh &>/dev/null; then
  if mongosh "$MONGODB_URI" --eval "db.runCommand({ping:1})" --quiet 2>/dev/null | grep -q "ok"; then
    success "Connected to $MONGO_HOST"

    # Report Embers data presence
    DB_NAME=$(echo "$MONGODB_URI" | grep -oP '[^/]+$' | grep -oP '^[^?]+')
    USERS_COUNT=$(mongosh "$MONGODB_URI" --eval "db.users.countDocuments()" --quiet 2>/dev/null || echo "?")
    CATEGORIES_COUNT=$(mongosh "$MONGODB_URI" --eval "db.categories.countDocuments()" --quiet 2>/dev/null || echo "?")
    info "DB: $DB_NAME | users: $USERS_COUNT | categories: $CATEGORIES_COUNT"
  else
    fail "Cannot connect to MongoDB at $MONGO_HOST"
    warn "  Check: is mongod listening on the right port? Is auth configured?"
    ERRORS=$((ERRORS + 1))
  fi
elif command -v mongo &>/dev/null; then
  if mongo "$MONGODB_URI" --eval "db.runCommand({ping:1})" --quiet 2>/dev/null; then
    success "Connected to $MONGO_HOST (legacy shell)"
  else
    fail "Cannot connect to MongoDB at $MONGO_HOST"
    ERRORS=$((ERRORS + 1))
  fi
else
  # Fallback: TCP check
  HOST=$(echo "$MONGO_HOST" | cut -d: -f1)
  PORT=$(echo "$MONGO_HOST" | cut -d: -f2)
  PORT="${PORT:-27017}"
  if command -v nc &>/dev/null && nc -z -w2 "$HOST" "$PORT" 2>/dev/null; then
    success "Port $PORT open on $HOST (likely MongoDB)"
  else
    warn "Cannot verify MongoDB connectivity (no mongosh/mongo/nc)"
  fi
fi

# ------------------------------------------------------------------
# 2. Embers (Rails) — optional
# ------------------------------------------------------------------
if [[ "$WITH_EMBERS" == true ]]; then
  echo ""
  echo -e "${CYAN}--- Embers (Rails) ---${NC}"

  # Find Embers
  EMBERS_PATH="${EMBERS_PATH:-}"
  if [[ -z "$EMBERS_PATH" ]]; then
    for candidate in "$PROJECT_DIR/../embers" "$PROJECT_DIR/../Embers" "$HOME/embers" "$HOME/Embers"; do
      if [[ -f "$candidate/Gemfile" && -f "$candidate/config/routes.rb" ]]; then
        EMBERS_PATH="$(cd "$candidate" && pwd)"
        break
      fi
    done
  fi

  if [[ -z "$EMBERS_PATH" || ! -d "$EMBERS_PATH" ]]; then
    fail "Embers project not found"
    warn "  Set EMBERS_PATH=/path/to/embers or place it at ../embers"
    ERRORS=$((ERRORS + 1))
  else
    success "Embers at: $EMBERS_PATH"

    # Check config files
    if [[ -f "$EMBERS_PATH/config/mongoid.yml" ]]; then
      success "mongoid.yml present"
    else
      fail "mongoid.yml missing — copy from mongoid.yml_example"
      ERRORS=$((ERRORS + 1))
    fi

    if [[ -f "$EMBERS_PATH/config/application.yml" ]]; then
      success "application.yml present (Figaro)"
    else
      warn "application.yml missing — env vars may not load"
    fi

    # Check if Rails/Puma is running
    if pgrep -f "puma\|rails server" &>/dev/null; then
      PUMA_PID=$(pgrep -f "puma\|rails server" | head -1)
      success "Rails/Puma running (PID: $PUMA_PID)"
    else
      fail "Rails/Puma NOT running"
      warn "  Start: cd $EMBERS_PATH && bundle exec rails server -p 3000"
      ERRORS=$((ERRORS + 1))
    fi

    # HTTP check
    if command -v curl &>/dev/null; then
      HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null || echo "000")
      if [[ "$HTTP_CODE" =~ ^[23] ]]; then
        success "Embers HTTP OK (http://localhost:3000 → $HTTP_CODE)"
      elif [[ "$HTTP_CODE" == "000" ]]; then
        info "Embers not reachable on port 3000"
      else
        warn "Embers returned HTTP $HTTP_CODE"
      fi
    fi
  fi
fi

# ------------------------------------------------------------------
# 3. Curve Sync status
# ------------------------------------------------------------------
echo ""
echo -e "${CYAN}--- Curve Sync ---${NC}"

CURVE_PORT=$(grep -oP '(?<=PORT=)\d+' "$PROJECT_DIR/server/.env" 2>/dev/null || echo "3001")

if command -v curl &>/dev/null; then
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$CURVE_PORT/api/health" 2>/dev/null || echo "000")
  if [[ "$HTTP_CODE" =~ ^[23] ]]; then
    success "Curve Sync running at http://localhost:$CURVE_PORT (HTTP $HTTP_CODE)"
  else
    info "Curve Sync not running on port $CURVE_PORT (start with: npm run dev)"
  fi
else
  info "curl not available — cannot check Curve Sync HTTP"
fi

# ------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------
echo ""
echo "========================================"
if (( ERRORS == 0 )); then
  echo -e "  ${GREEN}All services healthy${NC}"
else
  echo -e "  ${RED}$ERRORS issue(s) found${NC}"
fi
echo "========================================"
echo ""

exit $ERRORS
