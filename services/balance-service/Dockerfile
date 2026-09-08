# =============================================================================
# balance-service — multi-stage image (build -> slim runtime).
# Base node:24-alpine (matches engines: node >=24). Installs use the hardened
# .npmrc (ignore-scripts honored) via `npm ci` against the committed lockfile.
# Runs as the non-root `node` user; boots with migrations-then-listen (the app
# runs pending migrations on boot via TypeORM migrationsRun before it listens).
# =============================================================================

# ---- Stage 1: build ---------------------------------------------------------
FROM node:24-alpine AS builder
WORKDIR /app

# Install deps first (better layer caching). .npmrc carries the supply-chain
# posture; ignore-scripts=true means no dependency lifecycle scripts run.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

# Compile TypeScript -> dist/.
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---- Stage 2: runtime -------------------------------------------------------
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Production-only dependencies, installed from the lockfile with scripts disabled.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled output only — no source, no dev deps.
COPY --from=builder /app/dist ./dist

# Drop privileges: run as the built-in non-root `node` user.
USER node

EXPOSE 3000
# migrations-then-boot: migrationsRun applies pending migrations during DataSource
# init, before the HTTP server starts listening.
CMD ["node", "dist/main.js"]
