# public-nginx — customer front door (spec 06 edge + spec 08 router)

The **only host-published surface of the public plane** (`:8080` → `:80`). As of
spec 08 it is the thin **router** that ASSEMBLES the per-SPA atomic images
(developer ruling): it holds **no** bundles itself — each SPA image serves its own
— and forwards `/balance/api/*` to the gateway.

- **Image:** stock `nginx:1.27-alpine` (pinned) with a **read-only mounted**
  [`nginx.conf`](./nginx.conf) — no custom image needed (config as code, spec 00 §4).
  (Each SPA image bakes its OWN small nginx conf; that is the *image's* config, not
  this mounted router config.)
- **Networks:** `edge-public` **only** — it reaches the gateway + the two SPA
  images over that network, never a service directly.
- **Host-published:** `${PUBLIC_HTTP_PORT}` (=`8080`) → `:80`.

## What it does

nginx matches by **longest prefix**, so `/balance/api/` and `/otp/` win over the
`/` catch-all regardless of order. All three proxy blocks use a **variable
upstream + `resolver`** (per-request DNS; see below) and forward the original URI
verbatim (`$request_uri`); the SPA images own their own history fallback.

| Location | Behavior |
|---|---|
| `GET /healthz` | nginx **liveness** (static `200 ok`) — NOT an API; backs the compose healthcheck. |
| `/balance/api/*` | Reverse-proxy → `public-kong:8000`, forwarding the **service-namespaced** path verbatim. Kong strips `/balance` and delivers `/api/...` to balance-service (ADR-17). nginx injects **no** identity — Kong owns auth + identity injection. |
| `/otp/*` | Reverse-proxy → `otp-app:80`, **prefix preserved** (NOT stripped). That bundle is built for `base: '/otp/'`, so its assets + OIDC redirect live under `/otp/`; the otp-app image serves them from `…/html/otp/` and owns the `/otp/` fallback. |
| `/` | Catch-all reverse-proxy → `client-app:80`. The client bundle is built for `base: '/'`, served at the origin root; the client-app image owns the `/index.html` fallback. |

## TLS — plain HTTP on localhost (resolved)

TLS is **not** terminated here. This prototype runs plain HTTP over the loopback
edge (spec 06 open question, resolved), consistent with the `http` issuer scheme
(spec 02). In a real deployment TLS would terminate at this hop and **nothing
downstream would change**.

## Runtime DNS for the upstreams

Every proxy block (`/balance/api/`, `/otp/`, `/`) uses a **variable** upstream host
plus a `resolver 127.0.0.11` (Docker's embedded DNS) so `public-kong` / `otp-app` /
`client-app` are resolved **per request**, not once at startup — a restart / new
container IP is picked up without restarting nginx. (A literal
`proxy_pass http://public-kong:8000;` would resolve once at boot and also make
`nginx -t` fail when the name isn't yet resolvable.)

Startup order: `depends_on: { public-kong, client-app, otp-app }` all
`service_healthy` — until each upstream is healthy its route would 502, so nginx
waits for all three.

## Verifying

```sh
# Config syntax is valid (no network needed — the upstreams are runtime variables):
docker run --rm -v "$PWD/nginx.conf":/etc/nginx/nginx.conf:ro nginx:1.27-alpine nginx -t

# With the stack up:
docker compose up -d --build
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/healthz            # 200
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/                   # 200 (client SPA)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/otp/               # 200 (otp SPA)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/balance/api/whoami # 401 (no token; via Kong)
```
