# internal-kong — internal API gateway (spec 06, internal edge)

The **policy-enforcement point (PEP)** for the **admin plane**. It sits between
`internal-nginx` (the admin front door) and the two admin surfaces —
`balance-service` and `analytics-server` — verifies the caller's Keycloak token,
gates the **`admin`** realm role, and injects a **trusted identity**. Runs
**DB-less** from a committed declarative config, reproducible from zero.

- **Image:** stock **`kong:3.9.0`** (pinned). No custom build — every library the
  auth logic needs already ships in the image.
- **Networks:** `edge-internal` (← `internal-nginx`), `app-internal` (→
  `balance-service`, `analytics-server`, and the `keycloak.localtest.me` alias).
  **Not** on `app-public`, **not** on `data`; **never host-published** — only
  `internal-nginx` is (spec 00 §2/§3).
- **Config:** [`kong.yml`](./kong.yml), mounted read-only; `KONG_DATABASE=off`.

## The allowlist *is* the exposed surface (ADR-12), service-namespaced (ADR-17)

`kong.yml` declares exactly **two** routes:

| External path | Kong service | Upstream receives |
|---|---|---|
| `/balance/admin/*` | `http://balance-service:3000/admin` | `/admin/*` |
| `/analytics/admin/*` | `http://analytics-server:3000/admin` | `/admin/*` |

Each route uses **`strip_path: true`** (drops the matched `/<service>/admin`) and the
Kong service `path` is `/admin` (Kong prepends it), so `/balance/admin/whoami` →
`balance-service` `/admin/whoami`, and `/analytics/admin/whoami` →
`analytics-server` `/admin/whoami`.

**Default-deny** everything else — bare `/admin`, `/balance/api`, and (security
critical) **`/balance/internal`, `/analytics/internal`, `/internal` → 404. The
internal edge NEVER routes `/internal/*` for any service** ([ADR-12](../../docs/DECISIONS.md#adr-12--endpoint-prefix-convention-as-the-exposure-contract):
`/internal` is reachable only on the in-network service channel, from no gateway).

The **strip is security-load-bearing** ([ADR-17](../../docs/DECISIONS.md#adr-17--service-namespaced-edge-routing)):
the services' gateway guard enforces the admin-role check only when the first path
segment is `admin`, so the upstream must see `/admin` first — which the fixed
`/admin` service-path prepend guarantees.

## Auth model — same JWKS `pre-function` as public-kong, role gate = `admin`

The identity gate is the **public-kong pre-function reused verbatim except the role
gate is `admin`** (not `customer`). Same modern-Kong-3.x + vetted crypto (Kong core
`jwt_parser` to parse; `lua-resty-openssl` `pkey.new(jwk,{format="JWK"})` +
`pub:verify(sig, signing_input, "sha256")` to verify — no hand-rolled base64url /
bignum). It runs **first** (pre-function PRIORITY `1000000`) and **fails closed**;
per request it:

1. **Strips** inbound `X-User-Id` / `X-Roles` (anti-spoof) before any early return;
   defers only genuine CORS preflight to `cors`.
2. Reads the bearer token from the `Authorization` header only (scheme
   case-insensitive).
3. Pins **`alg = RS256`** (rejects `none` / `HS*`).
4. Selects the JWKS key by `kid` (cached in the `kong` shared dict, `ttl=300s`;
   throttled forced refetch on an unknown kid), verifies the RS256 signature.
5. Validates `iss` (exact), `aud` (contains `supercool-api`), `exp`/`nbf` (±60s skew).
6. **Role gate:** `realm_access.roles` must include **`admin`** → else **403**; a
   missing/invalid/unverifiable token → **401** (matching the services'
   `gateway-identity.guard.ts`).
7. Injects `X-User-Id` = `sub`, `X-Roles` = comma-joined roles (overwrite).

The Lua is defined **once** (a YAML anchor `&admin_gate`) and applied to **both**
routes, so the security-critical code cannot drift between them. `KONG_UNTRUSTED_LUA=on`
is required (the pre-function `require`s Kong core + crypto modules); the Lua is ours
(committed + reviewed), not user-supplied.

### Also on both routes

- `cors` — allow only the **admin SPA origin** (`http://localhost:8081`), credentials
  on; answers preflight.
- `rate-limiting` — per-IP fixed window (`minute:60`, `policy:local` — DB-less); a
  burst over the cap → **429**.

## Header contract (consumed by the admin surfaces)

Both services' gateway guard trusts **only** the Kong-injected `X-User-Id` (token
`sub`) and `X-Roles` (comma-separated `realm_access.roles`) — client-supplied copies
are stripped. `/admin` additionally requires the `admin` role, enforced here at the
gateway *and* in the service guard (defense in depth).

## Issuer / audience are fixed constants

Kong's DB-less declarative config does not interpolate env vars, so the pre-function
carries them literally: `ISSUER =
http://keycloak.localtest.me:8082/realms/supercool` (keep in sync with
`KC_HOSTNAME`/`KEYCLOAK_PORT`) and `EXPECTED_AUD = supercool-api` (the realm's
`oidc-audience-mapper`). Kong reaches Keycloak for the JWKS via the
`keycloak.localtest.me` alias on `app-internal`.

## Healthcheck

`kong health` — checks the local node's processes; needs no Admin API (turned off).
Gates `internal-nginx` via `depends_on: service_healthy`.

## Verifying

```sh
# Config is valid (DB-less):
docker run --rm -e KONG_DATABASE=off -e KONG_PLUGINS=bundled -e KONG_UNTRUSTED_LUA=on \
  -v "$PWD/kong.yml":/kong/kong.yml:ro --entrypoint kong kong:3.9.0 config parse /kong/kong.yml

# With the full stack up, via internal-nginx :8081 (admin token from Keycloak):
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8081/balance/admin/whoami    # 401 (no token)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8081/admin                   # 404 (bare /admin)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8081/balance/internal        # 404 (never routed)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8081/internal                # 404
# admin token -> /balance/admin/whoami and /analytics/admin/whoami -> 200;
# customer token -> /balance/admin/whoami -> 403.
```

During implementation the admin gate + strip were proven against the **full live
stack** with real Keycloak tokens (headless PKCE): `demo-admin` →
`/balance/admin/whoami` and `/analytics/admin/whoami` → `200` (identity injected);
`demo-customer` → `/balance/admin/whoami` → `403`; no token → `401`; spoofed
identity headers stripped; bare `/admin`, `/*/internal`, `/internal` → `404`.
