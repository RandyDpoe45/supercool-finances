# =============================================================================
# tools/seed — multi-stage image (deps -> slim runtime).
# Base node:24-alpine (matches engines: node >=24, same pin as the services).
# There is no TS build step — the tool is plain ESM JS — so the stages are
# deps (install from the committed lockfile) -> runtime (node_modules + src only).
# Installs use the hardened .npmrc (ignore-scripts honored) via `npm ci`. Runs as
# the non-root `node` user. One-shot: the CMD runs the seed script to completion
# and exits (the compose `seed` service is restart: "no").
# =============================================================================

# ---- Stage 1: deps ----------------------------------------------------------
FROM node:24-alpine AS deps
WORKDIR /app

# Install prod deps strictly from the lockfile. .npmrc carries the supply-chain
# posture; ignore-scripts=true means no dependency lifecycle scripts run.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- Stage 2: runtime -------------------------------------------------------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Installed modules + the script source (no lockfile/toolchain in the runtime image).
COPY --from=deps /app/node_modules ./node_modules
COPY package.json .npmrc ./
COPY src ./src

# Drop privileges: run as the built-in non-root `node` user.
USER node

CMD ["node", "src/seed.js"]
