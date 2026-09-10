# internal-nginx — admin front door (spec 06, internal edge)

The host-published surface of the **internal (admin) plane** (`:8081` → `:80`,
**demo-only** exposure). A thin reverse proxy in front of `internal-kong`; it will
also serve the admin SPA bundle once spec 08 builds it.

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
| `/` | **Placeholder** (currently `404`). The admin SPA bundle is wired here in **spec 08**; the commented `root` / `try_files` show the intended shape. |

nginx injects **no** identity — Kong owns auth (admin gate) + identity injection.

## TLS — plain HTTP on localhost (resolved)

TLS is **not** terminated here. This prototype runs plain HTTP over the loopback
edge (spec 06 open question, resolved). In a real deployment TLS would terminate at
this hop and **nothing downstream would change**.

## Runtime DNS for the upstream

The admin proxies use a **variable** upstream host plus a `resolver 127.0.0.11`
(Docker's embedded DNS) so `internal-kong` is resolved **per request**, not once at
startup — a Kong restart / new container IP is picked up without restarting nginx.

Startup order: `depends_on: internal-kong (service_healthy)` — until the gateway is
healthy, `/*/admin` would 502, so nginx waits for it.

## Verifying

```sh
# Config syntax is valid (no network needed — the upstream is a runtime variable):
docker run --rm -v "$PWD/nginx.conf":/etc/nginx/nginx.conf:ro nginx:1.27-alpine nginx -t

# With the stack up:
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8081/healthz                 # 200
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8081/                        # 404 (SPA: spec 08)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8081/balance/admin/whoami    # 401 (no token; via Kong)
```
