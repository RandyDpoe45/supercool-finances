# internal-nginx — admin front door (spec 06 edge + spec 08 router)

The host-published surface of the **internal (admin) plane** (`:8081` → `:80`,
**demo-only** exposure). As of the spec 08 admin step it is the thin **router** that
both reverse-proxies the admin APIs to `internal-kong` **and** serves the admin SPA:
its `/` catch-all now proxies to the `admin-app` image (a per-SPA atomic image that
holds its own bundle — internal-nginx holds none). This is the internal-plane mirror
of `public-nginx` (`/` → `client-app`).

- **Image:** stock `nginx:1.27-alpine` (pinned) with a **read-only mounted**
  [`nginx.conf`](./nginx.conf) — no custom image (config as code, spec 00 §4).
- **Networks:** `edge-internal` **only** — it never reaches services directly; the
  internal gateway is its sole upstream.
- **Host-published:** `${INTERNAL_HTTP_PORT}` (=`8081`) → `:80`. This is a **demo
  convenience** — the internal plane would not be host-exposed in production.

## What it does

| Location | Behavior |
|---|---|
| `GET /healthz` | nginx **liveness** (static `200 ok`) — NOT an API; backs the compose healthcheck. |
| `/balance/admin/*` | Reverse-proxy → `internal-kong:8000`, forwarding the **service-namespaced** path verbatim (`$request_uri`). Kong strips `/balance` and delivers `/admin/...` to balance-service (ADR-17). |
| `/analytics/admin/*` | Reverse-proxy → `internal-kong:8000`; Kong strips `/analytics` and delivers `/admin/...` to analytics-server. |
| `/` | **Catch-all** → the `admin-app` image (`admin-app:80`), forwarding the original URI verbatim (`$request_uri`). That bundle is built for base `/` and owns its own `try_files … /index.html` history fallback (spec 08 admin step). |

nginx injects **no** identity — Kong owns auth (admin gate) + identity injection.

## TLS — plain HTTP on localhost (resolved)

TLS is **not** terminated here. This prototype runs plain HTTP over the loopback
edge (spec 06 open question, resolved). In a real deployment TLS would terminate at
this hop and **nothing downstream would change**.

## Runtime DNS for the upstreams

Every proxied location uses a **variable** upstream host plus a `resolver 127.0.0.11`
(Docker's embedded DNS) so `internal-kong` (the admin APIs) and `admin-app` (the `/`
SPA catch-all) are each resolved **per request**, not once at startup — a container
restart / new IP is picked up without restarting nginx.

Startup order: `depends_on: internal-kong (service_healthy)` and `admin-app
(service_healthy)` — until the gateway is healthy `/*/admin` would 502, and until the
SPA image is healthy `/` would 502, so nginx waits for both.

## Verifying

```sh
# Config syntax is valid (no network needed — the upstream is a runtime variable):
docker run --rm -v "$PWD/nginx.conf":/etc/nginx/nginx.conf:ro nginx:1.27-alpine nginx -t

# With the stack up:
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8081/healthz                 # 200
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8081/                        # 200 (admin SPA shell)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8081/balance/admin/whoami    # 401 (no token; via Kong)
```
