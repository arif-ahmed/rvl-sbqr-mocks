// mock/mock-sbqr-api.cjs — spec-conformant stand-in for sbqr.api, for
// offline end-to-end runs of the emulator through the real FI BFF.
//
// Unlike rvl-sbqr-fi-gateway/tmp/fakes/fake-sbqr-api.js (fixed placeholder
// strings), this one builds real BanglaQR P2P payloads (spec Tables 3A–5B):
// TLV + CRC-16/CCITT-FALSE + Ed25519 signature over Tag59‖Tag26.03 split
// into Tags 80/81, and verifies them on /v1/qr/validate with the same
// verdict vocabulary as the real platform (contracts/v1.public.json).
//
//   POST /v1/oauth/token          → TokenResponse (camelCase)
//   POST /v1/qr/generate/static   → 201 GenerateQrResponse
//   POST /v1/qr/generate/dynamic  → 201 GenerateQrResponse
//   POST /v1/qr/validate          → 200 ValidateQrResponse
//
// Env: PORT (default 5201), INSTITUTION (6 digits type+id, default 000085).
// The signing key is generated at start-up; QRs from a previous run
// therefore validate as INVALID_SIGNATURE — handy for negative tests.

'use strict';

const crypto = require('crypto');
const http = require('http');

const PORT = Number(process.env.PORT || 5201);
const INSTITUTION = process.env.INSTITUTION || '000085';
const GUID = 'bd.org.bb.npsb';
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const TRUST_STORE = new Map([[INSTITUTION, publicKey]]);

const tlv = (id, v) => `${id}${String(v.length).padStart(2, '0')}${v}`;

function crc16(s) {
  let crc = 0xffff;
  for (const b of Buffer.from(s, 'utf8')) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function parse(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const id = s.slice(i, i + 2);
    const len = Number(s.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(id) || Number.isNaN(len) || i + 4 + len > s.length) throw new Error('TLV_MALFORMED');
    out.push([id, s.slice(i + 4, i + 4 + len)]);
    i += 4 + len;
  }
  return Object.fromEntries(out.reverse()); // first occurrence wins
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function build(req, dynamic) {
  const errors = [];
  const need = (k, max) => {
    if (typeof req[k] !== 'string' || !req[k].trim()) errors.push(`${k} is required`);
    else if (Buffer.byteLength(req[k]) > max) errors.push(`${k} exceeds ${max} bytes`);
  };
  need('recipientName', 25);
  need('recipientCity', 15);
  need('recipientPan', 19);
  if (dynamic) {
    need('transactionAmount', 13);
    if (req.transactionAmount && !/^\d+(\.\d{1,2})?$/.test(req.transactionAmount)) errors.push('transactionAmount must be digits with an optional decimal point');
  } else if (req.transactionAmount != null) errors.push('transactionAmount is not allowed on a static QR');
  for (const k of ['postalCode', 'customerLabel', 'purposeOfTransaction'])
    if (req[k] != null && Buffer.byteLength(String(req[k])) > (k === 'postalCode' ? 10 : 25)) errors.push(`${k} too long`);
  if (errors.length) return { errors };

  const sig = crypto.sign(null, Buffer.from(req.recipientName + req.recipientPan, 'utf8'), privateKey).toString('base64');
  let add = '';
  if (req.customerLabel) add += tlv('06', req.customerLabel);
  if (req.purposeOfTransaction) add += tlv('08', req.purposeOfTransaction);

  let p =
    tlv('00', '01') +
    tlv('01', dynamic ? '12' : '11') +
    tlv('26', tlv('00', GUID) + tlv('01', INSTITUTION.slice(0, 2)) + tlv('02', INSTITUTION.slice(2)) + tlv('03', req.recipientPan)) +
    tlv('52', '4829') +
    tlv('53', '050') +
    (dynamic ? tlv('54', req.transactionAmount) : '') +
    tlv('58', 'BD') +
    tlv('59', req.recipientName) +
    tlv('60', req.recipientCity) +
    (req.postalCode ? tlv('61', req.postalCode) : '') +
    (add ? tlv('62', add) : '') +
    tlv('80', tlv('00', GUID) + tlv('01', sig.slice(0, 44))) +
    tlv('81', tlv('00', GUID) + tlv('01', sig.slice(44))) +
    '6304';
  p += crc16(p);
  return { payload: p };
}

function validate(payload) {
  const base = { trustSource: 'NONE', reasonCode: null, institutionCode: null, payloadHash: sha256(payload || ''), recipientName: null, recipientPan: null, qrClassification: 'P2P' };
  const reject = (verdict, reasonCode, extra = {}) => ({ ...base, verdict, reasonCode, ...extra });
  if (!payload || payload.length < 12) return reject('STRUCTURAL_INVALID', 'TLV_MALFORMED');
  const at = payload.lastIndexOf('6304');
  if (at < 0 || at + 8 !== payload.length || crc16(payload.slice(0, at + 4)) !== payload.slice(at + 4).toUpperCase())
    return reject('STRUCTURAL_INVALID', 'CRC_MISMATCH');
  let root, t26, t80, t81;
  try {
    root = parse(payload);
    t26 = parse(root['26'] || '');
    t80 = parse(root['80'] || '');
    t81 = parse(root['81'] || '');
  } catch (e) {
    return reject('STRUCTURAL_INVALID', e.message);
  }
  for (const k of ['00', '26', '52', '53', '58', '59', '60']) if (!root[k]) return reject('STRUCTURAL_INVALID', `MISSING_TAG_${k}`);
  if (root['52'] !== '4829') return reject('NON_P2P', null, { qrClassification: 'NON_P2P' });
  const institutionCode = (t26['01'] || '') + (t26['02'] || '');
  const who = { institutionCode, recipientName: root['59'], recipientPan: t26['03'] || null };
  if (institutionCode.length !== 6) return reject('STRUCTURAL_INVALID', 'INSTITUTION_ID_MISSING', who);
  if (!t80['01'] || !t81['01']) return reject('INVALID_SIGNATURE', 'SIGNATURE_TAGS_MISSING', who);
  const key = TRUST_STORE.get(institutionCode);
  if (!key) return reject('KEY_NOT_FOUND', 'TRUST_DIRECTORY_MISS', who);
  const sig = Buffer.from(t80['01'] + t81['01'], 'base64');
  if (sig.length !== 64) return reject('INVALID_SIGNATURE', 'SIGNATURE_MALFORMED', { ...who, trustSource: 'TRUST_DIRECTORY' });
  const ok = crypto.verify(null, Buffer.from(root['59'] + (t26['03'] || ''), 'utf8'), key, sig);
  return ok
    ? { ...base, ...who, verdict: 'VALID', trustSource: 'TRUST_DIRECTORY', reasonCode: null }
    : reject('INVALID_SIGNATURE', 'SIGNATURE_MISMATCH', { ...who, trustSource: 'TRUST_DIRECTORY' });
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' });
  res.end(JSON.stringify(body));
}

http
  .createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      // The token endpoint receives a form-encoded client_credentials grant; the QR endpoints JSON.
      let body = {};
      const isForm = (req.headers['content-type'] || '').includes('x-www-form-urlencoded');
      try {
        body = !raw ? {} : isForm ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw);
      } catch {
        return send(res, 400, { title: 'Invalid JSON', status: 400 });
      }
      console.log(`[mock-sbqr-api] ${req.method} ${req.url} sub=${req.headers['x-user-sub'] ?? '-'} corr=${req.headers['x-correlation-id'] ?? '-'}`);

      if (req.method === 'POST' && req.url === '/v1/oauth/token')
        return send(res, 200, { accessToken: 'mock-platform-token-' + Date.now(), tokenType: 'Bearer', expiresIn: 3600, scope: 'sbqr.api' });

      if (req.method === 'POST' && (req.url === '/v1/qr/generate/static' || req.url === '/v1/qr/generate/dynamic')) {
        const dynamic = req.url.endsWith('dynamic');
        const r = build(body, dynamic);
        if (r.errors) return send(res, 400, { title: 'One or more validation errors occurred.', status: 400, detail: r.errors.join('; ') });
        return send(res, 201, { qrPayload: r.payload, payloadHash: sha256(r.payload), qrType: dynamic ? 'DYNAMIC' : 'STATIC', signatureKeyVersion: 1 });
      }

      if (req.method === 'POST' && req.url === '/v1/qr/validate') {
        if (typeof body.qrPayload !== 'string') return send(res, 400, { title: 'qrPayload is required', status: 400 });
        return send(res, 200, validate(body.qrPayload));
      }

      send(res, 404, { title: 'Not found', status: 404 });
    });
  })
  .listen(PORT, () => console.log(`mock sbqr.api (BanglaQR P2P, Ed25519, institution ${INSTITUTION}) on http://localhost:${PORT}`));
