# syntax=docker/dockerfile:1.7
#
# RakeSetu API — production image.
#
# Multi-stage: deps+build run with the full toolchain (bcrypt compiles native
# code), the runtime stage ships only dist/ and production node_modules.
#
# Unlike college-level-backend there is no .npmrc BuildKit secret here: the
# Drizzle schema lives in src/schema/ rather than a private package, so there
# is nothing to authenticate against.
#
#   docker build -t rakesetu-api .

ARG NODE_VERSION=22

# ---------------------------------------------------------------- base -------
FROM node:${NODE_VERSION}-bookworm-slim AS base
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends dumb-init curl \
    && rm -rf /var/lib/apt/lists/*

# ------------------------------------------------------------- builder -------
# Full dependency tree (dev included) + native build toolchain, then `tsc`.
FROM base AS builder
ENV NODE_ENV=development
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY drizzle ./drizzle
RUN npm run build

# ----------------------------------------------------------- prod-deps -------
# Same tree with dev dependencies pruned; native modules stay compiled.
FROM builder AS prod-deps
RUN npm prune --omit=dev

# -------------------------------------------------------------- runner -------
FROM base AS runner
ENV NODE_ENV=production \
    PORT=4000 \
    NODE_OPTIONS=--enable-source-maps

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder   --chown=node:node /app/dist         ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 4000

HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=6 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

# dumb-init reaps zombies and forwards SIGTERM/SIGINT to node.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/src/index.js"]
