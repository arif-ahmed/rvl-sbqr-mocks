# fi-idp-mock — mock FI Identity Provider (Node 22 + jose, no other deps).
FROM node:22-alpine
WORKDIR /app

COPY src/package.json src/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src/server.js ./server.js
COPY src/seed/ ./seed/

ENV NODE_ENV=production \
    PORT=5105 \
    FI_ID=dhakabank

EXPOSE 5105
USER node

HEALTHCHECK --interval=10s --timeout=2s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT:-5105}/health || exit 1

CMD ["node", "server.js"]
