# Build-and-serve — PUBLIC-PLANE verification (Spec 08, step 8-A)

Acceptance harness for the **public-plane build-and-serve** slice of
[`specs/08-build-and-serve.md`](../../specs/08-build-and-serve.md): the customer
(`client-app`) and OTP (`otp-app`) SPAs built as **per-SPA atomic images** and served
behind `public-nginx` as the **path-based router** (`/` → client, `/otp/` → otp,
`/balance/api/` → `public-kong`), with the spec-08 **port contract**.

The checks are written **from the spec**, not from the implementor's Dockerfiles /
nginx config: each asserts an intended invariant and is built to **fail on a real
defect**. Host ports are read from `.env.example`; the client/otp index markers and the
`/otp/` base come from the committed sources — never invented.

> **Scope (spec 08 scope note — this pass, public plane only).** The admin SPA and the
> internal front door **`:8081`** are DEFERRED; only **`:8080`** (public-nginx) and
> **`:8082`** (keycloak) are host-published this pass. The **transfer-with-OTP** and
> **admin maker-checker** end-to-end flows are steps **8-B/8-C** and are **not** tested
> here (the pending Playwright e2e stays `describe.fixme`, gated on `E2E_ENABLED`).

## Layout

| File | Purpose |
|---|---|
| `run.sh` | Orchestrator. Static suite, then runtime suite, then a summary. |
| `lib.sh` | All check functions + helpers, incl. the light self-up (sourced by `run.sh`; never run directly). |
| `README.md` | This file. |

## Running

```bash
bash tests/build-serve/run.sh            # static then runtime (default = "all")
bash tests/build-serve/run.sh static     # stack-free checks only (Checks 1-5)
bash tests/build-serve/run.sh runtime    # live-edge checks only (R1-R7)
```

- Written for **POSIX bash** (Git Bash on Windows). Not PowerShell.
- Exit code is **non-zero if any check FAILED**. **Skips never fail the run.**
- **Static** checks need the `docker` CLI (`docker compose config`) + `python`, but
  **not** the daemon or a running stack.
- **Runtime** checks need the public edge reachable at
  `http://localhost:${PUBLIC_HTTP_PORT}` (=8080) and `curl`.

### Runtime bring-up (two ways)

1. **Bring the full stack up first** (preferred for the 401-at-Kong evidence in R6):
   ```bash
   cp .env.example .env          # first time only
   docker compose up -d --build  # client-app, otp-app, public-nginx, kong, …
   bash tests/build-serve/run.sh runtime
   ```
2. **Let the suite self-up (light):** if the edge is **not** already reachable, the
   suite runs `docker compose up -d --build --no-deps public-nginx client-app otp-app`
   in an **isolated project** and tears it down afterward. This proves SPA serving and
   that the catch-all does not shadow the API (`/balance/api` → **5xx**, Kong absent —
   still *not* a SPA page); the transport suite covers the **401-at-Kong** specifics.
   Disable with `BUILD_SERVE_NO_SELFUP=1` (then the edge must be up first).

All runtime probes are **read-only** GETs (`/`, `/accounts`, `/otp/`, `/otp/pending`,
an `/otp/` asset, `/balance/api/whoami`, `/healthz`) — non-destructive; they move no
money and mutate no state. The suite never tears down a stack it did not create.

## What each check proves (mapped to spec 08)

### Static (no live stack)

| # | Check | Proves / fails on |
|---|---|---|
| 1 | `docker compose config` resolves **and** `public-nginx` + `client-app` + `otp-app` are in the **default** up graph (no profile gate) | "Full run" / "Serving layout": the public plane is wired into the spine. **FAILs** until the implementor adds the SPA images. |
| 2 | **Port contract** — the default `up` publishes **only** `:8080` (public-nginx) + `:8082` (keycloak); `:8081` and the SPA containers publish **nothing** | Scope note: "in this pass only `:8080` and `:8082` are published". **FAILs** if `:8081` is wired in early, a SPA is host-published, or a stray port appears. |
| 3 | **SPA topology** — `client-app` + `otp-app` are on **`edge-public` only** and host-publish nothing | "Ports & origin": "The SPA images join `edge-public` only and are not host-published" — reachable solely via the router. |
| 4 | **nginx router** — `/balance/api` still → `public-kong`; root `/` no longer the spec-06 `return 404` placeholder; an `/otp` route exists (reports whether it strips `/otp/`); `/healthz` still 200 | "Serving layout". Low-false-positive textual parse; **FAILs** on API removal/shadow, the placeholder left in, a missing `/otp` route, an `/otp` route that strips `/otp/`, or a dropped `/healthz`. |
| 5 | *(opportunistic)* a built `web/otp/dist/index.html` references **`/otp/`-prefixed** assets and no root `/assets/` | "a production `vite build` … base `/otp/`". **SKIPs** when no build artifact exists (R5 proves it at runtime). |

### Runtime (public edge reachable at `:${PUBLIC_HTTP_PORT}`)

| # | Check | Proves / fails on |
|---|---|---|
| R7 | `GET /healthz` → **200** | nginx liveness — the front door is serving. |
| R1 | `GET /` → **200**, the **client** SPA index (`<title>SuperCool Finances</title>`, `id="root"`; **not** the OTP title) | "Path-based: `/` → the `client-app` image". Fails if `/` 404s or is misrouted to the otp bundle. |
| R2 | `GET /accounts` (deep link) → **200**, the client index | "Each SPA image owns its own `try_files … /index.html` history fallback" — a client deep link survives a reload. |
| R3 | `GET /otp/` → **200**, the **OTP** SPA index (title contains `OTP`) | "`/otp/` → the `otp-app` image, proxied without stripping `/otp/`". Fails if `/otp/` 404s or is misrouted to the client bundle. |
| R4 | `GET /otp/pending` (deep link) → **200**, the otp index | otp SPA history fallback. |
| R5 | the otp index references an **`/otp/`-prefixed** asset **and** that asset loads **200** | "built for `base: '/otp/'` … its assets … live under `/otp/`" **and** the router serves `/otp/` **without stripping**. Fails if base was not applied (assets under `/assets/` → 404 behind `/otp/`) or the router strips `/otp/` (asset 404). |
| R6 | `GET /balance/api/whoami` (no token) is **not** a **200 SPA index** — a **401** with the full stack (Kong), a **5xx** with the light self-up | "the service-namespaced API path `/balance/api/` → `public-kong`" — the SPA catch-all must **not** shadow the API. The sharpest routing check: catches a catch-all that swallows gateway traffic. |

### How "is this a SPA page?" is decided

Every served SPA index is a `200` HTML doc containing **`id="root"`** (the mount node);
the two are told apart by `<title>`: the client is exactly `SuperCool Finances`, the
OTP is `SuperCool Finances — OTP`. Gateway/API responses (JSON, Kong error pages)
contain none of these. So a `/balance/api` response carrying `id="root"` means the
catch-all shadowed the API (R6); a `/` response with the OTP title means the root is
misrouted (R1); and so on.

## Deliberately out of scope (left to later steps)

- **Transfer-with-OTP** (client → OTP reveal → posted) and **admin maker-checker
  reversal** end-to-end — the pending Playwright chains (`describe.fixme`, `E2E_ENABLED`)
  are **step 8-C**; not enabled here.
- **Admin SPA** and the **internal edge** (`internal-nginx` / `:8081`) — the admin plane
  is deferred; this suite asserts `:8081` is **not** published (Check 2), nothing more.
- **Seed data** idempotency and Keycloak↔seed alignment — a separate spec-08 slice.
- **Kong auth semantics** (401/403/anti-spoof/rate-limit) — owned by `tests/transport`.

## Skips you may see (never false passes)

- **Static 1-4 FAIL** until the SPA images + router are wired — the expected
  "step-not-done" signal (this suite was authored against the spec before the wiring).
- **Static 5 SKIP** — no built otp bundle on disk (R5 covers it at runtime).
- **Runtime SKIP (all)** — the edge is not reachable and self-up is disabled/unavailable
  (offline, no daemon, or the SPA services aren't wired yet): bring the stack up first.
