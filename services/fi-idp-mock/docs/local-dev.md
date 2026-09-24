# fi-idp-mock — local dev runbook

Step-by-step: start both FI instances, test the full login flow, and tear
everything down. Commands are PowerShell (`curl.exe` = real curl, not the
`Invoke-WebRequest` alias). Each step shows the expected output so you can
tell at a glance whether it worked.

Time: ~5 minutes. Prerequisites: Node 20+ **or** Docker with Compose v2.

---

## 1. Startup

Pick **one** of A (Docker) or B (bare Node). Not both — they bind the
same ports.

### A. Docker Compose (from the repo root)

```powershell
docker compose up --build -d
docker compose ps
```

Expected: `fi-idp-dhakabank` (`:5105`) and `fi-idp-ebl` (`:5106`) both
`Up`. First build takes ~1 min (pulls `node:22-alpine`); rebuilds take
seconds.

### B. Bare Node (from `services/fi-idp-mock/`)

```powershell
npm --prefix src install --no-audit --no-fund
$dhaka = Start-Process -NoNewWindow -PassThru node `
  -ArgumentList 'src/server.js' `
  -Environment @{ FI_ID = 'dhakabank'; PORT = '5105' }
$ebl = Start-Process -NoNewWindow -PassThru node `
  -ArgumentList 'src/server.js' `
  -Environment @{ FI_ID = 'ebl'; PORT = '5106' }
```

> If `:5105` is already taken (e.g. the old `fake-idp.js` dev fake),
> stop that first or shift ports: `PORT='5191'` + `ISSUER` stays
> automatic (`http://localhost:<PORT>`).

---

## 2. Health check

```powershell
curl.exe -s http://localhost:5105/health; echo ""
curl.exe -s http://localhost:5106/health; echo ""
```

Expected (one line each):

```json
{"status":"ok","fi_id":"dhakabank","fi_name":"Dhaka Bank","issuer":"http://localhost:5105","users":5}
{"status":"ok","fi_id":"ebl","fi_name":"Eastern Bank","issuer":"http://localhost:5106","users":4}
```

If `curl` hangs or refuses: the instance isn't up — re-check step 1
(`docker compose logs fi-idp-dhakabank`, or the console of the
`Start-Process` window).

---

## 3. Login — happy path (Dhaka Bank, Fatema)

```powershell
curl.exe -s -X POST http://localhost:5105/connect/token `
  -H 'content-type: application/x-www-form-urlencoded' `
  --data-urlencode 'grant_type=password' `
  --data-urlencode 'username=fatema' `
  --data-urlencode 'password=fatema@1234'
echo ""
```

Expected: `200` with `access_token`, `id_token`, `refresh_token`,
`"token_type":"Bearer"`, `"expires_in":300`. Save the refresh token
for step 5:

```powershell
$tokens = curl.exe -s -X POST http://localhost:5105/connect/token `
  -H 'content-type: application/x-www-form-urlencoded' `
  --data-urlencode 'grant_type=password' `
  --data-urlencode 'username=fatema' `
  --data-urlencode 'password=fatema@1234' | ConvertFrom-Json
$tokens.access_token.Length -gt 100   # Expected: True
```

Second FI (Eastern Bank, Tanvir) — proves the instances are independent:

```powershell
curl.exe -s -X POST http://localhost:5106/connect/token `
  -H 'content-type: application/json' `
  -d '{"grant_type":"password","username":"tanvir","password":"tanvir@1234"}'
echo ""
```

Expected: `200` with a token triple. (This one also proves the JSON
body variant works.)

---

## 4. Login — negative cases

```powershell
# Wrong password (and unknown users — same response, no enumeration):
curl.exe -s -X POST http://localhost:5105/connect/token `
  -H 'content-type: application/x-www-form-urlencoded' `
  --data-urlencode 'grant_type=password' `
  --data-urlencode 'username=fatema' `
  --data-urlencode 'password=nope'; echo ""
# Expected: {"error":"invalid_grant","error_description":"Incorrect username or password."}

# Locked account (nasrin):
curl.exe -s -X POST http://localhost:5105/connect/token `
  -H 'content-type: application/x-www-form-urlencoded' `
  --data-urlencode 'grant_type=password' `
  --data-urlencode 'username=nasrin' `
  --data-urlencode 'password=nasrin@1234'; echo ""
# Expected: {"error":"account_locked","error_description":"This account is locked. Contact your branch."}

# Expired password (jalal):
curl.exe -s -X POST http://localhost:5105/connect/token `
  -H 'content-type: application/x-www-form-urlencoded' `
  --data-urlencode 'grant_type=password' `
  --data-urlencode 'username=jalal' `
  --data-urlencode 'password=jalal@1234'; echo ""
# Expected: {"error":"password_expired","error_description":"Password expired. Reset it at your branch, then try again."}
```

---

## 5. Refresh-token rotation

Uses `$tokens` from step 3:

```powershell
$new = curl.exe -s -X POST http://localhost:5105/connect/token `
  -H 'content-type: application/x-www-form-urlencoded' `
  --data-urlencode 'grant_type=refresh_token' `
  --data-urlencode "refresh_token=$($tokens.refresh_token)" | ConvertFrom-Json
$null -ne $new.access_token           # Expected: True (fresh pair issued)
$new.refresh_token -ne $tokens.refresh_token  # Expected: True (rotated)

# Reusing the old refresh token must now fail:
curl.exe -s -X POST http://localhost:5105/connect/token `
  -H 'content-type: application/x-www-form-urlencoded' `
  --data-urlencode 'grant_type=refresh_token' `
  --data-urlencode "refresh_token=$($tokens.refresh_token)"; echo ""
# Expected: {"error":"invalid_grant","error_description":"Refresh token is invalid or expired. Log in again."}
```

---

## 6. JWT verifies via JWKS (the BFF's exact path)

```powershell
node --input-type=module -e "
import { importJWK, jwtVerify } from 'jose';
const jwks = await (await fetch('http://localhost:5105/.well-known/jwks.json')).json();
const { payload } = await jwtVerify(process.argv[1], await importJWK(jwks.keys[0], 'RS256'), { issuer: 'http://localhost:5105', audience: 'sbqr-fi-gateway' });
console.log('VERIFIED sub=' + payload.sub, 'customer=' + payload.customer_id, 'fi=' + payload.fi_id);
" $($tokens.access_token)
```

Expected: `VERIFIED sub=user-fatema customer=CIF-00458821 fi=dhakabank`.
(Run from `services/fi-idp-mock/src/` so `jose` resolves, or from
anywhere with `NODE_PATH` pointed at it.)

---

## 7. Teardown

### A. Docker Compose (repo root)

```powershell
docker compose down
docker compose ps   # Expected: empty
```

### B. Bare Node

```powershell
Stop-Process -Id $dhaka.Id, $ebl.Id
curl.exe -s --max-time 3 http://localhost:5105/health
# Expected: curl exit code 7 (connection refused) — both instances gone
```

Confirm nothing lingers on the mock ports:

```powershell
netstat -ano | Select-String ':5105.*LISTENING|:5106.*LISTENING'
# Expected: no output
```

---

## 8. Port conflicts

If `:5105` is taken by the legacy `tmp/fakes/fake-idp.js` (same default
port), either stop it first or run this mock shifted:

```powershell
$dhaka = Start-Process -NoNewWindow -PassThru node `
  -ArgumentList 'src/server.js' `
  -Environment @{ FI_ID = 'dhakabank'; PORT = '5191' }
# …then use http://localhost:5191 everywhere above.
```

`ISSUER` follows `PORT` automatically, so shifted instances need no
other config. Remember: whichever port you use must match the BFF's
`Auth__Authority`/`Auth__Issuer` and the emulator's `VITE_IDP_ISSUER`.
