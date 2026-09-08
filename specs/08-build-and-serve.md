# Spec 08 — Build Pipelines, Seed Data & Full Run

**Purpose.** Make everything build into images and come up with one command:
backends behind Kong, frontends served by nginx, seed data loaded, demo flows
working on a clean machine.

**Depends on.** All prior specs.

## Backend build

- Multi-stage Dockerfile per app (`deps → build TS → runtime node:alpine`).
- Runs **migrations on boot** (balance service).
- Runs on `app-*` + `data` only — **not host-published**; reachable solely via its
  Kong (spec 06).

## Frontend build

- Multi-stage build per SPA (`node build → static output`), output served by nginx.
- **Serving layout** (resolve the open question from spec 07): the two public SPAs
  share `public-nginx`. Baseline = **path-based**: `/` → client-app, `/otp/` →
  otp-app, `/api/` → proxy to `public-kong`, each SPA location with its own
  `try_files … /index.html` fallback. `internal-nginx`: `/` → admin-app, `/admin/`
  → proxy to `internal-kong`.
- Baseline packaging = bake the built bundles into per-plane nginx images
  (public-nginx image carries client + otp; internal-nginx carries admin).

## Seed data

- After migrations, an **idempotent seed step** (compose `seed` profile or an init
  job) loads customers, accounts, default limits, and the two **clearing (system)
  accounts** (`clearing:rail-outbound`, `clearing:rail-inbound`) into the `balance`
  DB so the demo has state.
- Keycloak users/roles come from `realm-export.json` (spec 02); the seeded app
  customers must line up with the seeded Keycloak `sub`s.

## Full run

- `docker compose up --build` on a clean checkout →
  - datastores healthy → Keycloak (realm imported) → backends (migrated) → Kongs
    (config loaded) → nginx.
  - client SPA at `:8080`, admin SPA at `:8081`, Keycloak at `:8082`.

## Definition of Done

- [ ] Clean-machine `docker compose up --build` reaches all-healthy with no manual
      steps.
- [ ] A full **transfer-with-OTP** works from the client app; an **admin
      maker-checker reversal** works from the admin app.
- [ ] Seed data is present and Keycloak logins map to seeded customers.
- [ ] Re-running up is idempotent (seed doesn't duplicate; migrations no-op).
- [ ] Only `:8080`, `:8081`, `:8082` are published.

## Open questions

- Whether seed runs as a compose profile or an init container.

**Resolved:** public SPA layout is **path-based** (`/` → client, `/otp/` → otp).
