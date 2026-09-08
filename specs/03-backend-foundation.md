# Spec 03 — Backend Foundation (NestJS conventions)

**Purpose.** The shared skeleton both services are built on: workspace layout,
dependency injection, the repository/service interface pattern, entity models,
migrations, config, the identity guard, prefix routing, and testing. Getting this
right is what makes the two services' micro fall into place.

**Depends on.** [`00-architecture.md`](./00-architecture.md).

## Moving parts & conventions

- **Standalone projects (no shared code):** the two services are **separate,
  self-contained NestJS projects** in their own folders (`services/balance-service`,
  `services/analytics-server`) — **not** a shared workspace. Each carries its **own
  copy** of what it needs — the gateway/service identity guards, config loading, and
  the transaction **event contract** (types). The event contract is duplicated in
  both and **kept in sync via the spec**, which is the contract of record. This keeps
  each folder atomic (it could be its own repo); see `CLAUDE.md`
  ([ADR-16](../docs/DECISIONS.md#adr-16--self-contained-components-no-shared-code)).
- **Dependency injection:** components depend on **interfaces (injection tokens)**,
  never concretes. Repositories behind interfaces (`IAccountRepository`,
  `ILedgerRepository`, …); domain services behind interfaces. Concrete TypeORM/
  Mongo implementations are bound in the module. This is what lets us swap or mock
  in tests.
- **ORM & models:** **TypeORM** (default #1). Entities are the models; the balance
  service uses **migrations run on boot** (idempotent). TypeORM chosen for
  first-class `SELECT ... FOR UPDATE` / `SKIP LOCKED`, required by spec 04's
  transfers and relay.
- **Config:** `ConfigModule` with schema validation (zod/joi) — **fail fast** on a
  missing/invalid var at boot.
- **Identity guards (centralized):**
  - `/api` + `/admin`: read the gateway-injected `X-User-Id` / `X-Roles`; trust
    **only** those headers (never a body/query id). Reject if absent (means the
    request didn't come through Kong).
  - `/internal`: a service-identity guard (shared secret / mTLS), never a user JWT.
  - Guards are applied globally per prefix so an endpoint cannot skip them.
- **Prefix routing:** each app exposes `/api`, `/admin`, `/internal` modules
  consistent with the Kong allowlists (spec 06) and
  [ADR-12](../docs/DECISIONS.md#adr-12--endpoint-prefix-convention-as-the-exposure-contract).
- **Object-level authz helper:** a shared owner-scoped query/guard so ownership is
  enforced *in* the query, returning 404 on non-owned (spec 04).
- **Error model:** one consistent error DTO across services.
- **Health:** `/internal/health` (liveness + readiness) for compose healthchecks.
- **Testing:** follows the **Testing discipline** in `CLAUDE.md` and the
  **test-writer** agent's method (unit / integration / money-safety, from the spec,
  in each service's `tests/` folder). This spec doesn't restate conventions — each
  component spec's Definition of Done names the specific proofs it requires (e.g.
  spec 04's concurrency / idempotency / holds suites).

## Contracts / interfaces

- The **header contract** (`X-User-Id`, `X-Roles`) between Kong and the services.
- The **event contract** — defined **independently in each service** (producer in
  04, consumer in 05), kept in sync via the spec (no shared package).
- Repository/service interfaces that concrete stores implement.

## Definition of Done

- [ ] The workspace builds; both apps boot with config validation.
- [ ] A sample TypeORM migration runs on boot against the `balance` DB.
- [ ] The identity guard rejects a request lacking the gateway header, and accepts
      one carrying it.
- [ ] `/internal/health` responds and is used by the compose healthcheck.

## Open questions

- Validation lib: zod vs joi.

**Resolved:** no shared workspace — each service is a standalone project with no
shared code ([ADR-16](../docs/DECISIONS.md#adr-16--self-contained-components-no-shared-code)).
