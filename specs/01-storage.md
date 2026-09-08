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

- Connection strings surfaced to services via env only (no service reaches
  another's store): `POSTGRES_URL` → balance; `REDIS_URL` → balance;
  `MONGO_URL` → analytics; `KC_DB_URL` → Keycloak.
- Database-per-service is enforced by role privileges, not just convention.

## Definition of Done

- [ ] All three containers reach healthy; none host-published.
- [ ] `balance` and `keycloak` databases exist; the app role can connect to
      `balance` and **cannot** connect to `keycloak`.
- [ ] `redis-cli ping` and Mongo `ping` succeed from within `data` only.
- [ ] Volumes persist data across `docker compose down && up` (no `-v`).

## Open questions

- Redis persistence on/off for the demo (default: off).
- Keep Keycloak in the same Postgres (default #3) vs its own container.
