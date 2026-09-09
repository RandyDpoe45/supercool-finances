# Balance Service — Foundation (spec 03)

The shared NestJS skeleton the money domain (spec 04) is built on. This document
describes **only the foundation**: config + DSN composition, the DI/interface
pattern, the two identity guards, prefix routing, the error model, migrations on
boot, and the supply-chain posture. The ledger/transfers/OTP/relay domain arrives in
[spec 04](../../../specs/04-balance-service.md); its **persistence layer** (the
Postgres schema — tables, enum types, constraints, indexes) is documented separately
in [`persistence.md`](./persistence.md).

This service is a **self-contained component** ([ADR-16](../../../docs/DECISIONS.md#adr-16--self-contained-components-no-shared-code)):
no cross-folder imports, no shared code. It could be extracted to its own repo.

## Layout

```
src/
├── main.ts                     # bootstrap: validate config → create app → middleware → listen
├── app.module.ts               # root module; binds global guards + exception filter
├── config/                     # zod env schema, typed AppConfig, DSN/URL composition
├── database/                   # TypeORM options, entity, migration, CLI data-source
├── common/
│   ├── identity/               # gateway + service-identity guards, typed identity
│   ├── authz/                  # owner-scoped (anti-IDOR) helper — pattern for spec 04
│   ├── errors/                 # error DTO + global exception filter
│   └── request-context/        # request-id correlation middleware
├── health/                     # IHealthRepository (token) + TypeORM impl + controller
└── modules/{api,admin,internal}/  # per-prefix probe routes (foundation scaffolding)
```

## Configuration & DSN composition

The service defines its **own** env var names; docker-compose maps the root
**discrete credentials** into them. It **never** reads a pre-assembled `*_URL`
string and **composes its own** Postgres DSN and Redis URL from the discrete parts
(honoring the discrete-credentials contract — see
[spec 01 § Contracts](../../../specs/01-storage.md) and `tests/storage` Check 2).

| Var | Meaning | Default |
|---|---|---|
| `NODE_ENV` | `development` \| `test` \| `production` | `development` |
| `PORT` | HTTP listen port (in-network only) | `3000` |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | Postgres (`balance` DB, balance role) | port `5432` |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | Redis (used from spec 04) | port `6379` |
| `INTERNAL_SERVICE_TOKEN` | shared secret for the `/internal` guard | — |

- **Validation is zod, at boot, fail-fast.** `parseEnv` (`config/env.schema.ts`)
  validates and coerces `process.env`; any missing/invalid required var throws an
  aggregated message and the process **exits non-zero** before it listens.
- `buildConfig` (`config/configuration.ts`) composes the typed `AppConfig`,
  including the Postgres `dsn` (`postgres://…`) and the Redis `url` (`redis://…`),
  with credentials URL-encoded so reserved characters can't corrupt them.
- The config is exposed via DI under the `APP_CONFIG` token
  (`config/config.module.ts`, `@Global`); components inject the token, not a
  concrete config source.
- **Env sources.** In Docker the vars come from the compose `environment:` block.
  For a standalone run, copy `.env.example` → `.env`; `main.ts` calls Node's native
  `process.loadEnvFile()` on boot (and `node --env-file=.env` also works).

## Dependency injection — interfaces behind tokens

Components depend on **interfaces via injection tokens**, never concretes (so they
can be swapped/mocked). The foundation establishes the pattern minimally with the
readiness repository:

- `health/health-repository.interface.ts` — the `HEALTH_REPOSITORY` token +
  `IHealthRepository` interface.
- `health/health.repository.ts` — the concrete TypeORM implementation
  (`SELECT 1` via the injected `DataSource`), bound in `HealthModule`
  (`{ provide: HEALTH_REPOSITORY, useClass: HealthRepository }`).

Spec 04's repositories (`IAccountRepository`, `ILedgerRepository`, …) follow the
same shape.

## Migrations on boot

- TypeORM is configured (`database/data-source.options.ts`) with
  **`synchronize: false` always** and **`migrationsRun: true`**, so pending
  migrations run (idempotently) during `DataSource` init — i.e. **before** the HTTP
  server starts listening. This is how `start:prod` (and the Docker `CMD`)
  "run migrations then boot" with a single `node dist/main.js`.
- Entities and migrations are referenced **by class**, not by filesystem glob, so
  the same list works under ts-node (dev) and compiled JS (prod).
- The sample migration `CreateAppMetadata1725000000000` creates `app_metadata` and
  seeds a `schema_version` row — just enough to prove the pipeline runs against the
  `balance` DB.
- The domain schema starts with `CreateBalanceCore1788825600000` (the spec-04 money
  spine: `currency`, `account`, `external_payee`, `transaction`, `ledger_entry` + their
  native enum types) — see [`persistence.md`](./persistence.md).
- `database/data-source.ts` is a **CLI-only** entry (`migration:generate/run/revert`
  scripts). It has an import-time side effect and must never be imported by the app
  module graph.

## Identity guards (bound globally per prefix)

Both guards are registered as `APP_GUARD` in `app.module.ts`, so **no endpoint can
skip them**. Each guard scopes itself to its own prefix and returns early for
others.

**Prefix matching is case-insensitive and fails closed.** Express routes
case-insensitively by default (`/INTERNAL/ping` reaches `InternalController`), so
the guards lowercase the first path segment (`prefixSegment`) before matching —
otherwise a mixed-case prefix would slip past the check and answer with no
credential. The service is the real boundary here; it must hold even if the adapter
is booted without `case sensitive routing` or without `main.ts`.

- **Gateway identity guard** (`/api`, `/admin`) —
  [ADR-2](../../../docs/DECISIONS.md#adr-2--keycloak-idp--kong-pep)/[ADR-3](../../../docs/DECISIONS.md#adr-3--object-level-authorization-lives-in-the-service).
  Trusts **only** the Kong-injected `X-User-Id` (the token `sub`) and `X-Roles`
  headers — never a body/query id. Missing `X-User-Id` → **401** (the request
  didn't pass through Kong). `/admin` additionally requires the `admin` role in
  `X-Roles` → **403** otherwise. Exposes a typed `{ userId, roles }`
  (`@Identity()` decorator).
- **Service-identity guard** (`/internal`) —
  [ADR-12](../../../docs/DECISIONS.md#adr-12--endpoint-prefix-convention-as-the-exposure-contract).
  `/internal` is routed by **no gateway**; as defense in depth the service still
  requires `X-Service-Token == INTERNAL_SERVICE_TOKEN` (constant-time compare),
  never a user JWT → **401** otherwise.
  - **Health carve-out (documented):** `GET /internal/health` is **exempt** so the
    Docker healthcheck can reach liveness/readiness **without credentials**. The
    carve-out is case-insensitive but **exact** (`/internal/health-and-secrets`
    stays guarded), so it can't be widened into a prefix bypass.

## Prefix routing (ADR-12)

Three route groups, each with a trivial guarded probe (foundation scaffolding,
clearly marked; replaced by real endpoints in spec 04):

| Route | Guard | Proves |
|---|---|---|
| `GET /api/whoami` | gateway identity | customer-plane header accepted/rejected |
| `GET /admin/whoami` | gateway identity + `admin` role | admin-plane role gate |
| `GET /internal/ping` | service token | service-identity gate |
| `GET /internal/health` | **exempt** | readiness backs the compose healthcheck |

## Object-level authorization helper (anti-IDOR)

`common/authz/owner-scoped.ts` — `findOwnedOrFail` enforces ownership **inside the
query** (`… AND owner_id = :sub`) and returns **404** (not 403) on a non-owned/absent
row, to avoid enumeration leaks
([ADR-3](../../../docs/DECISIONS.md#adr-3--object-level-authorization-lives-in-the-service)).
It establishes the pattern for spec 04 and is intentionally **not yet wired** to a
domain endpoint (no domain entities exist yet).

## Error model

One error DTO across every surface (`common/errors/error-response.ts`):

```json
{ "error": { "code": "STRING_CODE", "message": "human message", "requestId": "uuid" } }
```

- A global exception filter (`AllExceptionsFilter`, bound via `APP_FILTER`) renders
  it. HTTP status → stable `code`; **5xx messages are made generic** so internal
  details never leak (the real error is logged server-side with the request id).
- `requestId` is threaded by `request-id.middleware.ts`: it reuses an inbound
  `X-Request-Id` or mints a UUID, exposes it on the request for the filter, and
  echoes it back on the `X-Request-Id` response header. It is applied in
  **`AppModule.configure()`** (`.forRoutes('*')`), not in `main.ts`, so the
  correlation guarantee holds whenever the module is booted (including tests that
  create `AppModule` without `main.ts`).

## Health

`GET /internal/health` (`health/health.controller.ts`):

- **Liveness** is implicit — a response at all means the process is up.
- **Readiness** pings Postgres via the injected `IHealthRepository`.
- **200** when ready, **503** when not. Body distinguishes the two:
  `{ status, liveness, readiness, checks: { db } }`.
- Backs the compose healthcheck (a Node `fetch` probe that fails on non-200).

## Bootstrap order (`main.ts`)

1. Load a local `.env` if present (standalone), then **validate config (fail
   fast)** — exit non-zero on invalid env.
2. **Create the app** — TypeORM runs pending migrations on boot. Global guards, the
   exception filter, and the request-id middleware are all bound in `AppModule`, so
   the module carries those guarantees on its own.
3. **Listen** on `PORT`.

## Supply-chain posture (`.npmrc`)

Hardened install policy:

| Setting | Effect |
|---|---|
| `save-exact=true` | pin exact resolved versions (no `^`/`~`) |
| `package-lock=true` | maintain `package-lock.json`; `npm ci` installs from it |
| `legacy-peer-deps=false` | surface real peer conflicts, don't paper over them |
| `engine-strict=true` | enforce `engines` (node ≥ 24) at install |
| `ignore-scripts=true` | never run dependency lifecycle scripts |
| `minimum-release-age=10080` | don't adopt releases newer than **7 days** |

**Note on `minimum-release-age`:** current npm (11.x) does **not** natively enforce
this key — it treats it as unknown config and only warns. It is set to declare
intent and to be honored automatically once npm/an installer supports it. Until
then the policy is upheld by **pinning exact, mature versions** in `package.json`
(all comfortably older than 7 days). If a fresh transitive dep is ever blocked once
the key is enforced, pick a slightly older mature exact version — never weaken the
policy.

## Scripts

| Script | Purpose |
|---|---|
| `npm run build` | `nest build` → `dist/` |
| `npm start` / `start:dev` | run (watch) |
| `npm run start:prod` | `node dist/main.js` (migrations run on boot) |
| `npm run lint` / `format` | eslint (flat config) / prettier |
| `npm test` / `test:e2e` | Jest unit / e2e (suites written by the test-writer, in `tests/`) |
| `npm run migration:generate/run/revert` | TypeORM CLI (dev) via `src/database/data-source.ts` |

## Docker

Multi-stage `Dockerfile` (build → slim runtime) on `node:24-alpine`, installs via
`npm ci` under the hardened `.npmrc`, runs as the non-root `node` user, and starts
with `node dist/main.js` (migrations-then-listen). The compose service joins
`app-public`, `app-internal`, `data` (never host-published) and depends on
`postgres` + `keycloak` being healthy (spec 00 §5).
