# Build Plan & Spec Index

The build plan for the SuperCool Finances prototype. Read this first; each numbered
spec is the buildable unit for one component.

## Methodology — top-down, macro → micro

We build from the **macro** (the architecture and its moving parts) down to the
**micro** (each component's internals). The governing heuristic:

> **If a piece of the micro doesn't fall into place, stop and revisit the macro
> from the top.** A correct macro makes the micro fall out with little friction;
> persistent friction in the small is a signal the design in the large is wrong.

So specs are written and locked **in order**. A later spec that can't satisfy an
earlier one is not worked around — it sends us back up to fix the earlier spec.

## Cross-cutting rules (apply to every spec)

1. **Compose is the spine.** A single `docker-compose.yml` exists from step 1 and
   **grows one service per step**. It is the macro artifact everything plugs into,
   not a final integration task.
2. **Nothing is host-published except the edges.** Only the two nginx ingresses
   (and Keycloak's browser-facing URL) bind host ports. Kong, the services, and
   all databases live on internal Docker networks, unpublished. See
   [`00-architecture.md`](./00-architecture.md).
3. **Reproducible from zero.** `docker-compose up` on a clean machine must reach a
   working demo: Keycloak realm imported from JSON, migrations run automatically,
   seed data loaded. No manual clicking.
4. **Every spec ends with a Definition of Done** — an observable acceptance check,
   so "does the micro fit?" is testable, not a matter of opinion.
5. **Time is UTC server-side; clients localize.** Every service **stores and serves
   time in UTC** (`timestamptz` = UTC instants; APIs emit ISO-8601 with a `Z`
   offset). All timezone handling — showing and accepting dates in **Mexico City
   time (IANA `America/Mexico_City`, UTC−6 with no DST since 2022)** — is a
   **client-app concern only**; no server component localizes, formats, or assumes a
   non-UTC zone.

## Spec template

Each spec follows this shape:

- **Purpose** — what this component is and the one job it does.
- **Depends on** — which specs/components must exist first.
- **Moving parts & configuration** — containers, images, config, env, volumes.
- **Contracts / interfaces** — what it exposes to and expects from others.
- **Definition of Done** — the acceptance check(s) that prove it works.
- **Open questions** — anything unresolved that may push back up to the macro.

## Build order & specs

| Step | Spec | Component | Depends on |
|---|---|---|---|
| 0 | [`00-architecture.md`](./00-architecture.md) | Macro: compose topology, networks, ports, startup order | — |
| 1 | [`01-storage.md`](./01-storage.md) | PostgreSQL, Redis, MongoDB | 00 |
| 2 | [`02-keycloak.md`](./02-keycloak.md) | Keycloak IdP + realm import | 01 |
| 3 | [`03-backend-foundation.md`](./03-backend-foundation.md) | NestJS workspace, DI, repos/services, ORM + migrations | 00 |
| 3 | [`04-balance-service.md`](./04-balance-service.md) | Ledger, transfers, limits, OTP module, outbox + relay | 01, 02, 03 |
| 3 | [`05-analytics-server.md`](./05-analytics-server.md) | Stream consumer, Mongo read model, reporting API | 01, 03 |
| 4 | [`06-transport.md`](./06-transport.md) | nginx ×2 + Kong ×2, allowlists, **vertical-slice checkpoint** | 02, 04, 05 |
| 5 | [`07-frontends.md`](./07-frontends.md) | client / otp / admin React SPAs | 04, 05, 06 |
| 6 | [`08-build-and-serve.md`](./08-build-and-serve.md) | Build pipelines, seed data, full run | all |

### The vertical-slice checkpoint (inside step 4)

After storage, Keycloak, the services, and transport are minimally up — **before**
building frontend or endpoint breadth — prove one end-to-end path:

> Browser obtains a real Keycloak token → calls `/api/...` on the public nginx →
> public Kong validates + injects identity → balance service reads Postgres →
> response returns.

This exercises the whole macro (auth, trust boundary, prefixes, networks) at its
cheapest-to-change moment. If it resists, we go back up the specs.

## Open decisions (resolve before/within the named spec)

- **Validation lib** (spec 03): zod vs joi.

**Resolved:** ORM = **TypeORM** (needs `SELECT ... FOR UPDATE` / `SKIP LOCKED`).
Components are **standalone with no shared code** — no backend workspace, no shared
frontend library; each folder is atomic and shared contracts are duplicated + kept
in sync via the spec (see `CLAUDE.md` / ADR-16).

## Reference

Design rationale lives in [`../docs/`](../docs/):
[ARCHITECTURE](../docs/ARCHITECTURE.md) ·
[DECISIONS](../docs/DECISIONS.md) ·
[THREAT-MODEL](../docs/THREAT-MODEL.md).
