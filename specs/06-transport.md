# Spec 06 — Transport (nginx ×2 + Kong ×2) & the vertical slice

**Purpose.** Stand up the two edges and prove the macro with an end-to-end slice.
nginx serves SPAs + terminates TLS; Kong enforces JWT/role/rate-limit and injects
the trusted identity. The Kong allowlists **are** the exposed API surface.

**Depends on.** [`02`](./02-keycloak.md), [`04`](./04-balance-service.md),
[`05`](./05-analytics-server.md).

## Moving parts & configuration

- **public-nginx** (`edge-public`, host `:8080`) — serves the client + OTP SPA
  bundles, terminates TLS (self-signed for demo), reverse-proxies `/api/*` →
  `public-kong`. (SPA path layout resolved in spec 08.)
- **internal-nginx** (`edge-internal`, host `:8081`) — serves the admin SPA,
  proxies `/admin/*` → `internal-kong`.
- **public-kong** (`edge-public` + `app-public`, DB-less `kong.yml`):
  - Routes **only** `/api/*` → `balance-service`. Default-deny everything else.
  - Plugins: `jwt` — **JWKS-only**, validating the signature **and** standard
    claims (`exp`, `iss`, `aud`); `acl` (require `customer`); `rate-limiting`;
    identity injection (map token `sub` → `X-User-Id`, roles → `X-Roles`); CORS.
    **Strips any client-supplied `X-User-Id` / `X-Roles`** (anti-spoof).
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

- TLS cert approach for the demo (self-signed vs plain HTTP on localhost).

**Resolved:** Kong uses **JWKS-only** validation (signature + `exp`/`iss`/`aud`).
No live revocation for the prototype — acceptable given short-lived tokens; noted
as residual risk in the threat model.
