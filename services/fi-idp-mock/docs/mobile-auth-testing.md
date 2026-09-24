# fi-idp-mock — mobile app authentication testing guide

End-to-end login test flow for FI mobile apps (or the emulator) against the
deployed mock IdPs. Run the full sequence twice — once per FI.

| FI | Base URL | `fi_id` claim |
|---|---|---|
| Dhaka Bank | `https://fi-idp-dhakabank.fly.dev` | `dhakabank` |
| Eastern Bank (EBL) | `https://fi-idp-ebl.fly.dev` | `ebl` |

Substitute the base URL in every command below.

## Test credentials (published fakes — DEV ONLY, never real PII)

Password pattern: `<username>@1234`.

| FI | Active (must succeed) | Locked (must fail) | Password-expired (must fail) |
|---|---|---|---|
| Dhaka Bank | `fatema`, `rafiq`, `karim` | `nasrin` | `jalal` |
| EBL | `tanvir`, `shabnam` | `monira` | `faruk` |

Full roster with customer IDs lives in
`src/seed/dhakabank.users.json` and `src/seed/ebl.users.json`.

## Step 1 — Service reachable

```powershell
curl.exe -s https://fi-idp-dhakabank.fly.dev/health; echo ""
```

Expect `{"status":"ok","fi_id":"dhakabank",…,"users":5}`
(EBL: `"fi_id":"ebl"`, `"users":4`).
Note: machines auto-stop when idle (`min_machines_running = 0`), so the
first call can take a few extra seconds — retry once before calling it down.
There is no `/` route: the root path returns `{"error":"not found"}` by
design on both apps.

## Step 2 — OIDC discovery (what the app fetches at startup)

```powershell
curl.exe -s https://fi-idp-dhakabank.fly.dev/.well-known/openid-configuration; echo ""
```

Expect `issuer` equal to the base URL, `token_endpoint` ending in
`/connect/token`, `jwks_uri` ending in `/.well-known/jwks.json`.
The app must use the `token_endpoint` from this document, not a hard-coded path.

## Step 3 — Happy-path login (active user)

```powershell
curl.exe -s -X POST https://fi-idp-dhakabank.fly.dev/connect/token `
  -d "grant_type=password&username=fatema&password=fatema@1234"
```

Expect `token_type: "Bearer"`, `expires_in: 300`, non-empty `access_token`
and `refresh_token`. Save both for the later steps.

## Step 4 — Token contents (what the BFF enforces)

Decode the `access_token` at jwt.io (paste it only there — never into
chat, logs, or tickets) and check:

- `iss` = `https://fi-idp-dhakabank.fly.dev`
- `aud` = `sbqr-fi-gateway`
- `sub` = `user-fatema`
- `fi_id` = `dhakabank`
- `customer_id` = `CIF-00458821`

## Step 5 — Key verification (same path the BFF uses)

```powershell
curl.exe -s https://fi-idp-dhakabank.fly.dev/.well-known/jwks.json; echo ""
```

Expect a `keys` array whose `kid` matches the JWT header's `kid`.

## Step 6 — Refresh flow (no re-login)

```powershell
curl.exe -s -X POST https://fi-idp-dhakabank.fly.dev/connect/token `
  -d "grant_type=refresh_token&refresh_token=<REFRESH_FROM_STEP_3>"
```

Expect a new `access_token` plus a **rotated** `refresh_token`.
Re-using the old refresh token must fail (reuse is rejected).

## Step 7 — Negative cases (must all fail cleanly)

```powershell
# wrong password → invalid_grant
-d "grant_type=password&username=fatema&password=wrong"
# locked account → account_locked
-d "grant_type=password&username=nasrin&password=nasrin@1234"
# expired password → password_expired
-d "grant_type=password&username=jalal&password=jalal@1234"
# unknown user → invalid_grant
-d "grant_type=password&username=ghost&password=ghost@1234"
```

Each must return HTTP 400 with an `error` field — no stack trace, no token.
For EBL swap in `monira` (locked) / `faruk` (expired).

## Step 8 — Repeat Steps 1–7 against EBL

Same commands with `https://fi-idp-ebl.fly.dev`, using `tanvir` as the
active user. The `iss` / `fi_id` claims must say `ebl` — this catches
FI cross-wiring in the app.
