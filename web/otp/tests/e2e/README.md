# otp-app end-to-end (Playwright) — PENDING until spec 08

These suites exercise the **real chain** — browser → public-nginx → public-Kong (JWT verify
+ identity injection) → balance-service — **not** the MSW stub the unit/component tests use.
They encode the spec-07 Definition of Done for the out-of-band OTP SPA.

They are **PENDING (skipped by default)** because the running stack, the seed data, and the
Keycloak login users are **spec-08 territory and do not exist yet**. Each suite is registered
via `describe.fixme` (see `fixtures/harness.ts`), so `npx playwright test --list` enumerates
them but nothing runs and **no browser is required**. Vitest never sees them: its `include`
matches `*.{test,spec}.{ts,tsx}` and these are `*.e2e.ts` under `tests/e2e/`.

## What each spec proves

- **`login-pending.e2e.ts`** — PKCE login via the SEPARATE `otp-app` client completes through
  nginx/Kong, and an authenticated `GET /balance/api/pending-authorization` renders the
  caller's real pending. Asserts the call carried a `Bearer` token, returned `200`, and that
  the feed's type label + currency match the wire payload.
- **`reveal.e2e.ts`** — revealing calls `POST /balance/api/otp` and displays the returned code
  (DOM code == the API `code`), with the shown-once warning. Then it proves the **singleton**:
  a page reload resets the client view, and a second reveal while the minted code is still
  active is rejected `409 OTP_ALREADY_ACTIVE` and surfaces the "already active" message (never
  a plaintext code).

## Enabling them (spec 08)

1. Bring up the stack: `docker compose up` (public plane on `:8080`; otp-app served at `/otp`).
2. Seed a **pending authorization** for the login user — seed a PENDING transfer, or run the
   client-app initiate flow first so a pending exists to authorize.
3. Provision the Keycloak login user for the `otp-app` client (the same `customer`-role human
   whose pending is being authorized).
4. Install browsers once (the repo's `.npmrc` sets `ignore-scripts=true`, so the auto
   post-install download is skipped): `npx playwright install chromium`.
5. Run: set the env below and `E2E_ENABLED=1 npm run test:e2e`.

## Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `E2E_ENABLED` | _(unset)_ | Set `1`/`true` to actually run (otherwise every spec is `describe.fixme`). |
| `E2E_BASE_URL` | `http://localhost:8080` | Public front door origin (otp-app under `/otp/`). |
| `E2E_OTP_USERNAME` / `E2E_OTP_PASSWORD` | _(none — REQUIRED when `E2E_ENABLED=1`; falls back to `E2E_USERNAME` / `E2E_PASSWORD`)_ | otp-app Keycloak login — the same human as the customer, via the separate `otp-app` client. No default is baked in; both are read lazily and throw if unset when the suites run. |

Selectors for the Keycloak login form (`#username` / `#password` / `#kc-login`) target the
stock login theme; adjust `fixtures/auth.ts` if spec 08 ships a custom theme.
