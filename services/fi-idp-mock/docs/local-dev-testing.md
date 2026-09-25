# fi-idp-mock — local dev testing (neutral, any FI)

Setup → API testing → teardown for **any** `fi-idp-mock` instance.
Parameterize with 3 values and every command below works unchanged:

| Var | Dhaka Bank | EBL |
|---|---|---|
| `FI_ID` | `dhakabank` | `ebl` |
| `PORT` | `5105` | `5106` |
| `BASE_URL` | `http://localhost:5105` | `http://localhost:5106` |

```powershell
# Set once per shell — swap to test the other FI:
$FI_ID = 'dhakabank'; $PORT = '5105'; $BASE_URL = "http://localhost:$PORT"
# $FI_ID = 'ebl'; $PORT = '5106'; $BASE_URL = "http://localhost:$PORT"
```

Rosters (`src/seed/<FI_ID>.users.json`, password = `<username>@1234`):

| FI | Active (→ 200) | Locked (→ `account_locked`) | Expired (→ `password_expired`) |
|---|---|---|---|
| dhakabank (5 users) | `fatema`, `rafiq`, `karim` | `nasrin` | `jalal` |
| ebl (4 users) | `tanvir`, `shabnam` | `monira` | `faruk` |

Time: ~5 min. Prerequisites: Node 20+ **or** Docker Compose v2.
Commands are PowerShell (`curl.exe` = real curl).

---

## 1. Setup (pick one — not both, same ports)

### A. Docker (repo root)

```powershell
# Both instances (default):
docker compose up --build -d
docker compose ps
# Expected: fi-idp-dhakabank :5105 + fi-idp-ebl :5106, both Up

# Or just the FI under test:
docker compose up --build -d fi-idp-dhakabank
# docker compose up --build -d fi-idp-ebl
docker compose logs fi-idp-dhakabank --tail 3
# Expected: [dhakabank] loaded 5 user(s) ... on :5105 (issuer=http://localhost:5105, aud=sbqr-fi-gateway)
# EBL: [ebl] loaded 4 user(s) ... on :5106
```

### B. Bare Node (from `services/fi-idp-mock/`)

```powershell
npm --prefix src install --no-audit --no-fund
$proc = Start-Process -NoNewWindow -PassThru node `
  -ArgumentList 'src/server.js' `
  -Environment @{ FI_ID = $FI_ID; PORT = $PORT }
```

> Port taken (e.g. legacy `tmp/fakes/fake-idp.js` on `:5105`)? Stop it
> or shift: `$PORT='5191'` — `ISSUER` follows automatically to
> `http://localhost:5191`. Keep `$BASE_URL` in sync.

---

## 2. API testing (same steps, either FI)

### 2.1 Health

```powershell
curl.exe -s "$BASE_URL/health"; echo ""
```

Expected (`dhakabank`):

```json
{"status":"ok","fi_id":"dhakabank","fi_name":"Dhaka Bank","issuer":"http://localhost:5105","users":5}
```

EBL: `"fi_id":"ebl"`, `"users":4`. Wrong `users` count = you hit the
other instance.

### 2.2 OIDC discovery (what BFF/emulator fetch at startup)

```powershell
curl.exe -s "$BASE_URL/.well-known/openid-configuration"; echo ""
```

Expected: `issuer` == `$BASE_URL`,
`token_endpoint` == `$BASE_URL/connect/token`,
`jwks_uri` == `$BASE_URL/.well-known/jwks.json`,
`grant_types_supported=["password","refresh_token"]`.

### 2.3 JWKS

```powershell
curl.exe -s "$BASE_URL/.well-known/jwks.json"; echo ""
```

Expected: `keys[0].kid=dev-key-1`, `alg=RS256`, `use=sig`.

### 2.4 Login happy path

Use the active user for the FI under test (`fatema` / `tanvir`):

```powershell
# Dhaka Bank:
curl.exe -s -X POST "$BASE_URL/connect/token" `
  -H 'content-type: application/x-www-form-urlencoded' `
  --data-urlencode 'grant_type=password' `
  --data-urlencode 'username=fatema' `
  --data-urlencode 'password=fatema@1234'; echo ""
# EBL: username=tanvir, password=tanvir@1234
# Expected 200: access_token + id_token + refresh_token, token_type Bearer, expires_in 300
```

Save tokens for steps 2.6–2.7:

```powershell
# Set $USER / $PASS to the FI's active user first:
$USER = 'fatema'; $PASS = 'fatema@1234'   # dhakabank
# $USER = 'tanvir'; $PASS = 'tanvir@1234' # ebl
$tokens = curl.exe -s -X POST "$BASE_URL/connect/token" `
  -H 'content-type: application/x-www-form-urlencoded' `
  --data-urlencode 'grant_type=password' `
  --data-urlencode "username=$USER" `
  --data-urlencode "password=$PASS" | ConvertFrom-Json
$tokens.access_token.Length -gt 100   # Expected: True
```

Username is case-insensitive (`FATEMA` works). Other active users in
the same roster (`rafiq`/`karim`, `shabnam`) must also return 200 with
their own `sub` (`user-<username>`).

### 2.5 Login negative cases

Set `$LOCKED` / `$EXPIRED` to the FI's users (`nasrin`/`jalal` for
dhakabank, `monira`/`faruk` for ebl):

```powershell
$LOCKED = 'nasrin'; $LOCKED_PASS = 'nasrin@1234'   # dhakabank
$EXPIRED = 'jalal'; $EXPIRED_PASS = 'jalal@1234'   # dhakabank
# $LOCKED = 'monira'; $LOCKED_PASS = 'monira@1234' # ebl
# $EXPIRED = 'faruk'; $EXPIRED_PASS = 'faruk@1234' # ebl

# Wrong password (unknown users give the SAME response — no enumeration):
curl.exe -s -X POST "$BASE_URL/connect/token" `
  -H 'content-type: application/x-www-form-urlencoded' `
  --data-urlencode 'grant_type=password' `
  --data-urlencode "username=$USER" `
  --data-urlencode 'password=nope'; echo ""
# Expected 400: {"error":"invalid_grant",...}

# Locked:
curl.exe -s -X POST "$BASE_URL/connect/token" `
  -H 'content-type: application/x-www-form-urlencoded' `
  --data-urlencode 'grant_type=password' `
  --data-urlencode "username=$LOCKED" `
  --data-urlencode "password=$LOCKED_PASS"; echo ""
# Expected 400: {"error":"account_locked","error_description":"This account is locked. Contact your branch."}

# Expired:
curl.exe -s -X POST "$BASE_URL/connect/token" `
  -H 'content-type: application/x-www-form-urlencoded' `
  --data-urlencode 'grant_type=password' `
  --data-urlencode "username=$EXPIRED" `
  --data-urlencode "password=$EXPIRED_PASS"; echo ""
# Expected 400: {"error":"password_expired","error_description":"Password expired. Reset it at your branch, then try again."}

# Unsupported grant:
curl.exe -s -X POST "$BASE_URL/connect/token" `
  -H 'content-type: application/x-www-form-urlencoded' `
  --data-urlencode 'grant_type=client_credentials'; echo ""
# Expected 400: {"error":"unsupported_grant_type",...}
```

### 2.6 Refresh-token rotation (uses `$tokens` from 2.4)

```powershell
$new = curl.exe -s -X POST "$BASE_URL/connect/token" `
  -H 'content-type: application/x-www-form-urlencoded' `
  --data-urlencode 'grant_type=refresh_token' `
  --data-urlencode "refresh_token=$($tokens.refresh_token)" | ConvertFrom-Json
$null -ne $new.access_token                  # Expected: True
$new.refresh_token -ne $tokens.refresh_token # Expected: True (rotated)

# Old token reuse must fail:
curl.exe -s -X POST "$BASE_URL/connect/token" `
  -H 'content-type: application/x-www-form-urlencoded' `
  --data-urlencode 'grant_type=refresh_token' `
  --data-urlencode "refresh_token=$($tokens.refresh_token)"; echo ""
# Expected 400: {"error":"invalid_grant","error_description":"Refresh token is invalid or expired. Log in again."}
```

Refresh tokens are opaque, in-memory, die on restart — disposable by design.

### 2.7 JWT verifies via JWKS (the BFF's exact path)

```powershell
# Run from services/fi-idp-mock/src/ so `jose` resolves:
node --input-type=module -e "
import { importJWK, jwtVerify } from 'jose';
const base = process.argv[2];
const jwks = await (await fetch(base + '/.well-known/jwks.json')).json();
const { payload } = await jwtVerify(process.argv[1], await importJWK(jwks.keys[0], 'RS256'), { issuer: base, audience: 'sbqr-fi-gateway' });
console.log('VERIFIED sub=' + payload.sub, 'customer=' + payload.customer_id, 'fi=' + payload.fi_id);
" $($tokens.access_token) $BASE_URL
```

Expected (dhakabank/fatema):
`VERIFIED sub=user-fatema customer=CIF-00458821 fi=dhakabank`.
EBL/tanvir: `sub=user-tanvir customer=CIF-00910011 fi=ebl`.

Manual check at jwt.io: `iss` == `$BASE_URL`, `aud=sbqr-fi-gateway`,
`sub=user-<username>`, `fi_id` == `$FI_ID`.

### Postman alternative

Import `docs/fi-idp-mock.postman_collection.json` and set collection
variable `baseUrl` = `$BASE_URL` (`eblBaseUrl` for the second FI).
Requests 01–09 encode this flow; 10 covers the other FI.

---

## 3. Teardown

### A. Docker (repo root)

```powershell
docker compose stop fi-idp-dhakabank fi-idp-ebl  # just the mocks
# or full:
docker compose down
docker compose ps   # Expected: empty (or only unrelated services)
```

### B. Bare Node

```powershell
Stop-Process -Id $proc.Id
curl.exe -s --max-time 3 "$BASE_URL/health"
# Expected: exit code 7 (connection refused) — instance gone
```

Confirm nothing lingers:

```powershell
netstat -ano | Select-String ':5105.*LISTENING|:5106.*LISTENING'
# Expected: no output
```

Restart is a clean slate: signing key regenerates (unless
`SIGNING_KEY_PEM` set) and all refresh tokens invalidate — clients
just log in again.
