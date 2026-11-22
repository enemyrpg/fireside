# syntax=docker/dockerfile:1
#
# Fireside server + dashboard. Multi-platform: linux/amd64 and linux/arm64.
#
#   docker compose up -d --build     (see docker-compose.yml and README "Docker")
#
# Stages:
#   build   – compiles shared/, server/ and web/. Runs on the build machine's
#             own platform: the output is plain JavaScript, so an arm64 build
#             under QEMU does not have to emulate tsc and Vite.
#   deps    – production dependencies for the target platform (native modules
#             such as better-sqlite3 are fetched or built for that platform).
#   runtime – the final image, with the same layout as the repo, so the paths
#             in server/src/paths.ts and server/src/db/index.ts work unchanged.

# The Node image is written out in every FROM, pinned to a version and digest,
# because Dependabot (docker) only updates literal FROM lines, not ARGs. Its
# major version must match .node-version (scripts/docker/check-node-version.sh,
# run in CI). Dependabot opens one PR that updates all three.

# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS pnpm
WORKDIR /app
COPY package.json ./
# Node 26 ships without corepack: install the pnpm version from "packageManager".
RUN npm install --global --no-fund --no-audit \
      "$(node -p "require('./package.json').packageManager")"

# ---------------------------------------------------------------------------
FROM pnpm AS build
COPY LICENSE pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
COPY scripts/package.json scripts/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY shared/ shared/
COPY server/ server/
COPY web/ web/
RUN pnpm build

# ---------------------------------------------------------------------------
FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS deps
ARG TARGETPLATFORM
# better-sqlite3 ships N-API prebuilds for linux-x64 and linux-arm64 (glibc
# and musl) inside the package, so no compiler is needed. This stage still runs
# on the target platform, so a future native dependency gets the right binary.
WORKDIR /app
COPY package.json ./
RUN npm install --global --no-fund --no-audit \
      "$(node -p "require('./package.json').packageManager")"
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
COPY scripts/package.json scripts/
# The server and what it depends on (shared), production dependencies only.
RUN --mount=type=cache,id=pnpm-store-$TARGETPLATFORM,target=/root/.local/share/pnpm/store \
    pnpm install --prod --frozen-lockfile --filter '@fireside/server...'

# ---------------------------------------------------------------------------
FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS runtime

# Also set by the release workflow (.github/workflows/release-image.yml), which
# adds the version, revision and creation time.
LABEL org.opencontainers.image.title="fireside" \
      org.opencontainers.image.description="Self-hosted tracker for Old School RuneScape: server and dashboard" \
      org.opencontainers.image.source="https://github.com/enemyrpg/fireside" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.authors="EnemyRPG"

# The server needs no package manager at runtime.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && printf '#!/bin/sh\nexec node /app/server/bin/cli.js "$@"\n' > /usr/local/bin/fireside \
    && chmod 755 /usr/local/bin/fireside \
    && mkdir -p /data && chown node:node /data

WORKDIR /app
COPY LICENSE package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/shared/node_modules ./shared/node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY shared/package.json shared/
COPY --from=build /app/shared/dist ./shared/dist
COPY server/package.json server/
COPY server/bin ./server/bin
COPY server/drizzle ./server/drizzle
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist

# HOST stays 127.0.0.1: the container runs with host networking on Linux, so
# any other address would put the server on the LAN. Remote access goes through
# the tunnel, which connects to loopback (see docker-compose.yml and
# docs/decisions/0008-docker-host-networking.md).
ENV NODE_ENV=production \
    HOST=127.0.0.1 \
    PORT=3100 \
    DATA_DIR=/data

USER node
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD ["node", "/app/server/bin/healthcheck.js"]

CMD ["node", "/app/server/dist/index.js"]
