# public-kong — public API gateway (spec 06, public edge)

The **policy-enforcement point (PEP)** for the customer plane. It sits between
`public-nginx` (the front door) and `balance-service`, verifies the customer's
Keycloak token, and injects a **trusted identity** the service can rely on. Runs
**DB-less** from a committed declarative config, so the gateway is reproducible
from zero with no admin clicks.

- **Image:** stock **`kong:3.9.0`** (pinned — reproducible-from-zero, same rationale
  as the other image pins). No custom build: every library the auth logic needs
  already ships in the image.
- **Networks:** `edge-public` (← `public-nginx`), `app-public` (→ `balance-service`
  and the `keycloak.localtest.me` alias). **Never host-published** — only
  `public-nginx` is (spec 00 §2/§3).
- **Config:** [`kong.yml`](./kong.yml), mounted read-only; `KONG_DATABASE=off`.

## The allowlist *is* the exposed surface (ADR-12), service-namespaced (ADR-17)

`kong.yml` declares exactly **one** route — external **`/balance/api`** → the Kong
service `http://balance-service:3000/api`. The path is **service-namespaced**
(ADR-17): the route uses **`strip_path: true`** to drop the matched `/balance/api`,
and Kong prepends the service `path` (`/api`), so the upstream still receives its
built surface: `GET /balance/api/whoami` → `balance-service` `GET /api/whoami` (its
controllers + the guard's first-segment check are unchanged).

There is **no catch-all**, so any other path is a **404 at the gateway**
(default-deny) — including bare **`/api`**, **`/balance/admin`**, and **`/admin`**:
admin is never reachable on the public plane. The **strip is security-load-bearing**
(ADR-17): the balance guard only enforces the admin-role check when the first path
segment is `admin`, so an *un-stripped* `/balance/admin` would bypass it — hence the
namespace is stripped and admin is simply not routed here. Exposing a new endpoint
means adding a route here — exposure stays explicit and auditable.

## Auth model — JWKS verification in a `pre-function` (we own the Lua)

Stock OSS Kong's `jwt` plugin has no JWKS discovery, and the OSS `jwt-keycloak`
community plugin's only published rock is abandoned and pins pre-3.0 Kong. Per the
developer's ruling we therefore **own the security-critical verification** in a Kong
**`pre-function`** (serverless-functions), on modern Kong 3.x, built from **vetted
crypto primitives** — no hand-rolled base64url/bignum:

- **Parsing:** Kong's core `kong.plugins.jwt.jwt_parser` (base64url + structure,
  gives `header`, `claims`, decoded `signature`, and the exact `header_64`/`claims_64`
  signing input).
- **JWK → RSA key + RS256 verify:** `lua-resty-openssl` — `pkey.new(jwk, {format="JWK"})`
  builds the public key straight from the JWK params, and `pub:verify(sig, signing_input, "sha256")`
  verifies with a **fixed** RSA+SHA-256 method (never derived from the token header,
  so it cannot be tricked into HMAC).
- **JWKS fetch:** `lua-resty-http`; **cache + refetch throttle:** the `kong` shared
  dict directly (get/set/add) — `kong.cache`'s plugin-facing object exposes no write
  that composes with its `get`, so owning the dict makes a rotation refetch persist.

`KONG_UNTRUSTED_LUA=on` is required because the pre-function `require`s those Kong
core + crypto modules; the Lua is **ours** (committed + reviewed), not user-supplied.

### What the pre-function does, in order (access phase, runs FIRST)

The `pre-function` priority is `1000000`, so it runs before `cors` (2000) and
`rate-limiting` (901). It **fails closed** — every failure returns and the request
**never** reaches the upstream and **no** identity is injected:

1. **Strip** inbound `X-User-Id` / `X-Roles` **unconditionally, before any early
   return** (anti-spoof — a spoofed header cannot survive on any path).
   *Genuine CORS preflight* (`OPTIONS` + `Access-Control-Request-Method`) is then
   deferred to the `cors` plugin; everything else must authenticate.
2. Extract the bearer token from the **`Authorization` header only** (no query/cookie).
3. **Pin `alg = RS256`** — reject `none`, `HS*`, anything else *before* verifying.
4. Read `kid`; fetch **JWKS** (`{issuer}/protocol/openid-connect/certs`, cached
   `ttl=300s`), select the RSA signing key by `kid`. On an **unknown kid** (rotation
   or attacker) allow **one forced refetch per 30s** (atomic `ngx.shared.kong:add`)
   so a bad kid cannot hammer Keycloak; still unknown → reject.
5. Build the RSA key from the JWK and **verify the RS256 signature** over
   `header_64 . "." . claims_64`.
6. Validate claims: `iss` **exact-match** the configured issuer; `aud` **contains**
   `supercool-api` (string *or* array); `exp` (and `nbf` if present) within a **60s
   clock-skew**.
7. **Role gate:** `realm_access.roles` must include `customer` → else **403**; a
   missing/invalid/unverifiable token → **401** (matching the balance service's
   `gateway-identity.guard.ts`). On full success, **inject** `X-User-Id` = `sub` and
   `X-Roles` = comma-joined roles (`set_header` overwrites).

### Kept alongside it

- `cors` — allow only the SPA origin (`http://localhost:8080`), credentials on;
  answers preflight (deferred from the pre-function).
- `rate-limiting` — per-IP fixed window (`minute:60`, `policy:local` — DB-less); a
  burst over the cap → **429**.

## Header contract (consumed by the balance service)

The gateway guard (`services/balance-service/.../gateway-identity.guard.ts`) trusts
**only** these Kong-injected headers — never a user id from the body/query:

| Header | Value | Source |
|---|---|---|
| `X-User-Id` | token `sub` | injected by the pre-function; inbound copies stripped |
| `X-Roles` | comma-separated `realm_access.roles` (e.g. `customer`) | injected by the pre-function; inbound copies stripped |

## Issuer / audience are fixed constants (not env-interpolated)

Kong's **DB-less declarative config does not interpolate env vars**, so `kong.yml`
carries them literally in the pre-function:

- `ISSUER` = `http://keycloak.localtest.me:8082/realms/supercool` — fixed by the
  compose alias `KC_HOSTNAME`, `KEYCLOAK_PORT` and the realm name. If you change
  `KC_HOSTNAME`/`KEYCLOAK_PORT` in `.env`, update this constant too.
- `EXPECTED_AUD` = `supercool-api` — must match the `oidc-audience-mapper` in
  [`tools/keycloak/realm-export.json`](../../tools/keycloak/realm-export.json).

Kong reaches `keycloak.localtest.me:8082` for the JWKS via the compose network alias
on `app-public` (spec 02's load-bearing detail).

## Healthcheck

`kong health` — checks the local node's processes; needs no Admin API (which is
turned **off**: DB-less has nothing to administer at runtime, and it shrinks the
attack surface). Gates `public-nginx` via `depends_on: service_healthy`.

## Verifying

```sh
# Config is valid (DB-less):
docker run --rm -e KONG_DATABASE=off -e KONG_PLUGINS=bundled -e KONG_UNTRUSTED_LUA=on \
  -v "$PWD/kong.yml":/kong/kong.yml:ro --entrypoint kong kong:3.9.0 config parse /kong/kong.yml

# With the full stack up (fresh .env from .env.example):
docker compose up -d

# Default-deny / fail-closed (no Keycloak token needed):
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/nope                    # 404
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/api/whoami              # 404 (bare /api not routed)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/balance/admin           # 404 (admin off the public plane)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/balance/api/whoami      # 401 (no token)
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'X-User-Id: attacker' http://localhost:8080/balance/api/whoami                     # 401 (never injected)
```

The full **valid-token** path (real customer token → `X-User-Id` reaches the
service; wrong-role → 403; expired/forged/`alg:none` → 401; rate-limit 429) is
exercised at the spec-06 **vertical-slice checkpoint** with the full stack and a
real Keycloak token. During implementation these were also proven against a **mock
JWKS + echo upstream**: valid customer token → `200` with `X-User-Id=<sub>`; a
request carrying a spoofed `X-User-Id`/`X-Roles` alongside a valid token still
delivered only the token-derived identity; wrong-role → `403`; expired / wrong-aud /
forged-signature / `alg:none` → `401`. The **service-namespaced strip** was also
confirmed live: external `/balance/api/whoami` reached the (mock) upstream as
`/api/whoami`, while bare `/api`, `/balance/admin`, and `/admin` → `404`.
