B=http://localhost:5055/api; J=/tmp/e2e.jar; rm -f $J; O=http://localhost:4173
pass=0; fail=0; chk(){ if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 (got $2 want $3)"; fail=$((fail+1)); fi; }
EMAIL="e2e$(date +%s)@example.com"
c=$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/signup -H 'content-type: application/json' -d "{\"name\":\"E2E Dist\",\"email\":\"$EMAIL\",\"password\":\"Passw0rd!x1\",\"city\":\"Pune\",\"country\":\"IN\",\"phone_number\":\"9999999999\",\"tax_no\":\"22AAAAA0000A1Z5\",\"pan\":\"AAAAA0000A\"}"); chk "signup" $c 201
c=$(curl -s -o /dev/null -w "%{http_code}" $B/stock); chk "protected without cookie -> 401" $c 401
c=$(curl -s -o /dev/null -w "%{http_code}" -c $J -X POST $B/login -H "origin: $O" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"wrong\"}"); chk "wrong password rejected (4xx)" $([ $c -ge 400 ] && [ $c -lt 500 ] && echo ok) ok
c=$(curl -s -o /dev/null -w "%{http_code}" -c $J -X POST $B/login -H "origin: $O" -H 'content-type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"Passw0rd!x1\"}"); chk "login" $c 200
grep -q access_token $J && chk "access cookie set" 1 1 || chk "access cookie set" 0 1
grep access_token $J | grep -q "#HttpOnly" && chk "cookie httpOnly" 1 1 || chk "cookie httpOnly" 0 1
c=$(curl -s -o /dev/null -w "%{http_code}" -b $J $B/stock); chk "protected with cookie -> 200" $c 200
h=$(curl -s -D - -o /dev/null -b $J -H "origin: $O" $B/stock | tr -d '\r'); echo "$h" | grep -qi "access-control-allow-origin: $O" && chk "CORS allowed origin echoed" 1 1 || chk "CORS allowed origin echoed" 0 1
echo "$h" | grep -qi "access-control-allow-credentials: true" && chk "CORS credentials" 1 1 || chk "CORS credentials" 0 1
echo "$h" | grep -qi "cache-control: no-store" && chk "no-store on authenticated JSON" 1 1 || chk "no-store" 0 1
h2=$(curl -s -D - -o /dev/null -H "origin: https://evil.example" $B/health/live | tr -d '\r'); echo "$h2" | grep -qi "access-control-allow-origin" && chk "foreign origin gets no CORS header" 0 1 || chk "foreign origin gets no CORS header" 1 1
p=$(curl -s -o /dev/null -w "%{http_code}" -X OPTIONS $B/stock -H "origin: $O" -H "access-control-request-method: POST" -H "access-control-request-headers: content-type"); chk "preflight 204" $p 204
c=$(curl -s -o /dev/null -w "%{http_code}" -b $J -c $J -X POST $B/refresh-token); chk "refresh-token with cookie" $c 200
c=$(curl -s -o /dev/null -w "%{http_code}" -b $J -X POST $B/logout); chk "logout" $c 200
c=$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/public/contact -H 'content-type: application/json' -d '{"name":"Asha Rao","email":"a@b.co","message":"We would like a demo for two sites."}'); chk "contact: valid but SMTP unset -> 503 (never fake success)" $c 503
echo "pass=$pass fail=$fail"
