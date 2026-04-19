#!/usr/bin/env bash
# ------------------------------------------------------------------
# setup-pi.sh — Pre-flight check for Curve Sync on Raspberry Pi
#
# READ-ONLY: This script does NOT install or modify anything.
# It only checks what is installed, reports versions, and tells
# you what (if anything) is missing.
#
# Usage:
#   chmod +x scripts/setup-pi.sh
#   ./scripts/setup-pi.sh
# ------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
success() { echo -e "${GREEN}[ OK ]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail()    { echo -e "${RED}[FAIL]${NC} $*"; }

ERRORS=0
WARNINGS=0

echo ""
echo "========================================"
echo "  Curve Sync — Pre-flight Check"
echo "========================================"
echo ""

# ------------------------------------------------------------------
# 1. System info
# ------------------------------------------------------------------
ARCH=$(uname -m)
KERNEL=$(uname -r)
info "Architecture: $ARCH"
info "Kernel: $KERNEL"

if [[ "$ARCH" == "aarch64" || "$ARCH" == "arm64" ]]; then
  success "ARM64 — compatible with Raspberry Pi 5"
elif [[ "$ARCH" == "x86_64" ]]; then
  success "x86_64 — compatible"
else
  warn "Architecture $ARCH — may have compatibility issues"
  WARNINGS=$((WARNINGS + 1))
fi

OS_ID=$(grep -oP '(?<=^ID=).+' /etc/os-release 2>/dev/null | tr -d '"' || echo "unknown")
OS_VERSION=$(grep -oP '(?<=^VERSION_ID=).+' /etc/os-release 2>/dev/null | tr -d '"' || echo "unknown")
OS_PRETTY=$(grep -oP '(?<=^PRETTY_NAME=).+' /etc/os-release 2>/dev/null | tr -d '"' || echo "unknown")
info "OS: $OS_PRETTY"

# Check available RAM
if [[ -f /proc/meminfo ]]; then
  TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
  TOTAL_RAM_MB=$((TOTAL_RAM_KB / 1024))
  if (( TOTAL_RAM_MB >= 2048 )); then
    success "RAM: ${TOTAL_RAM_MB}MB (>= 2GB recommended)"
  elif (( TOTAL_RAM_MB >= 1024 )); then
    warn "RAM: ${TOTAL_RAM_MB}MB (2GB+ recommended, 1GB may be tight with MongoDB)"
    WARNINGS=$((WARNINGS + 1))
  else
    warn "RAM: ${TOTAL_RAM_MB}MB (MongoDB needs at least 1GB)"
    WARNINGS=$((WARNINGS + 1))
  fi
fi

# Check available disk
DISK_AVAIL=$(df -BM "$PROJECT_DIR" 2>/dev/null | tail -1 | awk '{print $4}' | tr -d 'M')
if [[ -n "$DISK_AVAIL" ]] && (( DISK_AVAIL > 0 )); then
  if (( DISK_AVAIL >= 2048 )); then
    success "Disk: ${DISK_AVAIL}MB available"
  else
    warn "Disk: ${DISK_AVAIL}MB available (2GB+ recommended)"
    WARNINGS=$((WARNINGS + 1))
  fi
fi

# ------------------------------------------------------------------
# 2. Node.js
# ------------------------------------------------------------------
echo ""
echo -e "${BLUE}--- Node.js ---${NC}"

if command -v node &>/dev/null; then
  NODE_VERSION=$(node -v | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
  NODE_PATH=$(command -v node)
  if (( NODE_MAJOR >= 18 )); then
    success "Node.js v$NODE_VERSION ($NODE_PATH)"
  else
    fail "Node.js v$NODE_VERSION — too old (>= 18 required)"
    warn "  Install Node.js 20 LTS: https://nodejs.org/ or via nvm/NodeSource"
    ERRORS=$((ERRORS + 1))
  fi
else
  fail "Node.js not found"
  warn "  Install Node.js 20 LTS: https://nodejs.org/"
  warn "  ARM64: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs"
  ERRORS=$((ERRORS + 1))
fi

if command -v npm &>/dev/null; then
  success "npm $(npm -v)"
else
  fail "npm not found"
  ERRORS=$((ERRORS + 1))
fi

# ------------------------------------------------------------------
# 3. MongoDB
# ------------------------------------------------------------------
echo ""
echo -e "${BLUE}--- MongoDB ---${NC}"

MONGODB_URI=""
if [[ -f "$PROJECT_DIR/server/.env" ]]; then
  MONGODB_URI=$(grep -oP '(?<=MONGODB_URI=).+' "$PROJECT_DIR/server/.env" 2>/dev/null || echo "")
fi
MONGODB_URI="${MONGODB_URI:-mongodb://localhost:27017/embers_db}"

if command -v mongod &>/dev/null; then
  MONGO_VERSION=$(mongod --version 2>/dev/null | head -1 | grep -oP '[\d.]+' | head -1 || echo "unknown")
  MONGO_PATH=$(command -v mongod)
  success "mongod v$MONGO_VERSION ($MONGO_PATH)"
else
  fail "mongod not found"
  warn "  Install MongoDB 7.0+: https://www.mongodb.com/docs/manual/installation/"
  warn "  ARM64 (RPi 5): https://www.mongodb.com/docs/manual/tutorial/install-mongodb-on-debian/"
  ERRORS=$((ERRORS + 1))
fi

if command -v mongosh &>/dev/null; then
  MONGOSH_VERSION=$(mongosh --version 2>/dev/null || echo "unknown")
  success "mongosh v$MONGOSH_VERSION"
else
  warn "mongosh not found (optional, but useful for debugging)"
  WARNINGS=$((WARNINGS + 1))
fi

# Check if MongoDB is running
MONGO_RUNNING=false
if pgrep -x mongod &>/dev/null; then
  MONGO_PID=$(pgrep -x mongod | head -1)
  success "mongod is running (PID: $MONGO_PID)"
  MONGO_RUNNING=true
elif command -v systemctl &>/dev/null && systemctl is-active --quiet mongod 2>/dev/null; then
  success "mongod service is active"
  MONGO_RUNNING=true
else
  fail "mongod is NOT running"
  warn "  Start with: sudo systemctl start mongod"
  ERRORS=$((ERRORS + 1))
fi

# Test connectivity if mongosh is available and mongo is running
if [[ "$MONGO_RUNNING" == true ]] && command -v mongosh &>/dev/null; then
  if mongosh "$MONGODB_URI" --eval "db.runCommand({ping:1})" --quiet 2>/dev/null | grep -q "ok"; then
    success "MongoDB responding to queries"

    DB_NAME=$(echo "$MONGODB_URI" | grep -oP '[^/]+$' | grep -oP '^[^?]+')
    COLLECTIONS=$(mongosh "$MONGODB_URI" --eval "db.getCollectionNames().join(', ')" --quiet 2>/dev/null || echo "?")
    info "Database: $DB_NAME"
    info "Collections: $COLLECTIONS"
  else
    warn "MongoDB running but not responding to queries on $MONGODB_URI"
    WARNINGS=$((WARNINGS + 1))
  fi
fi

# ------------------------------------------------------------------
# 4. Ruby / Rails (Embers)
# ------------------------------------------------------------------
echo ""
echo -e "${BLUE}--- Ruby / Rails (Embers) ---${NC}"

if command -v ruby &>/dev/null; then
  RUBY_VERSION=$(ruby -v 2>/dev/null | grep -oP '[\d.]+' | head -1 || echo "unknown")
  RUBY_PATH=$(command -v ruby)
  success "Ruby $RUBY_VERSION ($RUBY_PATH)"
else
  warn "Ruby not found"
  warn "  Required only if running Embers Rails alongside Curve Sync"
  warn "  Install: sudo apt-get install -y ruby-full  (or use rbenv/rvm)"
  WARNINGS=$((WARNINGS + 1))
fi

if command -v rails &>/dev/null; then
  RAILS_VERSION=$(rails -v 2>/dev/null | grep -oP '[\d.]+' || echo "unknown")
  success "Rails $RAILS_VERSION"
else
  warn "Rails not found"
  warn "  Required only if running Embers locally"
  WARNINGS=$((WARNINGS + 1))
fi

if command -v bundle &>/dev/null; then
  BUNDLER_VERSION=$(bundle -v 2>/dev/null | grep -oP '[\d.]+' | head -1 || echo "unknown")
  success "Bundler $BUNDLER_VERSION"
else
  warn "Bundler not found (needed for Embers: gem install bundler)"
  WARNINGS=$((WARNINGS + 1))
fi

# Check if Embers is nearby
EMBERS_FOUND=false
for candidate in "$PROJECT_DIR/../embers" "$PROJECT_DIR/../Embers" "$HOME/embers" "$HOME/Embers"; do
  if [[ -f "$candidate/Gemfile" && -f "$candidate/config/routes.rb" ]]; then
    EMBERS_PATH="$(cd "$candidate" && pwd)"
    success "Embers project found at: $EMBERS_PATH"
    EMBERS_FOUND=true
    break
  fi
done
if [[ "$EMBERS_FOUND" == false ]]; then
  info "Embers project not found nearby (checked ../embers, ~/embers)"
  info "Set EMBERS_PATH env var if it's in a custom location"
fi

# Check if Embers/Puma is running
if pgrep -f "puma\|rails server" &>/dev/null; then
  PUMA_PID=$(pgrep -f "puma\|rails server" | head -1)
  success "Rails/Puma is running (PID: $PUMA_PID)"
  if command -v curl &>/dev/null; then
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null || echo "000")
    if [[ "$HTTP_CODE" =~ ^[23] ]]; then
      success "Embers responding at http://localhost:3000 (HTTP $HTTP_CODE)"
    else
      warn "Embers on port 3000 returned HTTP $HTTP_CODE"
    fi
  fi
else
  info "Rails/Puma not running (only needed if using Embers locally)"
fi

# ------------------------------------------------------------------
# 5. Project state
# ------------------------------------------------------------------
echo ""
echo -e "${BLUE}--- Project ---${NC}"

if [[ -d "$PROJECT_DIR/node_modules" ]]; then
  success "root node_modules exists (concurrently)"
else
  fail "root node_modules missing — run: npm run install:all"
  ERRORS=$((ERRORS + 1))
fi

if [[ -d "$PROJECT_DIR/client/node_modules" ]]; then
  success "client/node_modules exists"
else
  fail "client/node_modules missing — run: npm run install:all"
  ERRORS=$((ERRORS + 1))
fi

if [[ -d "$PROJECT_DIR/server/node_modules" ]]; then
  success "server/node_modules exists"
else
  fail "server/node_modules missing — run: npm run install:all"
  ERRORS=$((ERRORS + 1))
fi

if [[ -f "$PROJECT_DIR/server/.env" ]]; then
  success "server/.env exists"
  # Check key vars without revealing values
  if grep -q 'MONGODB_URI=' "$PROJECT_DIR/server/.env" 2>/dev/null; then
    success "MONGODB_URI is set"
  else
    warn "MONGODB_URI not found in server/.env"
    WARNINGS=$((WARNINGS + 1))
  fi
else
  fail "server/.env missing — copy from server/.env.example"
  ERRORS=$((ERRORS + 1))
fi

# ------------------------------------------------------------------
# 6. Optional tools
# ------------------------------------------------------------------
echo ""
echo -e "${BLUE}--- Optional Tools ---${NC}"

if command -v git &>/dev/null; then
  success "git $(git --version 2>/dev/null | grep -oP '[\d.]+' | head -1)"
else
  warn "git not found"
fi

if command -v curl &>/dev/null; then
  success "curl available"
else
  warn "curl not found (useful for health checks)"
fi

if command -v python3 &>/dev/null; then
  success "Python $(python3 --version 2>/dev/null | grep -oP '[\d.]+' || echo '?') (for legacy curve.py)"
else
  info "Python3 not found (only needed for legacy curve.py)"
fi

# ------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------
echo ""
echo "========================================"
echo "  Summary"
echo "========================================"
echo ""

if (( ERRORS == 0 && WARNINGS == 0 )); then
  echo -e "${GREEN}All checks passed! Ready to run.${NC}"
elif (( ERRORS == 0 )); then
  echo -e "${GREEN}Ready to run${NC} with ${YELLOW}$WARNINGS warning(s)${NC}"
else
  echo -e "${RED}$ERRORS issue(s) must be fixed${NC}, ${YELLOW}$WARNINGS warning(s)${NC}"
fi

echo ""
echo "  Next steps:"
if (( ERRORS > 0 )); then
  echo "    1. Fix the FAIL items above"
  echo "    2. Re-run: ./scripts/setup-pi.sh"
else
  echo "    ./scripts/dev.sh          # Check services + launch dev"
  echo "    npm run dev               # Launch dev directly"
fi
echo ""

exit $ERRORS
