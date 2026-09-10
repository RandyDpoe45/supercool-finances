# Transport — PUBLIC edge verification (Spec 06, Step 1)

Acceptance harness for the **public plane** of transport: `public-nginx` (:8080) →
`public-kong` → `balance-service`, plus the **vertical-slice checkpoint**
(`GET /balance/api/whoami` echoes the Kong-injected identity). It is the acceptance gate
for the public-plane lines of the Definition of Done in
[`specs/06-transport.md`](../../specs/06-transport.md).

> **Routing (developer ruling):** the external public path is namespaced **`/balance/api/*`**;
> Kong **strips `/balance`** so the balance service still serves its built `/api/*` surface
> (e.g. `/api/whoami`). The bare, un-namespaced `/api` is **not** routed.

The checks are written **from the spec**, not from the implementor's nginx/Kong config:
each asserts an intended invariant and is built to **fail on a real defect**. Host ports
are read from `.env.example`; realm/user/client facts from
`tools/keycloak/realm-export.json` — never hardcoded.

> **Scope.** PUBLIC plane only. `/admin`, the internal edge (internal-nginx /
> internal-kong), and analytics are **Step 2** and are not tested here — except that the
> public edge must **not** expose `/admin` (Check 9), which is a public-plane invariant.

## Layout

| File | Purpose |
|---|---|
| `run.sh` | Orchestrator. Runs the static suite, then the runtime suite, then a summary. |
| `lib.sh` | All check functions + helpers, incl. the PKCE token minter (sourced by `run.sh`; never run directly). |
| `README.md` | This file. |

## Running

```bash
bash tests/transport/run.sh            # static checks, then runtime (default = "all")
bash tests/transport/run.sh static     # stack-free checks only (checks 1-3)
bash tests/transport/run.sh runtime    # live-stack checks only (checks 4-9)
```

- Written for **POSIX bash** (Git Bash on Windows). Not PowerShell.
- Exit code is **non-zero if any check FAILED**. **Skips never fail the run.**
- **Static** checks need the `docker` CLI (for `docker compose config`) + `python`
  (+ PyYAML for the Kong config parse), but **not** the daemon or a running stack.
- **Runtime** checks need the **FULL stack already running** and `curl` + `python`. If the
  public edge is not reachable at `http://localhost:${PUBLIC_HTTP_PORT}` (=8080), they
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

The vertical slice needs a **real customer access token**. All three SPA clients set
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

1. Open `http://localhost:8080/` (the client SPA) and log in as `demo-customer` /
   `demo-customer-pw`, **or** open the Keycloak account console at
   `http://keycloak.localtest.me:8082/realms/supercool/account` and complete a login; grab
   the access token from the app's network tab / storage.
2. Probe the edge with it:
   ```bash
   TOKEN=<paste-access-token>
   curl -i -H "Authorization: Bearer $TOKEN" http://localhost:8080/balance/api/whoami
   # expect: HTTP 200 and body {"userId":"<token sub>","roles":["customer", ...]}
   ```

You can also feed a browser-obtained token straight into the automated assertions:

```bash
# (helper is sourced; then assert against the live edge)
source tests/transport/lib.sh && load_env_values
CUSTOMER_TOKEN=<paste>; CUSTOMER_SUB=$(decode_jwt_claims "$CUSTOMER_TOKEN" | awk -F'\t' '$1=="sub"{print $2}')
check_vertical_slice; check_anti_spoof
```

## What each check proves (mapped to the spec-06 DoD)

### Static (no live stack)

| # | Check | Proves |
|---|---|---|
| 1 | `docker compose config` resolves **and** `public-nginx` + `public-kong` + `balance-service` are defined | Task item 7 ("compose config valid"); the public edge is wired into the spine. FAILs until the implementor adds the services. |
| 2 | Only `public-nginx` host-publishes `:${PUBLIC_HTTP_PORT}` (on `edge-public`); `public-kong` + `balance-service` publish **nothing** | spec 00 §3 "nothing host-published except the edges" — the gateway and app are reachable only through nginx. |
| 3 | The public-kong declarative config **parses** and declares a **namespaced `/balance/api` route** (not bare `/api`) with **`/balance` stripped → upstream `/api`**, targeting `balance-service`, plus the identity-gate intents: **strip** both `X-User-Id`/`X-Roles`, **RS256** pin + JWKS **signature verify**, exact **issuer**, **aud** `supercool-api`, **exp/nbf**, **customer** 403 gate, **inject** both headers, + rate-limiting | Task item 7 ("Kong declarative config parses"); the routing ruling + the security-critical intents of spec 06, asserted against the **pre-function** shape (see mechanism note below). Tolerant of formatting; **FAILs** on a bare-`/api` route, a dropped strip, a dropped role-gate, or invalid YAML. |

### Runtime (need the FULL stack up; reached via `:${PUBLIC_HTTP_PORT}`)

| # | Check | Proves (DoD line) |
|---|---|---|
| 4 | **Vertical slice** — real demo-customer token → `GET /balance/api/whoami` → **200**, body `userId == token sub`, `roles` contains `customer` (proves `/balance` is stripped to the upstream `/api/whoami`) | "Valid customer token → /api reaches the balance service with injected `X-User-Id`"; **"Vertical slice is green."** |
| 5 | **No token → 401** at Kong, and the response is **not** from the balance service (no `{error:{…,requestId}}` envelope / no upstream marker) | "missing/invalid token → 401 at Kong" — proven to be rejected **at the edge**, not by the app. |
| 6 | **Invalid token → 401** — a **malformed** bearer and a **tampered-signature** token (real header/payload, flipped signature) both 401 at the edge | "invalid token → 401"; the tampered case proves Kong genuinely **verifies the JWKS signature**. (Expiry is an **opt-in** slow test — see below.) |
| 7 | **Anti-spoof (money-safety)** — (a) valid token **+** spoofed `X-User-Id`/`X-Roles: admin` → whoami still reflects the **token** (`userId==sub`, roles has `customer`, **no** `admin`); (b) spoofed headers **without** a token → still **401**, never reaches the app | "A client-supplied `X-User-Id` header is stripped before the upstream." The sharpest test: catches identity spoofing **and** header-only privilege escalation / auth bypass. |
| 7b | **Customer-role gate** — a **valid** token lacking `customer` (demo-admin, role `admin` only) is **rejected** at `/api` (403 ideal), never reaching the app as an authorized customer | The spec's "acl (require customer)" **intent**, proven behaviorally: the public edge requires the `customer` realm role. |
| 8 | **Rate limiting** — a burst of authenticated `/api` requests eventually returns **429** | "Rate limiting triggers on the auth/money routes." Uses a valid token so requests pass auth and hit the limiter; run **last** so the consumed budget can't affect other checks. |
| 9 | **Default-deny** — a random non-`/api` path, the **un-namespaced bare `/api`**, **`/balance/admin`**, the bare `/admin`, **and** `/internal` do **not** reach the balance service via the public edge | spec 06 "Routes **only** `/balance/api/*` → balance-service. Default-deny everything else"; and "`/internal/*` is not routable from either edge" (public-plane half); the public edge must not expose the bare `/api`, admin, or internal surfaces. |

### How "reached the balance service" is decided

The balance service renders **every** response with a recognizable shape: success carries
`userId`/`roles`; every error carries the `{error:{code,message,requestId}}` envelope
(`AllExceptionsFilter`). Kong's own short-circuit bodies (`{"message":"Unauthorized"}`, …)
carry none of those. So a `401`/`404` **without** that envelope came from the **edge**, and
one **with** it came from the **app** — the discriminator that turns "status 401" into
"rejected **at the edge**, never reached upstream." Check 4 additionally self-calibrates the
`X-Kong-Upstream-Latency` header (present only on genuinely-proxied responses) as a second
signal for the negative checks.

## Note — spec vs. implementation: the identity gate mechanism (developer ruling)

Spec 06 lists the public-kong plugins as `jwt … ; acl (require customer); rate-limiting; …`.
Per a **developer ruling**, the implementor OWNs the security-critical validation in a single
**`pre-function`** (serverless-functions, priority 1000000, runs first) rather than depending
on the abandoned `jwt-keycloak` rock or Kong's `acl` plugin (which needs consumers, absent
under DB-less JWKS validation). So the intents — strip inbound identity, RS256 pin + JWKS
`pub:verify`, exact `iss`, `aud`, `exp`/`nbf`, the `customer` 403 gate, and identity injection
— live as **Lua inside the pre-function block** of `kong.yml`. The only other plugins on the
`/balance/api` route are `cors` and `rate-limiting`.

Because the DoD is behavioral, the tests assert the **intent**, not a specific plugin:

- **Check 3** parses the config and asserts each intent against the pre-function's Lua
  (raw-string regexes, tolerant of formatting) — and stays tolerant of the alternative
  mechanisms (a `request-transformer` strip, or an `acl`/`realm_roles` gate) so a future
  re-swap won't false-fail. It still FAILs on a dropped strip/role-gate or invalid YAML.
- **Checks 4–9** prove the behavior black-box, unchanged by the mechanism: the vertical
  slice (Check 4), the anti-spoof strip (Check 7), and the **customer-role gate** (Check 7b —
  a valid non-customer token is rejected at `/balance/api`) are the real acceptance evidence.

## Skips you may see (never false passes)

- **Static 1 / 2 FAIL** until `public-nginx` / `public-kong` are wired into the spine — the
  expected "step-not-done" signal (this suite was authored against the coordination contract
  before the compose wiring landed).
- **Runtime SKIP (all)** — the public edge isn't reachable: `docker compose up -d` first.
- **Token-dependent checks SKIP** — the host can't resolve `keycloak.localtest.me` to
  loopback (offline), or no seeded plaintext demo password is recoverable: use the manual
  checkpoint above.
- **Expiry sub-check** is off by default; run the slow (~5 min) variant with
  `TRANSPORT_TEST_EXPIRY=1 bash tests/transport/run.sh runtime`.
