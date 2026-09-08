# Storage-layer verification (Spec 01)

Verification suite for **Step 1 — the storage layer**: PostgreSQL's two databases
(`balance` + `keycloak`) and least-privilege roles, Redis AUTH + AOF persistence,
MongoDB auth + app user + the `analytics` db, and the **discrete-credentials env
contract** (the storage layer publishes discrete credentials + fixed coordinates,
**not** pre-assembled connection strings — each consumer composes its own DSN). It
is the acceptance harness for the Definition of Done in
[`specs/01-storage.md`](../../specs/01-storage.md).

Checks are written **from the spec**, not from the implementor's files: each asserts
an intended invariant and is designed to **fail on a real defect** (missing db,
privilege leak, auth disabled, wiped volume). Names come from the Step-1
coordination contract; where a value can legitimately vary it is **read from
`.env.example`** rather than hardcoded.

> **Scope.** Only the three datastores' real config. Keycloak / balance / analytics
> containers and the ledger/outbox schema are **not** part of this step and are not
> tested here. Network-level "data only" isolation is proven in
> [`tests/macro`](../macro/README.md) (Check 9); here we prove the **authenticated**
> pings work on `data`.

## Layout

| File | Purpose |
|---|---|
| `run.sh` | Orchestrator: static suite, then runtime suite, then a summary. |
| `lib.sh` | All check functions + helpers (sourced by `run.sh`; never run directly). |
| `README.md` | This file. |

## Running

```bash
# from anywhere:
bash tests/storage/run.sh            # static checks, then runtime (default = "all")
bash tests/storage/run.sh static     # only the daemon-free checks (1-4)
bash tests/storage/run.sh runtime    # only the daemon checks (5-9)
```

- Written for **POSIX bash** (Git Bash on Windows). Not PowerShell.
- Exit code is **non-zero if any check FAILED**. **Skips never fail the run.**
- **Static** checks need the `docker` CLI (for `docker compose config`) + `python`,
  but **not** the daemon. **Runtime** checks need the daemon; if it is down/absent
  they **SKIP with an explicit message** (skip is never a false pass).

### Non-destructive by design

- Config resolution copies `.env.example` to a **throwaway temp file** passed via
  `--env-file`; it never creates, overwrites, or requires a real `.env`.
- The runtime suite runs under its own project name **`scfin-storage-test`** and
  tears down with `-v`, so it can only ever remove **its own**
  containers/volumes/networks. The datastores set no `container_name`, so the
  project name fully namespaces them and the suite never touches another stack.
- Ephemeral client containers (`postgres:16`, `redis:7`, `mongo:7`) reuse the same
  images the stack already pulled, run with `--rm`, and are attached only to the
  test project's `data` network.

## What each check proves (mapped to the DoD)

### Static (docker CLI + python; no daemon)

| # | Check | Proves (spec 01) |
|---|---|---|
| 1 | Neither `postgres`, `redis`, nor `mongo` declares a host `ports:` mapping | DoD "none host-published" (static half). |
| 2 | **(a)** `.env.example` documents the **discrete creds/coordinates** each consumer composes its own DSN from — balance role (`POSTGRES_BALANCE_USER`/`_PASSWORD`) + the balance db name `POSTGRES_DB`=`balance`; keycloak role (`POSTGRES_KEYCLOAK_USER`/`_PASSWORD`); `REDIS_PASSWORD`; mongo app user (`MONGO_APP_USER`/`_PASSWORD`) + `MONGO_DB`=`analytics`. **(b)** the contract **invariant**: no tracked file (esp. `.env.example`) publishes a **pre-assembled connection string** — none of `POSTGRES_URL`/`KC_DB_URL`/`REDIS_URL`/`MONGO_URL` is defined, and no committed line embeds credentials in a DSN (`scheme://user:password@host`). | Rewritten Contracts section (discrete creds, not URLs; a credential lives in one place); supports database-per-service. |
| 3 | Every required `${VAR}` referenced in `docker-compose.yml` is documented in `.env.example` | The Step-1 env additions won't break a fresh clone (extends macro Check 5). |
| 4 | No placeholder secret **value** from `.env.example` appears in any other tracked file, and infra init scripts set passwords from `$ENV_VAR`, never a bare literal | `CLAUDE.md` no-secrets rule (a committed literal secret is a hard failure). |

### Runtime (need the Docker daemon)

| # | Check | Proves (spec 01) |
|---|---|---|
| 5 | `up -d` the three datastores; poll `docker inspect` health until all `healthy` (180s) | DoD "all three reach healthy". Because Redis AUTH and the mongo/postgres init all run through the healthchecks, a broken auth/init flips a container `unhealthy` and fails here. |
| 6 | Connect as superuser; assert both `balance` and `keycloak` rows exist in `pg_database` | DoD "`balance` and `keycloak` databases exist". |
| 7 | **Privilege split, positive + negative:** balance role **can** connect to `balance` and run `SELECT 1`; balance role is **denied** connecting to `keycloak`; keycloak role **can** connect to `keycloak`; keycloak role is **denied** connecting to `balance` | DoD (safety-critical) "app role can connect to `balance` and **cannot** connect to `keycloak`" + "database-per-service enforced by role privileges". The positive control proves the denial is a *privilege* denial, not a bad password. |
| 8 | Redis authenticated `ping`→`PONG`; **unauthenticated** `ping`→`NOAUTH` (denied). Mongo authenticated ping ok; **unauthenticated** `listDatabases` denied; app user authenticates to `analytics` | DoD "`redis-cli ping` and Mongo `ping` succeed from within `data`" + the auth-is-real control (unauth denied — otherwise "auth enabled" is unproven). |
| 9 | Redis `appendonly=yes` (Resolved AOF decision); write a marker into each store, `docker compose down` **without `-v`**, `up` again, assert all three markers survived | DoD "volumes persist data across `down && up` (no `-v`)". The Redis key surviving specifically exercises the **AOF** load-bearing volume. |

## Interpretations / assumptions (escalate if wrong)

- **Names.** Assertions use the exact Step-1 coordination-contract names
  (`POSTGRES_BALANCE_USER`, `POSTGRES_KEYCLOAK_USER`, `REDIS_PASSWORD`,
  `MONGO_INITDB_ROOT_USERNAME`/`_PASSWORD`, `MONGO_APP_USER`/`_PASSWORD`,
  `MONGO_DB`). Connection strings are **not** among them: the storage layer publishes
  discrete creds + fixed coordinates and each consumer composes its own DSN at its own
  step, so Check 2 asserts the *absence* of the (removed) `POSTGRES_URL`/`KC_DB_URL`/
  `REDIS_URL`/`MONGO_URL` vars rather than their contents. Runtime credentials are
  **read from `.env.example`** so a rename is picked up there; the `keycloak` database
  name is treated as the literal `keycloak` and the `balance` database name is read
  from `POSTGRES_DB` (default `balance`). If the implementor's names differ, that is a
  coordination defect — Check 2 flags the undocumented discrete cred/coordinate and the
  runtime checks report the missing var explicitly.
- **Check 2(b) DSN shape.** The invariant flags a `scheme://user:password@host` line
  with **literal** credentials — the duplicated-secret pattern that was removed. A DSN
  whose credentials are env-var references (`mongodb://$USER:$PW@host`, as shown in the
  infra docs) is the *consumer-composes* pattern and is intentionally **not** flagged;
  the scan excludes `$`/`{`/`%` from the credential characters. The `tests/` tree is
  excluded from the tracked-file scan because it carries the detection regex itself.
- **Check 7 reverse leak.** The spec's DoD names only balance→keycloak. This suite
  additionally asserts keycloak→balance is denied, because "database-per-service
  enforced by role privileges" implies both directions. Escalate if only the
  one-way guarantee is intended.
- **Check 8 mongo app authSource.** The app user is assumed created **in** the
  `analytics` db (standard `MONGO_INITDB_DATABASE` init). The helper tries
  `authSource=analytics` first and falls back to `authSource=admin`, so either
  placement passes.
- **Check 9 AOF nuance.** A graceful `compose down` lets Redis also snapshot (RDB),
  so the surviving key proves *volume persistence*; the explicit `appendonly=yes`
  assertion is what proves the **AOF** Resolved decision independently.

## How this was validated

- `bash -n` on both scripts (syntax).
- Static checks were run against the current repo and against deliberately-broken
  fixtures (a datastore publishing a port, a missing discrete cred/coordinate, a
  reintroduced `POSTGRES_URL=` var, a committed `scheme://user:password@host` DSN with
  a literal secret, a placeholder password embedded in an init script) — each defect
  made exactly its targeted check **fail**; see the delivery report.
- Runtime checks require the Step-1 compose/init to exist; against the current
  Step-0 skeleton (no AUTH/roles/keycloak db yet) they **fail as intended**, which
  is the point — they pass only once the storage layer is actually delivered.
