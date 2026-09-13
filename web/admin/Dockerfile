# =============================================================================
# admin-app — admin dashboard SPA production image (spec 08, internal plane).
#
# Per-SPA ATOMIC image (developer ruling, spec 08): this SPA is BUILT and SERVED
# by its own multi-stage image, its build context scoped to web/admin ONLY — no
# cross-folder COPY (ADR-16 folder atomicity). No build args are needed: a
# production `vite build` sets import.meta.env.DEV = false so the MSW stub
# self-disables, the API base defaults to the same-origin /balance/admin, and the
# OIDC authority / client-id defaults already match the compose issuer + the
# realm's `admin-app` client (spec 08). internal-nginx routes `/` -> this image.
#
#   Stage 1 (builder)  node:24-alpine — install exact deps from the lockfile with
#                      the committed hardened .npmrc, then compile TS + Vite to dist/.
#   Stage 2 (runtime)  nginx:1.27-alpine — serve the static bundle at / with an
#                      SPA history fallback. No Node in the final image.
# =============================================================================

# ---- Stage 1: build the static bundle ---------------------------------------
FROM node:24-alpine AS builder
WORKDIR /app

# Deps first for layer caching: the lockfile + hardened .npmrc drive `npm ci`
# (exact, ignore-scripts, engine-strict), so deps are only reinstalled when they
# change — not when source changes. Do NOT set NODE_ENV=production here: the build
# toolchain (vite, typescript, plugins) lives in devDependencies.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

# Sources needed to build (this folder only). tsconfig.node.json + tsconfig.app.json
# are project references of tsconfig.json (tsc -b), so all three must be present.
COPY tsconfig.json tsconfig.app.json tsconfig.node.json vite.config.ts index.html ./
# Tailwind/PostCSS config: Vite auto-detects postcss.config.js and runs the Tailwind
# pass over index.css (the @tailwind directives + @apply). WITHOUT these two files the
# build ships index.css unprocessed — @tailwind/@apply survive as invalid CSS the
# browser drops, so the served SPA is completely unstyled (the dev server reads them
# from disk, which is why `npm run dev` looked fine while the built image did not).
COPY tailwind.config.js postcss.config.js ./
COPY public ./public
COPY src ./src

# `npm run build` = `tsc -b && vite build` -> /app/dist (base '/', assets at /assets/).
RUN npm run build

# ---- Stage 2: serve the static bundle ---------------------------------------
FROM nginx:1.27-alpine AS runtime

# This image's OWN server config (baked in) — distinct from the mounted
# internal-nginx router. Overwrites the stock default.conf server block.
COPY nginx.conf /etc/nginx/conf.d/default.conf

# The built bundle -> nginx web root; the URL path maps 1:1 onto the filesystem.
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80
# The base image's entrypoint launches nginx in the foreground.
