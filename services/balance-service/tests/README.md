# Balance-service foundation — test suite (Spec 03, Step 3a)

Tests written **from the spec** (`specs/03-backend-foundation.md`) and the Step-3a
coordination contract, not from the implementor's code. Each test is designed to
**fail on a real defect**. Tests live here, segregated from `src/` (CLAUDE.md).

## What runs where

| File | DoD / contract item | Docker? | Runner |
|---|---|---|---|
| `unit/config.validation.spec.ts` | Config validation / **fail-fast** (typed values, defaults, required-var throws) | No | `npm test` |
| `e2e/identity-and-error-model.e2e-spec.ts` | **Gateway identity guard**, **admin role**, **service identity guard**, prefix self-scoping, **mixed-case prefix fails closed** (case-bypass regression), **error DTO** + code vocabulary + correlation id, **5xx genericization / no info leak** | No | `npm run test:e2e` |
| `e2e/health.e2e-spec.ts` | **`/internal/health`** liveness-vs-readiness body, **503 on readiness failure**, service-token **carve-out** | No | `npm run test:e2e` |
| `integration/health-and-migration.integration.spec.ts` | Real DB readiness UP + **sample migration ran on boot** in `balance` | **Yes** (honest-SKIP) | `npm test` |

Discovery is already wired by the scaffold: `jest.config.ts` matches
`tests/**/*.spec.ts` (unit + the integration spec, which self-skips) and
`jest-e2e.config.ts` matches `tests/**/*.e2e-spec.ts`.

## Honest-SKIP (integration)

The integration suite is **opt-in** via `BALANCE_INTEGRATION=1`; unset it is
`describe.skip`, so Jest reports it as **skipped, never passed** (a skip is never a
false pass — see `tests/storage/README.md`). When opted in, `beforeAll` TCP-probes
Postgres (`DB_HOST:DB_PORT`, default `127.0.0.1:5432`) and **fails loudly** if it is
unreachable rather than silently degrading. It boots the real `AppModule` and runs
the real migrations against the target `balance` DB (idempotent — safe to re-run).

Run it:

```bash
# with the compose datastores reachable to the runner:
BALANCE_INTEGRATION=1 DB_HOST=127.0.0.1 DB_PORT=5432 \
  DB_NAME=balance DB_USER=balance_app DB_PASSWORD=... npm test
# optional: SAMPLE_MIGRATION_TABLE=app_metadata to also assert the exact table
```

## Seam: `support/harness.ts`

All imports of the implementor's source funnel through `support/harness.ts` (the
single coordination point). If a module/export is renamed, that file is the only
edit and it throws an actionable error naming what is missing. The seam it wires:
`parseEnv` (config), `GatewayIdentityGuard`, `ServiceIdentityGuard`,
`AllExceptionsFilter`, the `APP_CONFIG` token, `HealthController` +
`HEALTH_REPOSITORY`, `InternalController`, `requestIdMiddleware`, and `AppModule`.

## Design notes / where fidelity comes from

- **Real code under test.** The e2e suites bind the implementor's REAL guards
  globally (`APP_GUARD`, exactly as `AppModule` does) and thread the REAL request-id
  middleware + error filter. Only genuinely-external seams are faked: the health
  suite fakes `HEALTH_REPOSITORY` (the Postgres ping) so the 200 *and* 503 branches
  are deterministic without Docker. Nothing under test is mocked away.
- **Admin is enforced inside the gateway guard** (path-based), so there is no
  separate admin guard to wire — the `/admin` 403/200 cases exercise the gateway
  guard on an `/admin` path.
- **Self-scoping** is asserted directly: a valid `/api` request needs no service
  token and a valid `/internal` request needs no user header — proving the two
  global guards do not bleed across planes.

## Known gaps (deliberate)

- **Real DB-down => 503 over the wire** is not asserted in the integration suite
  (tearing Postgres down mid-suite is flaky); the 503 readiness path is instead
  proven deterministically in `health.e2e-spec.ts` by faking the readiness repo.
- The integration migration check is **name-independent** (asserts a migrations
  tracking table with >=1 executed row + >=1 non-tracking application table) rather
  than hard-coding `app_metadata`, so it proves the DoD without coupling to the
  sample table's name. Pass `SAMPLE_MIGRATION_TABLE` to pin the exact name.

## Escalations / assumptions (confirm with the developer)

1. **Error `code` vocabulary is now asserted** (`UNAUTHORIZED`/`FORBIDDEN`/`NOT_FOUND`/
   `INTERNAL_ERROR`) against `src/common/errors/error-response.ts`. If that mapping is
   deliberately non-contractual (free to change), loosen these back to a string check.
2. **`main.ts`-only middleware.** `requestIdMiddleware` is applied in `main.ts`, not
   in `AppModule`. The Docker-free e2e applies it explicitly (mirroring `main.ts`).
   The integration suite boots `AppModule` via `Test` (no `main.ts`), so its error
   responses would carry `requestId: 'unknown'` — it does not assert the correlation
   id, only health + migration. If correlation must hold under `AppModule` alone,
   move the middleware into a `NestModule.configure()` and escalate.
