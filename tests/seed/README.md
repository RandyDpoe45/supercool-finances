# Seed data — verification (Spec 08, step 8-B)

Acceptance harness for the **seed data** slice of
[`specs/08-build-and-serve.md`](../../specs/08-build-and-serve.md) — the idempotent,
**`seed`-profile** one-shot tool (`tools/seed/`) that loads the demo customers +
accounts into the `balance` DB, aligned to the **pinned Keycloak subs** in
`tools/keycloak/realm-export.json`.

The checks are written **from the spec** (the *Seed data* section, its *Demo dataset*
contract, the *Sub alignment* developer ruling, and the DoD lines "Seed data is
present and Keycloak logins map to seeded customers" + "Re-running up is idempotent"),
**not** from the implementor's seed code. Each asserts an intended invariant and is
built to **fail on a real defect**. DB creds/coordinates are read from `.env.example`;
the demo dataset **values** are the spec contract and are pinned in `lib.sh`.

## The load-bearing link (sub alignment)

`customer.id` **is** the Keycloak `sub` and `account.owner_id` FKs to it. So a real
`demo-customer` login only resolves to the seeded customer if **Customer A's seeded
`customer.id` == the `demo-customer` user's pinned `id` in `realm-export.json`**. A
hardcoded-but-mismatched id breaks the whole demo — it is caught by **Check 3**
(static, against the pinned contract) and **R3** (runtime, against the actually-inserted
row and account FK).

## Layout

| File | Purpose |
|---|---|
| `run.sh` | Orchestrator. Static suite, then runtime suite, then a summary. |
| `lib.sh` | All check functions + helpers (sourced by `run.sh`; never run directly). |
| `README.md` | This file. |

## Running

```bash
bash tests/seed/run.sh            # static then runtime (default = "all")
bash tests/seed/run.sh static     # stack-free checks only (Checks 1-3)
bash tests/seed/run.sh runtime    # daemon checks only (baseline + R1-R5)
```

- Written for **POSIX bash** (Git Bash on Windows). Not PowerShell.
- Exit code is **non-zero if any check FAILED**. **Skips never fail the run.**
- **Static** checks need the `docker` CLI (`docker compose config`) + `python`, but
  **not** the daemon.
- **Runtime** checks need the Docker daemon. The suite is **self-contained**: under an
  isolated compose project (`-p scfin-seed-test`, env from `.env.example`) it brings up
  `postgres` + `redis`, **builds and boots `balance-service`** (`--no-deps`, so its
  TypeORM migrations run on boot and create the schema + migration-seeded system
  constants), then runs the seed **twice** (`docker compose --profile seed run --rm
  seed`), queries the DB via `psql`, and **tears everything down with `-v`**. Nothing it
  starts is host-published, so it does not collide with a running stack, and it **never
  tears down a stack it did not create**. The first `balance-service` build can take a
  few minutes.

## What each check proves (mapped to spec 08 "Seed data")

### Static (no daemon)

| # | Check | Proves / fails on |
|---|---|---|
| 1 | **Profile gating** — a `seed`-profile service is **absent** from the default `config` up graph, **present** under `--profile seed`, and host-publishes nothing | "a one-shot service under a compose `seed` profile … so the default `up` graph carries no … seed container". **FAILs** if the seed service is missing (step not done), un-gated (would run on a plain `up`), or publishes a port. |
| 2 | **Discrete creds** — the seed's resolved compose env uses the **balance role**, never the **bootstrap superuser** | "reaching Postgres with the same discrete creds as the service". **FAILs** if the seed is wired with the superuser password (least-privilege violation). A NOTE (not a fail) if the role can't be resolved from compose env. |
| 3 | **Pinned subs** — `realm-export.json` pins `demo-customer` = `1111…`, `demo-customer-2 … -10` = `c00000NN-…`, `demo-admin` = `2222…`, `demo-customer`'s email matches Customer #1, and Maria has **no** realm user | "Sub alignment": every login sub must be deterministic. **FAILs** on a missing/mismatched pinned id (any of the 10 logins) — the cheap half of the load-bearing link. |

### Runtime (Docker daemon)

| # | Check | Proves / fails on |
|---|---|---|
| Baseline | after migrations / **before** seed: MXN present, **2** clearing accounts, **1** global `user_limits`, **0** customers, **0** customer accounts | "System constants are seeded by boot MIGRATIONS, not by this step" — and makes the seed's effect attributable. |
| R1 | the demo dataset matches the spec **exactly**: all 11 customers (id/name/phone/email) — `demo-customer` #1, `demo-customer-2 … -10`, and Maria — each with **one** active MXN account (account_number, balance, `held`=0, spend counters 0, non-null `spent_*_date` = `CURRENT_DATE`), and exactly **11** customers / **11** customer accounts | DoD "Seed data is present". Fails on any wrong/missing field, a missing customer, or wrong cardinality. |
| R3 | **sub alignment** — for `demo-customer` and each `demo-customer-N`, the seeded `customer.id` **and** its account's `owner_id` both equal that user's pinned realm sub (and Maria's account has her synthetic owner, with no realm user) | DoD "Keycloak logins map to seeded customers". The load-bearing link, proven against the real rows for all 10 logins. |
| R4 | **no collateral** — after the seed, currency=**1** (MXN), clearing accounts=**2**, `user_limits`=**1** (no per-customer rows) | "The seed must NOT duplicate or touch these"; "Per-customer limit overrides … are NOT seeded". |
| R5 | **idempotency** — a second seed run **exits 0** (no unique-violation), customer/account counts are unchanged, **Customer A's `updated_at` is unchanged** (`ON CONFLICT DO NOTHING`, not `DO UPDATE`), and system constants are still untouched | DoD "Re-running up is idempotent (seed doesn't duplicate)". |

## Skips you may see (never false passes)

- **Static 1 FAILs / runtime SKIPs** until a `seed`-profile service exists — the expected
  "step-not-done" signal.
- **Runtime SKIP (all)** — no Docker daemon, or the seed image / balance-service image
  can't be built/pulled in this environment (offline/registry). A **real** build or seed
  defect **FAILs**; only environmental failures skip.

## Deliberately out of scope (covered elsewhere / not meaningfully testable here)

- **SPA serving / router / port contract** — `tests/build-serve`.
- **Kong auth semantics** and the **datastore privilege split** — `tests/transport`,
  `tests/storage`.
- **A live Keycloak login actually resolving to the seeded customer end-to-end** — that
  needs the full stack + a browser OIDC flow (the pending Playwright e2e, `E2E_ENABLED`).
  Here the alignment is proven structurally: the seeded id **equals** the pinned realm
  `sub` (Check 3 + R3), which is exactly the value Keycloak stamps into the token.
