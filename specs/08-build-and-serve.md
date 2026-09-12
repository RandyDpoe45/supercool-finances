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
  `internal-nginx` (admin plane) now follows the same router pattern (THIS admin step):
  `/` → the `admin-app` image (served, not a placeholder), `/balance/admin/` and
  `/analytics/admin/` → `internal-kong` (the internal edge landed on main via #46).
- **Ports & origin.** The SPA images join `edge-public` only and are **not
  host-published**; only `public-nginx` (:8080) is (spec 00 §3). The browser must
  reach the apps at `http://localhost:8080` — the OIDC `redirect_uri` is derived from
  `window.location.origin` and is allowlisted for exactly that origin (client `…/`,
  otp `…/otp/`).

## Seed data

- **System constants are seeded by boot MIGRATIONS, not by this step** — the MXN
  `currency` row, the two **clearing (system) accounts** (`clearing:rail-outbound`,
  `clearing:rail-inbound`), and the **global baseline `user_limits`** row. The seed
  must NOT duplicate or touch these.
- After migrations, an **idempotent seed step** — a one-shot service under a compose
  **`seed` profile** (developer ruling), run explicitly (`docker compose --profile
  seed up`) so the default `up` graph carries no always-declared seed container —
  loads the **demo customers and their accounts** into the `balance` DB so the demo
  has state. It is an atomic tool in `tools/seed/` (its own package + Dockerfile, no
  balance-service imports per ADR-16 — the schema is duplicated and kept in sync via
  this spec), reaching Postgres with the same discrete creds as the service. Upserts
  are idempotent: customers `ON CONFLICT (id) DO NOTHING`, accounts
  `ON CONFLICT (account_number) DO NOTHING` (a re-run changes nothing). Per-customer
  limit overrides are an admin concern (`PUT /limits`) and are NOT seeded.
- **Sub alignment (developer ruling).** `customer.id` IS the Keycloak `sub` and
  `account.owner_id` FKs to it, so the demo users carry a **pinned `id`** in
  `realm-export.json` (spec 02) to make the `sub` deterministic, and the seed inserts
  the customer row with that SAME id. Realm import is first-boot only, so a clean
  `up --build` is required to (re)align.
- **Demo dataset** — the shared contract both the seed code and its tests follow.
  There are **10 login-capable customers** (`demo-customer` = #1, then
  `demo-customer-2` … `demo-customer-10`) plus **one no-login payee** (Maria
  Gonzalez), so the seed loads **11 customers + 17 customer accounts** in total —
  most customers own one account, but a few own **2–3** (see "Multiple accounts"
  below).
  - Pinned Keycloak ids — **customers** (realm role `customer`; account.owner_id FKs
    to `customer.id` = this sub, so each is deterministic):
    - `demo-customer`    = `11111111-1111-4111-8111-111111111111`
    - `demo-customer-2`  = `c0000002-0002-4002-8002-000000000002`
    - `demo-customer-3`  = `c0000003-0003-4003-8003-000000000003`
    - `demo-customer-4`  = `c0000004-0004-4004-8004-000000000004`
    - `demo-customer-5`  = `c0000005-0005-4005-8005-000000000005`
    - `demo-customer-6`  = `c0000006-0006-4006-8006-000000000006`
    - `demo-customer-7`  = `c0000007-0007-4007-8007-000000000007`
    - `demo-customer-8`  = `c0000008-0008-4008-8008-000000000008`
    - `demo-customer-9`  = `c0000009-0009-4009-8009-000000000009`
    - `demo-customer-10` = `c0000010-0010-4010-8010-000000000010`
  - Pinned Keycloak ids — **admins** (realm role `admin`; **NO customer/account row**,
    identity comes from the gateway):
    - `demo-admin`   = `22222222-2222-4222-8222-222222222222`
    - `demo-admin-2` = `33333333-3333-4333-8333-333333333333` — the **distinct
      checker** so the maker-checker reversal has four eyes (checker ≠ maker).
  - **Customer #1** (`demo-customer`, the primary login): `id` = the demo-customer sub
    above; `name` "Demo Customer", `phone` "5510000001", `email`
    "demo-customer@example.test" (matches its realm-export email); realm password
    `demo-customer-pw`. One **active MXN customer account**: `account_number`
    `1000000001`, `balance` `100000000` (1,000,000.00 MXN), `held` 0, spend counters 0,
    `spent_today_date`/`spent_month_date` = `CURRENT_DATE`.
  - **Customers #2–#10** (`demo-customer-2` … `demo-customer-10`, logins): for each `N`
    in `2..10`, `id` = its pinned sub above; `customer.name` = `"Demo Customer N"`;
    realm `firstName` "Demo", `lastName` `"Customer N"`, `email`
    `demo-customer-N@example.test`, `phone` = `55100000` + zero-padded 2-digit `N`
    (`5510000002` … `5510000010`), realm password `demo-customer-N-pw`, realm role
    `customer`, `enabled` + `emailVerified` true. Each owns a **primary active MXN
    account**: `account_number` = `1000000001 + N` (`1000000003` … `1000000011`,
    skipping `1000000002` which is Maria's); `balance` = `N × 10000000` minor units
    (N × 100,000.00 MXN → #2 = 200,000.00 … #10 = 1,000,000.00); `held` 0, spend
    counters 0, dates = `CURRENT_DATE`, same defaults as #1. A few of them **also**
    own extra accounts — see "Multiple accounts".
  - **Maria Gonzalez** (transfer destination, **NO Keycloak login**): synthetic `id`
    `b0000000-0000-4000-8000-000000000002`; `name` "Maria Gonzalez", `phone`
    "5520000002", `email` "maria.gonzalez@example.test". One active MXN customer
    account: `account_number` `1000000002`, `balance` `50000000` (500,000.00 MXN),
    same counter defaults. Exists so the demo has a confirmation-of-payee target for
    the transfer-with-OTP flow — she has **no realm user** and cannot log in.
  - **Multiple accounts** — so the apps can be tested with customers holding more than
    one account, a few login customers own **2–3** MXN accounts (**never more than 3**);
    every other customer owns exactly its one primary account. `demo-customer` (#1) and
    Maria are deliberately kept at **one** account each — #1 is the transfer-with-OTP
    e2e source and Maria its destination, so their single-account shape is load-bearing.
    Extra accounts are numbered from `1000000012` upward (the primary numbers above are
    unchanged), so `account_number` stays globally unique. Extra accounts are `active`
    MXN, `held` 0, counters 0 @ `CURRENT_DATE`, `owner_id` = that customer's sub; a
    **secondary** account carries `5000000` (50,000.00 MXN), a **tertiary** `2500000`
    (25,000.00 MXN). Per customer (extras assigned in ascending customer order):
    - `demo-customer-2` → **3** accounts: `1000000003` (primary, 200,000.00),
      `1000000012` (50,000.00), `1000000013` (25,000.00)
    - `demo-customer-3` → **2** accounts: `1000000004` (primary, 300,000.00),
      `1000000014` (50,000.00)
    - `demo-customer-4` → **3** accounts: `1000000005` (primary, 400,000.00),
      `1000000015` (50,000.00), `1000000016` (25,000.00)
    - `demo-customer-5` → **2** accounts: `1000000006` (primary, 500,000.00),
      `1000000017` (50,000.00)
    - every other customer (`demo-customer`, `demo-customer-6` … `-10`, Maria) → **1**
      account (its primary).
    Total: **17** customer accounts (11 primaries + 6 extras).

## Full run

- `docker compose up --build` on a clean checkout →
  - datastores healthy → Keycloak (realm imported) → backends (migrated) → Kongs
    (config loaded) → nginx.
  - client SPA at `:8080`, admin SPA at `:8081`, Keycloak at `:8082`.

## Definition of Done

- [ ] Clean-machine `docker compose up --build` reaches all-healthy with no manual
      steps.
- [x] A full **transfer-with-OTP** works from the client app; an **admin
      maker-checker reversal** works from the admin app. (Both halves are proven
      end-to-end by the full-run harness, `tests/e2e-fullrun/`: the public
      transfer-with-OTP chain, then the admin reversal of that posted transfer —
      `demo-admin` proposes, `demo-admin-2` approves.)
- [ ] Seed data is present and Keycloak logins map to seeded customers.
- [ ] Re-running up is idempotent (seed doesn't duplicate; migrations no-op).
- [ ] Only `:8080`, `:8081`, `:8082` are published.

> **Scope note — build passes.** Pass 1 (DONE, merged) delivered the PUBLIC plane end
> to end: the client + otp SPAs served by `public-nginx`, seed data, and a clean-machine
> `docker compose up --build` proving the **transfer-with-OTP** flow from the client app
> (`:8080` + `:8082`).
>
> Pass 2 (THIS admin step) delivers the ADMIN plane's **build & serve + internal front
> door**: the internal transport edge is on main (#46), and this step builds the
> `admin-app` as a per-SPA atomic image, flips `internal-nginx`'s `/` from the placeholder
> `404` to route `/` → `admin-app`, publishes **`:8081`**, and proves a **demo-admin
> Keycloak login at `:8081` reaches the real `/balance/admin` surface** (the whoami
> landing) through `internal-nginx → internal-kong → balance-service`.
>
> Still OPEN after this pass (NOT claimed done): the DoD item **"admin maker-checker
> reversal from the admin app"** — the reversal UI (admin-app A3) is not built. Also, the
> admin app's **Accounts/Limits screens** (admin-app A2) call balance-service admin READ
> endpoints (`GET /admin/accounts`, `GET /admin/limits`) that **do not exist yet**, so
> those screens are not functional against the real backend; only the whoami landing is
> proven end-to-end. Published ports remain `:8080` / `:8081` / `:8082`.
>
> **Update (post-Pass-2).** The admin app has since been completed — A2 accounts/limits
> (#47), A3 maker-checker reversals (#51), A4 audit view (#52), A5 analytics dashboard
> (#53) — and the balance-service admin READ surface now exists: `GET /admin/accounts` +
> `/admin/limits` + `/admin/approvals` (#50) and `GET /admin/audit` (#54). Accordingly the
> full-run harness (`tests/e2e-fullrun/`) now runs the admin browser e2e — `login` (PKCE +
> whoami), `accounts` (accounts + limits reads through the gateway), `analytics` (the
> `/analytics/admin` reporting reads), **`reversals`, and `audit`** — in addition to the
> public transfer-with-OTP chain. The DoD item **"admin maker-checker reversal from the
> admin app"** is now **proven end-to-end**: the admin chain runs AFTER the public chain, so
> the POSTED internal transfer the transfer-with-OTP flow creates (`1000000001 →
> 1000000002`) is the reversible transaction — **`demo-admin` proposes** the reversal and a
> **second admin, `demo-admin-2`, approves** it (four-eyes: checker ≠ maker), so the demo
> transfer is reversed and the reversal's rows are then visible via `GET /admin/audit`. A
> full run therefore ends with that demo transfer reversed. (`demo-admin-2` is a new
> admin-only realm user pinned at `33333333-…`, added purely to be the distinct checker.)

## Open questions

- _None open._

**Resolved:**
- Public SPA layout is **path-based** (`/` → client, `/otp/` → otp).
- SPA packaging is **per-SPA atomic images** behind `public-nginx` as router
  (supersedes bake-into-the-nginx-image).
- The seed step runs as a **compose `seed` profile** (not an init container).
