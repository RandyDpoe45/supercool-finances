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
  used as per-rail clearing (see external rails). Customer accounts also carry an optional
  **`label`** (a customer-chosen display name set at self-service creation), and a customer may
  **self-create** additional customer accounts (up to a small per-customer cap), each minted at
  **zero balance**.
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
  - **External outbound (initiate + confirm):** a customer sends to an **enrolled payee**
    addressed by `payeeId` (the cooling-off gate + display name come from enrollment; there is
    **no** resolve/confirm-of-payee step and the external account number is not re-typed).
    `POST /api/transfers/external` `{ sourceAccountId, payeeId, amount, currency }` +
    `Idempotency-Key` **places a hold**: lock the source, check `available ≥ amount`,
    `held += amount`, insert a `Hold` (`PLACED`, on the `rail-outbound` rail), and create the
    `PENDING` `external_outbound` transaction crediting the **`clearing:rail-outbound`** account —
    **no balance moves yet**. The payee must be past its cooling-off (`now() ≥ cooling_off_until`,
    else rejected). It obeys the **single active pending** rule and the **2-minute auth TTL**
    exactly like an internal transfer: an unconfirmed outbound lazily **expires** (`→ EXPIRED`) and
    its hold is **released** (`held −=`, no ledger entry); a new initiate **auto-supersedes** the
    prior pending and releases its hold; an explicit **cancel** releases the hold too. **Confirm is
    shared** (`POST /api/transfers/:id/confirm`) and branches on the transaction type — internal →
    post; external → **settle at confirm**: one locked, deadlock-retried tx posts the
    **customer → `clearing:rail-outbound`** double-entry, sets `held −= amount`, marks the hold
    **`SETTLED`**, transitions `PENDING → POSTED`, and writes one outbox row. Money leaves the
    customer into the outbound clearing account (the net **in transit**) at confirm; the step-5c
    rail settlement callback finalizes the clearing side (success → draw down / reconcile; failure →
    compensating reversal). `cancel` and the single `GET /api/pending-authorization` feed are shared
    across both transfer types.
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
  - **Lifecycle:** `PENDING → POSTED / EXPIRED / CANCELLED`, and posted movements
    may later be `REVERSED`; reversals are compensating entries, never mutations.
    Terminal states are **retained** (never deleted) for compliance. External
    outbound is two-phase: initiation **places a hold** (reserves funds; `balance`
    unchanged) and settlement/OTP-confirm **settles** it into a posted movement
    (fail/expiry **releases** it). Internal transfers place **no hold** but are
    still **OTP-gated**: they stay `PENDING` at initiation and **post on
    OTP-confirm**, with the funds check performed at confirm-time under the account
    lock.
  - **Pending authorization is single and time-boxed.** A user has **at most one
    PENDING transfer awaiting authorization at any time** — enforced by a partial
    unique index on `initiated_by WHERE status = 'PENDING'`, not just a service
    check. A pending transfer carries an **`expires_at` = `created_at` + 2 minutes**;
    once past it the transfer is **no longer valid** and lazily transitions to
    **`EXPIRED`** on the next access (confirm / read / the next initiate) — the DB
    clock (`now()`) is the single source of truth, **no scheduler**. **Confirm checks
    expiry before consuming the OTP**, so an expired transfer never burns the
    caller's code. Initiating a new transfer while one is still pending
    **auto-supersedes** the old one (→ `CANCELLED`, retained) and creates the new;
    the caller may also **cancel** a pending transfer explicitly (guarded
    `PENDING → CANCELLED`, retained). The single-pending rule spans **all**
    user-initiated types (internal and, later, external outbound).
- **Holds (reservation ledger)** — an append-only `Hold` log for funds reserved
  but not yet posted (external outbound awaiting OTP/settlement). Lifecycle
  `PLACED → SETTLED | RELEASED | EXPIRED`; each hold carries an `externalRef` for
  later settlement/reconciliation against the external rail. Placing a hold
  increments `account.held` (available drops); **settling** converts it to a
  posted movement (hold→`SETTLED`, `held−`, `balance−`, append the double-entry
  `LedgerEntry`); **releasing/expiry** returns the funds (`held−`) with **no**
  main-ledger entry — a hold whose **auth TTL elapsed** goes to **`EXPIRED`**
  (alongside the transaction's `EXPIRED`), one **explicitly released** (the transfer
  was **cancelled** or **auto-superseded**, or later a rail failure) goes to
  **`RELEASED`**. Kept separate from the main ledger, which records only money that
  actually moved.
- **Limits** — a per-transaction cap plus **fixed calendar-window** daily and monthly
  **amount** caps — **no rolling windows** and no count-based velocity. Enforced **only on
  customer-initiated outbound** movements (internal transfer out + external outbound) at
  **post/confirm time**, inside the reducer's account-lock critical section beside the funds
  check: the resolved caps are checked and the account's fixed-window spend counters
  (`spent_today` / `spent_month`) incremented under the **same** `FOR UPDATE` lock, so the
  counters can never exceed the cap under a concurrent race. **Inbound credits and reversals
  never count**, and a rail-failure reversal does **not** give the amount back (the fixed
  window holds the slot until it resets). Counters are **per-account**; the cap is
  **per-owner** (customer override) **or the global baseline** — the customer row wins
  wholesale when present, else the global row, else uncapped (a NULL cap field = uncapped).
  Windows reset **lazily on the next spend** off the **DB clock, UTC calendar** boundary
  (`spent_*_date` behind the current day / month-start → zero-then-add). The **global baseline
  is seeded** (migration, like the system accounts); the `/admin PUT /limits` configuration
  surface is part of the admin step, not here.
- **External payees** — enrollment with a **cooling-off period** before a new payee
  can receive money. Registration input is minimal — **`{ displayName, destinationRef }`**
  (`destination_ref` = the **external bank account number**, the human-identifier
  convention); the **rail is a single constant outbound rail** (not user-supplied — the
  prototype clears all external outbound through one mocked rail). Usability is
  **date-gated, not status-driven**: enrollment stamps **`cooling_off_until` = `now()` +
  `PAYEE_COOLING_OFF_SECONDS`**, and a payee is a valid destination from that instant on
  (`now() >= cooling_off_until`) — **no PENDING→ACTIVE transition** (the `status` column is
  reserved for a future admin/self-disable flow, unused for now). Uniqueness
  `(owner_id, rail, destination_ref)` (with a constant rail, effectively one enrollment per
  external account per customer) → a duplicate is a **409**. Enrollment is **not** OTP-gated
  and has **no resolve/confirm step** (no external name to look up — the user supplies
  `display_name`); the cooling-off delay is the anti-fraud control.
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
  their pending transfer; expose `GET /api/pending-authorization` (the caller's single active
  pending transfer, or none) for the OTP app.
- **Outbox + relay worker** — write the `OutboxEvent` in the **same DB
  transaction** as the ledger change; an **in-process** short-interval poll loop (a worker
  inside the balance service — not an OS cron; see `docs/ARCHITECTURE.md`) drains it. Each
  drain tick, in one transaction: `SELECT ... WHERE published_at IS NULL ORDER BY created_at
  FOR UPDATE SKIP LOCKED LIMIT n` (so multiple balance-service instances never double-publish),
  `XADD`s each row to **`events:transactions`**, then `markPublished` (`published_at = now()`),
  then commits. **XADD BEFORE mark** so a crash between them re-publishes (a duplicate), never
  loses — **at-least-once**; the consumer dedups on the event id. The stream **entry contract**
  (balance↔analytics contract of record; analytics keeps its own copy): fields **`event_id`**
  (= the `OutboxEvent.id`, the dedup key), **`event_type`**, and **`payload`** (the JSON the
  reducer built). Config knobs: `RELAY_ENABLED` (default true), `RELAY_POLL_INTERVAL_MS`,
  `RELAY_BATCH_SIZE`. No dead-letter/attempts in the prototype — a failed tick simply retries.
- **Admin ops (`/admin`)** — freeze/unfreeze, configure limits, reversals (behind
  **maker-checker**), view any transaction + audit, trigger a simulated external
  inbound. All admin actions write the **audit log**.
- **Mocked external rails** — outbound settlement callback + inbound webhook behind
  an interface. The settlement callback is a **third-party webhook** the external
  rail calls to notify completion, so it lives on a dedicated **`/external` surface**
  authenticated by an **HMAC request signature** (Stripe-style) — header
  **`X-Rail-Signature: t=<unix-seconds>,v1=<hex>`**, where `v1` must equal
  **`HMAC-SHA256(RAILS_WEBHOOK_SIGNING_SECRET, "<t>.<rawBody>")`** computed over the
  **raw request-body bytes** (not reparsed JSON) and compared constant-time; a missing/
  malformed header, a signature mismatch, or a **timestamp outside ±300s** (replay guard)
  is **401**. This is a **distinct trust domain** from `/internal` (our own network peers,
  `X-Service-Token`) and `/api` (customers, gateway `X-User-Id`). The `/external` surface is
  a per-surface controller registry like the others (`ExternalModule` + a global
  signature guard scoped to the `external` prefix; the app captures the raw body on
  `/external` routes so the verified bytes are exactly what the sender signed). The
  per-`externalRef` idempotency remains as defense-in-depth inside the replay window. Each rail has its own
  internal **clearing account** (a system account, not a customer account); the
  prototype seeds two — `clearing:rail-outbound` and `clearing:rail-inbound`. A
  clearing balance is the net in transit for that rail and reconciles against that
  rail's settlement feed via the hold `externalRef`. **Outbound completion**
  (`/external/rails/settlement-callback`) correlates by **our transaction id** and is
  **idempotent** (a retried webhook is a no-op): **SUCCESS reconciles** — records the
  rail `externalRef` on the settled hold, **no new ledger movement** (the money already
  moved customer→`clearing:rail-outbound` at OTP-confirm); **FAILURE reverses** — a
  **compensating** movement `clearing:rail-outbound → customer` refunds the payer (a new
  transaction with `reverses_transaction_id`, original → `REVERSED`), acquiring the
  **customer lock before the clearing lock**. **Inbound** (`/external/rails/inbound`) is a
  fresh POSTED `external_inbound` movement — debit `clearing:rail-inbound`, credit the
  customer resolved by **account number** — **not OTP-gated** (approved by the originating
  institution), **idempotent by the rail `externalRef`** (no double-credit), and a frozen
  customer may still be credited. (An admin-triggered simulated inbound is a separate,
  deferred admin-surface concern.)

## Endpoints (representative)

- `/api`: `GET /accounts`, `POST /accounts`, `GET /accounts/:id/transactions`,
  `POST /transfers/resolve-destination`, `POST /transfers`, `POST /transfers/external`,
  `POST /transfers/:id/confirm`, `POST /transfers/:id/cancel`, `POST /otp`, `POST /payees`,
  `GET /payees`, `GET /pending-authorization`.
  `POST /transfers/resolve-destination` is the **confirmation-of-payee query**: body
  `{ accountNumber }` (10-digit numeric) → `{ maskedName, currency, confirmationToken }`
  (no money moves). `POST /transfers` addresses the payee by
  `destinationAccountNumber` and **requires** that `confirmationToken`.
  `GET /accounts` exposes the owner's own `accountNumber` per account.
  `POST /accounts` **creates a new customer account** for the caller (self-service): body
  `{ label }` (a customer-chosen display name, 1–50 chars) yields **201** with the new
  `AccountDto`. The account is minted at **`balance = 0`, `held = 0`** (money-safety — a
  self-service create can never seed funds), `kind = customer`, `status = active`,
  `currency = MXN` (the single seeded currency), with a freshly generated unique 10-digit
  `account_number`. A customer may hold **at most 5** customer accounts; an over-cap create is
  rejected **422 `ACCOUNT_LIMIT_REACHED`**, and the cap is enforced under a per-owner lock so a
  concurrent double-create cannot exceed it. Creating an account moves no money, so it is
  **not** OTP-gated and writes **no** audit / ledger / outbox row.
  `POST /otp` mints the caller's user-scoped one-time code (the mocked out-of-band delivery to
  the OTP app) — a **dedicated generate endpoint**, singleton-gated; OTP is **not** auto-minted
  at transfer initiation. `POST /transfers/:id/cancel` cancels the caller's pending transfer
  (guarded `PENDING → CANCELLED`, retained); `GET /pending-authorization` returns the caller's
  **single** active pending transfer (or none), with the destination's masked holder name.
  `POST /payees` enrolls an external beneficiary (`{ displayName, destinationRef }` → the new
  payee with its `coolingOffUntil`); `GET /payees` lists the caller's enrolled payees.
- `/admin` (role-gated: the gateway injects `X-User-Id` + `X-Roles`; the surface requires the
  `admin` role, else 403). Every **mutating** admin action writes one **audit row** (actor, action,
  target, before/after metadata) in the same transaction as the change; reads do not.
  **Maker-checker is scoped to reversals only** — freeze/unfreeze and `PUT /limits` are single-actor
  admin actions applied directly (each audited).
  - Single-actor: `POST /accounts/:id/freeze`, `POST /accounts/:id/unfreeze` (flip account
    `status`; a frozen account can still be credited, only debits are blocked); `PUT /limits`
    (upsert the global baseline or a per-customer override — `{ scope, ownerId?, currency,
    perTransactionMax?, dailyMax?, monthlyMax? }`, `ON CONFLICT (scope, owner_id)` upsert);
    `GET /transactions` (view ANY transaction, not owner-scoped, with filters + pagination — a read,
    no audit); `POST /external/inbound` (trigger a **simulated** external inbound — reuses the rail
    inbound-credit path, idempotent by `externalRef`).
  - Maker-checker (four-eyes): `POST /transfers/:id/reverse` (a maker proposes a reversal →
    `ApprovalRequest` PENDING), `POST /approvals/:id/approve` / `POST /approvals/:id/reject` (a
    DIFFERENT checker decides; approve executes the reversal — `checker_id <> maker_id` enforced in
    the service and by the DB CHECK). **Reversible** = a **POSTED internal** transfer or a **POSTED
    external_inbound** credit (external_outbound is NOT admin-reversible — its reversal is the 5c
    rail-failure callback path); a non-POSTED / already-REVERSED target → 409. **Approve executes
    atomically** — in one deadlock-retried tx: guarded `ApprovalRequest PENDING → EXECUTED`
    (the maker-checker concurrency gate, so two simultaneous checkers yield exactly one execution),
    guarded original `POSTED → REVERSED` (the no-double-reversal gate), then a fresh **compensating**
    movement (`reverses_transaction_id` = original; legs mirrored — credit the original debit account,
    debit the original credit account) via the posting reducer, then one audit row. The compensating
    debit is a **FORCED admin correction**: it **bypasses** the counterparty's overdraft + frozen
    checks (via a guarded `forced` flag on the reducer, set ONLY by admin reversal), so it always
    executes and the counterparty may go **negative** — still a balanced double-entry (no money
    created/lost) and authorized by four-eyes. A reversal does **not** refund the spend counters
    (fixed-window; consistent with the outbound-only limits rule). For an inbound reversal (a clearing
    account is involved) the customer is locked **before** the clearing account (source-before-clearing,
    as in 5c). Every reversal step (`propose` / `approve`→execute / `reject`) writes an audit row.
- `/external` (third-party rail webhooks — HMAC-signed: `X-Rail-Signature: t=…,v1=…`, `v1 == HMAC-SHA256(RAILS_WEBHOOK_SIGNING_SECRET, "<t>.<rawBody>")`, ±300s replay window, 401 otherwise):
  `POST /rails/settlement-callback` (outbound completion: SUCCESS reconciles — records
  the rail `externalRef`, no new ledger post; FAILURE reverses `clearing → customer`),
  `POST /rails/inbound` (external inbound credit — debit `clearing:rail-inbound`, credit
  the customer by account number; **not** OTP-gated; idempotent by the rail `externalRef`).
- `/internal`: `GET /health` (health/readiness; our-own-peers surface, `X-Service-Token`).

## Data model (entities → migrations)

`Customer` (the money-domain user representation — PK = the Keycloak `sub`, i.e. the same
value stored in `account.owner_id`; fields **name, phone, email** only, with **phone and email
UNIQUE** (email uniqueness is **case-insensitive** — unique on `LOWER(email)`). **Updates the earlier
data-model note that said `sub → name` was Keycloak/UI-only** — the balance DB now owns the
customer profile; Keycloak keeps only auth), `Account` (carries `balance`, `held` + period
counters, and now a nullable **`account_number`** — a unique 10-digit numeric string on
customer accounts, NULL on system accounts; and a nullable **`label`** (a customer-chosen
display name on self-created accounts, NULL on seeded/system accounts); `owner_id` is an FK to `Customer`), `LedgerEntry`
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
- [ ] **At most one PENDING transfer per user** — proven under a concurrent
      double-initiate race (partial unique index, not just a service check); a new
      initiate **auto-supersedes** the prior pending (→ CANCELLED, retained).
- [ ] A pending transfer **expires after 2 minutes** (`expires_at`): confirming or
      reading an overdue transfer transitions it to **EXPIRED** (retained) and
      confirm does **not** consume the OTP; the caller can **cancel** a pending
      transfer (→ CANCELLED, retained). Terminal transfers are never deleted.
- [ ] **Every user-initiated transfer — internal and external outbound — requires
      OTP confirm** (user-scoped, single-use code): internal posts on confirm,
      external settles its hold on confirm.
- [ ] External outbound **places a hold** at initiation (available drops, balance
      unchanged), **settles** it at confirm (hold→SETTLED, balance/held updated,
      double-entry posted), and **releases** it on fail/expiry (no ledger entry).
- [ ] **Limits enforced under the lock:** a customer-initiated outbound transfer (internal or
      external) is rejected (422 `LIMIT_EXCEEDED`) when it would breach the per-transaction,
      daily, or monthly cap; the account's `spent_today` / `spent_month` increment **atomically
      with the post** and **never exceed the cap under a concurrent race** (per-account counter,
      per-owner/global cap, customer-override-wins resolution, DB-clock UTC window reset).
      Inbound credits and reversals do **not** touch the counters.
- [ ] A reversal requires a second approver (maker-checker) and writes an audit row.
- [ ] Each money change emits exactly one outbox row in the same tx; the relay
      publishes it (SKIP LOCKED verified across two instances).
- [ ] Reconciliation: `sum(ledger delta) == account.balance` **and**
      `sum(active holds) == account.held`; internal accounts net to 0.
- [ ] **Customer self-service account creation** (`POST /api/accounts`): mints a new customer
      account at **balance 0 / held 0** (never seeds money), owner-scoped to the caller, with a
      unique generated 10-digit account number and a validated `label`; the **per-customer cap
      (5)** holds even under a concurrent double-create; the create emits **no** ledger/outbox row.

## Open questions

_None outstanding._

**Resolved:** single-currency; holds modeled as a materialized `held` field + a
`Hold` reservation ledger; **one clearing account per external rail** (two in the
prototype: `clearing:rail-outbound`, `clearing:rail-inbound`), reconciled per rail.
