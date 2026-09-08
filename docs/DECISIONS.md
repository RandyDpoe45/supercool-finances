# Architecture Decision Log

Lightweight ADRs for the SuperCool Finances balance service. Each records the
decision, why, and what was rejected. See [ARCHITECTURE.md](./ARCHITECTURE.md)
for how they fit together.

| # | Decision | Status |
|---|---|---|
| 1 | Two physically separated gateways (public + internal) | Accepted |
| 2 | Keycloak as IdP; Kong as Policy Enforcement Point | Accepted |
| 3 | Object-level authZ in the service, not the gateway | Accepted |
| 4 | Postgres double-entry ledger as source of truth | Accepted |
| 5 | Transactional outbox in Postgres; Redis Streams as transport | Accepted |
| 6 | App-level transaction OTP with a separate out-of-band app | Accepted |
| 7 | Redis for OTP storage | Accepted |
| 8 | Maker-checker for admin money operations | Accepted |
| 9 | Mock external rails & OTP delivery behind clean seams | Accepted |
| 10 | nginx ingress per plane in front of Kong (serves SPAs, proxies API) | Accepted |
| 11 | Service boundaries: relay + OTP inside balance service; analytics server owns Mongo | Accepted |
| 12 | Endpoint prefix convention: `/api` (customer), `/admin` (admin), `/internal` (service-to-service) | Accepted |
| 13 | Concurrency & balance: materialized balance (reducer) + `FOR UPDATE` (READ COMMITTED); SERIALIZABLE dropped | Accepted |
| 14 | Holds: materialized `held` on the account + a `Hold` reservation ledger (two-phase settle) | Accepted |
| 15 | Clearing accounts: one internal clearing account per external rail (two in the prototype) | Accepted |
| 16 | Self-contained components: no shared code across folders; monorepo for delivery only | Accepted |

---

## ADR-1 — Two physically separated gateways

**Decision.** A public Kong gateway faces customer traffic; a separate internal
Kong gateway serves admin operations on a non-public network.

**Why.** Network segmentation / defense in depth. The admin plane should be
*unreachable* from the public internet, not merely role-gated. The gateway
allowlist doubles as the exposed-API contract — only necessary endpoints are
reachable per plane.

**Rejected.** A single gateway with role-based routing only: one
misconfiguration exposes admin endpoints to the internet; no network-level blast
radius reduction.

---

## ADR-2 — Keycloak (IdP) + Kong (PEP)

**Decision.** Keycloak authenticates humans and issues signed JWTs. Kong
validates the JWT (signature via JWKS, expiry), optionally introspects for
revocation, checks role/scope vs. route, rate-limits, allowlists, and injects a
trusted identity header. Neither "shares" auth: Keycloak = authentication, Kong =
enforcement of it.

**Why.** Centralizing authN at the edge stops every service re-implementing it.
Standard OIDC ecosystem; Kong gives JWT/ACL/rate-limiting as configuration.

**Notes / trade-offs.**
- Stock nginx cannot validate a JWT natively — that's why the gateway is Kong (or
  nginx + `auth_request`/oauth2-proxy). Chose **Kong in DB-less (declarative)
  mode** for a clean compose story and plugins-as-config.
- Live revocation ("still valid?") needs **introspection** (a call per request,
  briefly cacheable). Full OIDC/introspection on Kong OSS may need the
  third-party `kong-oidc` plugin; signature+role validation via the built-in
  `jwt`/`acl` plugins is the low-friction baseline.

**Rejected.** Per-service token validation as the *primary* mechanism (duplicated
logic); building a bespoke gateway (scope creep, no payoff).

---

## ADR-3 — Object-level authorization lives in the service

**Decision.** The gateway does coarse (role/route) authZ. "Does user X own
resource Y?" is answered in the service using the token `sub` + resource id,
verified against the DB.

**Why.** The gateway has no ownership data; only the service does. IDOR/BOLA is
the top fintech API risk.

**Implementation rules.**
- Enforce ownership *inside* the query: `WHERE id = :id AND owner_id = :sub`;
  0 rows → deny.
- Return `404` (not `403`) for non-owned resources to avoid enumeration leaks.
- Cover nested resources (verify the account being debited, not just the transfer
  id).
- Admin plane is role-based, not ownership-based.
- Centralize in a shared guard / owner-scoped repository so it can't be forgotten.

**Rejected.** Trusting a user id from the request body/query (spoofable);
attempting ownership checks at the gateway (it lacks the data).

---

## ADR-4 — Postgres double-entry ledger as the source of truth

**Decision.** An append-only, double-entry ledger in Postgres (ACID) is
authoritative. Balances are derived (optionally materialized, always
rebuildable). Money is stored as integer minor units + currency. External flows
route through an internal clearing account.

**Why.** This is the "money is safe" core: immutable history, provable balance,
no float rounding, double-entry invariant even for external rails.

**Rejected.** A mutable `balance` column (`UPDATE balance = balance - x`): no
audit trail, race-prone, no way to prove correctness. MongoDB as the balance
store: not the right consistency model for authoritative money.

---

## ADR-5 — Transactional outbox (Postgres) + Redis Streams transport

**Decision.** The event is written to an `outbox` table in the **same DB
transaction** as the ledger change. A relay polls the outbox, `XADD`s to a Redis
Stream, then marks the row published. An idempotent consumer reads the stream and
upserts into MongoDB (the analytics read model).

**Why.** Avoids the dual-write divergence bug (DB commits, publish fails, or vice
versa). Ordering gives at-least-once delivery; idempotent consumer (`event_id`
upsert) makes redelivery safe. Streams (not Pub/Sub) persist + support consumer
groups/acks/replay.

**Rejected.** Publishing to a broker as a second step after commit (dual-write).
Redis as the outbox *storage* (reintroduces dual-write — Redis is transport
only). Redis Pub/Sub (fire-and-forget, drops events).

**Notes.** Reusing one Redis for OTP + stream is a demo simplification; prod would
likely use Kafka/RabbitMQ for the backbone.

---

## ADR-6 — App-level transaction OTP with a separate out-of-band app

**Decision.** Sensitive transfers require a one-time code generated server-side
at transaction initiation, **bound to the specific transaction** (amount +
destination). A separate OTP web app with its own login acts as the simulated
out-of-band channel and reveals the pending code. Default UX is code-entry. OTP is implemented as a
bounded module inside the balance service (see ADR-11), not a standalone service.

**Why.** Transaction signing (step-up), not just login. Binding prevents replay
against a different transfer. A separate authenticated app reads as a true second
factor; mocking delivery avoids forcing the evaluator into an authenticator app.

**Rejected.** Showing the code in the same session/page that consumes it
(security theater — not a second factor). Forcing a real TOTP app like Authy
(evaluator friction). Keycloak per-transaction step-up (ACR/LoA) — powerful but
fiddly to wire for the test; login stays on Keycloak, transaction OTP is
app-level. TOTP for transaction signing (time-based, cannot bind to a specific
transaction).

---

## ADR-7 — Redis for OTP storage

**Decision.** OTP codes live in Redis with a 2–5 min TTL, single-use via an
atomic `GETDEL`/Lua op, plus an attempt counter.

**Why.** OTPs are ephemeral; TTL gives free expiry; atomic consume prevents
double-redemption races. Non-durability is acceptable — a lost code is just
re-requested.

**Rejected.** Storing OTPs in Postgres (needless durability + cleanup burden).
Non-atomic check-then-delete (race allows double use).

---

## ADR-8 — Maker-checker for admin money operations

**Decision.** Balance-affecting admin actions (reversals, manual adjustments)
require a second admin's approval; all admin actions are written to an immutable
audit log.

**Why.** The admin plane acts across users with elevated power; four-eyes control
+ audit are standard bank controls and the natural counterpart to role-based
admin authZ.

**Rejected.** Unilateral admin balance edits (single point of abuse/error, no
accountability).

---

## ADR-9 — Mock external rails and OTP delivery behind clean seams

**Decision.** External inbound/outbound money and OTP delivery are mocked behind
interfaces that a real implementation could replace, and the mock is documented.

**Why.** Keeps the evaluation runnable end-to-end without real banking
integrations, while demonstrating the flow and the production path. See the
"real vs. mocked" table in [ARCHITECTURE.md](./ARCHITECTURE.md#9-whats-real-vs-mocked).

**Rejected.** Real rail integration (out of scope, non-runnable for a reviewer);
undocumented mocks (reads as an oversight rather than a decision).

---

## ADR-10 — nginx ingress per plane, in front of Kong

**Decision.** Each plane has an **nginx ingress** as its front door, with Kong
behind it: the public nginx serves the **client + OTP** web apps and the internal
nginx serves the **admin dashboard**. nginx terminates TLS, serves the SPA
bundles, and reverse-proxies `/api/*` to that plane's Kong; Kong does JWT/role/
rate-limit enforcement and routes to services.

**Why.** Separates two distinct edge jobs. Serving static SPA assets, TLS
termination, HTTP/2, gzip/caching are nginx's strengths; JWT validation,
introspection, per-route RBAC, allowlisting, and rate limiting are Kong's. It
also keeps a single clean public entry point per plane, and the internal nginx
keeps the admin SPA off the public internet entirely.

**Notes.** The static bundle is public — no sensitive data is gated by "who can
load the SPA"; all authorization happens on the `/api` path (Kong + service).
Two edge components per plane is a deliberate, defensible split, not accidental
double-proxying.

**Rejected.** Serving SPA static assets from Kong (not its job); a single shared
edge for both planes (loses the network-level isolation of the admin plane).

---

## ADR-11 — Service boundaries & data ownership

**Decision.** The backend is **two services**, and each data store has a single
owner (database-per-service):

- **Balance service** — transfers, ledger, limits, external clearing, the outbox
  **relay** (an in-process background worker), and the **OTP module** (transaction
  signing). Owns **Postgres** and **Redis**.
- **Analytics server** — consumes the Redis Stream, owns **MongoDB** (the read
  model), and serves the admin dashboard's reporting queries.

No service reaches into another's database.

**Why.**
- The **relay** polls the outbox table, which lives in the balance service's
  Postgres — keeping it in-process avoids a needless deployable and keeps it next
  to its data. It's a short-interval poller (not OS cron, whose 1-min floor is too
  slow) and claims rows with `SELECT ... FOR UPDATE SKIP LOCKED`, so
  horizontally-scaled balance instances never double-publish. At-least-once
  semantics and the idempotent consumer are unchanged (ADR-5).
- **OTP here is transaction signing**, bound to a transfer the balance service
  owns; generation (at initiate) and verification (at confirm) are states in the
  transfer lifecycle. A standalone service would duplicate transaction knowledge
  or add chatty calls on the money path. Kept as a bounded module (own package +
  Redis key-space) so it's cleanly extractable if step-up is ever reused. Login
  step-up is Keycloak's job and admin actions use maker-checker — so nothing else
  needs OTP (ADR-6).
- The **analytics server** is the CQRS read side; ingest (stream → Mongo) and
  query (reporting API) share one deployable for the demo and can split later.

**Rejected.** OTP as a standalone service (coupling leaks immediately; extra hop
on the money path). Relay as a separate deployable (needless for a table it's
coupled to) or as an OS cron (too coarse; latency). Shared databases across
services (couples schemas, breaks ownership).

---

## ADR-12 — Endpoint prefix convention as the exposure contract

**Decision.** Both services split routes by prefix, and the prefix determines
exposure and auth (not just naming):

- `/api/*` — customer-facing; routed **only** by the public gateway; customer
  token + object-level authz.
- `/admin/*` — admin operations; routed **only** by the internal gateway; admin
  role + audit (+ maker-checker on money ops).
- `/internal/*` — service-to-service; routed by **no gateway**; reachable only on
  the internal network; authenticated by service identity (mTLS / signed service
  token), never a user JWT.

**Why.** Makes "only expose the necessary endpoints" a mechanical property: each
Kong allowlist is prefix-scoped and default-deny (public → `/api` only, internal
→ `/admin` only), and `/internal` is never routable from any edge. A single
convention across services keeps the surface auditable at a glance. The balance
service uses all three; the analytics server uses `/admin` + `/internal` and has
no `/api` (customers never query it).

**Defense in depth.** Services also reject `/internal/*` that didn't arrive over
the trusted service channel — the gateway allowlist is the first control, not the
only one, since the boundary rests on network isolation that can be
misconfigured.

**Rejected.** A flat/undifferentiated route space (relies on per-route config
discipline; easy to accidentally expose an admin or internal path). Exposing
`/internal` through a gateway "for convenience" (defeats the isolation the prefix
exists to provide).

---

## ADR-13 — Concurrency & balance projection

**Decision.** Each `Account` carries a **materialized `balance`** plus per-period
spend counters. Every money movement, in **one DB transaction**, appends the
double-entry `LedgerEntry` rows *and* folds the delta into the affected accounts'
`balance` and counters — the posting acts as a **reducer**
(`balance_after = balance_before + delta`), with `balance_after` stored on each
entry. The ledger remains the source of truth; `balance` is a
transactionally-synced projection, always rebuildable.

Concurrency uses **READ COMMITTED + `SELECT ... FOR UPDATE`** on the affected
account row(s), locked in a **canonical order (by account id)** to avoid
deadlocks. Because the funds check, ledger append, balance update, and
limit-counter update all occur under that one row lock, the single-row overdraft
invariant *and* the multi-row limit/velocity invariants hold **without
SERIALIZABLE**. Retry only on the rare deadlock (`40P01`).

**Why.**
- Materializing `balance` + counters on the locked account row turns both the
  overdraft check and the aggregate limit check into **single-row, locked**
  read-modify-writes — which is exactly what removes the need for SERIALIZABLE's
  phantom protection.
- Fast balance reads (no fold over the ledger per read) while the ledger stays
  authoritative and auditable (`balance_after` per entry enables statements and
  drift repair).
- Idempotency keys make the rare deadlock retry safe.

**Guardrails.**
- **All** balance mutations funnel through one posting operation, so `balance` and
  the ledger can never be updated independently.
- A **reconciliation** job asserts `sum(ledger delta) == account.balance` and that
  internal accounts net to zero — drift is detectable precisely because there are
  two representations.

**Rejected.** SERIALIZABLE (dropped — the materialized, row-locked counters make it
unnecessary and it imposed a pervasive retry cost). Deriving balance by folding the
ledger on every read (slow; still needs locking for the invariant). Updating
`balance` outside the ledger transaction (dual-write drift).

---

## ADR-14 — Holds & settlement

**Decision.** Funds reserved for an in-flight external transfer are modeled in two
places, kept in sync transactionally:

- a **materialized `held`** field on the account (sum of active holds), giving
  **`available = balance − held`**; and
- an append-only **`Hold` reservation ledger** — one row per hold with lifecycle
  `PLACED → SETTLED | RELEASED | EXPIRED` and an `externalRef` for settlement.

External outbound is **two-phase**: initiation **places a hold** (increments
`held`; `balance` and the main ledger unchanged); settlement (OTP-confirm + rail
callback) **settles** the hold into a posted movement (hold→`SETTLED`, `held−`,
`balance−`, append the double-entry `LedgerEntry`); failure/expiry **releases** it
(hold→`RELEASED`, `held−`, no ledger entry). Internal transfers post directly, no
hold.

**Why.**
- Reserving funds prevents double-spending money already committed to a pending
  transfer — the new-transfer check is against `available`, not `balance`.
- A separate reservation ledger keeps the **main ledger strictly "money that
  moved,"** while holds track "money reserved pending settlement."
- `Hold` rows with `externalRef` + status are exactly what reconciles against an
  external rail's settlement feed, so holds can later be **synced and settled**
  from that source.

**Guardrails.** `held` is a materialized projection like `balance`: mutated only by
the hold operations, under the same account `FOR UPDATE` lock, and reconciled
(`sum(active holds) == account.held`).

**Rejected.** Debiting `balance` at initiation (loses the posted-vs-reserved
distinction; complicates reversal on failure). Posting holds into the main ledger
(pollutes it with money that hasn't moved). A derived-only `held` scanned on every
check (slower; loses the single-row locked check).

---

## ADR-15 — Clearing accounts per rail

**Decision.** External money moves through internal **clearing accounts, one per
rail** — system accounts (not customer accounts) that hold the counter-leg of
external entries so double-entry stays balanced across the boundary. The prototype
has two mock rails and therefore two clearing accounts: `clearing:rail-outbound`
and `clearing:rail-inbound`.

**Why.**
- Each clearing balance = the **net money in transit for that rail**, reconciled
  independently against that rail's settlement feed (via the hold `externalRef`) —
  cleaner than one global figure that mixes every source.
- Per-rail visibility scales: adding a rail adds a clearing account without
  entangling reconciliation across rails.

**Note.** A real bidirectional rail (e.g. ACH) would use a single clearing account
netting both directions; the prototype's two rails are single-direction mocks
(outbound, inbound), so "one per rail" yields two.

**Rejected.** One global clearing account (simpler, but mixes all external sources
into one balance, so a discrepancy can't be attributed to a rail).

---

## ADR-16 — Self-contained components (no shared code)

**Decision.** Every component (each service, each frontend) is a **standalone,
self-contained project** in its own folder, with **no cross-folder imports and no
shared code**. Each could be extracted to its own repository; the monorepo is a
**delivery convenience only**. Where components must agree on a contract — notably
the transaction **event shape** between the balance service and the analytics
server — each keeps its **own copy**, kept in sync via the spec, which is the
contract of record.

**Why.**
- Maximum decoupling and independent deployability — the folders behave as the
  separate services they represent, not as a coupled workspace.
- No shared library becomes a hidden coupling point or a reason two components must
  release together.

**Trade-off (accepted).** Duplication — the event contract types, guards, config
helpers, and frontend primitives are repeated per component. The **spec** is the
single source of truth that keeps the duplicated contracts aligned.

**Rejected.** A shared backend workspace with `libs/*` (couples the two services; a
shared-lib change forces coordinated releases). A shared frontend component library
across the three SPAs (same coupling; contradicts atomic folders).
