# Spec 00 — Macro Architecture & Compose Topology

**Purpose.** Define the moving parts, the Docker network segmentation, the
host-published surface, volumes, and the startup/health order. This is the macro
contract every other spec plugs into. If a later spec cannot satisfy something
here, fix it *here* first (see the [methodology](./README.md#methodology--top-down-macro--micro)).

**Depends on.** Nothing. This is step 0.

For the request-flow and rationale, see
[../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md); this spec is the deployment
view of that design.

---

## 1. Moving parts

| Container | Role | Image (baseline) | Host-published |
|---|---|---|---|
| `public-nginx` | Public ingress: serves client + OTP SPAs, proxies `/api` → public Kong | `nginx:alpine` | **yes** — `:8080` |
| `internal-nginx` | Internal ingress: serves admin SPA, proxies `/admin` → internal Kong | `nginx:alpine` | **demo only** — `:8081` |
| `public-kong` | Public PEP: JWT/role/rate-limit for `/api` | `kong:3.x` (DB-less) | no |
| `internal-kong` | Internal PEP: admin-role enforcement for `/admin` | `kong:3.x` (DB-less) | no |
| `keycloak` | Identity Provider (authN), realm imported at boot | `keycloak:latest` | **yes** — `:8082` (browser login) |
| `balance-service` | Ledger, transfers, limits, OTP module, outbox **relay worker** | built (NestJS) | no |
| `analytics-server` | Stream consumer + Mongo read model + reporting API | built (NestJS) | no |
| `postgres` | Source of truth: ledger + outbox (+ Keycloak DB) | `postgres:16` | no |
| `redis` | OTP codes + Redis Streams transport | `redis:7` | no |
| `mongo` | Analytics read model (analytics-owned) | `mongo:7` | no |

> **Only edges are published.** `public-nginx` is the customer front door;
> `internal-nginx` is published on a distinct port **for the demo only** (in
> production it lives on a separate/VPN network). `keycloak` must be reachable by
> the browser for the OIDC login redirect. Everything else is internal.

## 2. Network segmentation

Five Docker networks keep the two planes isolated at the infrastructure level. The
public and internal edges share **no** network; the planes meet only at the
deliberately-shared services and Keycloak.

| Network | Purpose | Members |
|---|---|---|
| `edge-public` | Customer browser → public front door | `public-nginx`, `public-kong` |
| `edge-internal` | Admin browser → **private** internal front door | `internal-nginx`, `internal-kong` |
| `app-public` | Public gateway → services it may reach | `public-kong`, `balance-service`, `keycloak` |
| `app-internal` | Internal gateway → services it may reach | `internal-kong`, `balance-service`, `analytics-server`, `keycloak` |
| `data` | Services → datastores | `balance-service`, `analytics-server`, `postgres`, `redis`, `mongo`, `keycloak` |

Consequences that make the isolation *real*, not aspirational:

- **The public and internal edges never share a network.** `public-nginx` /
  `public-kong` (on `edge-public`) cannot reach `internal-nginx` /
  `internal-kong` (on `edge-internal`) at all — the internal gateway is genuinely
  private.
- **The two gateways never share a network either** — `public-kong` is on
  `app-public`, `internal-kong` on `app-internal`, so there is no lateral path
  between them. They converge only *on the services*.
- **Analytics is on no public network** — `analytics-server` sits on
  `app-internal` + `data` only, so the public plane cannot reach it even at L3,
  consistent with it having no `/api`.
- **Databases sit only on `data`** — no gateway or browser can reach them.
- **Services sit on `app-*` + `data`, never on `edge-*`** — reachable only via a
  Kong, the only component that injects the trusted identity header.
- `/internal/*` endpoints are reachable only by peers on the `app-*` nets; no
  gateway routes them (enforced again in Kong allowlists — see spec 06).

Keycloak is the one shared identity component: reachable by both gateways
(JWKS / introspection), both services, and the browser via its host port (§3).
Its issuer URL must be consistent across all of them (§3 gotcha).

## 3. Host port map (demo)

| Port | Serves | Notes |
|---|---|---|
| `8080` | `public-nginx` | Client SPA, OTP SPA, `/api` |
| `8081` | `internal-nginx` | Admin SPA, `/admin` — demo-only exposure |
| `8082` | `keycloak` | Login UI + OIDC/JWKS/introspection |

**Issuer-URL gotcha (pin now):** the token `issuer` must be identical as seen by
the browser *and* by the services validating tokens. Use one canonical Keycloak
URL (`KC_HOSTNAME`) reachable under the same name from both, or tokens validate in
the browser flow but fail signature/issuer checks in the services. This is the
most common Keycloak-in-Docker failure. Resolved in spec 02.

## 4. Volumes

| Volume | Backs | Why |
|---|---|---|
| `pg-data` | `postgres` | Ledger + outbox durability (source of truth) |
| `mongo-data` | `mongo` | Read model persistence |
| `redis-data` | `redis` (optional) | OTP is disposable; persistence optional |

Realm export, seed SQL, Kong declarative config, and nginx config are **mounted
from the repo** (config as code), not baked into images where avoidable.

## 5. Startup & health order

`depends_on` with health conditions enforces this chain; nothing starts before its
prerequisites are healthy:

```
postgres, redis, mongo   (healthy)
        ↓
keycloak                 (realm imported, healthy)
        ↓
balance-service, analytics-server   (migrations run on boot, healthy)
        ↓
public-kong, internal-kong          (declarative config loaded)
        ↓
public-nginx, internal-nginx        (upstreams reachable)
```

- Each backend runs its **migrations on boot** (balance service at minimum) and
  exposes `/internal/health` for the healthcheck.
- Kong healthchecks its route/plugin config load.
- nginx comes last so it never serves before its upstream exists.

## 6. Environment & secrets conventions

- One `.env` at the compose root holds non-secret config (ports, hostnames, DB
  names, Kong/Keycloak URLs). Committed as `.env.example`.
- Secrets (DB passwords, Keycloak admin, client secrets) via Docker secrets or a
  git-ignored `.env` — **never** in images or committed files.
- Each service reads config through NestJS `ConfigModule` (validated on boot;
  fail fast on missing required vars).
- Datastore ownership is fixed: `postgres` + `redis` → balance service; `mongo` →
  analytics server (database-per-service; see
  [ADR-11](../docs/DECISIONS.md#adr-11--service-boundaries--data-ownership)).

## 7. Vertical-slice checkpoint

This macro is considered *proven* only when the end-to-end slice defined in the
[README](./README.md#the-vertical-slice-checkpoint-inside-step-4) passes:
browser token → `public-nginx` → `public-kong` → `balance-service` → `postgres`
→ response. Build breadth only after the slice is green.

## 8. Definition of Done (macro)

- [ ] `docker-compose.yml` skeleton exists with the five networks (§2) and the
      datastore + Keycloak containers, and comes up healthy.
- [ ] Network membership matches §2 (verified: a datastore is unreachable from
      `edge`; a service is unreachable from the browser except via a gateway).
- [ ] Only `:8080`, `:8081`, `:8082` are host-published.
- [ ] Startup order from §5 holds (no container serves before its deps are healthy).
- [ ] `.env.example` documents every required variable.

## 9. Open questions

- Confirm `internal-nginx` demo exposure on `:8081` is acceptable, or whether the
  admin plane should be reachable only via `docker exec`/a compose profile.
- Whether Keycloak shares the `postgres` instance (separate database) or gets its
  own container — baseline assumes a separate database in the same `postgres`.
