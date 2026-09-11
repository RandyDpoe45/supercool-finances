# Full-run e2e — PUBLIC + ADMIN plane harness (Spec 08, step 8-C + Pass 2)

The reproducible **clean-machine** proof of the spec-08
[`Full run`](../../specs/08-build-and-serve.md) + **Definition of Done**: one command
brings the whole stack up all-healthy, loads the seed, drives the headline
**transfer-with-OTP** flow from the real client app (public plane), and proves the
**admin whoami landing** through the internal front door (admin plane, Pass 2).

It orchestrates the existing pieces — it does **not** re-implement them:

1. `docker compose up -d --build --wait` the **default graph** → **all-healthy** (DoD #1) —
   now including the internal edge (`internal-kong`, `internal-nginx`, `admin-app`).
2. `docker compose --profile seed run … seed` → demo data loaded, then **run again** and
   prove the counts are unchanged (DoD #4, idempotency).
3. **Public plane:** the demo-customer logs in through the **real** Keycloak → public-nginx
   → public-Kong → balance-service chain and the seeded account renders (DoD #3), then the
   **transfer-with-OTP** flow runs from `web/client`'s Playwright e2e: confirmation-of-payee
   → initiate (pending) → **code revealed via the real otp-app in a second browser context**
   → confirm → the source balance is debited by **exactly** the transfer amount (DoD #2,
   public half).
4. **Admin plane (Pass 2):** the admin SPA is served at **`:8081`**, a no-token
   `/balance/admin/whoami` is a **401 at Kong**, a **real demo-admin bearer** reaches
   `/balance/admin/whoami` → **200** with the `admin` role (black-box, through
   internal-nginx → internal-kong → balance-service), and the admin app's `login.e2e.ts`
   browser chain runs for real (PKCE at `:8081` → the whoami landing renders "Admin console").

The Playwright specs (`web/client/tests/e2e/**`, `web/otp/tests/e2e/**`,
`web/admin/tests/e2e/**`) are the **test-writer's artifact** and are **not** edited here.
This harness only supplies the env those specs read and the running stack.

> **Scope.** Public plane end to end **plus** the admin plane's build & serve + the whoami
> landing. Host-published: **`:8080`** (public-nginx), **`:8081`** (internal-nginx),
> **`:8082`** (keycloak).
>
> **Known gap (not proven here).** The **admin maker-checker reversal** e2e (the reversal UI
> is not built) and the admin **`/accounts` + `/limits`** screens (their `GET /admin/accounts`
> + `GET /admin/limits` reads do not exist yet). The admin browser chain runs **only**
> `login.e2e.ts` (the whoami landing), never `accounts.e2e.ts`.

## Layout

| File | Purpose |
|---|---|
| `run.sh` | Orchestrator: up → healthy → seed → browser-reach → public edge + e2e → admin edge + whoami + admin login e2e → teardown. |
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
  remove what it created. (A foreign stack already holding `:8080`/`:8081`/`:8082` makes
  bring-up **SKIP** with guidance — it is never clobbered.)
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
| **Admin edge sanity** | `GET :8081/healthz` → 200, `GET :8081/` → 200 the **admin** SPA index (title contains `Admin`, not the client/otp bundle), `GET /balance/admin/whoami` **no token** → **401 at Kong** — the admin `/` catch-all does not shadow the admin API, and the authenticated admin spine is wired. |
| **Admin whoami slice** | black-box (browser-independent): a **real demo-admin bearer** (PKCE via the `admin-app` client) → `GET /balance/admin/whoami` → **200** with `userId == token sub` and `roles` containing `admin` — the demo-admin login reaches balance-service through `internal-nginx → internal-kong`. **FAILs** on a 401/403 for a valid admin or a wrong echoed identity; **SKIPs** if a token can't be minted (no `*.localtest.me` DNS). |
| **Admin login e2e** | the admin-plane spine: the admin app's `login.e2e.ts` runs for real (E2E enabled, demo-admin creds, origin `:8081`) — PKCE login through internal-nginx/Kong and `GET /balance/admin/whoami` renders the gateway-resolved admin identity ("Admin console", role `admin`). A non-zero exit is a **real** serving/auth failure (or a test-code bug) → **FAIL**. `accounts.e2e.ts` is **not** run (its reads don't exist yet). |

### Why `external-transfer.e2e.ts` is not run here

That spec needs at least one **usable** external payee (past its cooling-off) to exist for
the customer. The spec-08 seed loads **only** the demo customers + their internal accounts
(§Demo dataset) — it does not enroll external payees — so running it would fail on seed
**shape**, not on a money-flow defect. The internal-transfer spec is the public-plane DoD
proof and exercises the identical OTP out-of-band chain.

## Deliberately out of scope (other spec-08 slices / later passes)

- **Build-and-serve** serving contract — public plane in `tests/build-serve`, admin plane in
  `tests/build-serve-admin` (router, port contract, catch-all-not-shadow, static self-up).
- **Seed** dataset exactness, sub-alignment, no-collateral, deep idempotency — `tests/seed`.
- **Kong auth** semantics (401/403/anti-spoof/rate-limit, both edges) — `tests/transport`.
- **Admin maker-checker reversal** e2e (reversal UI not built) and the admin
  **`/accounts` + `/limits`** screens (their reads don't exist yet) — later work.

## Skips you may see (never false passes)

- **Bring up SKIP** — no Docker daemon, offline/registry, or `:8080`/`:8081`/`:8082` already
  held by a foreign stack (stop it, then re-run).
- **Browser reachability SKIP** — `*.localtest.me` does not resolve to `127.0.0.1` on this
  host. Add `127.0.0.1 keycloak.localtest.me` to the hosts file and re-run.
- **Playwright prep SKIP** — Chromium could not be downloaded (offline).
- **Admin whoami slice SKIP** — a demo-admin token could not be minted headlessly (Keycloak
  unreachable / no `*.localtest.me` DNS); the admin `login.e2e.ts` still proves it if it runs.
