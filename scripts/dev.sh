#!/usr/bin/env bash
# ------------------------------------------------------------------
# dev.sh — Check services and launch Curve Sync in development mode
#
# What it does:
#   1. Verifies MongoDB is running (exits if not)
#   2. Ensures server/.env exists
#   3. Installs dependencies if node_modules are missing
#   4. Optionally checks Embers Rails (--with-embers)
#   5. Launches both client (Vite :5173) and server (Express :3001)
#
# Usage:
#   ./scripts/dev.sh                  # Start Curve Sync dev
#   ./scripts/dev.sh --with-embers    # Also verify Embers is running
#   ./scripts/dev.sh --server-only    # Backend only
#   ./scripts/dev.sh --client-only    # Frontend only
# ------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

MODE="both"   # both | server | client
CHECK_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --server-only) MODE="server" ;;
    --client-only) MODE="client" ;;
    --with-embers) CHECK_ARGS+=("--with-embers") ;;
    --help)
      head -16 "$0" | grep '^#' | sed 's/^# \?//'
      exit 0
      ;;
  esac
done

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[ OK ]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail()    { echo -e "${RED}[FAIL]${NC} $*"; }

echo ""
echo "========================================"
echo "  Curve Sync — Dev Launcher"
echo "========================================"
echo ""

# ------------------------------------------------------------------
# 1. Quick service checks (MongoDB mandatory)
# ------------------------------------------------------------------
info "Checking required services..."

MONGO_OK=false
if pgrep -x mongod &>/dev/null; then
  MONGO_OK=true
elif command -v systemctl &>/dev/null && systemctl is-active --quiet mongod 2>/dev/null; then
  MONGO_OK=true
fi

if [[ "$MONGO_OK" == true ]]; then
  success "MongoDB is running"
else
  fail "MongoDB is NOT running"
  echo ""
  echo "  Start MongoDB first:"
  echo "    sudo systemctl start mongod"
  echo ""
  echo "  Then re-run: ./scripts/dev.sh"
  exit 1
fi

# Optional Embers check
if [[ ${#CHECK_ARGS[@]} -gt 0 ]]; then
  "$SCRIPT_DIR/check-services.sh" "${CHECK_ARGS[@]}" || {
    warn "Some service checks failed (see above). Continuing anyway..."
  }
fi

# ------------------------------------------------------------------
# 2. Environment file
# ------------------------------------------------------------------
if [[ ! -f "$PROJECT_DIR/server/.env" ]]; then
  info "Creating server/.env from .env.example..."
  cp "$PROJECT_DIR/server/.env.example" "$PROJECT_DIR/server/.env"
  warn "Created server/.env — edit MONGODB_URI if needed"
else
  success "server/.env exists"
fi

# ------------------------------------------------------------------
# 3. Dependencies (install only if missing)
# ------------------------------------------------------------------
NEEDS_INSTALL=false

if [[ ! -d "$PROJECT_DIR/client/node_modules" ]]; then
  warn "client/node_modules missing"
  NEEDS_INSTALL=true
fi

if [[ ! -d "$PROJECT_DIR/server/node_modules" ]]; then
  warn "server/node_modules missing"
  NEEDS_INSTALL=true
fi

if [[ "$NEEDS_INSTALL" == true ]]; then
  info "Installing dependencies..."
  cd "$PROJECT_DIR"
  npm install 2>/dev/null || true
  npm run install:all
  success "Dependencies installed"
fi

# ------------------------------------------------------------------
# 4. Launch
# ------------------------------------------------------------------
echo ""
cd "$PROJECT_DIR"

case "$MODE" in
  both)
    info "Starting client (Vite :5173) + server (Express :3001)..."
    echo ""
    exec npm run dev
    ;;
  server)
    info "Starting server only (Express :3001)..."
    echo ""
    exec npm run dev:server
    ;;
  client)
    info "Starting client only (Vite :5173)..."
    echo ""
    exec npm run dev:client
    ;;
esac
