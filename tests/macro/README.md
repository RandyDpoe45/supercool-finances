# Macro spine verification (Spec 00)

Verification suite for **Step 0 — the Docker Compose spine**: the five networks, the
three datastores (`postgres`, `redis`, `mongo`) coming up healthy, `.env.example`, and
the root `.gitignore`. It is the acceptance harness for the Definition of Done in
[`specs/00-architecture.md`](../../specs/00-architecture.md) §8.

The checks are written **from the spec**, not from the compose file: each asserts an
intended invariant and is designed to **fail on a real defect** (each one was proven
to fail against a deliberately-broken fixture — see "How this was validated").

> **Scope.** This step is only the spine. Keycloak, Kong, nginx and the app services
> are **not** tested here (they arrive in later steps). Postgres init SQL / multiple
> DBs / roles, Redis AUTH, and Mongo auth are **spec 01** and are not asserted here.

## Layout

| File | Purpose |
|---|---|
| `run.sh` | Orchestrator. Runs the static suite, then the runtime suite, then a summary. |
| `lib.sh` | All check functions + helpers (sourced by `run.sh`; never run directly). |
| `README.md` | This file. |

## Running

```bash
# from anywhere:
bash tests/macro/run.sh            # static checks, then runtime (default = "all")
bash tests/macro/run.sh static     # only the daemon-free checks (1-7)
bash tests/macro/run.sh runtime    # only the daemon checks (8-9)
```

- Written for **POSIX bash** (Git Bash on Windows). Not PowerShell.
- Exit code is **non-zero if any check FAILED**. **Skips never fail the run.**
- **Static** checks need the `docker` CLI (for `docker compose config`) but **not** the
  daemon. **Runtime** checks need the daemon; if it is down/absent they **SKIP with an
  explicit message** (never a false pass).
- Requires `python` (used to parse the resolved config / YAML / env — `jq` is not
  assumed). PyYAML is used when present for Check 2, with a block-style fallback.

### Non-destructive by design

- Config resolution copies `.env.example` to a **throwaway temp file** passed via
  `--env-file`; it never creates, overwrites or requires a real `.env`.
- The runtime suite runs under its own project name **`scfin-macro-test`** and tears
  down with `-v`, so it can only ever remove **its own** containers/volumes/networks.
- The spine pins `container_name` on the datastores. If a stack is already running
  those names (e.g. a live `docker compose up`), the runtime suite **skips** with a
  message and **never tears down a stack it did not create**. Run `docker compose down`
  first if you want the runtime checks to execute.

## What each check proves (mapped to the DoD)

### Static (no daemon)

| # | Check | Proves (spec 00) |
|---|---|---|
| 1 | `docker compose config` resolves using `.env.example` values | §8 "skeleton exists" — the file is valid and interpolates. |
| 2 | Exactly the five networks are declared (no missing, no extras) — parsed from the **raw** top-level `networks:` block | §8 "the five networks (§2)". |
| 3 | Each datastore is on `data` and on **no** `edge-*`/`app-*` network | §2 network membership; §8 "a datastore is unreachable from edge" (static half). |
| 4 | No datastore declares `ports:`; no service publishes a host port outside `{8080,8081,8082}` | §8 "Only `:8080/:8081/:8082` are host-published". |
| 5 | Every required `${VAR}` referenced in `docker-compose.yml` is documented in `.env.example` | §8 ".env.example documents every required variable". |
| 6 | `.gitignore` ignores `.env` but **not** `.env.example` (via `git check-ignore`) | Guards the repo's no-secrets-in-history rule (`CLAUDE.md`). |
| 7 | All three datastores define a `healthcheck` | Supports §8 "comes up healthy" and §5 (health conditions have something to gate on). |

**Why Check 2 parses raw YAML, not `docker compose config`.** `docker compose config`
**prunes** any network that no started service references. In Step 0 four of the five
networks (the edge/app planes) have no members yet, so the resolved config only shows
`data`. The DoD requires all five to be **declared**, so Check 2 reads the raw
top-level `networks:` block (PyYAML, or a block-style fallback).

### Runtime (need the Docker daemon)

| # | Check | Proves (spec 00) |
|---|---|---|
| 8 | `up -d` the three datastores; poll `docker inspect` health until all `healthy` (120s timeout); then tear down | §8 "comes up healthy". A datastore with no healthcheck reports `none` and fails the wait. |
| 9 | **Isolation, positive + negative control:** an ephemeral container on `data` **can** reach `postgres:5432` (`nc -z`, exit 0); one off `data` **cannot** (exit ≠ 0) | §8 "a datastore is unreachable from `edge`". The positive control proves the negative isn't a false pass. |

**Edge-network stand-in (Check 9).** `edge-public` has no members in Step 0, so Compose
does not create it at runtime. When the real `edge-public` network is absent, the
negative control uses a standalone **off-`data`** bridge as the edge stand-in — the
invariant proven is identical (a datastore is unreachable from any non-`data` network).
Once a later step puts a member on `edge-public`, the check automatically uses the real
network.

## Interpretations / assumptions (escalate if wrong)

- **Check 5 — "required" variable.** A variable is treated as *required* (must appear
  in `.env.example`) if **any** reference lacks an inline default (`${VAR}`,
  `${VAR:?…}`, `$VAR`). A variable that **always** carries an inline default
  (`${VAR:-…}`) is *optional* — reported as a `NOTE`, not a failure. This matches the
  DoD wording "documents every **required** variable". Escalate if the intent is that
  *every* referenced variable (defaults included) must be listed.
- **Check 4** tolerates `8080/8081/8082` appearing later (the reserved edge ports) so
  the check stays valid as the spine grows; in Step 0 nothing is published and it
  reports exactly that.

## How this was validated

- `bash -n` on both scripts (syntax).
- Every static check was driven against a **spec-compliant fixture** (all pass) and a
  set of **defect fixtures** (missing/extra network, datastore on `app-internal`,
  datastore publishing a port + a service on `:9999`, an undocumented required var, a
  `.gitignore` that also ignores `.env.example`, a datastore missing its healthcheck) —
  each defect made exactly its targeted check **fail**.
- The runtime suite (Checks 8 & 9) was driven end-to-end against a real-image fixture
  (`postgres:16-alpine` + `redis:7-alpine`): health polling reached `healthy`, and the
  isolation controls returned exit 0 (from `data`) / exit ≠ 0 (off `data`), with clean
  teardown.
