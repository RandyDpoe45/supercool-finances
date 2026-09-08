# Spec 01 — Storage Layer (PostgreSQL, Redis, MongoDB)

**Purpose.** Provision the three datastores and fix their ownership. Postgres is
the source of truth; Redis is ephemeral (OTP + stream transport); Mongo holds the
derived read model.

**Depends on.** [`00-architecture.md`](./00-architecture.md).

## Moving parts & configuration

| Store | Image | Network | Volume | Owned by |
|---|---|---|---|---|
| PostgreSQL | `postgres:16` | `data` | `pg-data` | balance service (+ Keycloak DB) |
| Redis | `redis:7` | `data` | `redis-data` (optional) | balance service |
| MongoDB | `mongo:7` | `data` | `mongo-data` | analytics server |

- **Postgres** — one container, two databases via an init script
  (`/docker-entrypoint-initdb.d`): `balance` (ledger + outbox) and `keycloak`
  (Keycloak's store, per default #3). Create a least-privilege app role for the
  balance service (owns `balance` only) and a separate role for Keycloak. Password
  via Docker secret / git-ignored env. Healthcheck: `pg_isready`.
- **Redis** — key-spaces are namespaced: `otp:<txId>` for transaction codes
  (TTL-managed), stream key `events:transactions` for the outbox transport.
  Persistence optional (`appendonly` off is fine — OTP is disposable). Healthcheck:
  `redis-cli ping`. AUTH enabled.
- **MongoDB** — database `analytics`. Auth enabled (root + app user). Healthcheck:
  `mongosh --eval "db.adminCommand('ping')"`.

## Contracts / interfaces

- The storage layer surfaces **discrete credentials + fixed coordinates** per store
  (in-network service name, database name, user, password) via env — it does **not**
  publish pre-assembled connection strings. Each consuming service composes its own
  DSN from those parts in its config layer (NestJS `ConfigModule`, validated on
  boot). This keeps a credential in exactly one place, leaves the URL format to the
  consumer's driver (TypeORM DSN, JDBC URL, `redis://`, `mongodb://`), and avoids
  leaning on Compose `env_file` interpolation (which does not exist). Ownership map:
  - `balance` service → the balance role's creds for the `balance` DB on `postgres`.
  - `analytics` server → the app-user creds for `analytics` on `mongo`.
  - `balance` service → `redis` (authenticated by `requirepass`).
  - Keycloak → the keycloak role's creds for the `keycloak` DB on `postgres`.
- No service is handed another service's credentials, so no service can reach
  another's store. Database-per-service is enforced by role privileges (below), not
  just convention.

## Definition of Done

- [ ] All three containers reach healthy; none host-published.
- [ ] `balance` and `keycloak` databases exist; the app role can connect to
      `balance` and **cannot** connect to `keycloak`.
- [ ] `redis-cli ping` and Mongo `ping` succeed from within `data` only.
- [ ] Volumes persist data across `docker compose down && up` (no `-v`).

## Resolved

- **Redis persistence: ON (`appendonly`/AOF).** Overrides the earlier "off" default.
  Chosen for reliability of the outbox → Redis Stream transport: the relay marks an
  outbox row *published* right after `XADD`, so a wiped stream would drop in-flight
  events the relay will never re-publish, breaking the "never lost" guarantee
  (`../docs/ARCHITECTURE.md` §7). `redis-data` is therefore a load-bearing volume,
  not optional. OTP durability is a harmless side effect (codes remain TTL-bound).
- **Keycloak DB: shared Postgres instance, separate `keycloak` database** (default
  #3), decided at step 0. Isolation is enforced by **per-role privileges** (the
  balance app role cannot `CONNECT` to `keycloak`), not by convention.
