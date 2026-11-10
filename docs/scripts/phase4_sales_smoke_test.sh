#!/usr/bin/env bash
# Phase 4 smoke test for the Admin Sales API boundary and read endpoints. Creates no data by default (set CREATE=1 to also
# exercise the write path with a throwaway draft order, which is left in DRAFT and never confirmed/posted).
#
# Usage:
#   ADMIN_EMAIL=admin@company.com ADMIN_PASSWORD='...' bash phase4_sales_smoke_test.sh
#   CREATE=1 ADMIN_EMAIL=... ADMIN_PASSWORD=... DISTRIBUTOR_ID=1 RETAILER_ID=1 PRODUCT_ID=1 bash phase4_sales_smoke_test.sh
set -u
BASE_URL="${BASE_URL:-http://localhost:5000/api}"
: "${ADMIN_EMAIL:?Set ADMIN_EMAIL}"
: "${ADMIN_PASSWORD:?Set ADMIN_PASSWORD}"
ADMIN_JAR="$(mktemp)"; trap 'rm -f "$ADMIN_JAR"' EXIT
PASS=0; FAIL=0
report() { if [ "$2" = "$3" ]; then printf "PASS  %-70s %s\n" "$1" "$2"; PASS=$((PASS+1)); else printf "FAIL  %-70s got %s, expected %s\n" "$1" "$2" "$3"; FAIL=$((FAIL+1)); fi; }
code() { curl -s -o /dev/null -w "%{http_code}" -b "$ADMIN_JAR" -c "$ADMIN_JAR" -X "$1" "${@:3}" "$BASE_URL$2"; }
post_json() { curl -s -b "$ADMIN_JAR" -c "$ADMIN_JAR" -X POST -H "Content-Type: application/json" -d "$2" "$BASE_URL$1"; }

echo "== Target: $BASE_URL"
LOGIN_JSON="$(python3 -c 'import json,sys; print(json.dumps({"email":sys.argv[1],"password":sys.argv[2]}))' "$ADMIN_EMAIL" "$ADMIN_PASSWORD")"
report "POST /admin/login" "$(curl -s -o /dev/null -w '%{http_code}' -b "$ADMIN_JAR" -c "$ADMIN_JAR" -X POST -H 'Content-Type: application/json' -d "$LOGIN_JSON" "$BASE_URL/admin/login")" 200

echo "== 1. Reads"
report "GET  /admin/sales/lookups/filters" "$(code GET /admin/sales/lookups/filters)" 200
report "GET  /admin/sales/orders" "$(code GET /admin/sales/orders)" 200
report "GET  /admin/sales/invoices" "$(code GET /admin/sales/invoices)" 200
report "GET  /admin/sales/secondary" "$(code GET /admin/sales/secondary)" 200
report "GET  /admin/sales/secondary/summary" "$(code GET /admin/sales/secondary/summary)" 200

echo "== 2. Validation"
report "GET  /admin/sales/orders?page=0 -> 400" "$(code GET '/admin/sales/orders?page=0')" 400
report "GET  /admin/sales/orders?sort=x -> 400" "$(code GET '/admin/sales/orders?sort=x')" 400
report "GET  /admin/sales/orders/999999999 -> 404" "$(code GET /admin/sales/orders/999999999)" 404
report "POST /admin/sales/orders/999999999/confirm -> 404" "$(code POST /admin/sales/orders/999999999/confirm)" 404
report "POST /admin/sales/orders (empty body) -> 400" "$(curl -s -o /dev/null -w '%{http_code}' -b "$ADMIN_JAR" -c "$ADMIN_JAR" -X POST -H 'Content-Type: application/json' -d '{}' "$BASE_URL/admin/sales/orders")" 400

echo "== 3. Security"
DIST_JAR="$(mktemp)"; trap 'rm -f "$DIST_JAR"' EXIT
if [ -n "${DIST_EMAIL:-}" ] && [ -n "${DIST_PASSWORD:-}" ]; then
  DJSON="$(python3 -c 'import json,sys; print(json.dumps({"email":sys.argv[1],"password":sys.argv[2]}))' "$DIST_EMAIL" "$DIST_PASSWORD")"
  curl -s -o /dev/null -b "$DIST_JAR" -c "$DIST_JAR" -X POST -H 'Content-Type: application/json' -d "$DJSON" "$BASE_URL/login"
  report "Distributor session cannot read /admin/sales/orders" "$(curl -s -o /dev/null -w '%{http_code}' -b "$DIST_JAR" "$BASE_URL/admin/sales/orders")" 401
else
  echo "== 3. Distributor cross-check: SKIPPED (set DIST_EMAIL and DIST_PASSWORD to enable)"
fi
report "No cookie -> 401" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/admin/sales/orders")" 401

if [ "${CREATE:-0}" = "1" ]; then
  : "${DISTRIBUTOR_ID:?Set DISTRIBUTOR_ID}"; : "${RETAILER_ID:?Set RETAILER_ID}"; : "${PRODUCT_ID:?Set PRODUCT_ID}"
  echo "== 4. Write path (creates a throwaway DRAFT order only)"
  BODY="$(python3 -c 'import json,sys; print(json.dumps({"distributorId":int(sys.argv[1]),"customerId":int(sys.argv[2]),"paymentTerms":"Net 30","lines":[{"productId":int(sys.argv[3]),"quantity":1}]}))' "$DISTRIBUTOR_ID" "$RETAILER_ID" "$PRODUCT_ID")"
  PREVIEW="$(post_json /admin/sales/orders/preview "$BODY")"
  echo "$PREVIEW" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("preview valid:", d.get("valid"))'
  RESP="$(post_json /admin/sales/orders "$BODY")"
  ORDER_ID="$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null)"
  if [ -n "$ORDER_ID" ]; then
    report "created order is fetchable" "$(code GET "/admin/sales/orders/$ORDER_ID")" 200
    echo "NOTE: order id $ORDER_ID was created as DRAFT and left as-is (not confirmed). Cancel or delete it manually if not wanted."
  else
    echo "Order not created: $RESP"
  fi
fi

echo; echo "Summary: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
