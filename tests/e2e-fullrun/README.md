# Full-run + transfer-with-OTP e2e — PUBLIC-PLANE harness (Spec 08, step 8-C)

The reproducible **clean-machine** proof of the spec-08
[`Full run`](../../specs/08-build-and-serve.md) + **Definition of Done** for the
**public plane**: one command brings the whole stack up all-healthy, loads the seed,
and drives the headline **transfer-with-OTP** flow end to end from the real client app.

It orchestrates the existing pieces — it does **not** re-implement them:

1. `docker compose up -d --build --wait` the **default graph** → **all-healthy** (DoD #1).
2. `docker compose --profile seed run … seed` → demo data loaded, then **run again** and
   prove the counts are unchanged (DoD #4, idempotency).
3. The demo-customer logs in through the **real** Keycloak → public-nginx → public-Kong
   (JWT verify + identity inject) → balance-service chain and the seeded account renders
   (DoD #3), then the **transfer-with-OTP** flow runs from `web/client`'s Playwright e2e:
   confirmation-of-payee → initiate (pending) → **code revealed via the real otp-app in a
   second browser context** → confirm → the source balance is debited by **exactly** the
   transfer amount (DoD #2, public half).

The Playwright specs (`web/client/tests/e2e/**`, `web/otp/tests/e2e/**`) are the
**test-writer's artifact** and are **not** edited here. This harness only supplies the
**seed-aligned env** those specs read (`tests/e2e/fixtures/env.ts`) and the running stack.

> **Scope (spec 08 scope note — public plane only).** The admin plane is deferred: the
> admin SPA, the internal front door **`:8081`**, and the **admin maker-checker reversal**
> e2e are **not** exercised here. Only **`:8080`** (public-nginx) and **`:8082`**
> (keycloak) are host-published.

## Layout

| File | Purpose |
|---|---|
| `run.sh` | Orchestrator: up → healthy → seed → browser-reach → edge sanity → Chromium → e2e → teardown. |
| `lib.sh` | All phases + helpers (sourced by `run.sh`; never run directly). |
| `README.md` | This file. |

## Running

```bash
bash tests/e2e-fullrun/run.sh          # full run; tears the stack down at the end
bash tests/e2e-fullrun/run.sh keep     # full run; leaves the stack UP for inspection
bash tests/e2e-fullrun/run.sh down     # tear down this harness's isolated project
```

- Written for **POSIX bash** (Git Bash / MSYS on Windows). Not PowerShell.
- Exit code is **non-zero if any check FAILED**. **Skips never fail the run.**
- Needs the **Docker daemon**, **node/npm/npx** (≥ 24), **curl**, and **python**.
- Uses an **isolated compose project** (`scfin-e2e-fullrun`) and an `--env-file` temp copy
  of `.env.example`, so it **never touches your real `.env`** and a teardown can only
  remove what it created. (A foreign stack already holding `:8080`/`:8082` makes bring-up
  **SKIP** with guidance — it is never clobbered.)
- The hardened `.npmrc` sets `ignore-scripts=true`, so the harness installs the browser
  explicitly (`npx playwright install chromium`) after `npm ci` — the post-install
  auto-download is deliberately skipped by the repo.

## The seed ↔ e2e contract (what the harness feeds the specs)

The specs read everything infrastructure-specific from the environment; the harness sets:

| Var | Value it sets | Why |
|---|---|---|
| `E2E_ENABLED` | `1` | Flips the suites from `describe.fixme` to live. |
| `E2E_BASE_URL` | `http://localhost:8080` | The public front door (the spec default; shown for clarity). |
| `E2E_USERNAME` / `E2E_PASSWORD` | **read from `tools/keycloak/realm-export.json`** | The `demo-customer` login — the project's existing demo credential; **no new secret** is introduced. |
| `E2E_DEST_ACCOUNT` | `1000000002` | Customer B's **seeded** account. The spec-07 baked default `2000000001` does **not** match our seed, so this override is the load-bearing glue. |
| `E2E_TRANSFER_MAJOR` / `E2E_TRANSFER_MINOR` | *(defaults 10.00 / 1000)* | Customer A is funded with 1,000,000.00 MXN, so the default 10.00 transfer is well within balance. |

## What each phase proves (mapped to spec 08)

| Phase | Proves / fails on |
|---|---|
| **Preflight** | docker daemon + node/npx + curl + python present — else **SKIP** (never a false pass). |
| **Bring up** | `up -d --build --wait` on the default graph reaches **all-healthy** with no manual steps (DoD #1). A real build/boot/health defect **FAILs**; offline/registry/daemon or a host-port conflict **SKIPs**. |
| **All-healthy** | each default-graph service reports `healthy` (explicit evidence behind `--wait`). |
| **Seed** | `--profile seed run … seed` exits 0 and loads the demo customers/accounts; a **second** run exits 0 with **unchanged** counts (DoD #4, idempotent). |
| **Browser reachability** | Keycloak OIDC discovery at `http://keycloak.localtest.me:8082/realms/supercool` → 200 — i.e. `*.localtest.me` resolves to `127.0.0.1` so the browser can complete the login redirect. If not, the e2e is **SKIPPED** with hosts-file guidance (environmental, not a defect). |
| **Public edge sanity** | `GET /healthz` → 200, `GET /` → 200 (client SPA), `GET /balance/api/accounts` **no token** → **401 at Kong** — the authenticated spine the e2e needs. |
| **Playwright prep** | `web/client` deps installed + **Chromium** installed (explicit, because `ignore-scripts`). Offline **SKIPs**. |
| **Transfer-with-OTP e2e** | the headline **DoD #2 (public half)**: `internal-transfer.e2e.ts` drives the full chain (client → real otp-app reveal → confirm → exact debit) and `login.e2e.ts` proves the seeded account renders (DoD #3). A non-zero exit is a **real** serving/transfer failure (or a test-code bug) → **FAIL**. |

### Why `external-transfer.e2e.ts` is not run here

That spec needs at least one **usable** external payee (past its cooling-off) to exist for
the customer. The spec-08 seed loads **only** the demo customers + their internal accounts
(§Demo dataset) — it does not enroll external payees — so running it would fail on seed
**shape**, not on a money-flow defect. The internal-transfer spec is the public-plane DoD
proof and exercises the identical OTP out-of-band chain.

## Deliberately out of scope (other spec-08 slices / later passes)

- **Build-and-serve** serving contract (router, `/otp/` base, port contract) — `tests/build-serve`.
- **Seed** dataset exactness, sub-alignment, no-collateral, deep idempotency — `tests/seed`.
- **Kong auth** semantics (401/403/anti-spoof/rate-limit) — `tests/transport`.
- **Admin plane** — the admin SPA, `internal-nginx` (`:8081`), and the admin maker-checker
  reversal e2e are **deferred** (spec 08 scope note).

## Skips you may see (never false passes)

- **Bring up SKIP** — no Docker daemon, offline/registry, or `:8080`/`:8082` already held
  by a foreign stack (stop it, then re-run).
- **Browser reachability SKIP** — `*.localtest.me` does not resolve to `127.0.0.1` on this
  host. Add `127.0.0.1 keycloak.localtest.me` to the hosts file and re-run.
- **Playwright prep SKIP** — Chromium could not be downloaded (offline).
