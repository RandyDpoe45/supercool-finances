# tools/seed — demo-data seed

Idempotent loader for the **demo customers and their accounts** into the balance
service's Postgres `balance` database, so a clean `docker compose up` demo has state
to work with. It is the seed step of **spec 08** (`specs/08-build-and-serve.md`,
§Seed data).

## What it is (and is not)

- **Atomic tool (ADR-16).** It imports **no** balance-service code. The balance
  schema it writes to is **duplicated here** (in `src/seed.js`) and kept in sync with
  the service **via the spec** — the spec is the contract of record. This is the
  accepted price of folder independence: the tool could be extracted to its own repo.
- **Seeds demo data only.** It inserts the two demo customers and one MXN account
  each. It does **not** insert or modify the **system constants** — the MXN `currency`
  row, the two clearing/system accounts (`clearing:rail-outbound`,
  `clearing:rail-inbound`), or any `user_limits` row. Those are seeded by the balance
  service's **boot migrations** and are out of this tool's scope.
- **Not in the default `up` graph.** It runs as a one-shot service behind the compose
  `seed` **profile**, invoked explicitly (see below).

## The dataset (spec 08 §Seed data)

| Customer | `customer.id` | name | phone | email | account_number | balance (minor units) |
|----------|---------------|------|-------|-------|----------------|-----------------------|
| A (login) | `11111111-1111-4111-8111-111111111111` | Demo Customer | 5510000001 | demo-customer@example.test | `1000000001` | `100000000` (1,000,000.00 MXN) |
| B (payee) | `b0000000-0000-4000-8000-000000000002` | Maria Gonzalez | 5520000002 | maria.gonzalez@example.test | `1000000002` | `50000000` (500,000.00 MXN) |

Each account is a **customer** account, **active**, currency **MXN**, with `held = 0`,
`spent_today = spent_month = 0`, and `spent_today_date = spent_month_date =
CURRENT_DATE` (the database's notion of "today", so the fixed-window spend counters
start fresh). `account.id` uses the DB default (`gen_random_uuid()`).

### Sub alignment

Customer A's `id` **is** the Keycloak `sub`: the `demo-customer` user carries a pinned
`id` (`11111111-…`) in `tools/keycloak/realm-export.json`, and the seed inserts the
customer row with that **same** id, so the token's `sub` lines up with
`account.owner_id`. Realm import is **first-boot only** — a clean `up --build` is
required to (re)align. Customer B has **no** Keycloak login (synthetic id); it exists
so the demo has a confirmation-of-payee transfer target.

## Idempotency

Re-running the seed changes nothing:

- customers: `INSERT … ON CONFLICT ("id") DO NOTHING`
- accounts: `INSERT … ON CONFLICT ("account_number") DO NOTHING`

Customers are inserted **before** accounts (FK `account.owner_id → customer.id`) inside
a single transaction. The tool logs, per row, whether it was **inserted** or **skipped**
(already present), then a one-line summary. It exits `0` on success and non-zero on a
real error (e.g. the schema is missing, or Postgres is unreachable after retries).

## Configuration

Discrete credentials only — the **same** variable names balance-service uses. The tool
composes its own connection internally; there is **no** `*_URL` connection-string var.

| Var | Meaning |
|-----|---------|
| `DB_HOST` | Postgres host (compose: `postgres`) |
| `DB_PORT` | Postgres port (compose: `5432`) |
| `DB_NAME` | database name (compose: `${POSTGRES_DB}` = `balance`) |
| `DB_USER` | balance app role (compose: `${POSTGRES_BALANCE_USER}`) |
| `DB_PASSWORD` | balance app role password (compose: `${POSTGRES_BALANCE_PASSWORD}`) |

No secrets live in this folder: compose maps the discrete creds from the root `.env`
(copied from `.env.example`).

## How to run

The `seed` service depends on `balance-service` being **healthy** — the balance service
runs the migrations on boot, so its health guarantees the schema (and the
migration-seeded system constants) exists first.

```sh
# 1. Bring the stack up (postgres -> keycloak -> balance-service runs migrations -> …).
docker compose up --build -d

# 2. Run the one-shot seed (profile-gated, so it is not in the default up graph).
docker compose --profile seed up

#    A second run is a no-op — every row reports "skipped".
docker compose --profile seed up
```

`docker compose --profile seed up` builds `tools/seed`, waits for `balance-service` to
be healthy, runs the seed to completion, and the container exits (`restart: "no"`).

## Supply-chain posture

Node `>= 24`, single runtime dependency (`pg`), pinned exact version with a committed
`package-lock.json`. The hardened `.npmrc` (ignore-scripts, save-exact, lockfile,
engine-strict) mirrors the repo posture; the image is a multi-stage build on the pinned
`node:24-alpine` base running as the non-root `node` user.
