# client-app end-to-end (Playwright) — PENDING until spec 08

These suites exercise the **real chain** — browser → public-nginx → public-Kong (JWT
verify + identity injection) → balance-service — **not** the MSW stub the unit/component
tests use. They encode the spec-07 Definition of Done for the customer SPA.

They are **PENDING (skipped by default)** because the running stack, the seed data, and the
Keycloak login users are **spec-08 territory and do not exist yet**. Each suite is registered
via `describe.fixme` (see `fixtures/harness.ts`), so `npx playwright test --list` enumerates
them but nothing runs and **no browser is required**. Vitest never sees them: its `include`
matches `*.{test,spec}.{ts,tsx}` and these are `*.e2e.ts` under `tests/e2e/`.

## What each spec proves

- **`login.e2e.ts`** — PKCE login completes through nginx/Kong and an authenticated
  `GET /balance/api/accounts` renders real balances. Asserts the call carried a `Bearer`
  token, returned `200`, and that the rendered account list reflects the real payload.
- **`internal-transfer.e2e.ts`** — a full internal transfer with the out-of-band OTP step:
  confirmation-of-payee → amount + captcha → initiate (PENDING) → **code read from the real
  otp-app** (second browser context) → confirm → settle. Asserts the source `balance` drops
  by exactly the amount with `held` untouched (BigInt over minor-unit strings).
- **`external-transfer.e2e.ts`** — the headline DoD: an external transfer including the OTP
  step. Proves the **hold** (available reserved, balance untouched at initiate) then the
  **settle** (balance debited, hold released at OTP confirm), with the code again read from
  the real otp-app. A second test proves a freshly enrolled payee is shown in cooling-off and
  cannot yet be paid.

The cross-app OTP retrieval (`revealOtpCodeFromOtpApp` in `fixtures/auth.ts`) drives the
**real otp-app** in a second Playwright browser context — a genuine out-of-band second
channel, exactly as the DoD requires ("code read from the otp-app").

## Enabling them (spec 08)

1. Bring up the stack: `docker compose up` (public plane on `:8080`).
2. Seed the demo data (`tools/seed`): a funded customer source account; a 10-digit internal
   destination account in the same currency; at least one **usable** external payee (past its
   cooling-off).
3. Provision the Keycloak login user(s): a `customer`-role user usable for both the
   `client-app` and `otp-app` clients.
4. Install browsers once (the repo's `.npmrc` sets `ignore-scripts=true`, so the auto
   post-install download is skipped): `npx playwright install chromium`.
5. Run: set the env below and `E2E_ENABLED=1 npm run test:e2e`.

## Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `E2E_ENABLED` | _(unset)_ | Set `1`/`true` to actually run (otherwise every spec is `describe.fixme`). |
| `E2E_BASE_URL` | `http://localhost:8080` | Public front door origin. |
| `E2E_USERNAME` / `E2E_PASSWORD` | _(none — REQUIRED when `E2E_ENABLED=1`)_ | Keycloak customer login (spec-08-seeded). No default is baked in; both are read lazily and throw if unset when the suites run. |
| `E2E_OTP_USERNAME` / `E2E_OTP_PASSWORD` | _(falls back to `E2E_USERNAME` / `E2E_PASSWORD`)_ | otp-app login (same human/`sub` by default). No default is baked in. |
| `E2E_DEST_ACCOUNT` | `2000000001` | Seeded 10-digit internal destination account number. |
| `E2E_TRANSFER_MAJOR` / `E2E_TRANSFER_MINOR` | `10.00` / `1000` | Transfer amount as the human input AND the exact minor-unit (centavos) delta; keep them consistent. |

Selectors for the Keycloak login form (`#username` / `#password` / `#kc-login`) target the
stock login theme; adjust `fixtures/auth.ts` if spec 08 ships a custom theme.
