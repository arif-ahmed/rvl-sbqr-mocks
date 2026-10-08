# fi-idp-mock — Beginner's Guide (for .NET Developers)

> You don't need to know Node.js to understand this service.
> If you know `AddAuthentication().AddJwtBearer()` in ASP.NET Core, you already know 80% of what's going on here.

## 1. What is this thing, in one paragraph?

**fi-idp-mock is a fake bank login server.**

In production, each bank (Dhaka Bank, Eastern Bank, …) has its own real Identity Provider (IdP) — think **Duende IdentityServer / Azure AD / Keycloak** run by the bank. A customer types username + password into the banking app, the bank's IdP checks it, and hands back a signed **JWT access token**.

This mock does exactly that — but with **published fake users** (like `fatema / fatema@1234`), no real database, no real PII. It exists so you can develop and test the rest of the system without a real bank.

**Dev/test only. Never use for real authentication.**

## 2. Why does it exist? The big picture

There are 3 players. You are testing the middle link:

```text
┌──────────────┐      1. login          ┌──────────────┐
│ Banking app  │  ───────────────────▶  │  fi-idp-mock │
│ (or emulator)│  username + password   │  (this repo) │
└──────────────┘                        └──────────────┘
       │                                        │
       │  2. gets JWT (access_token)            │ signs JWT with RS256
       │◀───────────────────────────────────────┘  iss=http://localhost:5105
       │                                        │  aud=sbqr-fi-gateway
       ▼                                        ▼
┌──────────────┐      3. calls API      ┌───────────────────┐
│ Banking app  │  ───────────────────▶  │ rvl-sbqr-fi-gateway│
│              │  Authorization:        │ (BFF, .NET)        │
│              │  Bearer <JWT>          │ validates JWT via  │
└──────────────┘                        │ OIDC discovery     │
                                        │ + JWKS, then calls │
                                        │ sbqr.api upstream  │
                                        └───────────────────┘
```

Step by step:

1. **App → IdP:** `POST /connect/token` with `username` + `password`.
2. **IdP → App:** returns `access_token` (a RS256 JWT), `id_token`, and `refresh_token`.
3. **App → BFF:** calls the gateway with `Authorization: Bearer <access_token>`.
4. **BFF verifies the token** — it does NOT call the IdP per request. It:
   - fetches `http://localhost:5105/.well-known/openid-configuration` once at startup (OIDC discovery),
   - fetches `http://localhost:5105/.well-known/jwks.json` to get the public key,
   - checks signature + `iss` + `aud` + `exp` — exactly what `Microsoft.AspNetCore.Authentication.JwtBearer` does.
5. If valid → BFF lets the call through to `sbqr.api`. If invalid → `401`.

### .NET mental model

| IdP mock concept | .NET equivalent |
|---|---|
| `ISSUER` (`http://localhost:5105`) | `JwtBearerOptions.Authority` / `Auth__Authority` |
| `AUDIENCE` (`sbqr-fi-gateway`) | `JwtBearerOptions.Audience` / `Auth__Audience` |
| `/.well-known/openid-configuration` | What `AddJwtBearer` fetches automatically |
| `/.well-known/jwks.json` | The signing keys `Microsoft.IdentityModel` caches |
| `sub = user-fatema` | `User.FindFirst("sub")` — what the BFF reads as the user id |
| `fi_id`, `customer_id` claims | Extra claims like `User.FindFirst("fi_id")` |
| `expires_in = 300` | Token lifetime 5 min (`exp` claim) |

In C#, the BFF side looks conceptually like this:

```csharp
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        o.Authority = "http://localhost:5105"; // = ISSUER of this mock
        o.Audience = "sbqr-fi-gateway";        // = AUDIENCE of this mock
        // o handles discovery + JWKS + iss/aud/exp/signature for you
    });
```

**Golden rule:** `ISSUER` on the mock must exactly equal `Auth__Authority` + `Auth__Issuer` on the BFF, and `AUDIENCE` must equal `Auth__Audience`. 90% of "401" bugs are this mismatch (e.g. `localhost` vs `fi-idp-dhakabank` inside Docker).

## 3. One image, N banks

There is only **one codebase** (`src/server.js`, Node + `jose` library), but you run **one instance per bank** with different env vars:

| Instance | Port | `FI_ID` | `ISSUER` | Users |
|---|---|---|---|---|
| Dhaka Bank | `5105` | `dhakabank` | `http://localhost:5105` | 5 (`fatema`, `rafiq`, `karim` active) |
| Eastern Bank (EBL) | `5106` | `ebl` | `http://localhost:5106` | 4 (`tanvir`, `shabnam` active) |

Each instance has its **own signing key, own issuer, own user list**. A token from `:5105` will never validate against a BFF pointed at `:5106` — by design. That's why the BFF validates a single issuer, so each FI needs its own BFF instance pointed at that FI's IdP.

## 4. The 5 endpoints (you only need 3 to test)

| Verb | Route | What it is | Do you need it? |
|---|---|---|---|
| `GET` | `/health` | "Are you alive?" → `{status, fi_id, issuer, users}` | ✅ yes — always check first |
| `GET` | `/.well-known/openid-configuration` | OIDC discovery doc: tells the BFF where `token_endpoint` and `jwks_uri` are | ✅ yes — this is what `AddJwtBearer` reads |
| `GET` | `/.well-known/jwks.json` | The RSA **public** key (`kid=dev-key-1`) | ✅ yes — this is how signatures are verified |
| `POST` | `/connect/token` | Login + refresh. The real OAuth2 endpoint | ✅ yes — the main one |
| `POST` | `/mint` | Old dev backdoor, **deprecated**. Ignore it | ❌ no — don't use in new code |

### `POST /connect/token` in detail

Accepts **form-urlencoded** (OAuth2 standard) or JSON.

**Login (password grant):**

```http
POST /connect/token
Content-Type: application/x-www-form-urlencoded

grant_type=password&username=fatema&password=fatema@1234
```

Success `200`:

```json
{
  "access_token": "eyJhbGciOi...",
  "token_type": "Bearer",
  "expires_in": 300,
  "scope": "openid profile sbqr.api",
  "id_token": "eyJhbGciOi...",
  "refresh_token": "a3f9...",
  "refresh_expires_in": 86400
}
```

The `access_token` is a JWT with claims:

```json
{
  "iss": "http://localhost:5105",
  "aud": "sbqr-fi-gateway",
  "sub": "user-fatema",
  "name": "Fatema Akter",
  "preferred_username": "fatema",
  "customer_id": "CIF-00458821",
  "fi_id": "dhakabank",
  "exp": 1717...,
  "iat": 1717...
}
```

**Refresh (no re-login):**

```http
grant_type=refresh_token&refresh_token=<the-opaque-string>
```

Returns a fresh pair and **rotates** — the old refresh token is burned. Reusing it → `invalid_grant`. Refresh tokens live in memory only; a restart wipes them (clients just log in again).

**Errors (all HTTP 400, OAuth2 style):**

| You did | `error` | Meaning |
|---|---|---|
| Wrong password OR unknown user (same response on purpose — no user enumeration) | `invalid_grant` | "Incorrect username or password." |
| `nasrin` / `monira` (locked) | `account_locked` | "Contact your branch." |
| `jalal` / `faruk` (expired) | `password_expired` | "Reset it at your branch." |
| Bad/expired/reused refresh token | `invalid_grant` | "Log in again." |
| Anything else as `grant_type` | `unsupported_grant_type` | Only `password` + `refresh_token` supported |

## 5. Test users (fake — password = `<username>@1234`)

| FI | Active ✅ (login → 200) | Locked 🔒 (→ `account_locked`) | Expired ⏳ (→ `password_expired`) |
|---|---|---|---|
| **Dhaka Bank** (`dhakabank`) | `fatema`, `rafiq`, `karim` | `nasrin` | `jalal` |
| **EBL** (`ebl`) | `tanvir`, `shabnam` | `monira` | `faruk` |

Full details (display name, CIF) are in `src/seed/dhakabank.users.json` and `src/seed/ebl.users.json`. Usernames are case-insensitive (`FATEMA` works).

## 6. Hands-on: test it in 5 minutes

Prerequisites: **Docker Compose v2** OR **Node 20+**. All commands are PowerShell. `curl.exe` = real curl (not the `Invoke-WebRequest` alias).

### Step 0 — Start it (pick ONE option)

**Option A — Docker (from repo root, runs both banks):**

```powershell
docker compose up --build -d
docker compose ps
# Expected: fi-idp-dhakabank :5105 + fi-idp-ebl :5106, both Up
```

**Option B — Bare Node (from `services/fi-idp-mock/`):**

```powershell
npm --prefix src install --no-audit --no-fund
$env:FI_ID='dhakabank'; $env:PORT='5105'; node src/server.js
# New shell for the second FI:
$env:FI_ID='ebl'; $env:PORT='5106'; node src/server.js
```

> Port `5105` already taken? An old fake may be squatting there. Stop it, or shift: `$env:PORT='5191'` — `ISSUER` follows automatically to `http://localhost:5191`.

### Step 1 — Is it alive?

```powershell
curl.exe -s http://localhost:5105/health; echo ""
# {"status":"ok","fi_id":"dhakabank","fi_name":"Dhaka Bank","issuer":"http://localhost:5105","users":5}
curl.exe -s http://localhost:5106/health; echo ""
# {"status":"ok","fi_id":"ebl","fi_name":"Eastern Bank","issuer":"http://localhost:5106","users":4}
```

Wrong `users` count = you hit the other instance. Connection refused = go back to Step 0.

### Step 2 — What does the BFF see at startup?

```powershell
curl.exe -s http://localhost:5105/.well-known/openid-configuration; echo ""
curl.exe -s http://localhost:5105/.well-known/jwks.json; echo ""
```

Check: `issuer` == `http://localhost:5105`, `token_endpoint` ends in `/connect/token`, `jwks_uri` ends in `/jwks.json`, first key has `kid=dev-key-1`, `alg=RS256`.

### Step 3 — Log in (happy path)

```powershell
curl.exe -s -X POST http://localhost:5105/connect/token `
  -H 'content-type: application/x-www-form-urlencoded' `
  --data-urlencode 'grant_type=password' `
  --data-urlencode 'username=fatema' `
  --data-urlencode 'password=fatema@1234'; echo ""
# Expected 200: access_token + id_token + refresh_token
```

Save tokens for the next steps:

```powershell
$tokens = curl.exe -s -X POST http://localhost:5105/connect/token `
  -H 'content-type: application/x-www-form-urlencoded' `
  --data-urlencode 'grant_type=password' `
  --data-urlencode 'username=fatema' `
  --data-urlencode 'password=fatema@1234' | ConvertFrom-Json
$tokens.access_token.Length -gt 100   # Expected: True
```

### Step 4 — Look inside the JWT (no code needed)

1. Copy `$tokens.access_token`.
2. Paste it at **jwt.io** (header shows `alg=RS256`, `kid=dev-key-1`).
3. Verify payload: `iss=http://localhost:5105`, `aud=sbqr-fi-gateway`, `sub=user-fatema`, `fi_id=dhakabank`, `customer_id=CIF-00458821`.

> Never paste real tokens into chat, logs, or tickets. These are fakes, so it's fine here — build the habit anyway.

### Step 5 — Verify like the BFF does (signature check via JWKS)

Run from `services/fi-idp-mock/src/` so `jose` resolves:

```powershell
node --input-type=module -e "
import { importJWK, jwtVerify } from 'jose';
const base = 'http://localhost:5105';
const jwks = await (await fetch(base + '/.well-known/jwks.json')).json();
const { payload } = await jwtVerify(process.argv[1], await importJWK(jwks.keys[0], 'RS256'), { issuer: base, audience: 'sbqr-fi-gateway' });
console.log('VERIFIED sub=' + payload.sub, 'customer=' + payload.customer_id, 'fi=' + payload.fi_id);
" $($tokens.access_token)
# Expected: VERIFIED sub=user-fatema customer=CIF-00458821 fi=dhakabank
```

If this passes but the BFF returns 401, the BFF's `Authority`/`Audience` config doesn't match this instance — check Section 7.

C# equivalent of the same check (what the BFF does under the hood with `AddJwtBearer`):

```csharp
// Pseudo-code — the real BFF does this via JwtBearer middleware:
var handler = new JsonWebTokenHandler();
var result = await handler.ValidateTokenAsync(accessToken, new TokenValidationParameters
{
    ValidIssuer = "http://localhost:5105",
    ValidAudience = "sbqr-fi-gateway",
    IssuerSigningKey = jwksKey, // from /.well-known/jwks.json
});
Assert.True(result.IsValid);
```

### Step 6 — Call the BFF with the token (the whole point)

```powershell
# BFF pointed at Dhaka Bank mock:
curl.exe -s http://localhost:5000/api/whatever `
  -H "Authorization: Bearer $($tokens.access_token)"
# Expected: real response, not 401.
# 401 here = BFF config mismatch (see troubleshooting below).
```

### Step 7 — Negative cases (must all fail with 400, no token)

```powershell
# Wrong password:
curl.exe -s -X POST http://localhost:5105/connect/token `
  -H 'content-type: application/x-www-form-urlencoded' `
  --data-urlencode 'grant_type=password' `
  --data-urlencode 'username=fatema' `
  --data-urlencode 'password=nope'; echo ""
# → {"error":"invalid_grant",...}

# Locked (nasrin / monira for EBL):
curl.exe -s -X POST http://localhost:5105/connect/token `
  -H 'content-type: application/x-www-form-urlencoded' `
  --data-urlencode 'grant_type=password' `
  --data-urlencode 'username=nasrin' `
  --data-urlencode 'password=nasrin@1234'; echo ""
# → {"error":"account_locked",...}

# Expired (jalal / faruk for EBL):
curl.exe -s -X POST http://localhost:5105/connect/token `
  -H 'content-type: application/x-www-form-urlencoded' `
  --data-urlencode 'grant_type=password' `
  --data-urlencode 'username=jalal' `
  --data-urlencode 'password=jalal@1234'; echo ""
# → {"error":"password_expired",...}
```

### Step 8 — Refresh without re-login

```powershell
$new = curl.exe -s -X POST http://localhost:5105/connect/token `
  -H 'content-type: application/x-www-form-urlencoded' `
  --data-urlencode 'grant_type=refresh_token' `
  --data-urlencode "refresh_token=$($tokens.refresh_token)" | ConvertFrom-Json
$new.refresh_token -ne $tokens.refresh_token  # Expected: True (rotated)

# Old token reuse must fail:
curl.exe -s -X POST http://localhost:5105/connect/token `
  -H 'content-type: application/x-www-form-urlencoded' `
  --data-urlencode 'grant_type=refresh_token' `
  --data-urlencode "refresh_token=$($tokens.refresh_token)"; echo ""
# → {"error":"invalid_grant",...}
```

### Step 9 — Stop it

```powershell
# Docker (repo root):
docker compose down

# Bare Node:
# Ctrl+C in each window, then confirm:
netstat -ano | Select-String ':5105.*LISTENING|:5106.*LISTENING'
# Expected: no output
```

Restart = clean slate: signing key regenerates (unless `SIGNING_KEY_PEM` is set) and all refresh tokens die. Just log in again.

## 7. Wiring cheat-sheet (copy-paste)

The BFF and the emulator must point at the **same** IdP instance:

```bash
# BFF pointed at Dhaka Bank mock:
Auth__Authority=http://localhost:5105
Auth__Issuer=http://localhost:5105
Auth__Audience=sbqr-fi-gateway

# Emulator / app pointed at the same instance:
IDP_URL=http://localhost:5105
VITE_IDP_ISSUER=http://localhost:5105
VITE_IDP_AUDIENCE=sbqr-fi-gateway
```

Second FI = same values with `:5106`. Containerised BFFs must use `http://fi-idp-dhakabank:5105` (service name, not `localhost`) — see root `docker-compose.yml`.

Postman: import `docs/fi-idp-mock.postman_collection.json`, set `baseUrl` to the instance under test.

## 8. Troubleshooting (read this when stuck)

| Symptom | Almost always this | Fix |
|---|---|---|
| BFF returns `401` but login returned `200` | **Issuer/audience mismatch.** BFF points at `:5105`, token came from `:5106` (or `localhost` vs container hostname) | Decode JWT at jwt.io, compare `iss`/`aud` against BFF's `Auth__*`. They must be string-equal |
| `curl` hangs / connection refused | Instance not running or wrong port | `docker compose ps`, `docker compose logs fi-idp-dhakabank --tail 20` |
| Old tokens suddenly invalid | Restart regenerates the ephemeral signing key (by design) | Log in again. Set `SIGNING_KEY_PEM` env for a stable key if you need restarts to keep tokens |
| Refresh fails with `invalid_grant` | Token already rotated, expired, or server restarted | Log in again for a fresh refresh token |
| `users: 5` when you expected 4 (or vice versa) | You hit the other FI's port | `:5105` = Dhaka Bank (5 users), `:5106` = EBL (4 users) |
| First call to Fly.io mock is slow | Machines auto-stop when idle, cold-start on next login | Retry once; acceptable for dev mocks |

## 9. What this mock deliberately does NOT do

- **No password hashing, no database.** Users come from `src/seed/*.users.json`. Adding an FI = copy a seed file + add a compose service.
- **No browser redirect / authorization-code flow.** It uses OAuth2 `password` grant (app POSTs credentials directly) — simpler for emulators and tests.
- **No stable keys by default.** Boot generates a fresh RS256 keypair; set `SIGNING_KEY_PEM` for a stable one.
- **Not production.** Published passwords, in-memory refresh tokens, `min_machines_running = 0` on Fly.io. Never wire real auth to it.

## 10. Where to read next

- `README.md` (this service) — config table (`PORT`, `FI_ID`, `ISSUER`, `AUDIENCE`, `TOKEN_TTL_SECONDS`, …) + Fly.io deploy.
- `docs/local-dev.md` — the 5-minute runbook this guide is based on.
- `docs/local-dev-testing.md` — same flow parameterized for either FI (`$FI_ID` / `$PORT` / `$BASE_URL`).
- `docs/mobile-auth-testing.md` — the same 8 steps against the deployed Fly.io URLs.
- `src/server.js` (~300 lines, only dependency: `jose`) — the whole implementation; start at the `// ── HTTP ──` section.
