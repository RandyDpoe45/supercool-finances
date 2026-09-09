# Analytics-server foundation — test suite (Spec 03, Step 3b)

Tests written **from the spec** (`specs/03-backend-foundation.md`) and the Step-3b
coordination contract, not from the implementor's code. Each test is designed to
**fail on a real defect**. Tests live here, segregated from `src/` (CLAUDE.md). The
suite mirrors the just-merged `balance-service/tests/` (the template), adapted for
analytics: **Mongo** (not Postgres), **no Redis**, **no `/api`**, **no migration**.

## What runs where

| File | DoD / contract item | Docker? | Runner |
|---|---|---|---|
| `unit/config.validation.spec.ts` | Config validation / **fail-fast** (typed values, PORT/MONGO_PORT numeric defaults, MONGO_AUTH_SOURCE default `analytics`, required-var throws) + **DSN URL-encoding** regression lock (reserved-char user/password round-trip via `new URL`) | No | `npm test` |
| `e2e/identity-and-error-model.e2e-spec.ts` | **Gateway identity guard** (`/admin`), **admin role**, **service identity guard** (`/internal`), prefix self-scoping, **mixed-case prefix fails closed** (case-bypass regression), **error DTO** + code vocabulary + correlation id, **5xx genericization / no info leak** | No | `npm run test:e2e` |
| `e2e/health.e2e-spec.ts` | **`/internal/health`** liveness-vs-readiness body, **200/503** via faked Mongo ping, service-token **carve-out** + mixed-case `/INTERNAL/HEALTH` + **carve-out exactness** (`/internal/health-and-secrets` stays 401) | No | `npm run test:e2e` |
| `integration/health.integration.spec.ts` | Real Mongo readiness UP (`/internal/health` 200 over a live Mongo) | **Yes** (honest-SKIP) | `npm test` |

Discovery is wired by the scaffold (confirmed): `jest.config.ts` matches
`tests/**/*.spec.ts` (unit + the integration spec, which self-skips) and
`jest-e2e.config.ts` matches `tests/**/*.e2e-spec.ts`. Verified locally: `npm test`
= 17 passed + 2 skipped (integration); `npm run test:e2e` = 26 passed.

## Honest-SKIP (integration)

The integration suite is **opt-in** via `ANALYTICS_INTEGRATION=1`; unset, it is
`describe.skip`, so Jest reports it as **skipped, never passed** (a skip is never a
false pass — see `tests/storage/README.md`). When opted in, `beforeAll` TCP-probes
Mongo (`MONGO_HOST:MONGO_PORT`, default `127.0.0.1:27017`) and **fails loudly** if it
is unreachable rather than silently degrading. It boots the real `AppModule` against
the target Mongo and asserts the readiness path really connects.

Run it:

```bash
# with the compose datastores reachable to the runner:
ANALYTICS_INTEGRATION=1 MONGO_HOST=127.0.0.1 MONGO_PORT=27017 \
  MONGO_DB=analytics MONGO_USER=analytics_app MONGO_PASSWORD=... \
  MONGO_AUTH_SOURCE=analytics npm test
```

## Seam: `support/harness.ts`

All imports of the implementor's source funnel through `support/harness.ts` (the
single coordination point). If a module/export is renamed, that file is the only
edit and it throws an actionable error naming what is missing. The seam it wires:
`parseEnv` (config), `GatewayIdentityGuard`, `ServiceIdentityGuard`,
`AllExceptionsFilter`, the `APP_CONFIG` token, `HealthController` +
`HEALTH_REPOSITORY`, `InternalController` (the `/internal/ping` probe),
`requestIdMiddleware`, and `AppModule`.

## Design notes / where fidelity comes from

- **Real code under test.** The e2e suites bind the implementor's REAL guards
  globally (`APP_GUARD`, exactly as `AppModule` does) and thread the REAL request-id
  middleware + error filter. Only genuinely-external seams are faked: the health
  suite fakes `HEALTH_REPOSITORY` (the Mongo ping) so the 200 *and* 503 branches are
  deterministic without Docker. Nothing under test is mocked away.
- **No `/api`.** Per ADR-12 / spec 05, analytics exposes only `/admin` + `/internal`.
  The gateway-guard tests therefore exercise the `/admin` surface (401 no header, 403
  non-admin, 200 admin + identity resolved), not `/api`.
- **Self-scoping** is asserted directly: a valid `/admin` request needs no service
  token and a valid `/internal` request needs no user header — proving the two global
  guards do not bleed across planes.
- **Case-bypass negatives use no-self-defense probes** (`/INTERNAL/ping`,
  `/ADMIN/probe`), so a guard bypass surfaces as a raw 200 rather than being masked by
  a self-throwing handler — mirroring the balance suite's choice.

## Known gaps (deliberate)

- **Real Mongo-down => 503 over the wire** is not asserted in the integration suite
  (tearing Mongo down mid-suite is flaky); the 503 readiness path is proven
  deterministically in `health.e2e-spec.ts` by faking the readiness repo.
- **Stream consumer / read-model / reporting aggregates (spec 05 DoD)** are NOT
  covered here — they are out of scope for the Step-3b *foundation* (which is the
  skeleton: config, guards, prefixes, error model, health). Those get their own
  money-safety-style suites (idempotent upsert, redelivery, consumer restart) when
  spec 05 is built.

## Escalations / assumptions (confirm with the developer)

1. **Error `code` vocabulary is asserted** (`UNAUTHORIZED`/`FORBIDDEN`/`NOT_FOUND`/
   `INTERNAL_ERROR`) against the coordination contract / `src/common/errors/
   error-response.ts`. If that mapping is deliberately non-contractual (free to
   change), loosen these back to a bare string check.
2. **Health body field names.** The contract fixes the *semantics* (200 liveness +
   Mongo-ping readiness; 503 on readiness failure) but not the JSON field names. The
   health suite asserts `liveness`/`readiness` and a `checks.{mongo|mongodb|db|
   database}` key, mirroring the balance template. If the implementor names these
   differently, adjust `mongoCheckOf` / the field asserts — the load-bearing assert
   is the 200-vs-503 status, which is unambiguous.
3. **Readiness port method.** The faked repo implements `checkConnection()` (the
   balance template's `IHealthRepository` shape). If analytics names the Mongo-ping
   method differently, update the fake in `health.e2e-spec.ts`.
4. **Correlation-id middleware placement.** The implementor wires
   `requestIdMiddleware` in `AppModule.configure()` (not `main.ts`-only), so the
   `requestId` guarantee holds whenever `AppModule` boots. The Docker-free e2e uses a
   minimal test module (not `AppModule`), so it applies the middleware explicitly via
   `app.use` to reproduce that guarantee; the integration suite boots the real
   `AppModule` (middleware applied automatically) and asserts only health, not the
   correlation id. No escalation — noted for context.
