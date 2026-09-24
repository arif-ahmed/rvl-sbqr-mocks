# sbqr-api-mock — mock sbqr.api (BanglaQR P2P, Ed25519).
#
# Zero npm dependencies: the source uses only Node built-ins
# (crypto, http). There is intentionally no COPY of package.json
# and no `npm install` step.
#
# The signing key is generated at container start-up; restarting
# the container invalidates QRs that were signed by a previous
# instance of this image (see README "Signing key" callout).
FROM node:22-alpine
LABEL org.opencontainers.image.title="sbqr-api-mock" \
      org.opencontainers.image.description="Mock sbqr.api for SBQR development and integration testing. Builds signed BanglaQR P2P payloads (TLV, Ed25519) and verifies them against the platform verdict vocabulary. Zero npm dependencies."

WORKDIR /app

# Single source file. No package.json / node_modules to COPY.
COPY src/mock-sbqr-api.cjs ./mock-sbqr-api.cjs

ENV NODE_ENV=production \
    PORT=5201 \
    INSTITUTION=000085

EXPOSE 5201
USER node

# The mock has no /health endpoint. POST /v1/qr/validate with an
# empty body returns 400 (TLV_MALFORMED), which is the canonical
# "process is up and answering" signal we want from a healthcheck.
HEALTHCHECK --interval=10s --timeout=2s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-5201}/v1/qr/validate || exit 1

CMD ["node", "mock-sbqr-api.cjs"]
