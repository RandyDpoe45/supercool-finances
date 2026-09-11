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

- **Packaging = per-SPA atomic images** (developer ruling — supersedes the earlier
  "bake the bundles into the nginx image" baseline). Each SPA is built and served by
  its OWN multi-stage image (`node build → static output → nginx serving that
  bundle`), its build context scoped to its own folder — no cross-folder build
  context — so `web/client` and `web/otp` stay atomic and independently extractable
  (ADR-16). **No build args are required:** a production `vite build` disables the
  MSW stub (`import.meta.env.DEV` is false), the API base defaults to the same-origin
  `/balance/api`, and the OIDC authority/client-id defaults already match the compose
  issuer (`http://keycloak.localtest.me:8082/realms/supercool`) and the realm's
  `client-app` / `otp-app` clients.
- **Serving layout** (resolves the open question from spec 07): the two public SPAs
  sit behind a shared `public-nginx`, which is the thin **router** that ASSEMBLES the
  per-SPA images (it does not itself hold the bundles). Path-based: `/` → the
  `client-app` image; `/otp/` → the `otp-app` image, **proxied without stripping
  `/otp/`** (that bundle is built for `base: '/otp/'`, so its assets and OIDC redirect
  live under `/otp/`); and the service-namespaced API path `/balance/api/` →
  `public-kong` (already present in `infra/nginx-public/nginx.conf`). Each SPA image
  owns its own `try_files … /index.html` history fallback. The `/<service>/<surface>`
  namespacing (Kong strips `/<service>`) is established in spec 06
  ([ADR-17](../docs/DECISIONS.md#adr-17--service-namespaced-edge-routing)).
  `internal-nginx` (admin plane) follows the same router pattern when it lands: `/` →
  the `admin-app` image, `/balance/admin/` and `/analytics/admin/` → `internal-kong`.
- **Ports & origin.** The SPA images join `edge-public` only and are **not
  host-published**; only `public-nginx` (:8080) is (spec 00 §3). The browser must
  reach the apps at `http://localhost:8080` — the OIDC `redirect_uri` is derived from
  `window.location.origin` and is allowlisted for exactly that origin (client `…/`,
  otp `…/otp/`).

## Seed data

- After migrations, an **idempotent seed step** — a one-shot service under a compose
  **`seed` profile** (developer ruling), run explicitly (`docker compose --profile
  seed up`) so the default `up` graph carries no always-declared seed container —
  loads customers, accounts, default limits, and the two **clearing (system)
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

> **Scope note — this build pass (public plane only).** The admin plane is deferred:
> the admin SPA is not yet built and the internal transport edge (spec 06 step 2) is
> not merged. So the two admin-plane acceptance items above — the **admin
> maker-checker reversal from the admin app** and the **`:8081`** internal front door
> — are OUT of this pass (in this pass only `:8080` and `:8082` are published). They
> remain the eventual target. This pass delivers the PUBLIC plane end to end: the
> client + otp SPAs served by `public-nginx`, seed data, and a clean-machine
> `docker compose up --build` proving the **transfer-with-OTP** flow from the client
> app.

## Open questions

- _None open._

**Resolved:**
- Public SPA layout is **path-based** (`/` → client, `/otp/` → otp).
- SPA packaging is **per-SPA atomic images** behind `public-nginx` as router
  (supersedes bake-into-the-nginx-image).
- The seed step runs as a **compose `seed` profile** (not an init container).
