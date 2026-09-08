# MongoDB — storage provisioning (spec 01)

Single `mongo:7` instance on the `data` network only, never host-published. It
holds the **analytics read model** (CQRS read side), owned by the analytics
server (ADR-11). No other service reaches it.

## Auth & app user

Setting `MONGO_INITDB_ROOT_USERNAME` / `MONGO_INITDB_ROOT_PASSWORD` turns on
authentication in the official image and creates the root (admin) user. The init
script `init/10-app-user.js` runs **once, on an empty data dir**, authenticated as
that root user, and creates an application user scoped to the read model only:

| User (env)                    | Scope                         |
|-------------------------------|-------------------------------|
| `MONGO_INITDB_ROOT_USERNAME`  | root (bootstrap/init only)    |
| `MONGO_APP_USER`              | `readWrite` on `analytics` ONLY |

The app user has no privileges on `admin` or any other database, so the analytics
server cannot read or write outside its own store. Credentials are read from the
container environment (`process.env`), injected by compose from the git-ignored
`.env`; nothing is hardcoded. The init dir is mounted read-only (config as code).

Because init runs only on a fresh volume, the script is non-idempotent by design;
`docker compose down` without `-v` keeps `mongo-data` and the provisioned state.

> **⚠️ Upgrading from step 0 — start from a fresh volume.** Init runs *only* on an
> empty data dir. A `mongo-data` volume left from a step-0 `docker compose up` has
> no `analytics` app user provisioned, and a step-1 `up` over it **skips init**
> while the healthcheck still goes green. Before the first step-1 `up`, drop the
> stale volume: `docker compose down -v` (or
> `docker volume rm supercool-finances_mongo-data`). A clean machine is unaffected.

## Healthcheck

`mongosh --eval "db.adminCommand('ping')"` — `ping` is on Mongo's pre-auth allowed
list, so the healthcheck stays valid with auth enabled (no credentials needed).

## Connection contract

`MONGO_URL` (app user → `analytics`, `authSource=analytics`) is documented in the
root `.env.example`. The analytics server consumes it in step 3; it uses the
in-network service name `mongo:27017`.

## Verifying auth is enforced

```sh
# DENIED: no credentials -> not authorized to list databases
docker compose exec mongo mongosh --quiet --eval 'db.adminCommand({listDatabases:1})'

# OK: app user can read/write its own database
docker compose exec mongo mongosh --quiet \
  "mongodb://$MONGO_APP_USER:$MONGO_APP_PASSWORD@127.0.0.1:27017/analytics?authSource=analytics" \
  --eval 'db.runCommand({ping:1})'
```
