# Spec 04 — Balance Service (core domain)

**Purpose.** The money core: accounts, the double-entry ledger, transfers, limits,
external payees, the OTP module, and the outbox + relay. This is the service the
whole prompt is about — correctness here is the deliverable.

**Depends on.** [`01`](./01-storage.md), [`02`](./02-keycloak.md),
[`03`](./03-backend-foundation.md).

## Modules

- **Accounts** — multiple per customer; currency; status (`active` / `frozen`);
  a **materialized `balance`** (the posted projection), a **materialized `held`**
  (sum of active holds), and per-period spend counters (`spent_today`,
  `spent_month`, reset by date) for limit checks. **Available balance is derived:
  `available = balance − held`.** `balance` and `held` are caches kept in sync
  transactionally — never mutated except by the posting / hold operations.
  Accounts also have a **kind**: customer accounts, or internal **system accounts**
  used as per-rail clearing (see external rails).
- **Ledger** — append-only, double-entry `LedgerEntry` rows summing to zero per
  transaction; each entry records the signed delta and the resulting
  **`balance_after`** for its account (the running fold). The account's
  materialized `balance` is updated **in the same transaction** as the entry — the
  posting acts as a reducer: `balance_after = balance_before + delta`. The ledger
  is the **source of truth**; `balance` is a transactionally-synced projection,
  always rebuildable. All balance mutations funnel through **one `postTransaction`
  operation**, so ledger and `balance` can never diverge. Money is **integer minor
  units + currency** (never float).
- **Transfers** — internal (customer↔customer), external outbound (debit customer,
  credit the **outbound-rail clearing account**) and external inbound (debit the
  **inbound-rail clearing account**, credit customer):
  - **Idempotency:** `Idempotency-Key` per request; a retry returns the original
    result (persisted `IdempotencyKey`).
  - **Concurrency:** READ COMMITTED + `SELECT ... FOR UPDATE` on the affected
    account row(s), locked in a **canonical order (by account id)** to avoid
    deadlocks. Because the account row holds the materialized `balance`, `held`
    **and** the period counters, the funds check (against `available = balance −
    held`), the ledger/hold append, the balance/held update, and the limit-counter
    update all happen under that one lock — covering both the
    single-row overdraft invariant and the multi-row limit/velocity invariants
    without SERIALIZABLE. Retry only on the rare deadlock (`40P01`). See
    [ADR-13](../docs/DECISIONS.md#adr-13--concurrency--balance-projection).
  - **Lifecycle:** `PENDING → POSTED → FAILED / REVERSED`; reversals are
    compensating entries, never mutations. External outbound is two-phase:
    initiation **places a hold** (reserves funds; `balance` unchanged) and
    settlement/OTP-confirm **settles** it into a posted movement (fail/expiry
    **releases** it). Internal transfers post directly (no hold).
- **Holds (reservation ledger)** — an append-only `Hold` log for funds reserved
  but not yet posted (external outbound awaiting OTP/settlement). Lifecycle
  `PLACED → SETTLED | RELEASED | EXPIRED`; each hold carries an `externalRef` for
  later settlement/reconciliation against the external rail. Placing a hold
  increments `account.held` (available drops); **settling** converts it to a
  posted movement (hold→`SETTLED`, `held−`, `balance−`, append the double-entry
  `LedgerEntry`); **releasing/expiry** returns the funds (hold→`RELEASED`,
  `held−`) with no main-ledger entry. Kept separate from the main ledger, which
  records only money that actually moved.
- **Limits** — per-transaction, daily/monthly caps, velocity checks; all
  configurable (global + per-customer).
- **External payees** — enrollment with a **cooling-off period** before a new payee
  can receive money.
- **OTP module** (bounded; [ADR-11](../docs/DECISIONS.md#adr-11--service-boundaries--data-ownership))
  — generate a code at transfer initiation, **bound to the transaction**; store in
  Redis with TTL, single-use via atomic `GETDEL`; verify at confirm; expose
  `GET /api/pending-authorizations` for the OTP app.
- **Outbox + relay worker** — write the `OutboxEvent` in the **same DB
  transaction** as the ledger change; a background worker polls with
  `SELECT ... FOR UPDATE SKIP LOCKED`, `XADD`s to `events:transactions`, then marks
  the row published (at-least-once).
- **Admin ops (`/admin`)** — freeze/unfreeze, configure limits, reversals (behind
  **maker-checker**), view any transaction + audit, trigger a simulated external
  inbound. All admin actions write the **audit log**.
- **Mocked external rails** — outbound settlement callback + inbound webhook behind
  an interface; callbacks arrive on `/internal`. Each rail has its own internal
  **clearing account** (a system account, not a customer account); the prototype
  seeds two — `clearing:rail-outbound` and `clearing:rail-inbound`. A clearing
  balance is the net in transit for that rail and reconciles against that rail's
  settlement feed via the hold `externalRef`.

## Endpoints (representative)

- `/api`: `GET /accounts`, `GET /accounts/:id/transactions`, `POST /transfers`,
  `POST /transfers/:id/confirm`, `POST /payees`, `GET /pending-authorizations`.
- `/admin`: `POST /accounts/:id/freeze`, `PUT /limits`, `POST /transfers/:id/reverse`,
  `POST /approvals/:id/approve`, `GET /transactions`, `POST /external/inbound`.
- `/internal`: `POST /rails/settlement-callback`, `GET /health`.

## Data model (entities → migrations)

`Account` (carries `balance`, `held` + period counters), `LedgerEntry` (carries
`balance_after`), `Hold` (reservation ledger: amount, status, `externalRef`),
`Transaction`, `ExternalPayee`, `Limit`, `OutboxEvent`, `AuditLog`,
`ApprovalRequest` (maker-checker), `IdempotencyKey`. (OTP codes live in Redis, not
Postgres.)

## Object-level authorization

Every `/api` access is scoped by `X-User-Id` + resource id **in the query**
(`WHERE id = :id AND owner_id = :sub`), 404 on non-owned, nested resources
verified (the account being debited, not just the transfer id). `/admin` is
role-based.

## Definition of Done

- [ ] Internal transfer works end-to-end; **concurrency test** (N simultaneous
      transfers) proves no double-spend / no overdraft / no money created or lost.
- [ ] **Idempotency test**: a replayed `Idempotency-Key` moves money once.
- [ ] External outbound requires OTP confirm (code bound to the tx, single-use).
- [ ] External outbound **places a hold** at initiation (available drops, balance
      unchanged), **settles** it at confirm (hold→SETTLED, balance/held updated,
      double-entry posted), and **releases** it on fail/expiry (no ledger entry).
- [ ] A reversal requires a second approver (maker-checker) and writes an audit row.
- [ ] Each money change emits exactly one outbox row in the same tx; the relay
      publishes it (SKIP LOCKED verified across two instances).
- [ ] Reconciliation: `sum(ledger delta) == account.balance` **and**
      `sum(active holds) == account.held`; internal accounts net to 0.

## Open questions

_None outstanding._

**Resolved:** single-currency; holds modeled as a materialized `held` field + a
`Hold` reservation ledger; **one clearing account per external rail** (two in the
prototype: `clearing:rail-outbound`, `clearing:rail-inbound`), reconciled per rail.
