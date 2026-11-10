#!/usr/bin/env bash
# Phase 3 smoke test for the Admin portal API boundary. Read-only except for signing in/out; creates no data.
#
# Usage:
#   ADMIN_EMAIL=admin@company.com ADMIN_PASSWORD='...' bash phase3_admin_smoke_test.sh
#   (optional) DIST_EMAIL=... DIST_PASSWORD=... to prove a Distributor login does NOT open the Admin API
#   (optional) BASE_URL (default http://localhost:5000/api)
# Do NOT run this against production with real credentials typed on a shared terminal.
set -u
BASE_URL="${BASE_URL:-http://localhost:5000/api}"
: "${ADMIN_EMAIL:?Set ADMIN_EMAIL}"
: "${ADMIN_PASSWORD:?Set ADMIN_PASSWORD}"

ADMIN_JAR="$(mktemp)"; DIST_JAR="$(mktemp)"; ANON_JAR="$(mktemp)"
trap 'rm -f "$ADMIN_JAR" "$DIST_JAR" "$ANON_JAR"' EXIT
PASS=0; FAIL=0
report() { if [ "$2" = "$3" ]; then printf "PASS  %-72s %s\n" "$1" "$2"; PASS=$((PASS+1)); else printf "FAIL  %-72s got %s, expected %s\n" "$1" "$2" "$3"; FAIL=$((FAIL+1)); fi; }
code() { curl -s -o /dev/null -w "%{http_code}" -b "$1" -c "$1" -X "$2" "${@:4}" "$BASE_URL$3"; }
json() { python3 -c 'import json,sys; print(json.dumps({"email":sys.argv[1],"password":sys.argv[2]}))' "$1" "$2"; }
post_json() { curl -s -o /dev/null -w "%{http_code}" -b "$1" -c "$1" -X POST -H "Content-Type: application/json" -d "$3" "$BASE_URL$2"; }

echo "== Target: $BASE_URL"
echo "== 1. Without any session"
report "GET  /admin/session (anonymous) answers 200 { authenticated:false }" "$(code "$ANON_JAR" GET /admin/session)" 200
report "GET  /admin/me (anonymous)" "$(code "$ANON_JAR" GET /admin/me)" 401
report "GET  /admin/dashboard/summary (anonymous)" "$(code "$ANON_JAR" GET /admin/dashboard/summary)" 401
AUTH_FLAG="$(curl -s "$BASE_URL/admin/session" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("authenticated"))' 2>/dev/null)"
report "     /admin/session body says authenticated=False" "$AUTH_FLAG" "False"

if [ -n "${DIST_EMAIL:-}" ] && [ -n "${DIST_PASSWORD:-}" ]; then
  echo "== 2. A DISTRIBUTOR session must not open the Admin API"
  report "POST /login (distributor)" "$(post_json "$DIST_JAR" /login "$(json "$DIST_EMAIL" "$DIST_PASSWORD")")" 200
  report "GET  /customer with distributor cookies still works" "$(code "$DIST_JAR" GET /customer)" 200
  report "GET  /admin/dashboard/summary with distributor cookies" "$(code "$DIST_JAR" GET /admin/dashboard/summary)" 401
  report "GET  /admin/me with distributor cookies" "$(code "$DIST_JAR" GET /admin/me)" 401
  DIST_TOKEN="$(awk '$6=="accessToken"{print $7}' "$DIST_JAR" | head -1)"
  if [ -n "$DIST_TOKEN" ]; then
    report "GET  /admin/dashboard/summary with the distributor token as Bearer" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $DIST_TOKEN" "$BASE_URL/admin/dashboard/summary")" 401
    report "GET  /admin/dashboard/summary with the distributor token forged into the admin cookie" "$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: adminAccessToken=$DIST_TOKEN" "$BASE_URL/admin/dashboard/summary")" 401
  fi
else
  echo "== 2. Distributor cross-check: SKIPPED (set DIST_EMAIL and DIST_PASSWORD to enable)"
fi

echo "== 3. Admin sign-in"
report "POST /admin/login with a wrong password" "$(post_json "$ADMIN_JAR" /admin/login "$(json "$ADMIN_EMAIL" "definitely-wrong-password")")" 401
report "POST /admin/login with the correct password" "$(post_json "$ADMIN_JAR" /admin/login "$(json "$ADMIN_EMAIL" "$ADMIN_PASSWORD")")" 200
COOKIE_LINE="$(grep adminAccessToken "$ADMIN_JAR" | head -1)"
report "session cookie is HttpOnly and scoped to /api/admin" "$(echo "$COOKIE_LINE" | grep -c '^#HttpOnly_.*/api/admin')" 1

echo "== 4. Admin data"
report "GET  /admin/session (admin)" "$(code "$ADMIN_JAR" GET /admin/session)" 200
report "GET  /admin/me (admin)" "$(code "$ADMIN_JAR" GET /admin/me)" 200
report "GET  /admin/dashboard/summary (default range)" "$(code "$ADMIN_JAR" GET '/admin/dashboard/summary')" 200
BODY="$(curl -s -b "$ADMIN_JAR" "$BASE_URL/admin/dashboard/summary?from=2026-01-01&to=2026-01-31")"
KPIS="$(echo "$BODY" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d["kpis"]), d["meta"]["range"]["from"], d["sap"]["status"])' 2>/dev/null)"
report "summary JSON has 8 KPIs, echoes the range, and reports SAP honestly" "$KPIS" "8 2026-01-01 not_configured"
report "invalid date → 400" "$(code "$ADMIN_JAR" GET '/admin/dashboard/summary?from=nope&to=2026-01-31')" 400
report "from after to → 400" "$(code "$ADMIN_JAR" GET '/admin/dashboard/summary?from=2026-02-01&to=2026-01-01')" 400
report "range over 400 days → 400" "$(code "$ADMIN_JAR" GET '/admin/dashboard/summary?from=2024-01-01&to=2026-01-31')" 400
echo "== 5. An ADMIN session must not open the Distributor API"
report "GET  /customer with the admin cookie" "$(code "$ADMIN_JAR" GET /customer)" 401

echo "== 6. Sign out"
report "POST /admin/logout" "$(code "$ADMIN_JAR" POST /admin/logout)" 200
report "GET  /admin/dashboard/summary after logout" "$(code "$ADMIN_JAR" GET /admin/dashboard/summary)" 401

echo; echo "Summary: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
