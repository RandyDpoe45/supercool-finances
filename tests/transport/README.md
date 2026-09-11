# Transport — edge verification (Spec 06)

Acceptance harness for **both** transport edges:

- **Public plane** (Step 1): `public-nginx` (:8080) → `public-kong` → `balance-service`;
  vertical slice `GET /balance/api/whoami` echoes the Kong-injected identity.
- **Internal plane** (Step 2): `internal-nginx` (:8081) → `internal-kong` → **two upstreams**
  `balance-service` + `analytics-server`; vertical slice `GET /balance/admin/whoami` and
  `GET /analytics/admin/whoami`. Role gate is **admin**.

It is the acceptance gate for the public- and internal-plane lines of the Definition of Done
in [`specs/06-transport.md`](../../specs/06-transport.md).

> **Routing (developer ruling, ADR-17):** external paths are **service-namespaced** and Kong
> **strips the service segment**:
> - public: `/balance/api/*` → strip `/balance` → upstream `/api/*` (e.g. `/api/whoami`);
> - internal: `/balance/admin/*` → strip → balance `/admin/*`; `/analytics/admin/*` → strip →
>   analytics `/admin/*`.
> The bare un-namespaced `/api` and `/admin` are **not** routed, and `/internal/*` is never
> routable from **either** edge.

The checks are written **from the spec**, not from the implementor's nginx/Kong config:
each asserts an intended invariant and is built to **fail on a real defect**. Host ports
are read from `.env.example`; realm/user/client facts from
`tools/keycloak/realm-export.json` — never hardcoded.

> **Scope.** Both edges of spec 06 (public + internal). Analytics reporting endpoints beyond
> the `/analytics/admin/whoami` scaffolding probe, and the SPAs, are later specs.

## Layout

| File | Purpose |
|---|---|
| `run.sh` | Orchestrator. Runs the static suite, then the runtime suite, then a summary. |
| `lib.sh` | All check functions + helpers, incl. the PKCE token minter (sourced by `run.sh`; never run directly). |
| `README.md` | This file. |

## Running

```bash
bash tests/transport/run.sh            # static checks, then runtime (default = "all")
bash tests/transport/run.sh static     # stack-free checks only (public 1-3 + internal I1-I3)
bash tests/transport/run.sh runtime    # live-stack checks only (public 4-9 + internal I4-I9)
```

- Written for **POSIX bash** (Git Bash on Windows). Not PowerShell.
- Exit code is **non-zero if any check FAILED**. **Skips never fail the run.**
- **Static** checks need the `docker` CLI (for `docker compose config`) + `python`
  (+ PyYAML for the Kong config parse), but **not** the daemon or a running stack.
- **Runtime** checks need the **FULL stack already running** and `curl` + `python`. Each edge
  is probed independently: if the **public** edge (`:${PUBLIC_HTTP_PORT}`, =8080) or the
  **internal** edge (`:${INTERNAL_HTTP_PORT}`, =8081) is not reachable, that edge's checks
  **SKIP with an explicit message** — never a false pass.

### Runtime prerequisite — bring the stack up first

The runtime suite is a **black-box** test of the live edge; it does **not** build or start
containers (the balance service needs a build; the whole stack is heavy). Start the stack,
then run the suite:

```bash
cp .env.example .env          # first time only
docker compose up -d --build  # postgres, keycloak, public-kong, public-nginx, balance-service, …
bash tests/transport/run.sh runtime
```

It only ever issues `GET /balance/api/whoami` (a read-only identity echo) and a burst against it,
so it is **non-destructive** — it moves no money and mutates no ledger state, and it never
tears down a stack it did not create.

## How a token is obtained — scripted Authorization Code + PKCE (approach chosen)

The vertical slices need **real access tokens**: `demo-customer` (public edge, and the
internal admin-gate 403 case) and `demo-admin` (internal edge). All three SPA clients set
`directAccessGrantsEnabled: false` (a deliberate security posture — the ROPC/password
grant is intentionally unavailable and **must not** be enabled to ease testing), so the
only way to a real token is the **Authorization Code + PKCE (S256)** flow.

**Chosen approach: (a) a headless scripted auth-code + PKCE helper** (`pkce_token_for_role`
in `lib.sh`), the *same* proven choreography the keycloak suite uses — it does exactly what
a browser does:

1. generate a `code_verifier` + S256 `code_challenge`;
2. `GET` the authorization endpoint (login page), keep the session cookies;
3. `POST` the seeded user's credentials, capture the `302` to `redirect_uri?code=…`
   (the redirect target never has to resolve — we read the `Location` directly);
4. exchange the `code` at the token endpoint **with the `code_verifier`** (this is what
   actually exercises PKCE).

Driven against the shared alias host `http://keycloak.localtest.me:8082` (== `KC_HOSTNAME`,
the browser's view; `*.localtest.me` resolves to 127.0.0.1). Seed usernames + demo
passwords are read from the realm export (`demo-customer`, and `demo-admin` for the
role-gate check).

**Why headless, not manual:** it is reproducible, needs no browser, and is already proven
to yield real tokens against the live Keycloak in this repo.

### Manual checkpoint (fallback for offline / flaky environments)

If the host cannot resolve `keycloak.localtest.me` to loopback (a fully offline box), the
scripted flow is impossible and the token-dependent checks **SKIP**. To run the vertical
slice by hand, obtain a token via the browser and re-run one probe:

1. Log in as `demo-customer` / `demo-customer-pw` (public) or `demo-admin` / `demo-admin-pw`
   (internal) via the Keycloak account console at
   `http://keycloak.localtest.me:8082/realms/supercool/account`; grab the access token.
2. Probe the relevant edge with it:
   ```bash
   TOKEN=<paste-access-token>
   # public (customer token):
   curl -i -H "Authorization: Bearer $TOKEN" http://localhost:8080/balance/api/whoami
   # -> HTTP 200, body {"userId":"<token sub>","roles":["customer", ...]}
   # internal (admin token):
   curl -i -H "Authorization: Bearer $TOKEN" http://localhost:8081/balance/admin/whoami
   curl -i -H "Authorization: Bearer $TOKEN" http://localhost:8081/analytics/admin/whoami
   # -> HTTP 200, body {"userId":"<token sub>","roles":["admin", ...]}
   ```

You can also feed browser-obtained tokens straight into the automated assertions:

```bash
# (helper is sourced; then assert against the live edges)
source tests/transport/lib.sh && load_env_values
CUSTOMER_TOKEN=<paste>; CUSTOMER_SUB=$(decode_jwt_claims "$CUSTOMER_TOKEN" | awk -F'\t' '$1=="sub"{print $2}')
ADMIN_TOKEN=<paste>;    ADMIN_SUB=$(decode_jwt_claims "$ADMIN_TOKEN" | awk -F'\t' '$1=="sub"{print $2}')
check_vertical_slice; check_anti_spoof                 # public
check_internal_vertical_slice; check_internal_anti_spoof; check_internal_role_gate  # internal
```

## What each check proves (mapped to the spec-06 DoD)

### Static (no live stack) — public edge

| # | Check | Proves |
|---|---|---|
| 1 | `docker compose config` resolves **and** `public-nginx` + `public-kong` + `balance-service` are defined | Task item 7 ("compose config valid"); the public edge is wired into the spine. FAILs until the implementor adds the services. |
| 2 | Only `public-nginx` host-publishes `:${PUBLIC_HTTP_PORT}` (on `edge-public`); `public-kong` + `balance-service` publish **nothing** | spec 00 §3 "nothing host-published except the edges" — the gateway and app are reachable only through nginx. |
| 3 | The public-kong declarative config **parses** and declares a **namespaced `/balance/api` route** (not bare `/api`) with **`/balance` stripped → upstream `/api`**, targeting `balance-service`, plus the identity-gate intents: **strip** both `X-User-Id`/`X-Roles`, **RS256** pin + JWKS **signature verify**, exact **issuer**, **aud** `supercool-api`, **exp/nbf**, **customer** 403 gate, **inject** both headers, + rate-limiting | Task item 7 ("Kong declarative config parses"); the routing ruling + the security-critical intents of spec 06, asserted against the **pre-function** shape (see mechanism note below). Tolerant of formatting; **FAILs** on a bare-`/api` route, a dropped strip, a dropped role-gate, or invalid YAML. |

### Static (no live stack) — internal edge

| # | Check | Proves |
|---|---|---|
| I1 | `docker compose config` resolves **and** `internal-nginx` + `internal-kong` + `analytics-server` (+ `balance-service`) are defined | The internal edge and its two upstreams are wired into the spine. |
| I2 | Only `internal-nginx` host-publishes `:${INTERNAL_HTTP_PORT}` (on `edge-internal`); `internal-kong` + `analytics-server` + `balance-service` publish **nothing** | spec 00 §3 — the internal gateway and both apps are reachable only through the internal nginx. |
| I3 | The internal-kong config **parses** and declares **two namespaced admin routes** — `/balance/admin` → balance (strip → `/admin`) and `/analytics/admin` → analytics (strip → `/admin`) — **no bare `/admin`**, **no `/internal`** route, an **admin** 403 gate, and the same identity-gate intents (strip both, RS256 + verify, issuer, aud, exp, inject both) + rate-limiting | The internal routing + admin gate + security-critical intents. **FAILs** on a bare-`/admin` route, a dropped strip, a missing route, a `/internal` route, a dropped admin gate, or invalid YAML. |

### Runtime — public edge (need the FULL stack up; reached via `:${PUBLIC_HTTP_PORT}`)

| # | Check | Proves (DoD line) |
|---|---|---|
| 4 | **Vertical slice** — real demo-customer token → `GET /balance/api/whoami` → **200**, body `userId == token sub`, `roles` contains `customer` (proves `/balance` is stripped to the upstream `/api/whoami`) | "Valid customer token → /api reaches the balance service with injected `X-User-Id`"; **"Vertical slice is green."** |
| 5 | **No token → 401** at Kong, and the response is **not** from the balance service (no `{error:{…,requestId}}` envelope / no upstream marker) | "missing/invalid token → 401 at Kong" — proven to be rejected **at the edge**, not by the app. |
| 6 | **Invalid token → 401** — a **malformed** bearer and a **tampered-signature** token (real header/payload, flipped signature) both 401 at the edge | "invalid token → 401"; the tampered case proves Kong genuinely **verifies the JWKS signature**. (Expiry is an **opt-in** slow test — see below.) |
| 7 | **Anti-spoof (money-safety)** — (a) valid token **+** spoofed `X-User-Id`/`X-Roles: admin` → whoami still reflects the **token** (`userId==sub`, roles has `customer`, **no** `admin`); (b) spoofed headers **without** a token → still **401**, never reaches the app | "A client-supplied `X-User-Id` header is stripped before the upstream." The sharpest test: catches identity spoofing **and** header-only privilege escalation / auth bypass. |
| 7b | **Customer-role gate** — a **valid** token lacking `customer` (demo-admin, role `admin` only) is **rejected** at `/api` (403 ideal), never reaching the app as an authorized customer | The spec's "acl (require customer)" **intent**, proven behaviorally: the public edge requires the `customer` realm role. |
| 8 | **Rate limiting** — a burst of authenticated `/api` requests eventually returns **429** | "Rate limiting triggers on the auth/money routes." Uses a valid token so requests pass auth and hit the limiter; run **last** so the consumed budget can't affect other checks. |
| 9 | **Default-deny** — a random non-`/api` path, the **un-namespaced bare `/api`**, **`/balance/admin`**, the bare `/admin`, **and** `/internal` do **not** reach the balance service via the public edge | spec 06 "Routes **only** `/balance/api/*` → balance-service. Default-deny everything else"; and "`/internal/*` is not routable from either edge" (public-plane half); the public edge must not expose the bare `/api`, admin, or internal surfaces. |

### Runtime — internal edge (need the FULL stack up; reached via `:${INTERNAL_HTTP_PORT}`)

| # | Check | Proves (DoD line) |
|---|---|---|
| I4 | **Internal vertical slice** — real demo-admin token → `GET /balance/admin/whoami` **and** `GET /analytics/admin/whoami` → **200**, `userId == sub`, `roles` contains `admin` | admin token → `/admin` works, across **both** upstreams; proves Kong strips the `/<ns>/admin` namespace to each upstream's built `/admin/whoami` + injects identity. |
| I5 | **Admin-role gate** — a valid **demo-customer** token → `GET /balance/admin/whoami` → **403**, never reaching an upstream | spec DoD **"Customer token → /admin → 403"**: the internal edge requires the `admin` realm role. |
| I6 | **No / invalid token → 401** — no token, a malformed bearer, and a tampered-signature admin token all 401 at the edge, none reaching an upstream | "missing/invalid token → 401"; the tampered case proves internal-kong genuinely **verifies the JWKS signature**. |
| I7 | **Anti-spoof (money-safety)** — (a) admin token **+** spoofed `X-User-Id`/`X-Roles: superuser` → whoami reflects the **token** (`userId==sub`, roles has `admin`, **no** `superuser`); (b) spoofed headers **without** a token → **401**, never reaches an upstream | "A client-supplied `X-User-Id` header is stripped before the upstream" — on the admin plane. Catches admin-identity spoofing **and** header-only auth bypass. |
| I8 | **Default-deny + `/internal`** — via `:8081`, the bare `/admin`, `/balance/internal`, `/analytics/internal`, `/internal`, and `/balance/api` do **not** reach an upstream | spec 06 default-deny; **"`/internal/*` is not routable from either edge"** (internal-plane half); the api namespace is public-only. |
| I9 | **Rate limiting** — a burst of authenticated admin requests on `/balance/admin` eventually returns **429** | "Rate limiting triggers on the auth/money routes" — internal edge. Run **last** (consumes the window's budget). |

### How "reached an upstream" is decided

An app response is recognizable: success carries `userId`/`roles`; the balance service's
errors carry the `{error:{code,message,requestId}}` envelope (`AllExceptionsFilter`), and the
analytics scaffolding may use the NestJS-default envelope (`{"statusCode":…,"message":…}`).
Kong's own short-circuit bodies (`{"message":"Unauthorized"}`, `{"message":"no Route
matched…"}`) carry none of those. So a `401`/`404` **without** an app envelope came from the
**edge**, and one **with** it came from an **upstream** — the discriminator that turns
"status 401" into "rejected **at the edge**, never reached upstream." `reached_balance`
covers the balance-only public edge; `reached_upstream` also accepts the NestJS-default
envelope for the internal edge's second (analytics) upstream. Both vertical slices
additionally self-calibrate the `X-Kong-Upstream-Latency` header (present only on
genuinely-proxied responses) as a second signal for the negative checks.

## Note — spec vs. implementation: the identity gate mechanism (developer ruling)

Spec 06 lists the public-kong plugins as `jwt … ; acl (require customer); rate-limiting; …`.
Per a **developer ruling**, the implementor OWNs the security-critical validation in a single
**`pre-function`** (serverless-functions, priority 1000000, runs first) rather than depending
on the abandoned `jwt-keycloak` rock or Kong's `acl` plugin (which needs consumers, absent
under DB-less JWKS validation). So the intents — strip inbound identity, RS256 pin + JWKS
`pub:verify`, exact `iss`, `aud`, `exp`/`nbf`, the `customer` 403 gate, and identity injection
— live as **Lua inside the pre-function block** of `kong.yml`. The only other plugins on the
`/balance/api` route are `cors` and `rate-limiting`.

The **internal-kong** config uses the same pre-function mechanism, differing only in the two
namespaced admin routes (`/balance/admin`, `/analytics/admin`) and the **`admin`** role gate;
Check I3 asserts those intents the same way, and Checks I4–I9 prove the internal behavior
black-box.

Because the DoD is behavioral, the tests assert the **intent**, not a specific plugin:

- **Checks 3 / I3** parse the config and assert each intent against the pre-function's Lua
  (raw-string regexes, tolerant of formatting) — and stay tolerant of the alternative
  mechanisms (a `request-transformer` strip, or an `acl`/`realm_roles` gate) so a future
  re-swap won't false-fail. They still FAIL on a dropped strip/role-gate, a bare/missing
  route, a `/internal` route (internal), or invalid YAML.
- **Checks 4–9 / I4–I9** prove the behavior black-box, unchanged by the mechanism: the
  vertical slices, the anti-spoof strips (Checks 7 / I7), and the role gates (Check 7b — a
  non-customer token rejected at `/balance/api`; Check I5 — a **customer token → `/balance/admin`
  → 403**) are the real acceptance evidence.

## Skips you may see (never false passes)

- **Static FAIL** for a plane whose services aren't wired into the spine yet (public
  `public-nginx`/`public-kong`, or internal `internal-nginx`/`internal-kong`) — the expected
  "step-not-done" signal.
- **Runtime SKIP (per edge)** — that edge isn't reachable (`:8080` public / `:8081` internal):
  `docker compose up -d` first. Each edge is probed and skipped independently.
- **Token-dependent checks SKIP** — the host can't resolve `keycloak.localtest.me` to
  loopback (offline), or no seeded plaintext demo password is recoverable: use the manual
  checkpoint above (mint `demo-customer` and/or `demo-admin`).
- **Expiry sub-check** is off by default; run the slow (~5 min) variant with
  `TRANSPORT_TEST_EXPIRY=1 bash tests/transport/run.sh runtime`.
