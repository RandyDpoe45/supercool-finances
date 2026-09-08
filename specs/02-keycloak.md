# Spec 02 — Keycloak (Identity Provider)

**Purpose.** Authenticate humans and issue signed JWTs consumed by the gateways
and services. Provisioned reproducibly from a realm export — no manual clicking.

**Depends on.** [`01-storage.md`](./01-storage.md) (the `keycloak` database).

## Moving parts & configuration

- Container `keycloak`, `KC_DB=postgres` pointing at the `keycloak` DB (spec 01).
- Boot with `--import-realm`, mounting `realm-export.json` from the repo.
- Host-published on `:8082` for the browser login redirect; also on `app-public`,
  `app-internal`, `data` for server-to-server (spec 00 §2).

### Realm `supercool`

- **Clients** (all public, Authorization Code + PKCE):
  - `client-app` — redirect URIs to the public nginx origin.
  - `otp-app` — redirect URIs to the public nginx (OTP path/origin).
  - `admin-app` — redirect URIs to the internal nginx origin.
  - (If Kong does live introspection, a confidential client `kong-introspect`
    with credentials.)
- **Roles** (realm roles): `customer`, `admin`. Seeded users carry the right role.
- **Token settings:** short access-token lifespan (≈5 min) + refresh tokens.
  Ensure the token carries `sub` (→ object-level authz) and a roles claim Kong can
  read (realm-roles mapper), plus the correct `aud`.
- **Seeded users:** at least one `customer` and one `admin` (credentials in the
  export) so the demo works on first boot.

## The issuer-URL resolution (the load-bearing detail)

**Decision: a shared host alias.** Use one hostname that resolves to the same
Keycloak from both the browser and the containers — e.g. a domain like
`keycloak.localtest.me` (which resolves to `127.0.0.1`) published on `:8082`, plus
a compose **network alias** so containers resolve that same name to the Keycloak
container. Set `KC_HOSTNAME` to it, so the token `issuer` is identical on both
sides. Verify by minting a token in the browser flow and validating it inside a
service.

## Contracts / interfaces

- **JWKS URL** and **issuer** → consumed by Kong (JWT plugin) and the services.
- **Introspection endpoint** → optional, for live revocation in Kong.
- **`sub`** → the user id used for object-level authz (spec 04).
- **roles claim** → used by Kong ACL (spec 06) and admin role checks.

## Definition of Done

- [ ] `docker compose up` imports the realm with clients, roles, and seed users.
- [ ] A seeded `customer` and `admin` can log in via PKCE.
- [ ] An issued token contains `sub` and the expected role; `aud`/`iss` correct.
- [ ] JWKS is reachable by both Kongs; a browser-minted token validates inside a
      service (issuer consistency proven).

## Resolved

- **Issuer:** shared host alias (above).
- **Kong validation:** JWKS-only — see spec 06.
