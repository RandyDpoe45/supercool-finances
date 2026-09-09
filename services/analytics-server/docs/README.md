# Analytics Server — Foundation (spec 03)

The NestJS skeleton the CQRS read side (spec 05) is built on. This document
describes **only the foundation**: config + Mongo DSN composition, the DI/interface
pattern, the two identity guards, prefix routing (no `/api`), the error model,
request-id correlation, health, and the supply-chain posture. The stream consumer,
the Mongo read-model collections, and the reporting aggregates are **not** here —
they arrive in [spec 05](../../../specs/05-analytics-server.md).

This service is a **self-contained component** ([ADR-16](../../../docs/DECISIONS.md#adr-16--self-contained-components-no-shared-code)):
no cross-folder imports, no shared code. It carries its **own copy** of the guards,
config helpers, and error model — re-derived from the spec, not imported from the
balance service. It could be extracted to its own repo.

## Ownership & surface

- **Owns MongoDB** ([ADR-11](../../../docs/DECISIONS.md#adr-11--service-boundaries--data-ownership)):
  the analytics read model. It touches no other service's store.
- **`/admin` + `/internal` only — no `/api`.** Customers never query analytics
  ([ADR-12](../../../docs/DECISIONS.md#adr-12--endpoint-prefix-convention-as-the-exposure-contract)),
  so there is no customer plane and no gateway-identity `/api` surface.
- **Networks: `app-internal` + `data` only** (spec 00 §2). It sits on **no** public
  network, so the public plane cannot reach it even at L3 — consistent with having
  no `/api`.

## Layout

```
src/
├── main.ts                     # bootstrap: validate config → create app → middleware → listen
├── app.module.ts               # root module; binds global guards + exception filter
├── config/                     # zod env schema, typed AppConfig, Mongo DSN composition
├── database/                   # MongooseModule wired from the composed DSN
├── common/
│   ├── identity/               # gateway (/admin) + service-identity (/internal) guards
│   ├── errors/                 # error DTO + global exception filter
│   └── request-context/        # request-id correlation middleware
├── health/                     # IHealthRepository (token) + Mongo impl + controller
└── modules/{admin,internal}/   # per-prefix probe routes (foundation scaffolding); NO api/
```

## Configuration & DSN composition

The service defines its **own** env var names; docker-compose maps the root
**discrete credentials** into them. It **never** reads a pre-assembled `*_URL`
string and **composes its own** MongoDB DSN from the discrete parts (honoring the
discrete-credentials contract — see
[spec 01 § Contracts](../../../specs/01-storage.md)).

| Var | Meaning | Default |
|---|---|---|
| `NODE_ENV` | `development` \| `test` \| `production` | `development` |
| `PORT` | HTTP listen port (in-network only) | `3000` |
| `MONGO_HOST` / `MONGO_PORT` / `MONGO_DB` | Mongo coordinates (`analytics` DB) | port `27017` |
| `MONGO_USER` / `MONGO_PASSWORD` | least-privilege `analytics` app user | — |
| `MONGO_AUTH_SOURCE` | DB the app user authenticates against | `analytics` |
| `INTERNAL_SERVICE_TOKEN` | shared secret for the `/internal` guard | — |

- **Validation is zod, at boot, fail-fast.** `parseEnv` (`config/env.schema.ts`)
  validates and coerces `process.env`; any missing/invalid required var throws an
  aggregated message and the process **exits non-zero** before it listens.
- `buildConfig` (`config/configuration.ts`) composes the typed `AppConfig`,
  including the Mongo `dsn`
  (`mongodb://user:pass@host:port/db?authSource=…`), with credentials URL-encoded
  so reserved characters can't corrupt it.
- The config is exposed via DI under the `APP_CONFIG` token
  (`config/config.module.ts`, `@Global`); components inject the token, not a
  concrete config source.
- **Redis is intentionally absent.** The transaction-stream consumer is spec 05, so
  the foundation's required-config surface is Mongo-only — it never demands config
  it doesn't yet use.
- **Env sources.** In Docker the vars come from the compose `environment:` block.
  For a standalone run, copy `.env.example` → `.env`; `main.ts` calls Node's native
  `process.loadEnvFile()` on boot (and `node --env-file=.env` also works).

## Dependency injection — interfaces behind tokens

Components depend on **interfaces via injection tokens**, never concretes (so they
can be swapped/mocked). The foundation establishes the pattern minimally with the
readiness repository:

- `health/health-repository.interface.ts` — the `HEALTH_REPOSITORY` token +
  `IHealthRepository` interface.
- `health/health.repository.ts` — the concrete Mongo implementation (checks the
  mongoose connection `readyState` and issues an admin `ping` via the injected
  `Connection`), bound in `HealthModule`
  (`{ provide: HEALTH_REPOSITORY, useClass: HealthRepository }`).

Spec 05's read-model repositories follow the same shape (interface + token, Mongo
implementation bound in the module).

## Mongo connection (no migrations)

- `database/database.module.ts` wires `MongooseModule.forRootAsync`, building the
  connection `uri` from the injected `AppConfig` (the composed DSN). This is the
  root connection spec 05's collections register against
  (`MongooseModule.forFeature([...])`).
- **Mongo has no schema migrations** (unlike the balance service's TypeORM). The
  read model is created lazily on first write, so there is **no on-boot migration
  step** and no `migrationsRun` equivalent — the app boots straight to listening.

## Identity guards (bound globally per prefix)

Both guards are registered as `APP_GUARD` in `app.module.ts`, so **no endpoint can
skip them**. Each guard scopes itself to its own prefix and returns early for
others.

**Prefix matching is case-insensitive and fails closed.** Express routes
case-insensitively by default (`/INTERNAL/ping` reaches `InternalController`,
`/ADMIN/whoami` reaches `AdminController`), so the guards lowercase the first path
segment (`prefixSegment`) before matching — otherwise a mixed-case prefix would
slip past the check and answer with no credential. The service is the real boundary
here; it must hold even if the adapter is booted without `case sensitive routing`
or without `main.ts`.

- **Gateway identity guard** (`/admin` only) —
  [ADR-2](../../../docs/DECISIONS.md#adr-2--keycloak-idp--kong-pep)/[ADR-3](../../../docs/DECISIONS.md#adr-3--object-level-authorization-lives-in-the-service).
  Trusts **only** the Kong-injected `X-User-Id` (the token `sub`) and `X-Roles`
  headers — never a body/query id. Missing `X-User-Id` → **401** (the request
  didn't pass through the internal Kong). `/admin` **requires the `admin` role** in
  `X-Roles` → **403** otherwise. Exposes a typed `{ userId, roles }`
  (`@Identity()` decorator). There is **no** `/api` surface and, since the admin
  plane is role-based rather than ownership-based (ADR-3), **no owner-scoped
  anti-IDOR helper**.
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

Two route groups (no `/api`), each with a trivial guarded probe (foundation
scaffolding, clearly marked; replaced by real endpoints in spec 05):

| Route | Guard | Proves |
|---|---|---|
| `GET /admin/whoami` | gateway identity + `admin` role | admin-plane role gate |
| `GET /internal/ping` | service token | service-identity gate |
| `GET /internal/health` | **exempt** | readiness backs the compose healthcheck |

## Error model

One error DTO across every surface (`common/errors/error-response.ts`):

```json
{ "error": { "code": "STRING_CODE", "message": "human message", "requestId": "uuid" } }
```

- A global exception filter (`AllExceptionsFilter`, bound via `APP_FILTER`) renders
  it. HTTP status → stable `code`; **5xx messages are made generic** so internal
  details never leak (no stack, no Mongo driver error, no DSN — the real error is
  logged server-side with the request id).
- `requestId` is threaded by `request-id.middleware.ts`: it reuses an inbound
  `X-Request-Id` or mints a UUID, exposes it on the request for the filter, and
  echoes it back on the `X-Request-Id` response header. It is applied in
  **`AppModule.configure()`** (`.forRoutes('*')`), not in `main.ts`, so the
  correlation guarantee holds whenever the module is booted (including tests that
  create `AppModule` without `main.ts`).

## Health

`GET /internal/health` (`health/health.controller.ts`):

- **Liveness** is implicit — a response at all means the process is up.
- **Readiness** pings MongoDB via the injected `IHealthRepository` (connection
  `readyState` + admin `ping`).
- **200** when ready, **503** when not. Body distinguishes the two:
  `{ status, liveness, readiness, checks: { db } }`.
- Backs the compose healthcheck (a Node `fetch` probe that fails on non-200).

## Bootstrap order (`main.ts`)

1. Load a local `.env` if present (standalone), then **validate config (fail
   fast)** — exit non-zero on invalid env.
2. **Create the app** — the Mongo connection is established during module init.
   Global guards, the exception filter, and the request-id middleware are all bound
   in `AppModule`, so the module carries those guarantees on its own.
3. **Listen** on `PORT`.

## Supply-chain posture (`.npmrc`)

Hardened install policy (a project standard, identical to the balance service):

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
| `npm run start:prod` | `node dist/main.js` |
| `npm run lint` / `format` | eslint (flat config) / prettier |
| `npm test` / `test:e2e` | Jest unit / e2e (suites written by the test-writer, in `tests/`) |

## Docker

Multi-stage `Dockerfile` (build → slim runtime) on `node:24-alpine`, installs via
`npm ci` under the hardened `.npmrc`, runs as the non-root `node` user, and starts
with `node dist/main.js` (no migration step — Mongo has none). The compose service
joins `app-internal`, `data` only (never `app-public`, never host-published) and
depends on `mongo` + `keycloak` being healthy (spec 00 §5).
