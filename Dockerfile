# ── Build stage: compile better-sqlite3's native addon ──────────────────────
FROM node:26-bookworm-slim AS build

# better-sqlite3 ships prebuilds, but they do not cover every platform; keep the
# toolchain here so the image builds on arm64 and musl hosts too. None of it
# reaches the runtime image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ── Runtime stage ───────────────────────────────────────────────────────────
FROM node:26-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Code and dependencies stay root-owned and read-only to the runtime user: the
# application never rewrites its own source, so nothing needs write access.
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# The database holds every message body in the mailbox plus the Google refresh
# token. It is the only path the runtime user may write.
RUN mkdir -p /app/data && chown node:node /app/data
USER node

ENV DATABASE_PATH=/app/data/labmail.db
ENV PORT=8000
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "src/web/server.ts"]
