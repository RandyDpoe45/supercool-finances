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
  units + a `currency` code** (never float); currency is normalized in a `currency`
  table (prototype seeds **MXN** only).
- **Transfers** — internal (customer↔customer), external outbound (debit customer,
  credit the **outbound-rail clearing account**) and external inbound (debit the
  **inbound-rail clearing account**, credit customer):
  - **Confirmation of payee (internal):** a customer addresses a transfer by the
    payee's **human account number** (a unique **10-digit numeric** string on customer
    accounts only; system/clearing accounts keep NULL). The flow is **resolve → token →
    initiate**: `resolve-destination` is a **query only** (no transaction) that returns
    the payee's **masked holder name** + a **confirmation token** (single-purpose, caller +
    destination-bound, TTL-expiring — GET-validated, so an idempotent initiate retry within the
    window still succeeds); that token is
    **REQUIRED** by initiate. A transfer can **only** be initiated with a valid token bound
    to the resolved destination — without it the caller is just querying. The token is
    bound to the **caller** (keyed by their `sub`) so another user cannot use it, and is
    stored in Redis (`xfer:confirm:<sub>:<token>` → the resolved destination account id,
    TTL 300s). **Masking rule:** split the name on whitespace, each token → its **first 3
    characters + exactly `**`** (uniform, non-length-revealing), joined by single spaces
    (`"Juan Perez"` → `"Jua** Per**"`); masking is applied **in the service** so the raw
    name (PII) never crosses the service boundary.
  - **Idempotency:** `Idempotency-Key` per request; a retry returns the original
    result (persisted `IdempotencyKey`).
  - **Duplicate suppression (soft, defense-in-depth):** distinct from idempotency —
    catches *different* requests that are semantically identical (a double-submit
    that mints a **new** key each time, which the idempotency key cannot dedup). If
    the same `(owner_id, request_fingerprint)` — `fingerprint = hash(type, source,
    destination, amount, currency)` — was seen within a **60-second window**, the
    transfer is held as a *suspected duplicate* and requires an explicit
    `confirmDuplicate` override. It is a **soft** block (repeating an identical
    payment is legitimately valid) and reuses the fingerprint already stored on
    `IdempotencyKey` — no new state. This is the **duplicate-transfer control** (the
    user-scoped OTP is the second factor, not a duplicate check): it catches an
    identical transfer resubmitted within 60s, whether from a double-click or a rapid
    manual repeat.
  - **Concurrency:** READ COMMITTED + `SELECT ... FOR UPDATE` on the affected
    account row(s), locked in a **canonical order (by account id)** to avoid
    deadlocks. Because the account row holds the materialized `balance`, `held`
    **and** the period counters, the funds check (against `available = balance −
    held`), the ledger/hold append, the balance/held update, and the limit-counter
    update all happen under that one lock — covering both the
    single-row overdraft invariant and the multi-row limit invariants
    without SERIALIZABLE. Retry only on the rare deadlock (`40P01`). See
    [ADR-13](../docs/DECISIONS.md#adr-13--concurrency--balance-projection).
  - **Lifecycle:** `PENDING → POSTED → FAILED / REVERSED`; reversals are
    compensating entries, never mutations. External outbound is two-phase:
    initiation **places a hold** (reserves funds; `balance` unchanged) and
    settlement/OTP-confirm **settles** it into a posted movement (fail/expiry
    **releases** it). Internal transfers place **no hold** but are still
    **OTP-gated**: they stay `PENDING` at initiation and **post on OTP-confirm**,
    with the funds check performed at confirm-time under the account lock.
- **Holds (reservation ledger)** — an append-only `Hold` log for funds reserved
  but not yet posted (external outbound awaiting OTP/settlement). Lifecycle
  `PLACED → SETTLED | RELEASED | EXPIRED`; each hold carries an `externalRef` for
  later settlement/reconciliation against the external rail. Placing a hold
  increments `account.held` (available drops); **settling** converts it to a
  posted movement (hold→`SETTLED`, `held−`, `balance−`, append the double-entry
  `LedgerEntry`); **releasing/expiry** returns the funds (hold→`RELEASED`,
  `held−`) with no main-ledger entry. Kept separate from the main ledger, which
  records only money that actually moved.
- **Limits** — a per-transaction cap plus **fixed calendar-window** daily and monthly
  **amount** caps — **no rolling windows** and no count-based velocity; checked against
  the account's fixed-window spend counters (`spent_today` / `spent_month`) under the
  row lock. Configurable (global baseline + per-customer override).
- **External payees** — enrollment with a **cooling-off period** before a new payee
  can receive money.
- **OTP module** (bounded; [ADR-11](../docs/DECISIONS.md#adr-11--service-boundaries--data-ownership))
  — a **user-scoped** one-time code (`otp:<sub>`), **not** transaction-scoped: **at
  most one active code per user**, **single-use via atomic `GETDEL`**, TTL-bound. It is
  the user's out-of-band second factor for authorizing their **own** transfers.
  **Single-use is atomic:** a code authorizes **exactly one** transaction — two
  confirmations with the same code, even microseconds apart, cannot both succeed
  (`GETDEL`: one wins, the other finds no code). Refinement: the `GETDEL` targets an
  `otp:<sub>:<code>` **composite key** (the code is in the key name) so a **wrong** code
  is **non-destructive** — verification tolerates **up to 3 attempts** tracked in the
  user-scoped record `otp:<sub>` (`{codeHash, attempts}`, reset on generate); the code is
  **burned on attempt exhaustion or regenerate**. **Codes are stored hashed at rest** — Redis
  never holds the plaintext: both the composite key and the record carry a **keyed HMAC**
  (HMAC-SHA256 peppered by env `OTP_HASH_SECRET`, userId mixed in), so a Redis dump can't be
  brute-forced offline over the 10^6 space. The hash is deterministic given the pepper, so
  verification stays hashed-key existence with **no plaintext compare**; the plaintext code is
  delivered **out-of-band** on generate and **never persisted**. **Generation is singleton-gated:** a
  user may generate a code without a pending transfer (harmless), but **not while one
  is already active** — a second generation is **rejected**; the slot frees only when
  the active code is **consumed** or its **TTL expires**. **Only user-initiated
  transfers are OTP-gated** — internal and external outbound; **external inbound is
  not** (it arrives already approved by the originating external institution, not ours
  to authorize). A dedicated `POST /api/otp` **generate** endpoint mints the code (the code is
  **not** auto-minted at transfer initiation); confirm verifies the user's active code and posts
  their pending transfer; expose `GET /api/pending-authorizations` for the OTP app.
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

- `/api`: `GET /accounts`, `GET /accounts/:id/transactions`,
  `POST /transfers/resolve-destination`, `POST /transfers`, `POST /transfers/:id/confirm`,
  `POST /otp`, `POST /payees`, `GET /pending-authorizations`.
  `POST /transfers/resolve-destination` is the **confirmation-of-payee query**: body
  `{ accountNumber }` (10-digit numeric) → `{ maskedName, currency, confirmationToken }`
  (no money moves). `POST /transfers` addresses the payee by
  `destinationAccountNumber` and **requires** that `confirmationToken`.
  `GET /accounts` exposes the owner's own `accountNumber` per account.
  `POST /otp` mints the caller's user-scoped one-time code (the mocked out-of-band delivery to
  the OTP app) — a **dedicated generate endpoint**, singleton-gated; OTP is **not** auto-minted
  at transfer initiation.
- `/admin`: `POST /accounts/:id/freeze`, `PUT /limits`, `POST /transfers/:id/reverse`,
  `POST /approvals/:id/approve`, `GET /transactions`, `POST /external/inbound`.
- `/internal`: `POST /rails/settlement-callback`, `GET /health`.

## Data model (entities → migrations)

`Customer` (the money-domain user representation — PK = the Keycloak `sub`, i.e. the same
value stored in `account.owner_id`; fields **name, phone, email** only. **Updates the earlier
data-model note that said `sub → name` was Keycloak/UI-only** — the balance DB now owns the
customer profile; Keycloak keeps only auth), `Account` (carries `balance`, `held` + period
counters, and now a nullable **`account_number`** — a unique 10-digit numeric string on
customer accounts, NULL on system accounts; `owner_id` is an FK to `Customer`), `LedgerEntry`
(carries `balance_after`), `Hold` (reservation ledger: amount, status, `externalRef`),
`Transaction`, `ExternalPayee`, `Limit`, `OutboxEvent`, `AuditLog`,
`ApprovalRequest` (maker-checker), `IdempotencyKey`. (OTP codes and confirmation-of-payee
tokens live in Redis, not Postgres.)

## Object-level authorization

Every `/api` access is scoped by `X-User-Id` + resource id **in the query**
(`WHERE id = :id AND owner_id = :sub`), 404 on non-owned, nested resources
verified (the account being debited, not just the transfer id). `/admin` is
role-based.

## Definition of Done

- [ ] Internal transfer works end-to-end; **concurrency test** (N simultaneous
      transfers) proves no double-spend / no overdraft / no money created or lost.
- [ ] **Idempotency test**: a replayed `Idempotency-Key` moves money once.
- [ ] **Every user-initiated transfer — internal and external outbound — requires
      OTP confirm** (user-scoped, single-use code): internal posts on confirm,
      external settles its hold on confirm.
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
