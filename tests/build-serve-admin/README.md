# Build-and-serve — ADMIN-PLANE verification (Spec 08, Pass 2)

Acceptance harness for the **admin-plane build-and-serve** slice of
[`specs/08-build-and-serve.md`](../../specs/08-build-and-serve.md): the admin
(`admin-app`) SPA built as a **per-SPA atomic image** and served by `internal-nginx`
at `/` (**`:8081`**), while `internal-nginx` still routes `/balance/admin/` +
`/analytics/admin/` → `internal-kong`. The intended proof (Pass 2 scope note): a
**demo-admin Keycloak login at `:8081` reaches the real `/balance/admin/whoami`
surface** through `internal-nginx → internal-kong → balance-service`, and the whoami
identity is an `admin`.

The checks are written **from the spec**, not from the implementor's Dockerfile /
compose / nginx edits: each asserts an intended invariant and is built to **fail on a
real defect**. Host ports are read from `.env.example`; the admin index marker
(`<title>… Admin</title>`) comes from the committed `web/admin/index.html`, and the
demo-admin identity from the committed `tools/keycloak/realm-export.json` — never
invented.

> **Scope.** The admin plane's **build & serve** + the **whoami landing** reached
> end-to-end. The Kong **auth semantics** (403 role gate, anti-spoof, rate-limit) are
> owned by [`tests/transport`](../transport); the **admin maker-checker reversal** e2e
> is **not** in this step (the reversal UI is not built).

> **Known gap (not tested as working).** The admin app's **`/accounts` + `/limits`**
> screens call balance-service admin READ endpoints (`GET /admin/accounts`,
> `GET /admin/limits`) that **do not exist yet**. So the runtime checks target only the
> **whoami landing + SPA serving**; the deep-link check (R2) asserts the SPA **shell** is
> served (history fallback), never that accounts/limits **data** loads.

## Layout

| File | Purpose |
|---|---|
| `run.sh` | Orchestrator. Static suite, then runtime suite, then a summary. |
| `lib.sh` | All check functions + helpers, incl. the light self-up and the PKCE token mint (sourced by `run.sh`; never run directly). |
| `README.md` | This file. |

## Running

```bash
bash tests/build-serve-admin/run.sh            # static then runtime (default = "all")
bash tests/build-serve-admin/run.sh static     # stack-free checks only (Checks 1-4)
bash tests/build-serve-admin/run.sh runtime    # live-edge checks only (R1-R6)
```

- Written for **POSIX bash** (Git Bash on Windows). Not PowerShell.
- Exit code is **non-zero if any check FAILED**. **Skips never fail the run.**
- **Static** checks need the `docker` CLI (`docker compose config`) + `python`, but
  **not** the daemon or a running stack.
- **Runtime** checks need the internal edge reachable at
  `http://localhost:${INTERNAL_HTTP_PORT}` (=8081) and `curl`.

### Runtime bring-up (two ways)

1. **Bring the full stack up first** (required for the R4 whoami vertical slice — it
   needs `internal-kong` + `balance-service` + `keycloak` all up):
   ```bash
   cp .env.example .env          # first time only
   docker compose up -d --build  # internal-nginx, internal-kong, admin-app, balance, keycloak, …
   bash tests/build-serve-admin/run.sh runtime
   ```
2. **Let the suite self-up (light):** if the edge is **not** already reachable, the
   suite runs `docker compose up -d --build --no-deps internal-nginx admin-app` in an
   **isolated project** and tears it down afterward. That proves SPA serving (R1/R2/R5)
   and that the `/` catch-all does not shadow the admin API (`/balance/admin` → **502**,
   Kong absent — still *not* a SPA page). The **R4 whoami slice SKIPs** (the full
   internal chain is not up). Disable the self-up with `BUILD_SERVE_NO_SELFUP=1`.

All runtime probes are **read-only** GETs (`/`, `/accounts`, `/balance/admin/whoami`,
`/healthz`) — non-destructive; they move no money and mutate no state. The suite never
tears down a stack it did not create.

## What each check proves (mapped to spec 08 Pass 2)

### Static (no live stack)

| # | Check | Proves / fails on |
|---|---|---|
| 1 | `docker compose config` resolves **and** `admin-app` + `internal-nginx` + `internal-kong` are in the **default** up graph (no profile gate) | "Full run": the admin plane is wired into the spine. **FAILs** until the implementor adds the `admin-app` image / de-gates it. |
| 2 | **Port contract** — `internal-nginx` host-publishes **`:8081`** (the internal front door, published this pass); `admin-app` + `internal-kong` publish **nothing**; **no** default-graph port lands outside `{:8080, :8081, :8082}` | DoD "Only `:8080`, `:8081`, `:8082` are published", now fully realized in Pass 2. **FAILs** if the admin SPA / gateway is host-published, `:8081` is missing/mis-owned, or a stray port appears. |
| 3 | **SPA topology** — `admin-app` is on **`edge-internal` only** and host-publishes nothing | "Ports & origin": the SPA images join their edge network only and are not host-published — reachable solely via the router. |
| 4 | **nginx router** — `/balance/admin` **and** `/analytics/admin` still → `internal-kong`; root `/` no longer the spec-06 `return 404` placeholder and now targets `admin-app`; `/healthz` still 200 | internal-nginx router paragraph. Low-false-positive textual parse (robust to the variable-upstream `proxy_pass` pattern); **FAILs** on an admin API route removed/shadowed, the placeholder left in, or a dropped `/healthz`. |

### Runtime (internal edge reachable at `:${INTERNAL_HTTP_PORT}`)

| # | Check | Proves / fails on |
|---|---|---|
| R5 | `GET /healthz` → **200** | internal-nginx liveness — the front door is serving. |
| R1 | `GET /` → **200**, the **admin** SPA index (`<title>… Admin</title>`, `id="root"`) | "`/` → the `admin-app` image (served, not a placeholder)". Fails if `/` 404s (placeholder left / admin-app down) or is misrouted to the wrong bundle. |
| R2 | `GET /accounts` (deep link) → **200**, the admin index (**shell only**) | "Each SPA image owns its own `try_files … /index.html` history fallback" — a deep link survives a reload. Asserts the shell, **not** that the accounts screen's data loads (that endpoint does not exist yet). |
| R3 | no-token `GET /balance/admin/whoami` is **not** a **200 SPA index** — a **401** with the full internal edge (Kong), a **502** with the light self-up | The sharpest routing check: the `/` catch-all must **not** shadow `/balance/admin/*`. Catches a catch-all that swallows gateway traffic. |
| R4 | a **real demo-admin bearer** → `GET /balance/admin/whoami` → **200** with `userId == token sub` and `roles` containing `admin` | The Pass-2 **proof**: the demo-admin login reaches balance-service through `internal-nginx → internal-kong` (JWT verified, admin gate, `/balance` stripped, identity injected). **FAILs** on a **401/403** for a valid admin (the edge rejects an admin) or a wrong echoed identity. **SKIPs** on a light bring-up (502) or when a token can't be minted (offline / no `*.localtest.me` DNS). |
| R6 | the **admin** index's linked stylesheet loads **200**, carries **no literal `@tailwind`**, and embeds the theme accent `#1db954` | the admin-app Docker build actually **ran Tailwind/PostCSS**. Fails if the build stage omits `postcss.config.js`/`tailwind.config.js` and ships `index.css` unprocessed → the admin app renders **unstyled**. (The `css:false` vitest suites cannot catch this.) Runs against the light self-up too. |

### How "is this a SPA page?" is decided

Every served SPA index is a `200` HTML doc containing **`id="root"`** (the mount node);
the admin bundle is told apart by its **`<title>… Admin</title>`** (the client title is
exactly `SuperCool Finances`, the OTP one `SuperCool Finances — OTP` — neither contains
`Admin`). Gateway/API responses (JSON, Kong error pages) contain none of these. So a
`/balance/admin/whoami` response carrying `id="root"` means the catch-all shadowed the
API (R3/R4); a `/` response without the admin title means the root is misrouted (R1).

### How the R4 admin bearer is obtained

A **real** Authorization-Code + PKCE (S256) login for the seeded `demo-admin` user
(recovered from `realm-export.json`, `admin` realm role, non-temporary demo password) via
the `admin-app` public client — the same scripted flow the `tests/transport` suite uses.
No credential literal is baked into this harness; the token is minted headlessly only when
the host resolves `keycloak.localtest.me` → loopback and Keycloak is up, else R4 SKIPs.

## Skips you may see (never false passes)

- **Static 1-4 FAIL** until the `admin-app` image + `/`→admin-app router wiring land —
  the expected "step-not-done" signal (this suite was authored against the spec).
- **Runtime SKIP (all)** — the edge is not reachable and self-up is disabled/unavailable
  (offline, no daemon, or the admin services aren't wired yet): bring the stack up first.
- **R4 SKIP** — a **light** self-up (internal-kong/balance/keycloak absent), or a token
  could not be minted (offline / no `*.localtest.me` DNS). Bring the **full** stack up
  (`docker compose up`) to prove the whoami vertical slice.
