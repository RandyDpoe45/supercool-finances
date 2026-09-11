# admin-app end-to-end (Playwright) — PENDING until spec 08

These suites exercise the **real chain** — browser → internal-nginx → internal-Kong (JWT
verify + identity injection, **`admin` role enforced**) → balance-service admin surface —
**not** the MSW stub the unit/component tests use. They encode the spec-07 Definition of Done
for the admin SPA's auth shell (Step 1).

They are **PENDING (skipped by default)** because the running stack, the seed data, and the
Keycloak login user are **spec-08 territory and do not exist yet**. Each suite is registered
via `describe.fixme` (see `fixtures/harness.ts`), so `npx playwright test --list` enumerates
them but nothing runs and **no browser is required**. Vitest never sees them: its `include`
matches `*.{test,spec}.{ts,tsx}` and these are `*.e2e.ts` under `tests/e2e/`.

## What each spec proves

- **`login.e2e.ts`** — PKCE login completes through internal-nginx/Kong and an authenticated
  `GET /balance/admin/whoami` renders the gateway-resolved admin identity. Asserts the call
  carried a `Bearer` token, returned `200`, that the resolved identity carries the `admin`
  role, and that the resolved `userId` and role render on the Home page.
- **`accounts.e2e.ts`** (Step A2) — the account-management and limits SCREENS are reachable on
  the internal plane and their reads (`GET /balance/admin/accounts`, `GET /balance/admin/limits`)
  traverse the gateway with an admin bearer (`200`) and render as tables. This is a **read smoke
  on purpose**: the freeze/unfreeze and PUT-limits MUTATION flow is **deferred to spec 08** (when
  seed data + the full stack exist) — mutating a shared seeded account/limit from a smoke test
  would risk interfering with the transfer-with-OTP e2e that spec 08 enables, and asserting a
  mutation without seed would be hollow.

The reversal **maker-checker** approval, audit, and analytics-dashboard flows — and the
account/limits **mutation** flow — are **later work** and get their own e2e specs as those
screens/seeds land; these files cover the Step-1 auth shell and the Step-A2 read surface.

## Enabling them (spec 08)

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
