#!/usr/bin/env bash
# Smoke test for passthrough-api — run this from your machine, not the sandbox
# (the sandbox can't reach passthrough.dev / workers.dev).
#
# Usage:
#   chmod +x smoke-test.sh
#   ./smoke-test.sh
#
# Override the base URL if testing against workers.dev directly instead of
# the custom domain, e.g.:
#   BASE=https://passthrough-api.deeptec.workers.dev ./smoke-test.sh

set -uo pipefail

BASE="${BASE:-https://passthrough.dev}"
API="$BASE/api"
PASS=0
FAIL=0

hr() { printf '%s\n' "──────────────────────────────────────────────"; }

check() {
  local label="$1" expected="$2" actual="$3" body="$4"
  if [[ "$actual" == "$expected" ]]; then
    echo "✅ PASS  $label  (status $actual)"
    ((PASS++))
  else
    echo "❌ FAIL  $label  (expected $expected, got $actual)"
    echo "        body: $(echo "$body" | head -c 300)"
    ((FAIL++))
  fi
}

hr
echo "Smoke testing $BASE"
hr

# 1. 404 route — confirms the worker is up and routing correctly
resp=$(curl -s -w "\n%{http_code}" "$API/this-route-does-not-exist")
body=$(echo "$resp" | head -n -1); code=$(echo "$resp" | tail -n1)
check "404 handler" "404" "$code" "$body"

# 2. Register a throwaway test user
EMAIL="smoketest+$(date +%s)@example.com"
PASSWORD="SmokeTest12345"
resp=$(curl -s -w "\n%{http_code}" -X POST "$API/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Smoke Test\",\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
body=$(echo "$resp" | head -n -1); code=$(echo "$resp" | tail -n1)
check "register" "201" "$code" "$body"
# Some deployments return 200 instead of 201 — surface it either way above.

# 3. Login with that user
resp=$(curl -s -w "\n%{http_code}" -X POST "$API/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
body=$(echo "$resp" | head -n -1); code=$(echo "$resp" | tail -n1)
check "login" "200" "$code" "$body"
TOKEN=$(echo "$body" | grep -o '"token":"[^"]*"' | head -1 | cut -d'"' -f4)
if [[ -z "$TOKEN" ]]; then
  TOKEN=$(echo "$body" | grep -o '"token"\s*:\s*"[^"]*"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
fi

# 4. /me without a token → 401
resp=$(curl -s -w "\n%{http_code}" "$API/auth/me")
body=$(echo "$resp" | head -n -1); code=$(echo "$resp" | tail -n1)
check "me (no token) -> 401" "401" "$code" "$body"

# 5. /me with the token from login
if [[ -n "$TOKEN" ]]; then
  resp=$(curl -s -w "\n%{http_code}" "$API/auth/me" -H "Authorization: Bearer $TOKEN")
  body=$(echo "$resp" | head -n -1); code=$(echo "$resp" | tail -n1)
  check "me (with token)" "200" "$code" "$body"
else
  echo "⚠️  SKIP  me (with token) — couldn't parse token out of login response"
fi

# 6. Verify a bogus code → 404
resp=$(curl -s -w "\n%{http_code}" "$API/verify/does-not-exist-code")
body=$(echo "$resp" | head -n -1); code=$(echo "$resp" | tail -n1)
check "verify bogus code -> 404" "404" "$code" "$body"

# 7. Employer lead submission
resp=$(curl -s -w "\n%{http_code}" -X POST "$API/employer-leads" \
  -H "Content-Type: application/json" \
  -d '{"name":"Smoke Test","company":"Acme QA","email":"employer-smoketest@example.com"}')
body=$(echo "$resp" | head -n -1); code=$(echo "$resp" | tail -n1)
check "employer-leads create" "200" "$code" "$body"

# 8. Payment init without a real scanId → should 400/403, NOT 500
if [[ -n "$TOKEN" ]]; then
  resp=$(curl -s -w "\n%{http_code}" -X POST "$API/payments/initialize" \
    -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
    -d '{"scanId":"00000000-0000-0000-0000-000000000000","fixTier":"FIX"}')
  body=$(echo "$resp" | head -n -1); code=$(echo "$resp" | tail -n1)
  if [[ "$code" == "400" || "$code" == "403" ]]; then
    echo "✅ PASS  payments/initialize rejects bogus scan  (status $code)"
    ((PASS++))
  else
    echo "❌ FAIL  payments/initialize rejects bogus scan  (expected 400/403, got $code)"
    echo "        body: $(echo "$body" | head -c 300)"
    ((FAIL++))
  fi
fi

hr
echo "Results: $PASS passed, $FAIL failed"
hr
