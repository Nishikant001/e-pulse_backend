#!/usr/bin/env bash
# Phase 1 read-only smoke test for the Pharma DMS backend.
# - Logs in with an EXISTING test distributor and issues GET requests only.
# - Creates, changes and deletes nothing.
# - Optional cross-tenant check when a second account is supplied.
#
# Usage:
#   EMAIL=a@example.com PASSWORD='secret' bash phase1_smoke_test.sh
#   EMAIL=... PASSWORD=... EMAIL2=b@example.com PASSWORD2='secret2' bash phase1_smoke_test.sh
# Optional: BASE_URL (default http://localhost:5000/api)
set -u

BASE_URL="${BASE_URL:-http://localhost:5000/api}"
: "${EMAIL:?Set EMAIL}"
: "${PASSWORD:?Set PASSWORD}"

JAR1="$(mktemp)"; JAR2="$(mktemp)"
trap 'rm -f "$JAR1" "$JAR2"' EXIT
PASS=0; WARN=0; FAIL=0

report() { # label status expectation
  local label="$1" status="$2" expect="$3"
  if [ "$status" = "$expect" ]; then
    printf "PASS  %-42s %s\n" "$label" "$status"; PASS=$((PASS+1))
  else
    printf "FAIL  %-42s got %s, expected %s\n" "$label" "$status" "$expect"; FAIL=$((FAIL+1))
  fi
}

status_of() { # jar method path [json]
  local jar="$1" method="$2" path="$3" data="${4:-}"
  if [ -n "$data" ]; then
    curl -s -o /dev/null -w "%{http_code}" -b "$jar" -c "$jar" -X "$method" \
      -H "Content-Type: application/json" -d "$data" "$BASE_URL$path"
  else
    curl -s -o /dev/null -w "%{http_code}" -b "$jar" -c "$jar" -X "$method" "$BASE_URL$path"
  fi
}

first_id() { # jar path  -> first "id" of a JSON array (or {data:[...]}) response
  curl -s -b "$1" "$BASE_URL$2" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if isinstance(d, dict):
    for k in ("data", "customers", "vendors", "rows"):
        if isinstance(d.get(k), list):
            d = d[k]; break
if isinstance(d, list) and d and isinstance(d[0], dict) and "id" in d[0]:
    print(d[0]["id"])
'
}

login_json() { python3 -c 'import json,sys; print(json.dumps({"email":sys.argv[1],"password":sys.argv[2]}))' "$1" "$2"; }

echo "== Target: $BASE_URL"
echo "== 1. Authentication"
report "GET /customer without login" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/customer")" 401
report "POST /login" "$(status_of "$JAR1" POST /login "$(login_json "$EMAIL" "$PASSWORD")")" 200
report "POST /refresh-token" "$(status_of "$JAR1" POST /refresh-token)" 200

echo "== 2. Read-only list endpoints (200 expected; 400/404 reported as WARN)"
for p in /customer /customer/count /customergroup /vendor /vendor/count /vendorgroup \
         /itemgroup /hsn /product /pricing /stock /stock/count /stockLedger/current /stockLedger/batch \
         /salesorder /salesorder/count /sales-delivery /sales-delivery/count /sales-invoice \
         /sales-creditnote /sales-debitnote /sales-return \
         /purchase-orders /po-delivery /po-invoice /purchase-return /purchase-debitnote \
         /gl-master /trial-balance /balance-sheet; do
  code="$(status_of "$JAR1" GET "$p")"
  case "$code" in
    200) printf "PASS  %-42s %s\n" "GET $p" "$code"; PASS=$((PASS+1)) ;;
    400|404) printf "WARN  %-42s %s (may need query params or have no data)\n" "GET $p" "$code"; WARN=$((WARN+1)) ;;
    *) printf "FAIL  %-42s %s\n" "GET $p" "$code"; FAIL=$((FAIL+1)) ;;
  esac
done

if [ -n "${EMAIL2:-}" ] && [ -n "${PASSWORD2:-}" ]; then
  echo "== 3. Cross-tenant isolation (account 2 must NOT see account 1's records)"
  CID="$(first_id "$JAR1" /customer)"; VID="$(first_id "$JAR1" /vendor)"
  report "POST /login (account 2)" "$(status_of "$JAR2" POST /login "$(login_json "$EMAIL2" "$PASSWORD2")")" 200
  if [ -n "$CID" ]; then
    report "acct2 GET /customer/$CID (acct1 record)" "$(status_of "$JAR2" GET "/customer/$CID")" 404
  else echo "SKIP  no customer found for account 1"; fi
  if [ -n "$VID" ]; then
    report "acct2 GET /vendor/$VID (acct1 record)" "$(status_of "$JAR2" GET "/vendor/$VID")" 404
  else echo "SKIP  no vendor found for account 1"; fi
  echo "NOTE  Read-only: update/delete cross-tenant checks are intentionally not automated here."
else
  echo "== 3. Cross-tenant isolation: SKIPPED (set EMAIL2 and PASSWORD2 to enable)"
fi

echo "== 4. Logout"
report "POST /logout" "$(status_of "$JAR1" POST /logout)" 200
report "GET /customer after logout" "$(status_of "$JAR1" GET /customer)" 401

echo
echo "Summary: $PASS passed, $WARN warnings, $FAIL failed"
[ "$FAIL" -eq 0 ]
