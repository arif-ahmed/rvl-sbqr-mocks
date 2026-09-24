# fi-idp-mock

Mock Financial Institution Identity Provider for SBQR development and
integration testing. Simulates a real FI login: the mobile emulator
POSTs username + password to an OAuth2 token endpoint and receives
RS256 JWTs that the `rvl-sbqr-fi-gateway` BFF validates via OIDC
discovery + JWKS — the same verification path a production FI IdP
would go through.

One image, N instances: each FI (Dhaka Bank, Eastern Bank, …) is a
separately deployed/configured instance with its own issuer, signing
key, and account-holder roster.

> Dev/test only. Seed credentials are published fakes — never real PII,
> and this service must never back production authentication.

## Endpoints

| Verb | Route | Purpose |
|---|---|---|
| POST | `/connect/token` | OAuth2 password + refresh-token grants (see below) |
| GET | `/.well-known/openid-configuration` | OIDC discovery (`issuer`, `jwks_uri`, `token_endpoint`, grants) |
| GET | `/.well-known/jwks.json` | RSA public key (`kid` = `KEY_ID`) |
| POST | `/mint` | **Deprecated** pre-grant dev backdoor (`{iss,aud,sub,…}` → `{token}`); kept until the emulator moves to `/connect/token` |
| GET | `/health` | Liveness probe → `{status, fi_id, fi_name, issuer, users}` |

### `POST /connect/token` — password grant

Accepts `application/x-www-form-urlencoded` (the OAuth2 standard) and
JSON. Returns `200`:

```json
{
  "access_token": "<RS256 JWT>",
  "token_type": "Bearer",
  "expires_in": 300,
  "scope": "openid profile sbqr.api",
  "id_token": "<RS256 JWT>",
  "refresh_token": "<opaque>",
  "refresh_expires_in": 86400
}
```

Access-token claims: `iss` (this instance), `aud` (`AUDIENCE`),
`sub` (`user-<username>` — what the BFF reads), `name`,
`preferred_username`, `customer_id`, `fi_id`.

Error shapes follow RFC 6749 plus two documented mock extensions:

| Case | Status | `error` |
|---|---|---|
| Wrong password / unknown user (no enumeration) | 400 | `invalid_grant` |
| Locked account (`nasrin`, `monira`) | 400 | `account_locked` |
| Expired password (`jalal`, `faruk`) | 400 | `password_expired` |
| Unknown/expired/reused refresh token | 400 | `invalid_grant` |
| Any other `grant_type` | 400 | `unsupported_grant_type` |

### Refresh flow

`grant_type=refresh_token` + `refresh_token` returns a fresh pair and
**rotates**: the old refresh token is invalidated (reuse →
`invalid_grant`). Refresh tokens are opaque, in-memory, and die on
restart — like access tokens, they are disposable by design.

## Configuration

| Env | Default | Notes |
|---|---|---|
| `PORT` | `5105` | Listen port (all interfaces) |
| `FI_ID` | `dhakabank` | Selects `seed/<FI_ID>.users.json`; stamped into `fi_id` claim + logs |
| `FI_NAME` | from seed | Display name |
| `ISSUER` | `http://localhost:<PORT>` | **Must equal the BFF's `Auth__Authority`/`Auth__Issuer` and the emulator's `VITE_IDP_ISSUER`.** On Fly.io, auto-derives `https://<FLY_APP_NAME>.fly.dev` when unset |
| `AUDIENCE` | `sbqr-fi-gateway` | Must equal BFF `Auth__Audience` / emulator `VITE_IDP_AUDIENCE` |
| `USERS_FILE` | `seed/<FI_ID>.users.json` (next to `server.js`) | Account-holder roster |
| `TOKEN_TTL_SECONDS` | `300` | Access/id-token lifetime |
| `REFRESH_TTL_SECONDS` | `86400` | Refresh-token lifetime |
| `KEY_ID` | `dev-key-1` | JWT `kid` + JWK id |
| `SIGNING_KEY_PEM` | _(ephemeral boot key)_ | Stable RSA PKCS8 PEM to survive restarts |

## Seed rosters (`src/seed/`)

```json
{
  "fi": { "id": "dhakabank", "name": "Dhaka Bank" },
  "users": [
    { "username": "fatema", "password": "fatema@1234",
      "displayName": "Fatema Akter", "customerId": "CIF-00458821",
      "status": "active" }
  ]
}
```

`status`: `active` | `locked` | `password_expired`. Passwords are
`<username>@1234` per user (documented fakes). To add an FI, copy a
seed file and add a compose service / Fly app (below).

## Run locally

```bash
# Both FIs (repo root):
docker compose up --build          # dhakabank :5105, ebl :5106

# One instance without Docker (from this directory):
FI_ID=dhakabank PORT=5105 node src/server.js
FI_ID=ebl PORT=5106 node src/server.js
```

Login smoke test (form-encoded, like a real OAuth client):

```bash
curl -X POST http://localhost:5105/connect/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode grant_type=password \
  --data-urlencode username=fatema \
  --data-urlencode password='fatema@1234'
```

## Wiring (per FI — the BFF validates a single issuer)

```bash
# BFF pointed at the Dhaka Bank mock:
Auth__Authority=http://localhost:5105
Auth__Issuer=http://localhost:5105
Auth__Audience=sbqr-fi-gateway

# Emulator pointed at the same instance:
IDP_URL=http://localhost:5105
VITE_IDP_ISSUER=http://localhost:5105
VITE_IDP_AUDIENCE=sbqr-fi-gateway
```

A second FI = a second BFF with `:5106` values. (Containerised BFFs
must use `http://fi-idp-<id>:<port>` as authority instead of
`localhost` — see root `docker-compose.yml`.)

## Deploy to Fly.io (free tier)

One app per FI, same image, different config:

```bash
# From this directory:
fly launch --no-deploy -c fly.dhakabank.toml   # first time only
fly deploy -c fly.dhakabank.toml
fly deploy -c fly.ebl.toml

# Issuer is automatic (FLY_APP_NAME fallback → https://<app>.fly.dev),
# or pin it explicitly:
fly secrets set -a fi-idp-dhakabank ISSUER=https://fi-idp-dhakabank.fly.dev
```

Machines auto-stop when idle (`min_machines_running = 0`) and cold-start
on the next login — acceptable for dev mocks. Signing keys are
ephemeral: a cold start invalidates outstanding tokens (clients just log
in again). Set `SIGNING_KEY_PEM` via `fly secrets` if stable keys are
ever needed. Region `sin` (Singapore) is closest to Bangladesh.

## Emulator migration note (companion change, other repo)

`rvl-sbqr-app-emulator/src/api/auth.ts` currently checks the password
in-browser and calls deprecated `/mint`. To use real-style login it
should POST credentials to `/connect/token` and store
`access_token` + `refresh_token`, refreshing on expiry — plus an FI
switcher mapping FI → `{IDP_URL, ISSUER, AUDIENCE, BFF_URL}`.

For the upstream side, the BFF now talks to
[`sbqr-api-mock`](../sbqr-api-mock/README.md) in this repo on
`:5201`. The deprecated `tmp/fakes/fake-sbqr-api.js` family in
`rvl-sbqr-fi-gateway` (placeholder strings, not BanglaQR) remains
only as a CI smoke-test fixture — `sbqr-api-mock` is the canonical
spec-conformant stand-in.

## Layout

```text
fi-idp-mock/
├── src/
│   ├── server.js          ← the mock (only dependency: jose)
│   ├── package.json / package-lock.json
│   └── seed/
│       ├── dhakabank.users.json
│       └── ebl.users.json
├── Dockerfile             ← node:22-alpine, non-root, healthcheck
├── .dockerignore
├── fly.dhakabank.toml     ← Fly.io app: fi-idp-dhakabank
├── fly.ebl.toml           ← Fly.io app: fi-idp-ebl
└── README.md              ← you are here
```
