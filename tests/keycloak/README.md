# Keycloak (Identity Provider) verification — Spec 02

Acceptance harness for **Step 2 — Keycloak**: the `supercool` realm imported at boot
(three public + PKCE clients, realm roles `customer`/`admin`, seeded users), real PKCE
logins, correct token claims, and the load-bearing **issuer consistency** across the
host and both app networks. It is the acceptance gate for the Definition of Done in
[`specs/02-keycloak.md`](../../specs/02-keycloak.md).

The checks are written **from the spec**, not from the implementor's files: each asserts
an intended invariant and is built to **fail on a real defect** (see "How this was
validated"). Names/values come from the Step-2 coordination contract; where a value can
vary — ports, master-admin creds, seed-user passwords — it is read from `.env.example`
or the realm export, never hardcoded.

> **Scope.** Kong and the services do not exist yet (steps 3-4). So the DoD line "a
> browser-minted token validates **inside a service**" is proven here only up to its
> achievable, load-bearing half — issuer byte-identical + JWKS reachable from both app
> networks. The remaining half ("validates inside a real service") lands at the
> **step-4 vertical-slice checkpoint** ([`specs/README.md`](../../specs/README.md)).

## Layout

| File | Purpose |
|---|---|
| `run.sh` | Orchestrator. Runs the static suite, then the runtime suite, then a summary. |
| `lib.sh` | All check functions + helpers (sourced by `run.sh`; never run directly). |
| `README.md` | This file. |

## Running

```bash
bash tests/keycloak/run.sh            # static checks, then runtime (default = "all")
bash tests/keycloak/run.sh static     # daemon-free checks only (1, 2, 3, 4, 4b, 5)
bash tests/keycloak/run.sh runtime    # daemon checks only (6-9)
```

- Written for **POSIX bash** (Git Bash on Windows). Not PowerShell.
- Exit code is **non-zero if any check FAILED**. **Skips never fail the run.**
- **Static** checks need the `docker` CLI (for `docker compose config`) + `python`, but
  **not** the daemon. **Runtime** checks need the daemon + `curl`; if either is
  absent — or if the `keycloak` service is not wired into the spine yet — they **SKIP
  with an explicit message** (never a false pass).

### Non-destructive by design

- Config resolution copies `.env.example` to a **throwaway temp file** via `--env-file`;
  it never creates, overwrites or requires a real `.env`.
- The runtime suite runs under its own project **`scfin-keycloak-test`** and tears down
  with `-v`, so it can only ever remove **its own** containers/volumes/networks. Its
  fresh Postgres volume means step-1's init provisions the `keycloak` DB/role
  automatically — the isolated project always starts clean.
- If host port **:8082** (or a container name) is already in use — e.g. your dev stack
  is up — the runtime suite **skips** with a message and **never tears down a stack it
  did not create**. Run `docker compose down` first if you want the runtime checks to
  execute.

## What each check proves (mapped to the DoD)

### Static (no daemon)

| # | Check | Proves (spec 02 / 00) |
|---|---|---|
| 1 | `docker compose config` resolves and a `keycloak` service is defined | Prerequisite; DoD "imported at boot". A missing service = step-2-not-done FAIL. |
| 2 | keycloak is on `app-public`+`app-internal`+`data` (never `edge-*`), host-publishes **only** `:8082`, and carries the network alias `keycloak.localtest.me` on **both** app networks | spec 00 §2/§3 membership + spec 02 §3 shared-host-alias (the issuer-consistency prerequisite). |
| 3 | Boot config: `--import-realm` in the command; realm export mounted into the import dir; `KC_HOSTNAME*` pins the shared alias; `KC_DB=postgres` wired to the `keycloak` DB | DoD "up imports the realm"; spec 02 §3 issuer; spec 01 database-per-service. |
| 4 | Realm export declares realm `supercool` + clients `client-app`/`otp-app`/`admin-app` (public, PKCE **S256**, auth-code, redirects set, an `oidc-audience-mapper` stamping `aud=supercool-api`) + roles `customer`+`admin` + ≥1 user per role + short access-token lifespan | DoD "clients, roles, seed users"; the config half of "log in via PKCE"; the audience contract at rest (Kong spec 06 filters on `aud=supercool-api`). |
| 4b | The three public SPA clients use **Authorization Code + PKCE only** — Direct Access Grants (ROPC), implicit flow, and service accounts all **off**, no consent screen | Security posture from spec 02 (clients are "Authorization Code + PKCE"). **Standing posture lock — see below.** |
| 5 | The **master admin** bootstrap password is env-driven (`${VAR}`) and not leaked into any tracked file; demo **seed-user** passwords are exempt | `CLAUDE.md` no-secrets rule. |

### Runtime (need the Docker daemon; isolated project, torn down with `-v`)

| # | Check | Proves (spec 02) |
|---|---|---|
| 6 | `up` postgres+keycloak; the `supercool` discovery doc returns 200 on the host | DoD "`docker compose up` imports the realm" — a 200 on `.../realms/supercool/...` means the realm imported and is served. |
| 7 | Via the **admin REST API** (master admin token → `admin-cli`): realm exists, all three clients present, both roles present, ≥1 user mapped to each role — with a **negative control** (a bogus clientId returns empty) | DoD "imports the realm with clients, roles, and seed users", end-to-end. |
| 8 | Discovery `issuer` is **byte-identical** on the host **and** inside a container on **both** `app-public` and `app-internal` (via the alias), and equals the canonical issuer; JWKS reachable from both app networks + serves keys | DoD "JWKS reachable by both Kongs; issuer consistency proven" (achievable half). |
| 9 | A seeded **customer** and **admin** each complete a real **Authorization Code + PKCE (S256)** login; the token carries `sub`, `iss` == canonical issuer, the realm-roles claim with the expected role, and `aud` **containing `supercool-api`** (the exact value Kong filters on, not merely non-empty) | DoD "a seeded customer and admin can log in via PKCE" + "token contains `sub` and the expected role; `aud`/`iss` correct". |

## How a token is obtained (Check 9) — scripted Authorization Code + PKCE

The token is minted by a **genuine, scripted Authorization-Code + PKCE (S256) flow**,
not by weakening any client. The flow (implemented in `python`'s `urllib` for reliable
cookie/redirect handling — equivalent to the curl approach the spec suggests, more
robust for the login-form HTML and session cookies) does exactly what a browser does:

1. Generate a `code_verifier` and its S256 `code_challenge`.
2. `GET` the authorization endpoint (login page) with the challenge; keep the session
   cookies.
3. `POST` the seeded user's credentials to the login-form action; capture the `302`
   redirect to `redirect_uri?code=…`.
4. Exchange the `code` at the token endpoint **with the `code_verifier`** — the step
   that actually exercises PKCE.

**Driven against the alias host.** The flow runs against
`http://keycloak.localtest.me:8082` (== `KC_HOSTNAME`), which is exactly the browser's
view: Keycloak renders absolute action URLs and scopes session cookies to
`KC_HOSTNAME`, and `start` mode enforces that host. Driving it against `localhost`
instead produces a cookie-domain mismatch and an HTTP 400 — so the flow uses the alias,
the public name that resolves to `127.0.0.1` (spec 02 §3). If the host cannot resolve
`keycloak.localtest.me` to loopback (a fully offline environment), Check 9 **skips**
with a message — an environment limitation, never a false pass; the config-level PKCE
posture is still proven by Checks 4/4b (S256, no ROPC) and issuer by Check 8.

Seed usernames + demo passwords are read from the realm export. If a `customer`/`admin`
seed user has no recoverable plaintext demo password (or a blocking required action),
Check 9 **skips that role** rather than pass — the config-level PKCE proof still stands.

We deliberately do **not** add Direct Access Grants (ROPC) to any SPA client to ease
token minting; the real browser flow is used instead (see Check 4b).

## How issuer consistency is proven (Check 8)

The single most common Keycloak-in-Docker failure is a token whose `issuer` differs
between the browser and the services. Check 8 fetches the OIDC discovery document:

- from the **host** (`localhost:8082`), and
- from **inside a container** attached to `app-public` and to `app-internal`, resolving
  `keycloak.localtest.me:8082` **via the compose network alias** (Docker embedded DNS).

It asserts every `issuer` is byte-identical **and** equals
`http://keycloak.localtest.me:8082/realms/supercool`, and that JWKS is reachable from
both app networks (what each Kong needs) and serves keys. Because the alias resolves to
the same container the browser reaches on `:8082`, a browser-minted token's `issuer`
matches what services on the app networks will validate against.

## Check 4b — the standing PKCE-only posture lock

The realm export configures all three public SPA clients as **Authorization Code + PKCE
only**: `directAccessGrantsEnabled: false`, `implicitFlowEnabled: false`,
`serviceAccountsEnabled: false`, and no consent screen. Check 4b asserts exactly that,
so it **passes** against the current export and acts as the **standing lock** that FAILS
the suite the moment any of those downgrades is re-enabled on a public client:

- **ROPC / Direct Access Grants** — lets anyone with a username+password mint tokens
  with **no** browser/PKCE flow.
- **Implicit flow** — returns tokens in the redirect URL fragment (leaks into browser
  history, server logs, `Referer` headers).
- **Service accounts** — hand a public SPA a machine (client-credentials) identity it
  has no business holding.

Each is a real weakening for a safety-critical money system; spec 02 lists these clients
as "Authorization Code + PKCE", so the export keeps all of them off.

> This started as an **escalation**: the first realm export shipped with
> `directAccessGrantsEnabled: true` on all three clients, and spec 02 is not *literally*
> explicit that ROPC must be off. The orchestrator resolved it by setting direct grants
> **off** on `client-app`, `otp-app`, `admin-app`. Check 4b is kept **isolated** from the
> structural realm proof (Check 4) so that, if a developer ever knowingly waived one of
> these toggles with a written reason, the waiver still could not mask the client/role/
> user proof — Check 4 stays green independently.

## Impact on the sibling suites (macro / storage) — a required, non-weakening fix

Adding `keycloak` to the spine introduced `${KEYCLOAK_PORT}` into a **structural** field
(`ports:`). Any `docker compose` subcommand that parses the file (`ps`, `down`, …) now
needs that variable interpolated, or it errors `no port specified` and silently does
nothing. That broke the macro suite's `docker compose ps` (Check 8 saw datastores as
`absent`) and both suites' teardown. Fix applied (test files only, **no assertion
changed**): a small `dc()` wrapper in `tests/macro/lib.sh` and `tests/storage/lib.sh`
that always supplies an `--env-file` (the runtime copy, or a throwaway from
`.env.example`) to those calls. After the fix, `tests/macro/run.sh all` and
`tests/storage/run.sh all` both pass **9/9, clean**. `tests/keycloak/lib.sh` supplies
the env file the same way from the start.

## How this was validated

- `bash -n` on `run.sh` and `lib.sh` (syntax).
- **Static** suite run against the implementor's actual files: Checks 1, 2, 3, 4, 4b, 5
  all **pass** — the realm export declares the three SPA clients as Authorization Code +
  PKCE only (direct grants / implicit / service accounts all off) and carries an
  `oidc-audience-mapper` stamping `aud=supercool-api`, so both the Check 4 audience proof
  and the Check 4b posture lock are green. (The first export shipped with ROPC on; once
  the orchestrator turned direct grants off, Check 4b flipped from fail to pass — see the
  posture-lock section above.) A self-inflicted false positive in Check 5 (an inverted
  condition) was found during validation and fixed — the check now correctly passes on
  the env-driven admin password.
- **Runtime** suite run end-to-end against the real stack (`quay.io/keycloak/keycloak:26.7.3`
  + `postgres:16`, fresh volumes): Checks 6, 7, 8 **pass**; Check 9 obtained **real
  tokens** for both `demo-customer` and `demo-admin` via the scripted PKCE flow, with
  `iss == http://keycloak.localtest.me:8082/realms/supercool`, a present `sub`, the
  correct realm role, and `aud = supercool-api`. The isolated project tore down cleanly
  with `-v` (no leftover containers/volumes/networks).
- The PKCE choreography itself was debugged against a live Keycloak until it yielded a
  token, so the flow is proven to work — not just syntactically valid.
