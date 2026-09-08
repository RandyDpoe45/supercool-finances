# Keycloak — identity provider (spec 02)

The `keycloak` container is the system's **identity provider**: it authenticates
humans and issues signed JWTs that the gateways (Kong) and the services validate.
It is provisioned **reproducibly from a realm export** — no manual clicking — and
stores its state in the `keycloak` Postgres database from step 1.

- **Image:** `quay.io/keycloak/keycloak:26.7.3` (pinned — see [Image pin](#image-pin)).
- **Networks:** `data` (→ Postgres), `app-public`, `app-internal` (spec 00 §2).
- **Host-published:** `:8082` only (the browser login redirect; spec 00 §3).
- **Realm export:** [`tools/keycloak/realm-export.json`](../../tools/keycloak/realm-export.json),
  mounted read-only into `/opt/keycloak/data/import/` and consumed by
  `start --import-realm` on first boot.

## Issuer resolution — why `keycloak.localtest.me:8082`

A JWT's `issuer` (`iss`) must be **byte-identical** as seen by the browser that
logs in and by the containers that validate the token. If the browser mints a
token against `localhost:8082` but a service inside Docker only knows the host as
`keycloak:8080`, the `iss` (and the `jwks_uri` discovered from it) won't match and
validation fails. This is the single most common Keycloak-in-Docker failure
(spec 00 §3), so it is pinned deliberately:

- **One canonical name for everyone: `keycloak.localtest.me`.**
  - The browser resolves it via **public DNS** — `*.localtest.me` resolves to
    `127.0.0.1` — and reaches the container through the published `:8082`.
  - In-container callers resolve the **same** name through a compose **network
    alias** (`keycloak.localtest.me`) attached to the container on `app-public`
    and `app-internal`, so Docker's embedded DNS returns the container's IP.
- **One port for everyone: `8082`.** `KC_HTTP_PORT` is set to `8082` (from
  `KEYCLOAK_PORT`) and the host publishes `8082:8082`, so the port in the issuer
  matches from the browser *and* from containers.
- **`KC_HOSTNAME` is set to the full URL** `http://keycloak.localtest.me:8082`
  (Keycloak 26 hostname v2). This fixes both the front-channel and back-channel
  base URL, so the discovery document returns the same `issuer` regardless of
  which side (or which `Host` header) requested it.

The result — the authoritative issuer string:

```
http://keycloak.localtest.me:8082/realms/supercool
```

TLS is **not** terminated here (`KC_HTTP_ENABLED=true`, `sslRequired: none` in the
realm). In the full topology TLS terminates at nginx (step 4); Keycloak speaks
plain HTTP behind it, which is why the issuer scheme is `http` for this demo.

## Consumer endpoints (OIDC)

All derived from the issuer; consumers should read them from discovery rather than
hard-coding:

| Endpoint | URL |
|---|---|
| Issuer (`iss`) | `http://keycloak.localtest.me:8082/realms/supercool` |
| Discovery | `…/realms/supercool/.well-known/openid-configuration` |
| JWKS (Kong + services) | `…/realms/supercool/protocol/openid-connect/certs` |
| Authorization | `…/realms/supercool/protocol/openid-connect/auth` |
| Token | `…/realms/supercool/protocol/openid-connect/token` |
| Introspection (optional) | `…/realms/supercool/protocol/openid-connect/token/introspect` |

Kong (spec 06) validates **JWKS-only** (signature + `iss`); there is no live
introspection and therefore **no `kong-introspect` confidential client**.

## Realm `supercool`

### Clients (all **public**, Authorization Code + **PKCE S256**, no secret)

| Client | Loads from (browser) | Redirect URIs | Web origins (CORS) |
|---|---|---|---|
| `client-app` | public-nginx `:8080` | `http://localhost:8080/*` | `http://localhost:8080` |
| `otp-app` | public-nginx `:8080` (OTP path) | `http://localhost:8080/otp/*`, `http://localhost:8080/*` | `http://localhost:8080` |
| `admin-app` | internal-nginx `:8081` | `http://localhost:8081/*` | `http://localhost:8081` |

The redirect URIs / web origins use `localhost:8080` / `:8081` because those are
the **browser-facing** origins where the SPAs load (spec 00 §3) — distinct from
the issuer host, which is where the browser is redirected *to* log in. They are
validated end-to-end at the step-4 vertical slice.

All three clients are **Authorization Code + PKCE (S256) only** —
`directAccessGrantsEnabled` is `false`, so the insecure ROPC/password grant is
off on these public SPA clients (it bypasses the browser + PKCE). Tests mint
tokens by driving the real PKCE flow headlessly (see `tests/keycloak`), not via a
password grant.

### Realm roles

- `customer` — object-level authz over the caller's own accounts (`sub`-scoped).
- `admin` — privileged admin-plane operations behind the internal gateway.

### Token claims (what the access token carries)

- **`sub`** — the Keycloak user id; the object-level authz key (spec 04).
- **`realm_access.roles`** — the realm-roles array (`customer` / `admin`), emitted
  by the built-in realm-roles mapper on the default `roles` client scope. This is
  the claim Kong's ACL (spec 06) and the services read.
- **`aud`** — includes **`supercool-api`**, added by an `oidc-audience-mapper`
  configured on each client. This is the audience Kong consumes in spec 06.
- Access-token lifespan is **300s (5 min)**; refresh tokens are enabled.

### Seed users (DEMO-ONLY credentials)

Both users ship in the realm export with a password so the demo works on first
boot. These are **throwaway demo credentials**, in the same spirit as the
`.env.example` placeholders — **never** real secrets, and safe to be in the repo.

| Username | Password | Realm role |
|---|---|---|
| `demo-customer` | `demo-customer-pw` | `customer` |
| `demo-admin` | `demo-admin-pw` | `admin` |

The **master-realm** bootstrap admin (for the admin console / REST API) is a
separate account and is **not** in the export — its credentials come from
`KC_BOOTSTRAP_ADMIN_USERNAME` / `KC_BOOTSTRAP_ADMIN_PASSWORD` in `.env` and are
never committed.

## Import mechanism

`command: ["start", "--import-realm"]` runs Keycloak in production mode and imports
every realm JSON found under `/opt/keycloak/data/import/` on boot. The export is
mounted **read-only** from `tools/keycloak/realm-export.json` (config as code,
spec 00 §4). Import is effectively first-boot provisioning: once the realm exists
in the `keycloak` DB (which persists on the `pg-data` volume), a re-import does not
overwrite the existing realm. To re-provision from scratch, drop the Postgres
volume (`docker compose down -v`) and bring the stack back up.

## Database

Keycloak connects to the `keycloak` Postgres database (step 1) using **discrete
credentials** — `KC_DB=postgres`, `KC_DB_URL_HOST=postgres`,
`KC_DB_URL_DATABASE=keycloak`, `KC_DB_USERNAME=${POSTGRES_KEYCLOAK_USER}`,
`KC_DB_PASSWORD=${POSTGRES_KEYCLOAK_PASSWORD}`. No full JDBC-URL variable is
introduced; the credential lives in exactly one place (spec 01 § Contracts). The
`keycloak` role can only `CONNECT` to the `keycloak` database (per-role isolation,
see [`infra/postgres/README.md`](../postgres/README.md)).

## Healthcheck

The minimal Keycloak image has **no** `curl`/`wget`, but `/bin/sh` is `bash` with
`/dev/tcp` support. The healthcheck opens a TCP socket to the **management port
`9000`** (enabled by `KC_HEALTH_ENABLED=true`, separate from the `8082` app port),
issues `GET /health/ready`, and requires the JSON `"status": "UP"`. The container
therefore only reports **healthy** once the DB migration and realm import have
completed — which is what gates `balance-service` in step 3 (`depends_on:
service_healthy`).

## Image pin

Spec 00's baseline lists `keycloak:latest`. This step pins
`quay.io/keycloak/keycloak:26.7.3` instead: a **reproducible-from-zero** boot
(the project's guiding constraint) cannot depend on a moving `:latest` tag. This is
a documented, reasoned deviation, not a scope change.

## Verifying (fresh volume)

```sh
# Fresh slate so step-1's postgres init creates the `keycloak` DB + role.
docker compose down -v
cp .env.example .env
docker compose --env-file .env up -d

# Keycloak reaches healthy (postgres gated it):
docker compose ps

# Discovery + issuer from the HOST (browser side):
curl -s http://keycloak.localtest.me:8082/realms/supercool/.well-known/openid-configuration

# Same discovery from INSIDE the docker network on app-public — a throwaway
# container joined to app-public, resolving the SAME name via the compose alias
# (no other service lives on app-public yet). Project name -> network prefix:
docker run --rm --network supercool-finances_app-public curlimages/curl:latest \
  -s http://keycloak.localtest.me:8082/realms/supercool/.well-known/openid-configuration
# The `issuer` field must be identical on both sides.
```
