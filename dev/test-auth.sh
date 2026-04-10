#!/bin/bash
# dev/test-auth.sh — Smoke test for MU-1/MU-2/MU-3 auth flow.
# Usage: ./dev/test-auth.sh <email> <password> [host]
#
# Example:
#   ./dev/test-auth.sh filipe3x@hotmail.com minha_pass
#   ./dev/test-auth.sh filipe3x@hotmail.com minha_pass http://raspberrypi.local:3001

set -euo pipefail

EMAIL="${1:?Usage: $0 <email> <password> [host]}"
PASSWORD="${2:?Usage: $0 <email> <password> [host]}"
HOST="${3:-http://localhost:3001}"

PASS=0
FAIL=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  ✓ $label"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $label (expected $expected, got $actual)"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Auth Smoke Tests ==="
echo "Host: $HOST"
echo ""

# ---------- 1. Login with wrong password ----------
echo "1. Login with wrong password"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "$HOST/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"definitely_wrong_password_123\"}")
check "returns 401" "401" "$HTTP"

# ---------- 2. Login with correct password ----------
echo "2. Login with correct password"
RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$HOST/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
HTTP=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
check "returns 200" "200" "$HTTP"

TOKEN=$(echo "$BODY" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{try{console.log(JSON.parse(d).token||'')}catch{console.log('')}})
" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "  ✗ No token received — cannot continue. Check password."
  echo ""
  echo "Response body: $BODY"
  exit 1
fi
echo "  ✓ Token received (${#TOKEN} chars)"

USER_EMAIL=$(echo "$BODY" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{try{console.log(JSON.parse(d).user.email||'')}catch{console.log('')}})
" 2>/dev/null)
check "user.email matches" "$EMAIL" "$USER_EMAIL"

# ---------- 3. Request without token ----------
echo "3. Request without token"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$HOST/api/expenses")
check "GET /expenses returns 401" "401" "$HTTP"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$HOST/api/curve/config")
check "GET /curve/config returns 401" "401" "$HTTP"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$HOST/api/categories")
check "GET /categories returns 401" "401" "$HTTP"

# ---------- 4. Request with valid token ----------
echo "4. Request with valid token"
AUTH="Authorization: Bearer $TOKEN"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "$HOST/api/expenses")
check "GET /expenses returns 200" "200" "$HTTP"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "$HOST/api/categories")
check "GET /categories returns 200" "200" "$HTTP"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "$HOST/api/curve/config")
check "GET /curve/config returns 200" "200" "$HTTP"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "$HOST/api/curve/logs")
check "GET /curve/logs returns 200" "200" "$HTTP"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "$HOST/api/autocomplete/entity")
check "GET /autocomplete/entity returns 200" "200" "$HTTP"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "$HOST/api/curve/scheduler/status")
check "GET /scheduler/status returns 200" "200" "$HTTP"

# ---------- 5. GET /auth/me ----------
echo "5. GET /auth/me"
RESPONSE=$(curl -s -w "\n%{http_code}" -H "$AUTH" "$HOST/api/auth/me")
HTTP=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')
check "returns 200" "200" "$HTTP"

ME_EMAIL=$(echo "$BODY" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{try{console.log(JSON.parse(d).user.email||'')}catch{console.log('')}})
" 2>/dev/null)
check "me.email matches" "$EMAIL" "$ME_EMAIL"

# ---------- 6. Logout ----------
echo "6. Logout"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST -H "$AUTH" "$HOST/api/auth/logout")
check "POST /logout returns 200" "200" "$HTTP"

# ---------- 7. Token invalidated after logout ----------
echo "7. Token invalidated after logout"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "$HOST/api/expenses")
check "GET /expenses returns 401" "401" "$HTTP"

HTTP=$(curl -s -o /dev/null -w "%{http_code}" -H "$AUTH" "$HOST/api/auth/me")
check "GET /me returns 401" "401" "$HTTP"

# ---------- 8. Health check (always public) ----------
echo "8. Health check (public)"
HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$HOST/api/health")
check "GET /health returns 200" "200" "$HTTP"

# ---------- Summary ----------
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
