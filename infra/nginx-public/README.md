# public-nginx — customer front door (spec 06, public edge)

The **only host-published surface of the public plane** (`:8080` → `:80`). It is a
thin reverse proxy in front of `public-kong`, and will also serve the customer +
OTP SPA bundles once spec 08 builds them.

- **Image:** stock `nginx:1.27-alpine` (pinned) with a **read-only mounted**
  [`nginx.conf`](./nginx.conf) — no custom image needed (config as code, spec 00 §4).
- **Networks:** `edge-public` **only** — it never reaches services directly; the
  gateway is its sole upstream.
- **Host-published:** `${PUBLIC_HTTP_PORT}` (=`8080`) → `:80`.

## What it does

| Location | Behavior |
|---|---|
| `GET /healthz` | nginx **liveness** (static `200 ok`) — NOT an API; backs the compose healthcheck. |
| `/api/*` | Reverse-proxy → `public-kong:8000`, **preserving the `/api` prefix** (`$request_uri` is forwarded verbatim). nginx injects **no** identity — Kong owns auth + identity injection. |
| `/` | **Placeholder** (currently `404`). The client + OTP SPA bundles are wired here in **spec 08**; the commented `root` / `try_files` show the intended shape. |

## TLS — plain HTTP on localhost (resolved)

TLS is **not** terminated here. This prototype runs plain HTTP over the loopback
edge (spec 06 open question, resolved), consistent with the `http` issuer scheme
(spec 02). In a real deployment TLS would terminate at this hop and **nothing
downstream would change**.

## Runtime DNS for the upstream

The `/api/` proxy uses a **variable** upstream host plus a `resolver 127.0.0.11`
(Docker's embedded DNS) so `public-kong` is resolved **per request**, not once at
startup — a Kong restart / new container IP is picked up without restarting nginx.
(A literal `proxy_pass http://public-kong:8000;` would resolve once at boot and
also make `nginx -t` fail when the name isn't yet resolvable.)

Startup order: `depends_on: public-kong (service_healthy)` — until the gateway is
healthy, `/api` would 502, so nginx waits for it.

## Verifying

```sh
# Config syntax is valid (no network needed — the upstream is a runtime variable):
docker run --rm -v "$PWD/nginx.conf":/etc/nginx/nginx.conf:ro nginx:1.27-alpine nginx -t

# With the stack up:
docker compose up -d
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/healthz     # 200
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/            # 404 (SPA: spec 08)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/api/whoami  # 401 (no token; via Kong)
```
