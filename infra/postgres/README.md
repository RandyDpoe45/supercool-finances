# Postgres — storage provisioning (spec 01)

Single `postgres:16` instance on the `data` network only, never host-published.
It is the **source of truth** (ledger + outbox for the balance service) and also
hosts **Keycloak's** store, isolated by privilege rather than by convention.

## What the init script does

`init/10-databases-and-roles.sh` runs **once, on an empty data dir**, as the
bootstrap superuser (`POSTGRES_USER`). It is mounted read-only into
`/docker-entrypoint-initdb.d` (config as code — not baked into an image). It:

1. Creates two least-privilege **login roles**, one per service, with passwords
   read from the environment (`POSTGRES_BALANCE_*`, `POSTGRES_KEYCLOAK_*`).
2. Creates the `keycloak` database (the `balance` database is already created by
   the entrypoint from `POSTGRES_DB`) and makes each role the **owner** of its own
   database and of that database's `public` schema.
3. Enforces **database-per-service by CONNECT privilege** (see below).

Because init runs only on a fresh volume, the script is intentionally
non-idempotent. A `docker compose down` (without `-v`) keeps the volume, so the
script does not re-run and the provisioned state persists.

> **⚠️ Upgrading from step 0 — start from a fresh volume.** Init runs *only* on an
> empty data dir. If you already ran `docker compose up` at step 0, a `pg-data`
> volume exists holding only the `balance` database — no roles, no `keycloak`, no
> CONNECT isolation. A step-1 `up` over that stale volume **skips init entirely**,
> leaving the safety-critical isolation unprovisioned while the healthcheck still
> goes green. Before the first step-1 `up`, drop the stale volume:
> `docker compose down -v` (or `docker volume rm supercool-finances_pg-data`). A
> clean machine (`docker compose up` from zero) is unaffected.

## Ownership & isolation model (the safety-critical crux)

| Role (env)                | Owns database | Can `CONNECT` to        |
|---------------------------|---------------|-------------------------|
| `POSTGRES_BALANCE_USER`   | `balance`     | `balance` only          |
| `POSTGRES_KEYCLOAK_USER`  | `keycloak`    | `keycloak` only         |
| `POSTGRES_USER` (super)   | —             | any (bootstrap/init only)|

Postgres grants `CONNECT` to `PUBLIC` on every database by default, so isolation
is **not** automatic. The init script therefore:

```
REVOKE CONNECT ON DATABASE balance  FROM PUBLIC;
REVOKE CONNECT ON DATABASE keycloak FROM PUBLIC;
GRANT  CONNECT ON DATABASE balance  TO <balance role>;
GRANT  CONNECT ON DATABASE keycloak TO <keycloak role>;
```

The result: the **balance role cannot connect to `keycloak`** and the keycloak
role cannot connect to `balance`. This is the enforcement behind ADR-11's
database-per-service ownership — a compromised or misconfigured service cannot
reach the other's data at the connection level, before object permissions even
apply. The superuser bypasses these checks and is used for bootstrap/init only;
services connect as the least-privilege roles.

Schema DDL (tables, migrations) is **out of scope for this step** — spec 03/04
create the balance schema; Keycloak creates its own on first boot. The init
script only provisions the empty databases, roles, and privileges.

## Connection contract

No pre-assembled connection URL is published in the env. Each consumer composes its
own DSN from the discrete credentials + coordinates: the **balance** service from
`POSTGRES_BALANCE_USER`/`POSTGRES_BALANCE_PASSWORD` → `balance`, and **Keycloak**
from `POSTGRES_KEYCLOAK_USER`/`POSTGRES_KEYCLOAK_PASSWORD` → `keycloak`, both via the
in-network service name `postgres:5432`. Consumers arrive in steps 2-3. Keeping the
credential in one place (not also inside a URL string) is deliberate — see spec 01
§ Contracts.

## Verifying the split

```sh
# CAN: balance role into its own DB
docker compose exec -e PGPASSWORD="$POSTGRES_BALANCE_PASSWORD" postgres \
  psql -h 127.0.0.1 -U "$POSTGRES_BALANCE_USER" -d balance -c '\conninfo'

# CANNOT: balance role into keycloak (expect: permission denied for database)
docker compose exec -e PGPASSWORD="$POSTGRES_BALANCE_PASSWORD" postgres \
  psql -h 127.0.0.1 -U "$POSTGRES_BALANCE_USER" -d keycloak -c '\conninfo'
```
