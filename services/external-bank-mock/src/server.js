// external-bank-mock — a bank that is NOT an SBQR platform tenant, but whose
// P2P QR codes still verify on the platform (Option A: zero migration —
// docs/external-bank-mock-option-a.md in the workspace root).
//
// The mock owns its Ed25519 keypair (private key lives only in its volume)
// and a QR generator UI for "its users". The platform stores only the public
// key — an admin seeds it via POST /v1/admin/institutions into
// institution_keys (Source=LOCAL) — and the unchanged verification read path
// (ValidateQr → GetInstitutionPublicKeyQuery → Ed25519 verify) accepts the
// QRs because key resolution is by institution code alone, with no tenant
// join.
//
// The EMVCo builder mirrors the platform codec (SBQR.SharedKernel.QrCodec:
// P2pQrBuilder + QrPayloadFinalizer) and the app emulator's reader
// (rvl-sbqr-app-emulator/src/lib/emv.ts): ascending tag order, char-count
// TLV lengths, NPSB GUID templates, 44/44 Base64 signature split into tags
// 80/81, CRC-16/CCITT-FALSE over everything up to and including "6304".
// Signing uses node:crypto's native Ed25519 — it emits exactly the SPKI
// "-----BEGIN PUBLIC KEY-----" PEM the platform's upsert validator and
// Ed25519SignatureVerifier expect, so no key-format translation is needed.
//
// Endpoints:
//   GET  /                    generator UI (src/ui/index.html)
//   GET  /healthz             liveness + key status
//   POST /api/keys/generate   generate (or rotate) the Ed25519 keypair
//   GET  /api/keys/public     public key + identity for platform onboarding
//   POST /api/qr/generate     build + sign a BanglaQR P2P payload → QR PNG
//
// Env:
//   PORT                 default 5205
//   BANK_ID              default shapla
//   BANK_NAME            default "Shapla Commercial Bank PLC" — FICTIONAL:
//                        invented for this mock, no affiliation with any
//                        real bank (see README "Branding & deploy safety").
//                        Override per instance via env.
//   BANK_TAGLINE         default "Banking for every rhythm of life"
//   BANK_PRODUCT         default "Shapla Pay" (the QR product name)
//   INSTITUTION_ID       default 039999 (type 03 + reserved 9999; 6 digits,
//                        prefix ≤ 05 per Tag 26 sub 01 rules)
//   CITY                 default DHAKA (Tag 60, ≤ 15 bytes)
//   PRIVATE_KEY_PEM_PATH default <this-dir>/keys/ed25519-private.pem
//                        (docker-compose mounts a volume at /keys)
//   CUSTOMERS_FILE       default <this-dir>/seed/customers.json — the
//                        account-holder roster the UI picker offers
//
// DEV/TEST ONLY. Demo keypairs are throwaway — never real bank key material,
// and the reserved 99xx institution range must never collide with a real BB
// REGISTRY code.

import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
} from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5205);
const BANK_ID = process.env.BANK_ID || 'shapla';
const BANK_NAME = process.env.BANK_NAME || 'Shapla Commercial Bank PLC';
const BANK_TAGLINE = process.env.BANK_TAGLINE || 'Banking for every rhythm of life';
const BANK_PRODUCT = process.env.BANK_PRODUCT || 'Shapla Pay';
const INSTITUTION_ID = process.env.INSTITUTION_ID || '039999';
const CITY = (process.env.CITY || 'DHAKA').slice(0, 15);
const PRIVATE_KEY_PEM_PATH =
  process.env.PRIVATE_KEY_PEM_PATH || path.join(HERE, 'keys', 'ed25519-private.pem');
const CUSTOMERS_FILE =
  process.env.CUSTOMERS_FILE || path.join(HERE, 'seed', 'customers.json');

// Reference prefix: first word of the product name, uppercased (PCB).
const REFERENCE_PREFIX = BANK_PRODUCT.split(/\s+/)[0].toUpperCase().replace(/[^A-Z0-9]/g, '');

// ── EMVCo constants (mirror BqrConstants / spec tables 3A/3B/5A/5B) ─────
const NPSB_GUID = 'bd.org.bb.npsb';
const PAYLOAD_FORMAT_INDICATOR = '01';
const STATIC_INITIATION = '11';
const DYNAMIC_INITIATION = '12';
const P2P_MCC = '4829';
const CURRENCY_BDT = '050';
const COUNTRY_BD = 'BD';
const MAX_NAME_BYTES = 25;   // Tag 59
const MAX_PAN_BYTES = 19;    // Tag 26 sub 03
const MAX_AMOUNT_BYTES = 13; // Tag 54
const MAX_TYPE = 5;          // Tag 26 sub 01 must be 00–05

// ── Identity ───────────────────────────────────────────────────────────
if (!/^\d{6}$/.test(INSTITUTION_ID)) {
  console.error(`INSTITUTION_ID must be exactly six digits, got "${INSTITUTION_ID}"`);
  process.exit(1);
}
const INSTITUTE_TYPE = INSTITUTION_ID.slice(0, 2);
const INSTITUTION_CODE_4 = INSTITUTION_ID.slice(2);
if (Number(INSTITUTE_TYPE) > MAX_TYPE) {
  console.error(`INSTITUTION_ID prefix (Tag 26 sub 01) must be 00–0${MAX_TYPE}, got "${INSTITUTE_TYPE}"`);
  process.exit(1);
}

// ── Customer roster (UI picker; published fakes, never real PII) ─────────
let customers = [];
try {
  customers = JSON.parse(fs.readFileSync(CUSTOMERS_FILE, 'utf8')).customers ?? [];
  console.log(`loaded ${customers.length} demo customer(s) from ${CUSTOMERS_FILE}`);
} catch {
  console.warn(`no customer roster at ${CUSTOMERS_FILE} — the UI falls back to manual entry`);
}

// ── Signing key (Ed25519, private never leaves this process/volume) ─────
let privateKey = null;
let publicKeyPem = null;

// Mirror InstitutionUpsertService: SHA-256 over the ASCII bytes of the
// trimmed PEM, lowercase hex — so the mock's logged fingerprint is directly
// comparable with institution_keys.public_key_sha256 on the platform.
function fingerprintOf(pem) {
  return createHash('sha256').update(Buffer.from(pem.trim(), 'ascii')).digest('hex');
}

function adoptKey(privatePem) {
  privateKey = privatePem;
  publicKeyPem = createPublicKey(privatePem)
    .export({ type: 'spki', format: 'pem' })
    .toString('ascii')
    .trim();
}

function loadKeyFromDisk() {
  try {
    const pem = fs.readFileSync(PRIVATE_KEY_PEM_PATH, 'ascii');
    adoptKey(pem);
    console.log(`loaded signing key from ${PRIVATE_KEY_PEM_PATH} (fingerprint ${fingerprintOf(publicKeyPem)})`);
  } catch {
    console.log(`no signing key at ${PRIVATE_KEY_PEM_PATH} — POST /api/keys/generate to create one`);
  }
}

function generateAndPersistKey() {
  const { privateKey: priv } = generateKeyPairSync('ed25519');
  const pem = priv.export({ type: 'pkcs8', format: 'pem' }).toString('ascii');
  fs.mkdirSync(path.dirname(PRIVATE_KEY_PEM_PATH), { recursive: true });
  fs.writeFileSync(PRIVATE_KEY_PEM_PATH, pem, { mode: 0o600 });
  const rotated = publicKeyPem !== null;
  adoptKey(pem);
  const fp = fingerprintOf(publicKeyPem);
  console.log(`${rotated ? 'ROTATED' : 'generated'} Ed25519 keypair — public PEM fingerprint sha256:${fp}`);
  console.log(publicKeyPem);
  return { rotated, fingerprint: fp };
}

loadKeyFromDisk();

// ── Codec helpers (mirror the platform's TLV + CRC rules) ──────────────
function tlv(id, value) {
  if (value.length > 99) throw new Error(`TLV value for tag ${id} exceeds 99 chars`);
  return `${id}${String(value.length).padStart(2, '0')}${value}`;
}

// CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) over UTF-8 bytes — the
// emulator's crc16() and Crc16CcittFalse.Compute() compute the same value.
function crc16(input) {
  const bytes = Buffer.from(input, 'utf8');
  let crc = 0xffff;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function byteCount(s) {
  return Buffer.byteLength(s, 'utf8');
}

// Build + sign one BanglaQR P2P payload per spec §2.5 / Annex B.
function buildSignedQr({ accountName, accountNumber, amount }) {
  // Spec §2.5: the signed payload is name ‖ pan "without any space or
  // symbol" — normalize whitespace out of the name BEFORE it goes into
  // Tag 59, so the displayed value and the signed bytes are the same string
  // the platform's SignaturePayload.Reconstruct will rebuild from the tags.
  const name = String(accountName).replace(/\s+/g, '');
  const pan = String(accountNumber).trim();

  if (!/^[A-Za-z0-9.'\-]+$/.test(name)) {
    throw new httpError(400, `Account Name must be letters/digits (spaces are stripped; got "${name}").`);
  }
  if (byteCount(name) > MAX_NAME_BYTES) {
    throw new httpError(400, `Account Name must be ≤ ${MAX_NAME_BYTES} bytes after whitespace stripping.`);
  }
  if (!/^[A-Za-z0-9]+$/.test(pan)) {
    throw new httpError(400, 'Account Number must be alphanumeric.');
  }
  if (byteCount(pan) > MAX_PAN_BYTES) {
    throw new httpError(400, `Account Number must be ≤ ${MAX_PAN_BYTES} bytes.`);
  }

  const hasAmount = amount !== undefined && amount !== null && String(amount) !== '';
  if (hasAmount && !/^\d+(\.\d{1,2})?$/.test(String(amount))) {
    throw new httpError(400, 'Amount must be digits with an optional two-decimal point (e.g. 1500 or 1500.50).');
  }
  if (hasAmount && String(amount).length > MAX_AMOUNT_BYTES) {
    throw new httpError(400, `Amount must be ≤ ${MAX_AMOUNT_BYTES} characters.`);
  }

  const tag26 = tlv('00', NPSB_GUID) + tlv('01', INSTITUTE_TYPE) + tlv('02', INSTITUTION_CODE_4) + tlv('03', pan);

  // Ascending tag order, exactly like P2pQrBuilder.Build.
  const fields = [
    ['00', PAYLOAD_FORMAT_INDICATOR],
    ['01', hasAmount ? DYNAMIC_INITIATION : STATIC_INITIATION],
    ['26', tag26],
    ['52', P2P_MCC],
    ['53', CURRENCY_BDT],
  ];
  if (hasAmount) fields.push(['54', String(amount)]);
  fields.push(['58', COUNTRY_BD], ['59', name], ['60', CITY]);

  const partial = fields.map(([id, v]) => tlv(id, v)).join('');

  // Signature: Ed25519 over UTF-8(name ‖ pan), standard Base64 (88 chars),
  // split 44/44 into the tag 80/81 templates (tables 5A/5B).
  const signatureBytes = cryptoSign(null, Buffer.from(name + pan, 'utf8'), privateKey);
  const signatureBase64 = signatureBytes.toString('base64');
  if (signatureBase64.length !== 88) {
    throw new Error(`expected 88-char Base64 signature, got ${signatureBase64.length}`);
  }
  const tag80 = tlv('80', tlv('00', NPSB_GUID) + tlv('01', signatureBase64.slice(0, 44)));
  const tag81 = tlv('81', tlv('00', NPSB_GUID) + tlv('01', signatureBase64.slice(44)));

  const withSignature = partial + tag80 + tag81;
  const emvcoString = withSignature + '6304' + crc16(withSignature + '6304');

  return {
    emvcoString,
    signatureBase64,
    signedPayload: name + pan,
    accountName: name,
    accountNumber: pan,
    amount: hasAmount ? String(amount) : null,
  };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ── HTTP helpers (same shape as fi-idp-mock) ────────────────────────────
// Every response carries machine-visible demo markers so a public deploy
// can never be mistaken for (or indexed as) a real bank site.
const DEMO_HEADERS = {
  'x-demo-service': 'external-bank-mock',
  'x-robots-tag': 'noindex, nofollow',
};

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', ...DEMO_HEADERS });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function keyPublicView() {
  return {
    bankId: BANK_ID,
    institutionId: INSTITUTION_ID,
    institutionCode: INSTITUTION_ID,
    instituteType: INSTITUTE_TYPE,
    institutionName: BANK_NAME,
    publicKeyPem,
    publicKeySha256: fingerprintOf(publicKeyPem),
  };
}

let indexHtml = null;

// ── HTTP ────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://local');
  const path_ = url.pathname;

  if (req.method === 'GET' && (path_ === '/' || path_ === '/index.html')) {
    indexHtml ??= fs.readFileSync(path.join(HERE, 'ui', 'index.html'));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...DEMO_HEADERS });
    return res.end(indexHtml);
  }

  if (req.method === 'GET' && path_ === '/healthz') {
    return json(res, 200, {
      status: 'ok',
      bankId: BANK_ID,
      bankName: BANK_NAME,
      bankTagline: BANK_TAGLINE,
      product: BANK_PRODUCT,
      institutionId: INSTITUTION_ID,
      customers: customers.length,
      keyLoaded: publicKeyPem !== null,
      publicKeySha256: publicKeyPem !== null ? fingerprintOf(publicKeyPem) : null,
    });
  }

  if (req.method === 'GET' && path_ === '/api/customers') {
    return json(res, 200, { bankId: BANK_ID, product: BANK_PRODUCT, customers });
  }

  if (req.method === 'POST' && path_ === '/api/keys/generate') {
    const { rotated, fingerprint } = generateAndPersistKey();
    return json(res, rotated ? 200 : 201, { ...keyPublicView(), rotated });
  }

  if (req.method === 'GET' && path_ === '/api/keys/public') {
    if (publicKeyPem === null) {
      return json(res, 404, {
        error: 'NO_SIGNING_KEY',
        hint: 'POST /api/keys/generate first, then seed this public key on the platform.',
      });
    }
    return json(res, 200, keyPublicView());
  }

  if (req.method === 'POST' && path_ === '/api/qr/generate') {
    if (publicKeyPem === null) {
      return json(res, 409, {
        error: 'NO_SIGNING_KEY',
        hint: 'POST /api/keys/generate first.',
      });
    }

    let body;
    try {
      body = await readBody(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }

    let qr;
    try {
      qr = buildSignedQr(body);
    } catch (err) {
      return json(res, err.status || 400, { error: err.message });
    }

    const qrPngDataUrl = await QRCode.toDataURL(qr.emvcoString, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 480,
    });

    const now = new Date();
    return json(res, 200, {
      institutionId: INSTITUTION_ID,
      bankName: BANK_NAME,
      product: BANK_PRODUCT,
      reference: `${REFERENCE_PREFIX}-${now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      emvcoString: qr.emvcoString,
      qrPngDataUrl,
      signatureBase64: qr.signatureBase64,
      signedPayload: qr.signedPayload,
      accountName: qr.accountName,
      accountNumber: qr.accountNumber,
      amount: qr.amount,
      generatedAt: now.toISOString(),
    });
  }

  res.writeHead(404, { 'content-type': 'application/json', ...DEMO_HEADERS });
  res.end('{"error":"not found"}');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `external-bank-mock [${BANK_ID} / ${BANK_NAME} — ${BANK_PRODUCT}] on :${PORT} ` +
      `(institutionId=${INSTITUTION_ID}, type=${INSTITUTE_TYPE}, city=${CITY})`,
  );
});
