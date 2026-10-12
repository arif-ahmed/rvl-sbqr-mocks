# external-bank-mock

Mock **external bank** for SBQR development and demos: a bank that is
**not** an SBQR platform tenant, has no tenant row and no KeyCustody
provisioning — yet whose BanglaQR P2P QR codes still verify on the
platform.

For the "real bank" feel it runs as the fictional **Shapla Commercial
Bank PLC** with its *Shapla Pay* QR product: branded app-style UI with
dark/light mode (system-aware, persisted toggle), seeded customer
roster, receipt-style signed-QR output. See
**Branding & deploy safety** below before pointing it at anything
public.

It owns its **Ed25519 keypair** (the private key lives only in its
volume) and a single-page **QR generator UI** for "its users". The
platform stores only the public key: an admin seeds it into
`institution_keys` via the existing `POST /v1/admin/institutions`
endpoint, and the unchanged verification read path
(`ValidateQr → GetInstitutionPublicKeyQuery → Ed25519SignatureVerifier`)
accepts the QRs because key resolution is by institution code alone —
no tenant join, no custody branch.

This is the **Option A (zero migration)** implementation of
`docs/external-bank-mock-option-a.md` (workspace root): no schema
change, no `EXTERNAL` source value, no verification code change. The
external bank's row is stored as `Source='LOCAL'`, same as a manual
tenant publish.

> Dev/test only. Demo keypairs are throwaway; the reserved `99xx`
> institution range must never collide with a real BB REGISTRY code,
> and this service must never back a production bank.

## Branding & deploy safety

The bank identity is **fictional by design** — "Shapla Commercial Bank
PLC" was invented for this mock and has no affiliation with any real
financial institution. This matters in both directions:

- **Never impersonate.** Every response carries
  `X-Demo-Service: external-bank-mock` and `X-Robots-Tag: noindex,
  nofollow`; the UI renders a persistent simulation banner, a DEMO badge,
  and per-receipt "simulated" notes; the HTML is `noindex`. A public
  deploy (Fly config included) must stay unmistakably a simulation so it
  can never be read as — or blocked as — bank impersonation/phishing.
- **Never pollute production.** Never seed this mock's public key into a
  production trust directory. The `03`/`99xx` institution code and the
  `Source='LOCAL'` row belong in dev/demo environments only.
- **Choosing another identity.** All branding is env-driven
  (`BANK_NAME`, `BANK_TAGLINE`, `BANK_PRODUCT`, `CUSTOMERS_FILE`). If
  you swap in a different name, verify it is not a real bank before
  exposing the instance anywhere.

## Endpoints

| Verb | Route | Purpose |
|---|---|---|
| GET | `/` | QR generator UI (`src/ui/index.html`) |
| GET | `/healthz` | Liveness + branding + key status → `{status, bankId, bankName, bankTagline, product, institutionId, customers, keyLoaded, publicKeySha256}` |
| GET | `/api/customers` | Seeded demo account-holder roster (UI picker; published fakes) |
| POST | `/api/keys/generate` | Generate (or rotate) the Ed25519 keypair; persists the private PKCS#8 PEM to `PRIVATE_KEY_PEM_PATH`; returns the public view (incl. `publicKeyPem`, `publicKeySha256`) |
| GET | `/api/keys/public` | Current public key + identity for copy-paste platform onboarding; `404 {error:"NO_SIGNING_KEY"}` before a key exists |
| POST | `/api/qr/generate` | `{accountName, accountNumber, amount?}` → `{reference, emvcoString, qrPngDataUrl, signatureBase64, signedPayload, institutionId, bankName, product, …}`; `409` if no key |

`publicKeySha256` is computed exactly like the platform's
`InstitutionUpsertService`: lowercase-hex SHA-256 over the ASCII bytes
of the **trimmed** SPKI PEM — so the mock's fingerprint is directly
comparable with `institution_keys.public_key_sha256`.

### QR construction (mirrors the platform codec)

Byte-for-byte the rules of `SBQR.SharedKernel.QrCodec`
(`P2pQrBuilder` + `QrPayloadFinalizer`) and the app emulator's reader
(`rvl-sbqr-app-emulator/src/lib/emv.ts`):

- Ascending tag order `00, 01, 26, 52, 53, [54], 58, 59, 60, 80, 81, 63`;
  TLV lengths are character counts (all values are ASCII).
- `00=01`; `01=11` static / `12` dynamic (dynamic when an amount is set);
  `26 = sub00 bd.org.bb.npsb + sub01 <type> + sub02 <code> + sub03 <pan>`;
  `52=4829`; `53=050`; `58=BD`; `60=CITY`.
- Signature: Ed25519 over UTF-8(`name ‖ pan`) — the same byte sequence
  `SignaturePayload.Reconstruct` rebuilds on the platform. The name is
  whitespace-stripped **before** it enters Tag 59, so the displayed value
  and the signed bytes agree. Standard Base64 (88 chars) split 44/44 into
  the Tag 80/81 templates (sub `00` = NPSB GUID).
- Tag 63: CRC-16/CCITT-FALSE over everything up to and including `6304`.

## Configuration

| Env | Default | Notes |
|---|---|---|
| `PORT` | `5205` | Listen port (all interfaces) |
| `BANK_ID` | `shapla` | Instance slug (multi-instance via env, like `fi-idp-mock`) |
| `BANK_NAME` | `Shapla Commercial Bank PLC` | Display name — fictional; verify any replacement isn't a real bank |
| `BANK_TAGLINE` | `Banking for every rhythm of life` | Header tagline |
| `BANK_PRODUCT` | `Shapla Pay` | QR product name; its first word prefixes transaction references |
| `INSTITUTION_ID` | `039999` | Six digits = Tag 26 sub 01 ‖ sub 02; prefix must be ≤ `05`. `03`+`9999` keeps the institution-code half in the reserved `99xx` range |
| `CITY` | `DHAKA` | Tag 60 value (≤ 15 bytes) |
| `CUSTOMERS_FILE` | `src/seed/customers.json` | Demo account-holder roster for the UI picker |
| `PRIVATE_KEY_PEM_PATH` | `<src>/keys/ed25519-private.pem` | Volume-backed path; `docker-compose.yml` mounts `ext-bank-keys` at `/keys` |

## Run

```bash
# from rvl-sbqr-mocks/
docker compose up --build ext-bank-mock   # UI on http://localhost:5205
```

or bare Node ≥ 20:

```bash
cd services/external-bank-mock/src
npm install
npm start
```

## Demo runbook (Option A — no platform code change)

1. **Generate the bank's keypair** — UI → *Generate new keypair*, or
   `curl -X POST http://localhost:5205/api/keys/generate`. Copy
   `publicKeyPem`.
2. **Seed it on the platform** (MasterAdmin auth; the endpoint is the
   permanent manual fallback alongside the BB trust-sync):

   ```bash
   curl -X POST "$MANAGER/v1/admin/institutions" \
     -H "Authorization: Bearer $MASTER_ADMIN_JWT" \
     -H "Content-Type: application/json" \
     -d '{
       "institutionCode": "039999",
       "instituteType":   "03",
       "institutionName": "External Demo Bank",
       "publicKeyPem":    "-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n"
     }'
   ```

   → creates an `ACTIVE v1, Source='LOCAL'` row. `GET /v1/admin/institutions`
   (`ListInstitutions`) now shows it.
3. **Generate a QR** in the UI (name / number / optional amount) and
   **scan or paste it into `ValidateQr` as any tenant payer** →
   `VALID, TrustSource=TRUST_DIRECTORY` — the read path never checks
   tenancy of the issuer.
4. **Rotation demo (optional)** — UI → *Generate new keypair (rotate)*,
   re-`POST /v1/admin/institutions` with the new PEM → the old version is
   auto-`RETIRED`. QRs signed with v1 still verify via the historical-key
   fallback (`VERIFIED_HISTORICAL_KEY` / latest `RETIRED`); new QRs verify
   on v2.

### Negative cases for the demo

The mock itself never verifies QRs — an external bank has no access to
the trust store's FI public keys, so there is nothing it could verify
against. Verification is platform-side only: paste the (possibly
tampered) EMVCo string into `ValidateQr` as a tenant payer.

- Untouched generated QR → `VALID, TrustSource=TRUST_DIRECTORY`.
- Tamper name/PAN in the EMVCo string (a CRC-consistent edit) →
  `INVALID_SIGNATURE`.
- An unknown institution code → `KEY_NOT_FOUND`.

## Safety notes

- **`Source='LOCAL'` ambiguity (accepted Option A trade-off):** demo
  external rows are indistinguishable from manual tenant publishes in the
  `source` column alone. Distinguish via `created_by` (`system` for the
  admin upsert path) and the `institution.trust.key.published` audit row.
- **Reserved range:** keep the Tag 26 sub 02 half in `99xx` so the demo
  code can never collide with a real tenant or BB `REGISTRY` code. The
  daily trust sync never deletes or overwrites institutions absent from
  the BB feed, so the `LOCAL` row is stable — but a code that *is* in the
  feed would be taken over by `REGISTRY` data.
- **Private key never leaves the volume.** Only the public PEM is pasted
  to the platform. Losing the volume = losing the bank's identity
  (re-generate + re-register; old QRs fail closed).
- Out of scope (Option B material): an `EXTERNAL` source value +
  migration, TrustStore sync awareness, mTLS for the mock, payer-side
  verify in the mock, billing/metering.

## Fly.io

`fly.extbank.toml` deploys the demo instance (`extbank-mock`, Singapore
region) with a mounted `extbank_keys` volume so the keypair survives
restarts:

```bash
fly volumes create extbank_keys --size 1 -a extbank-mock  # once
fly deploy -c fly.extbank.toml
```
