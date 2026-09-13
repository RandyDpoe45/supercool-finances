# SuperCool Finances

A safety-critical demo service for managing customer account balances: customer money is
never created, lost, or moved without authorization. A public customer surface and a
private admin surface sit behind gateways, over an authoritative transactional core plus a
derived analytics read model, all orchestrated with Docker Compose.

- **What it is / why:** [`docs/`](docs/) — architecture, decisions (ADRs), threat model.
- **What to build, in order:** [`specs/`](specs/) (start at [`specs/README.md`](specs/README.md)).
- **How we build it (the working agreement):** [`CLAUDE.md`](CLAUDE.md).

---

## Run the demo (public plane)

This is the **public-plane** demo: the customer SPA + the out-of-band OTP SPA, the
identity provider, the gateway, and the balance service — proving a full
**transfer-with-OTP** from the browser. (The admin plane — the admin SPA and internal
front door `:8081` — is deferred; see the scope note below.)

### Prerequisites

- **Docker Desktop** (Compose v2) running.
- **`*.localtest.me` must resolve to `127.0.0.1`.** The browser reaches the apps at
  `http://localhost:8080` and **Keycloak at `http://keycloak.localtest.me:8082`** — the
  OIDC issuer host must be byte-identical for the browser and for in-container services,
  which is why it is a hostname, not `localhost`. Public DNS already maps `*.localtest.me`
  to `127.0.0.1`; if your host has no such DNS (offline / split-horizon), add this line to
  your hosts file (`/etc/hosts`, or `C:\Windows\System32\drivers\etc\hosts`):

  ```
  127.0.0.1 keycloak.localtest.me
  ```

- **Node ≥ 24** — only if you want to run the end-to-end test (below).

### 1. Configure

```bash
cp .env.example .env
```

`.env` is git-ignored; `.env.example` ships **safe placeholder** values (local demo
passwords only — never real secrets). That copy is the **only** manual step.

### 2. Bring the stack up (wait for all-healthy)

```bash
docker compose up --build          # or: docker compose up -d --build --wait
```

On a clean machine the first run pulls base images and builds four app images (two NestJS
services + two Vite SPAs), so it takes several minutes. It is up when every service is
**healthy**: datastores → Keycloak (realm imported) → balance-service (migrations run on
boot) → public-Kong → the SPAs → public-nginx.

Host-published surfaces this pass: **`:8080`** (public-nginx, the front door) and
**`:8082`** (Keycloak, for the login redirect). Nothing else is published.

### 3. Load the demo data (idempotent seed)

```bash
docker compose --profile seed run --rm seed   # one-shot: runs the seed and returns when it exits
```

> Use `run --rm seed`, **not** `--profile seed up`. `up` attaches to the logs of the
> whole dependency graph (the long-running `balance-service`, `postgres`, …), so it keeps
> streaming after the seed container has finished and never returns to the prompt. `run`
> attaches to **only** the seed container and returns with its exit code; `--rm` removes
> that one-shot container afterward. (The stack from step 2 is already up, so this just
> runs the seed against it.)

This loads the demo customers + their MXN accounts into the balance DB (system constants —
currency, clearing accounts, baseline limits — are already seeded by boot migrations, not
by this step). It is **idempotent**: re-running it changes nothing.

- **Customer A** — the login: account `1000000001`, funded **1,000,000.00 MXN**.
- **Customer B** — the transfer destination (no login): account `1000000002`.

### 4. Log in and move money

1. Open **http://localhost:8080** and log in as the seeded customer:

   | Username | Password |
   |---|---|
   | `demo-customer` | `demo-customer-pw` |

   *(Demo credentials from the committed `tools/keycloak/realm-export.json` — local demo
   only.)* You land on **Your accounts** and see account `1000000001`.

2. **Send money → confirmation-of-payee.** Choose *Send money*, enter destination
   `1000000002`, look it up, and confirm the masked payee.
3. **Amount + captcha.** Enter an amount (e.g. `10.00`), solve the demo captcha, *Send*.
   The transfer is now **pending**, awaiting the out-of-band code.
4. **Reveal the OTP out-of-band.** In a **second tab**, open **http://localhost:8080/otp/**,
   log in as the same `demo-customer`, and *reveal* the one-time code for the pending
   authorization (shown once).
5. **Confirm.** Back in the first tab, enter the code and *Confirm transfer*. The transfer
   settles and the source balance drops by exactly the amount.

### 5. Tear down

```bash
docker compose down        # stop; keep data volumes
docker compose down -v      # stop and remove volumes (fresh next boot)
```

A clean, repeatable re-run is `down -v` → step 2 → step 3 (migrations no-op, seed no-op).

---

## Automated end-to-end (the same flow, headless)

A one-command harness brings the stack up all-healthy, seeds, installs a browser, and runs
the client **transfer-with-OTP** Playwright e2e against the real chain (driving the real
otp-app in a second browser context), then tears down:

```bash
bash tests/e2e-fullrun/run.sh          # full run; tears down at the end
bash tests/e2e-fullrun/run.sh keep     # leave the stack up for inspection
```

It uses an isolated compose project + an `--env-file` temp copy of `.env.example`, so it
never touches your `.env`. See [`tests/e2e-fullrun/README.md`](tests/e2e-fullrun/README.md)
for the seed↔e2e env contract and what each phase proves. Other acceptance harnesses live
alongside it under [`tests/`](tests/) (`macro`, `storage`, `keycloak`, `transport`,
`build-serve`, `seed`).

---

## Scope note — this pass is the public plane only

The admin plane is deferred: the **admin SPA is not built** and the **internal transport
edge** (`internal-nginx` / `:8081`, `internal-kong`) is not in this compose graph, so the
**admin maker-checker reversal from the admin app** and the **`:8081`** front door are out
of this pass. They remain the eventual target. This pass delivers the public plane end to
end: the client + otp SPAs behind `public-nginx`, the seed, and a clean-machine
`docker compose up --build` proving the **transfer-with-OTP** flow. See
[`specs/08-build-and-serve.md`](specs/08-build-and-serve.md) §"Full run".
