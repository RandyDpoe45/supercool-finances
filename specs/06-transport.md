# Spec 06 — Transport (nginx ×2 + Kong ×2) & the vertical slice

**Purpose.** Stand up the two edges and prove the macro with an end-to-end slice.
nginx serves SPAs + terminates TLS; Kong enforces JWT/role/rate-limit and injects
the trusted identity. The Kong allowlists **are** the exposed API surface.

**Depends on.** [`02`](./02-keycloak.md), [`04`](./04-balance-service.md),
[`05`](./05-analytics-server.md).

## Moving parts & configuration

> The public-edge bullets below describe the **intent**; for how it was actually
> built (plain HTTP; a `pre-function`/JWKS gate rather than stock `jwt`+`acl`), see
> **Resolved (implementation, public edge)** under *Open questions*.

- **public-nginx** (`edge-public`, host `:8080`) — serves the client + OTP SPA
  bundles and reverse-proxies `/api/*` → `public-kong`. **Plain HTTP on localhost**
  (no TLS for this demo — see *Resolved*). (SPA path layout resolved in spec 08.)
- **internal-nginx** (`edge-internal`, host `:8081`) — serves the admin SPA,
  proxies `/admin/*` → `internal-kong`.
- **public-kong** (`edge-public` + `app-public`, DB-less `kong.yml`):
  - Routes **only** `/api/*` → `balance-service`. Default-deny everything else.
  - Enforces **JWKS-only** validation (signature **and** `exp`/`iss`/`aud`) and the
    `customer` realm role, plus `rate-limiting`, CORS, and identity injection (map
    token `sub` → `X-User-Id`, roles → `X-Roles`), **stripping any client-supplied
    `X-User-Id` / `X-Roles`** (anti-spoof). Realized in a `pre-function` — see
    *Resolved (implementation, public edge)*.
- **internal-kong** (`edge-internal` + `app-internal`, DB-less):
  - Routes **only** `/admin/*` → `balance-service` and `analytics-server`. Requires
    `admin` role. Same identity injection + strip. Default-deny.
  - **Never** routes `/internal/*`.

## Contracts / interfaces

- **Header contract** consumed by the identity guard (spec 03): `X-User-Id`,
  `X-Roles`, injected by Kong from the validated token, client values stripped.
- **Allowlist = exposed surface** — adding an endpoint requires a route here, so
  exposure is explicit and auditable
  ([ADR-12](../docs/DECISIONS.md#adr-12--endpoint-prefix-convention-as-the-exposure-contract)).

## The vertical-slice checkpoint (do this before spec 07)

Prove one path end to end: browser gets a real Keycloak token → `GET /api/...` on
`public-nginx` → `public-kong` validates + injects identity → `balance-service`
reads Postgres → response. This validates auth, the trust boundary, prefixes, and
the network split at once. **If it resists, return to the macro (spec 00), not a
workaround.**

## Definition of Done

- [ ] Valid customer token → `/api` reaches the balance service with injected
      `X-User-Id`; missing/invalid token → 401 at Kong.
- [ ] Customer token → `/admin` → 403; admin token → `/admin` works.
- [ ] `/internal/*` is not routable from either edge.
- [ ] A client-supplied `X-User-Id` header is stripped before the upstream.
- [ ] Rate limiting triggers on the auth/money routes.
- [ ] **Vertical slice is green.**

## Open questions

- ~~TLS cert approach for the demo (self-signed vs plain HTTP on localhost).~~
  **Resolved: plain HTTP on localhost.** No TLS for this prototype — nginx and Kong
  speak plain HTTP over the loopback edge; the issuer scheme is already `http`
  (spec 02). In a real deployment TLS terminates at nginx; nothing downstream
  changes.

**Resolved:** Kong uses **JWKS-only** validation (signature + `exp`/`iss`/`aud`).
No live revocation for the prototype — acceptable given short-lived tokens; noted
as residual risk in the threat model.

**Resolved (implementation, public edge):** stock OSS Kong cannot do JWKS-based
JWT validation (its `jwt` plugin needs pre-registered consumers + static keys) and
its `acl` plugin keys off consumers that do not exist under JWT validation. The OSS
`jwt-keycloak` community plugin is abandoned and its only published rock pins
pre-3.0 Kong. So, by developer ruling, the public gateway runs **stock modern Kong
3.x (pinned)** and **owns the JWKS verification in a `pre-function`**
(serverless-functions) built from **vetted crypto** — Kong's core `jwt_parser` for
parsing and **`lua-resty-openssl`** for JWK→RSA-key + RS256 verify (no hand-rolled
base64url/bignum). The pre-function runs first and **fails closed**: it strips any
client-supplied `X-User-Id`/`X-Roles`, verifies the RS256 signature against
Keycloak's JWKS (`kid`-selected, cached, refetch-on-rotation with a bounded negative
path), pins `alg=RS256` (rejecting `none`/`HS*`), checks `iss`/`aud`/`exp` (±60s
skew), gates the `customer` realm role (**403** vs **401** per
`gateway-identity.guard.ts`), and only then injects the trusted `X-User-Id`/`X-Roles`.
`cors` + `rate-limiting` are kept; default-deny (only the `/api` route). See
`infra/kong-public/README.md`.
