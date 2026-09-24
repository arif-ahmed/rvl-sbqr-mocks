# sbqr-api-mock

Spec-conformant stand-in for **sbqr.api**, the upstream SBQR platform. Unlike
the older `rvl-sbqr-fi-gateway/tmp/fakes/fake-sbqr-api.js` (which returns
fixed placeholder strings that fail the on-device checks), this service
builds real BanglaQR P2P payloads — TLV with CRC-16/CCITT-FALSE, Ed25519
signature over Tag 59 ‖ Tag 26.03 split into Tags 80/81 — and verifies
them on `/v1/qr/validate` using the same verdict vocabulary as the real
platform.

> Dev / integration testing only. **Never** treat this as a real sbqr.api
> or as production signing material. It exists to make the FI BFF +
> emulator runnable end-to-end without a platform dependency.

## Endpoints

| Verb | Route | Status | Purpose |
|---|---|---|---|
| POST | `/v1/oauth/token` | 200 | Stub OAuth2 client-credentials grant → `TokenResponse` (camelCase) |
| POST | `/v1/qr/generate/static` | 201 | Static QR (no amount) → `GenerateQrResponse` |
| POST | `/v1/qr/generate/dynamic` | 201 | Dynamic QR (amount + 15-min expiry hook at platform level) → `GenerateQrResponse` |
| POST | `/v1/qr/validate` | 200 | Verdict vocabulary: `VALID` / `INVALID_SIGNATURE` / `STRUCTURAL_INVALID` / `NON_P2P` / `KEY_NOT_FOUND` … |

There is **no** `/health` endpoint. Use `POST /v1/qr/validate` with an
empty body as the container healthcheck — it returns 400 (`TLV_MALFORMED`),
which is the canonical "process is up and answering" signal.

## Configuration

| Env | Default | Notes |
|---|---|---|
| `PORT` | `5201` | Listen port (all interfaces) |
| `INSTITUTION` | `000085` | 6-digit type+id baked into Tag 26 (`00` GUID + `01` type + `02` id) at boot. Affects every payload this instance signs and every verdict it issues. |

No other env vars are read. No persistent state. No `node_modules`.

## ⚠️ Signing key is regenerated at startup

The Ed25519 key pair is generated at process boot (the file calls
`crypto.generateKeyPairSync('ed25519')` on the first line of execution).
This has three practical consequences:

1. **Container restart invalidates outstanding QRs.** Anything signed by
   the previous container instance validates as `INVALID_SIGNATURE`
   (`SIGNATURE_MISMATCH`) on the new one. If a demo is mid-flow, restart
   the *whole* stack together, not just this service.
2. **Cross-process signature verification fails by design.** If you bring
   up two `sbqr-api-mock` instances, QRs signed by one will fail
   validation against the other.
3. **The trust directory has exactly one entry** — the `INSTITUTION`
   baked into the running process. Any payload with a different Tag 26
   institution code returns `KEY_NOT_FOUND` (`TRUST_DIRECTORY_MISS`).

This is intentional: it lets negative tests exercise the `INVALID_SIGNATURE`
and `KEY_NOT_FOUND` paths without extra code paths.

## Run locally without Docker

```bash
# From this directory:
PORT=5201 INSTITUTION=000085 node src/mock-sbqr-api.cjs
# → "mock sbqr.api (BanglaQR P2P, Ed25519, institution 000085) on http://localhost:5201"
```

Node 18+ is sufficient — only `crypto` and `http` built-ins are used.

## Run in Docker

```bash
# From the mocks repo root:
docker compose up --build sbqr-api-mock
# or with the explicit path:
docker compose -f rvl-sbqr-mocks/docker-compose.yml up --build sbqr-api-mock
```

Container name: `sbqr-mocks-sbqr-api`. Healthcheck fires every 10s; the
container is `healthy` within ~5s of start.

## Wiring (for `rvl-sbqr-fi-gateway`)

The BFF talks to this mock via `Platform__BaseUrl`:

```bash
# Host-run BFF (this mock on the host):
Platform__BaseUrl=http://localhost:5201

# Containerised BFF (this mock in compose, same network):
Platform__BaseUrl=http://sbqr-api-mock:5201
```

Other BFF env stays as before:

```bash
Auth__Authority=http://localhost:5105     # fi-idp-mock
Auth__Issuer=http://localhost:5105
Auth__Audience=sbqr-fi-gateway
Platform__TokenEndpoint=/v1/oauth/token
Platform__ClientId=dev-fi-client
Platform__ClientSecret=dev-fi-secret
Platform__Scope=sbqr.api
```

## Smoke test (curl)

Token → generate → validate round-trip:

```bash
# 1. Token (form-encoded, like a real OAuth client):
curl -s -X POST http://localhost:5201/v1/oauth/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data 'grant_type=client_credentials&client_id=test&client_secret=test&scope=sbqr.api'

# 2. Generate a static QR:
gen=$(curl -s -X POST http://localhost:5201/v1/qr/generate/static \
  -H 'content-type: application/json' \
  -d '{"recipientName":"Alice Smith","recipientCity":"Dhaka","recipientPan":"1234567890123456"}')
qr=$(echo "$gen" | jq -r .qrPayload)

# 3. Validate the same QR (should be VALID):
curl -s -X POST http://localhost:5201/v1/qr/validate \
  -H 'content-type: application/json' \
  -d "{\"qrPayload\":\"$qr\"}"
# → {"verdict":"VALID","trustSource":"TRUST_DIRECTORY", …}
```

Tampered payload (CRC breaks):

```bash
bad=$(echo "$qr" | sed 's/....$/ZZZZ/')
curl -s -X POST http://localhost:5201/v1/qr/validate \
  -H 'content-type: application/json' \
  -d "{\"qrPayload\":\"$bad\"}"
# → {"verdict":"STRUCTURAL_INVALID","reasonCode":"CRC_MISMATCH", …}
```

Restart invalidates the key (save `$qr` first, restart, re-validate):

```bash
docker compose restart sbqr-api-mock
curl -s -X POST http://localhost:5201/v1/qr/validate \
  -H 'content-type: application/json' \
  -d "{\"qrPayload\":\"$qr\"}"
# → {"verdict":"INVALID_SIGNATURE","reasonCode":"SIGNATURE_MISMATCH", …}
```

## Companion repos

This service is one of several repos that make up the SBQR workflow:

- `rvl-sbqr-mocks` — this repo. Other services: `fi-idp-mock`,
  `bb-trust-store-mock`, `hsm-mock`.
- `rvl-sbqr-fi-gateway` — the FI Backend BFF that talks to this mock.
  `tmp/fakes/fake-sbqr-api.js` (and its `*-401.js` / `*-503.js` /
  `*-contract.js` / `*-mtls.js` siblings) remain in that repo as
  smoke-test fixtures; **this** service is the canonical spec-conformant
  upstream stand-in.
- `rvl-sbqr-app-emulator` — the React + Vite SPA that emulates the FI
  mobile app. It previously hosted `mock/mock-sbqr-api.cjs`; the file
  was promoted into this repo as `services/sbqr-api-mock/src/`.
- `rvl-sbqr-workspace` (planned) — a thin umbrella repo that orchestrates
  bringing these repos up side-by-side and links their READMEs.

## Layout

```text
sbqr-api-mock/
├── src/
│   └── mock-sbqr-api.cjs   ← the mock (zero deps; uses crypto + http built-ins)
├── Dockerfile              ← node:22-alpine, non-root, healthcheck to /v1/qr/validate
├── .dockerignore           ← defensive: node_modules/, npm-debug.log*
└── README.md               ← you are here
```

## Not real

- **No real signing material.** The Ed25519 key pair is process-ephemeral
  and self-signed. Treat it as throwaway test material.
- **No persistence.** Tokens are minted from `Date.now()`. QRs are
  rebuilt per request. There is no trust-store file on disk.
- **Single-tenant trust directory.** Exactly one `INSTITUTION` is
  trusted per running process; anything else returns `KEY_NOT_FOUND`.
- **No platform webhook side.** This service exposes only the BFF →
  sbqr.api surfaces (`/v1/oauth/token`, `/v1/qr/generate/*`,
  `/v1/qr/validate`). It does not implement settlement callbacks,
  idempotency storage, or audit logging.
