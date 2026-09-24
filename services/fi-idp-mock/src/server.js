// fi-idp-mock — mock Financial Institution Identity Provider.
//
// Simulates a real FI login: the mobile emulator POSTs username + password
// to /connect/token (OAuth2 Resource Owner Password Credentials grant) and
// gets back RS256 JWTs the BFF validates via OIDC discovery + JWKS — the
// same verification path a production FI IdP would go through.
//
// Endpoints:
//   GET  /.well-known/openid-configuration
//   GET  /.well-known/jwks.json
//   POST /connect/token          grant_type=password|refresh_token
//   POST /mint                   DEPRECATED dev backdoor (kept for the old emulator flow)
//   GET  /health
//
// Env:
//   PORT                 default 5105
//   FI_ID                default dhakabank (selects seed/<FI_ID>.users.json)
//   FI_NAME              default from seed file
//   ISSUER               default http://localhost:<PORT>; on Fly.io defaults to
//                        https://<FLY_APP_NAME>.fly.dev when FLY_APP_NAME is set
//   AUDIENCE             default sbqr-fi-gateway (must match BFF Auth__Audience)
//   USERS_FILE           default <this-dir>/seed/<FI_ID>.users.json
//   TOKEN_TTL_SECONDS    default 300
//   REFRESH_TTL_SECONDS  default 86400
//   KEY_ID               default dev-key-1
//   SIGNING_KEY_PEM      optional stable RSA PKCS8 PEM (else boot-generated ephemeral key)
//
// DEV/TEST ONLY. Seed credentials are published fakes — never real PII.

import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  exportJWK,
  generateKeyPair,
  importPKCS8,
  SignJWT,
} from 'jose';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5105);
const FI_ID = process.env.FI_ID || 'dhakabank';
const AUDIENCE = process.env.AUDIENCE || 'sbqr-fi-gateway';
const USERS_FILE =
  process.env.USERS_FILE || path.join(HERE, 'seed', `${FI_ID}.users.json`);
const TOKEN_TTL = Number(process.env.TOKEN_TTL_SECONDS || 300);
const REFRESH_TTL = Number(process.env.REFRESH_TTL_SECONDS || 86400);
const KID = process.env.KEY_ID || 'dev-key-1';

const ISSUER =
  process.env.ISSUER ||
  (process.env.FLY_APP_NAME
    ? `https://${process.env.FLY_APP_NAME}.fly.dev`
    : `http://localhost:${PORT}`);

// ── Signing key (RS256) ────────────────────────────────────────────────
let privateKey;
let publicKey;
if (process.env.SIGNING_KEY_PEM) {
  privateKey = await importPKCS8(process.env.SIGNING_KEY_PEM, 'RS256');
  publicKey = createPublicKey(privateKey);
  console.log('using stable SIGNING_KEY_PEM');
} else {
  ({ publicKey, privateKey } = await generateKeyPair('RS256'));
  console.log('using ephemeral boot-generated RS256 key (tokens die on restart)');
}
const publicJwk = {
  ...(await exportJWK(publicKey)),
  kid: KID,
  use: 'sig',
  alg: 'RS256',
};

// ── User roster ────────────────────────────────────────────────────────
const seed = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
const FI_NAME = process.env.FI_NAME || seed.fi?.name || FI_ID;
const users = new Map(
  (seed.users || []).map((u) => [String(u.username).toLowerCase(), u]),
);
console.log(`[${FI_ID}] loaded ${users.size} user(s) from ${USERS_FILE}`);

// refresh_token -> { sub, username, exp }
const refreshStore = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [tok, rec] of refreshStore) {
    if (rec.exp <= now) refreshStore.delete(tok);
  }
}, 60_000).unref();

// ── Helpers ────────────────────────────────────────────────────────────
function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req, contentType) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        if (contentType.includes('application/json')) {
          resolve(raw ? JSON.parse(raw) : {});
        } else {
          // application/x-www-form-urlencoded (the OAuth2 standard)
          resolve(Object.fromEntries(new URLSearchParams(raw)));
        }
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function mintAccessToken(user) {
  return await new SignJWT({
    name: user.displayName,
    preferred_username: user.username,
    customer_id: user.customerId,
    fi_id: FI_ID,
  })
    .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(`user-${user.username}`)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL}s`)
    .sign(privateKey);
}

async function mintIdToken(user, clientId) {
  return await new SignJWT({
    name: user.displayName,
    preferred_username: user.username,
    fi_id: FI_ID,
  })
    .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(clientId || AUDIENCE)
    .setSubject(`user-${user.username}`)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL}s`)
    .sign(privateKey);
}

function mintRefreshToken(user) {
  const token = randomBytes(32).toString('hex');
  refreshStore.set(token, {
    sub: `user-${user.username}`,
    username: user.username,
    exp: Date.now() + REFRESH_TTL * 1000,
  });
  return token;
}

async function tokenPair(user, clientId) {
  return {
    access_token: await mintAccessToken(user),
    token_type: 'Bearer',
    expires_in: TOKEN_TTL,
    scope: 'openid profile sbqr.api',
    id_token: await mintIdToken(user, clientId),
    refresh_token: mintRefreshToken(user),
    refresh_expires_in: REFRESH_TTL,
  };
}

// ── HTTP ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://local');
  const path_ = url.pathname;

  if (req.method === 'GET' && path_ === '/health') {
    return json(res, 200, {
      status: 'ok',
      fi_id: FI_ID,
      fi_name: FI_NAME,
      issuer: ISSUER,
      users: users.size,
    });
  }

  if (req.method === 'GET' && path_ === '/.well-known/openid-configuration') {
    return json(res, 200, {
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`,
      token_endpoint: `${ISSUER}/connect/token`,
      token_endpoint_auth_methods_supported: ['none'],
      grant_types_supported: ['password', 'refresh_token'],
      response_types_supported: ['token'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'profile', 'sbqr.api'],
      claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'name', 'preferred_username', 'customer_id', 'fi_id'],
    });
  }

  if (req.method === 'GET' && path_ === '/.well-known/jwks.json') {
    return json(res, 200, { keys: [publicJwk] });
  }

  if (req.method === 'POST' && path_ === '/connect/token') {
    let body;
    try {
      body = await readBody(req, req.headers['content-type'] || '');
    } catch {
      return json(res, 400, { error: 'invalid_request', error_description: 'Unparseable request body.' });
    }

    if (body.grant_type === 'password') {
      const username = String(body.username || '').toLowerCase();
      const user = users.get(username);
      // Deliberately no user enumeration: unknown user === wrong password.
      if (!user || user.password !== body.password) {
        return json(res, 400, {
          error: 'invalid_grant',
          error_description: 'Incorrect username or password.',
        });
      }
      if (user.status === 'locked') {
        return json(res, 400, {
          error: 'account_locked',
          error_description: 'This account is locked. Contact your branch.',
        });
      }
      if (user.status === 'password_expired') {
        return json(res, 400, {
          error: 'password_expired',
          error_description: 'Password expired. Reset it at your branch, then try again.',
        });
      }
      return json(res, 200, await tokenPair(user, body.client_id));
    }

    if (body.grant_type === 'refresh_token') {
      const rec = refreshStore.get(body.refresh_token);
      if (!rec || rec.exp <= Date.now()) {
        if (body.refresh_token) refreshStore.delete(body.refresh_token);
        return json(res, 400, {
          error: 'invalid_grant',
          error_description: 'Refresh token is invalid or expired. Log in again.',
        });
      }
      const user = users.get(rec.username);
      if (!user || user.status !== 'active') {
        refreshStore.delete(body.refresh_token);
        return json(res, 400, {
          error: 'invalid_grant',
          error_description: 'Account is no longer active. Log in again.',
        });
      }
      refreshStore.delete(body.refresh_token); // rotation
      return json(res, 200, await tokenPair(user, body.client_id));
    }

    return json(res, 400, {
      error: 'unsupported_grant_type',
      error_description: 'Supported grant types: password, refresh_token.',
    });
  }

  if (req.method === 'POST' && path_ === '/mint') {
    // DEPRECATED: pre-password-grant dev backdoor used by the old emulator
    // flow (client-supplied claims). Kept until the emulator moves to
    // /connect/token. Do not use in new code.
    console.warn('[/mint] deprecated — use POST /connect/token instead');
    let claims;
    try {
      claims = await readBody(req, req.headers['content-type'] || 'application/json');
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      name: claims.name,
      preferred_username: claims.preferred_username,
    })
      .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' })
      .setIssuer(claims.iss || ISSUER)
      .setAudience(claims.aud || AUDIENCE)
      .setSubject(claims.sub || 'dev-user-1')
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);
    return json(res, 200, { token, deprecated: 'use POST /connect/token' });
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"not found"}');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`fi-idp-mock [${FI_ID} / ${FI_NAME}] on :${PORT} (issuer=${ISSUER}, aud=${AUDIENCE})`);
});
