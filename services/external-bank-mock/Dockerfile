# external-bank-mock — mock external (non-tenant) bank
# (Node 22 + qrcode; Ed25519 via node:crypto, no other deps).
FROM node:22-alpine
WORKDIR /app

COPY src/package.json src/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src/server.js ./server.js
COPY src/ui/ ./ui/
COPY src/seed/ ./seed/

# Named-volume mount point for the Ed25519 private key. Owned by `node` so
# the unprivileged runtime user can persist generated keypairs.
RUN mkdir -p /keys && chown node:node /keys

ENV NODE_ENV=production \
    PORT=5205 \
    BANK_ID=shapla \
    BANK_NAME="Shapla Commercial Bank PLC" \
    BANK_TAGLINE="Banking for every rhythm of life" \
    BANK_PRODUCT="Shapla Pay" \
    INSTITUTION_ID=039999 \
    PRIVATE_KEY_PEM_PATH=/keys/ed25519-private.pem

EXPOSE 5205
USER node

HEALTHCHECK --interval=10s --timeout=2s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-5205}/healthz || exit 1

CMD ["node", "server.js"]
