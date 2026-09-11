# admin-app end-to-end (Playwright)

These suites exercise the **real chain** — browser → internal-nginx → internal-Kong (JWT
verify + identity injection, **`admin` role enforced**) → the admin surfaces (balance-service
`/balance/admin`, analytics-server `/analytics/admin`) — **not** the MSW stub the
unit/component tests use.

`login.e2e.ts`, `accounts.e2e.ts`, and `analytics.e2e.ts` are now **wired into and run by**
`tests/e2e-fullrun/` (the spec-08 full-run harness): it brings the stack up, seeds, mints a
demo-admin bearer, and runs all three with `E2E_ENABLED=1` against the live `:8081` origin.

By default (when `E2E_ENABLED` is unset) each suite is registered via `describe.fixme` (see
`fixtures/harness.ts`), so `npx playwright test --list` enumerates them but nothing runs and
**no browser is required**. Vitest never sees them: its `include` matches
`*.{test,spec}.{ts,tsx}` and these are `*.e2e.ts` under `tests/e2e/`.

## What each spec proves

- **`login.e2e.ts`** — PKCE login completes through internal-nginx/Kong and an authenticated
  `GET /balance/admin/whoami` renders the gateway-resolved admin identity. Asserts the call
  carried a `Bearer` token, returned `200`, that the resolved identity carries the `admin`
  role, and that the resolved `userId` and role render on the Home page.
- **`accounts.e2e.ts`** (Step A2) — the account-management and limits SCREENS are reachable on
  the internal plane and their reads (`GET /balance/admin/accounts`, `GET /balance/admin/limits`)
  traverse the gateway with an admin bearer (`200`) and render as tables. This is a **read smoke
  on purpose**: the freeze/unfreeze and PUT-limits MUTATION flow is **deferred** — mutating a
  shared seeded account/limit from a smoke test would risk interfering with the transfer-with-OTP
  e2e that spec 08 enables, and asserting a mutation without seed would be hollow. The reads are
  non-empty even before the customer seed (the migration seeds the system accounts + a global
  baseline limit).
- **`analytics.e2e.ts`** — login → `/analytics` → the two reporting reads
  `GET /analytics/admin/reports/account-summaries` + `/daily-aggregates` traverse the **internal
  gateway** (`/analytics/admin` namespace, the analytics-server) with an admin bearer (`200`) and
  the dashboard's "Daily aggregates" / "Account summaries" sections render. This is a **read
  smoke**: it asserts reachability + render, **not** row counts — the reports may be **empty**
  because no transactions are seeded.

The reversal **maker-checker** approval and **audit** flows — and the account/limits
**mutation** flow — are **later work** and get their own e2e specs as those screens/seeds land.
The audit read endpoint shipped as **PR #54** but is **not yet merged** to main; the reversal
and audit e2e need seeded transactions/approvals/audit rows the seed does not yet create.

## Enabling them

The `tests/e2e-fullrun/` harness does all of this for you against an isolated live stack.
To run these specs **by hand** against your own stack:

1. Bring up the stack: `docker compose up` (internal plane on `:8081`).
2. Provision the Keycloak login user: a user carrying the **`admin` realm role** (the admin
   plane is admin-only — a non-admin login is rejected at the gateway, not by the SPA).
3. Install browsers once (the repo's `.npmrc` sets `ignore-scripts=true`, so the auto
   post-install download is skipped): `npx playwright install chromium`.
4. Run: set the env below and `E2E_ENABLED=1 npm run test:e2e`.

## Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `E2E_ENABLED` | _(unset)_ | Set `1`/`true` to actually run (otherwise every spec is `describe.fixme`). |
| `E2E_BASE_URL` | `http://localhost:8081/` | Internal front door origin (admin plane). |
| `E2E_USERNAME` / `E2E_PASSWORD` | _(none — REQUIRED when `E2E_ENABLED=1`)_ | Keycloak admin login (spec-08-seeded, **`admin` realm role**). No default is baked in; both are read lazily and throw if unset when the suites run. |

Selectors for the Keycloak login form (`#username` / `#password` / `#kc-login`) target the
stock login theme; adjust `fixtures/auth.ts` if spec 08 ships a custom theme.
