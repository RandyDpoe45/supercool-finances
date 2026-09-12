# Balance Service — Persistence layer (spec 04)

This document describes the balance service's Postgres schema. The design of record is
[`specs/DATA-MODEL.md`](../../../specs/DATA-MODEL.md) (Part 1) +
[`specs/balance-schema.yaml`](../../../specs/balance-schema.yaml); this page records
**what was built and the mapping decisions**, so a reader/reviewer does not have to
reverse-engineer them from the migrations.

Schema changes are **migration-only** (`synchronize: false`, `migrationsRun: true` —
see [foundation docs](./README.md#migrations-on-boot)). Entities and migrations are
referenced **by class** in `src/database/data-source.options.ts`, never by glob.

## Tables & migrations

The schema is built in two ordered migrations, each self-contained:

**Step 1 — `CreateBalanceCore1788825600000`** (`…/migrations/1788825600000-CreateBalanceCore.ts`)
— the FK-self-contained **money spine**. Creates the enum types and tables in FK
dependency order and seeds MXN.

| Table | Role |
|---|---|
| `currency` | ISO 4217 reference/lookup; seeded with **MXN** only. |
| `account` | Balance-bearing account (customer or system/clearing); materialized `balance` / `held` + fixed-window spend counters. |
| `external_payee` | Enrolled external beneficiary, cooling-off gated. |
| `transaction` | Header grouping the balancing ledger legs of one movement. |
| `ledger_entry` | Append-only double-entry ledger — the source of truth for money movement. |

**Step 2 — `CreateBalanceSatellites1788912000000`** (`…/migrations/1788912000000-CreateBalanceSatellites.ts`)
— the six **satellites** that hang off the spine. Every FK points to a Step-1 table
(`account`, `transaction`, `currency`) or to nothing (`audit_log`), so the six are
created in any internal order.

| Table | Role |
|---|---|
| `hold` | Reservation ledger for in-flight external outbound funds; only PLACED counts toward `account.held`. |
| `user_limits` | Global baseline + per-customer override amount caps (per-tx, daily, monthly). |
| `outbox_event` | Transactional outbox; row `id` IS the analytics `event_id`. |
| `audit_log` | Immutable log of privileged `/admin` actions (identity PK). |
| `approval_request` | Maker-checker four-eyes for balance-affecting admin ops. |
| `idempotency_key` | At-most-once replay safety; composite PK `(owner_id, key)`. |

**Step 3 — `CreateCustomerAndAccountNumber1789084800000`**
(`…/migrations/1789084800000-CreateCustomerAndAccountNumber.ts`) — the confirmation-of-payee
schema: the balance-service's own **customer representation** plus the human **account number**.
(The interstitial `SeedSystemAccounts1788998400000` is a **data** migration — the two clearing
accounts — not a schema step.)

| Table / change | Role |
|---|---|
| `customer` | Money-domain user profile Keycloak does not hold. PK `id` = the Keycloak `sub` (`varchar`, same value as `account.owner_id`); `name` / `phone` / `email` NOT NULL, and `phone` / `email` UNIQUE; timestamps. |
| `uq_customer_phone` / `uq_customer_email` (add) | UNIQUE indexes on `customer.phone` and `customer.email` (both NOT NULL, so no multi-NULL concern). `uq_customer_email` is **case-insensitive** — a functional index on `LOWER(email)`; `uq_customer_phone` is plain (phone is digits). |
| `account.account_number` (add) | Human destination identifier — unique 10-digit numeric on customer accounts, NULL on system accounts. |
| `uq_account_account_number` (add) | Plain UNIQUE index on `account_number` (multiple NULLs coexist, so system accounts don't collide). |
| `fk_account_owner` (add) | `account.owner_id → customer.id`, nullable (not checked for system accounts' NULL owner). |

**Step 4 — `AddTransactionLifecycle1789171200000`**
(`…/migrations/1789171200000-AddTransactionLifecycle.ts`) — the pending-authorization lifecycle:
the two new terminal statuses, the 2-minute expiry marker, and the single-pending invariant.

| Table / change | Role |
|---|---|
| `transaction_status` (+labels) | `ALTER TYPE … ADD VALUE IF NOT EXISTS 'EXPIRED'` then `'CANCELLED'` — the two terminal-non-posted states a pending transfer can reach (lapsed, or auto-superseded / user-cancelled), both retained. |
| `transaction.expires_at` (add) | `timestamptz NULL` — the pending deadline set FROM THE DB CLOCK at initiate (`now() + interval '2 minutes'`). Nullable: only user-initiated PENDING transfers carry one. |
| `uq_one_pending_per_initiator` (add) | **PARTIAL** unique index `("initiated_by") WHERE "status" = 'PENDING'` — at most ONE live pending per user (structural, not just a service check), and the concurrency backstop against a double-initiate race (→ 23505 → 409). |

**PG note (ADD VALUE in a transaction).** On Postgres 12+ (this deployment is **PG 16**),
`ALTER TYPE … ADD VALUE` is allowed inside the migration's own transaction ONLY because the new
labels are **not used** in that same migration — the index predicate references the pre-existing
`'PENDING'`. This is verified against the live-PG boot gate (migrations run on boot). A later
migration that must USE `'EXPIRED'`/`'CANCELLED'` in DDL/DML has to be its own, ordered-after
migration. `down()` drops the index + `expires_at` column; it intentionally **does not** remove
the enum labels — Postgres cannot drop an enum value in place, and the leftover labels are
harmless once unused (documented in the migration).

**Step 5 — `SeedBaselineUserLimits1789257600000`**
(`…/migrations/1789257600000-SeedBaselineUserLimits.ts`) — a **data** migration (like
`SeedSystemAccounts`), seeding the single GLOBAL baseline `user_limits` row so the limit check has
a cap to resolve on boot. See [the baseline-limits seed](#system-seed--the-global-baseline-limits).

Each migration's `down()` drops its tables (any order for the satellites; reverse FK
order for the spine) then removes its enum types — a clean inverse. Step 3's `down()` drops the
FK, the `account_number` index and column, then the two `customer` unique indexes, then the
`customer` table. Step 4's `down()` drops `uq_one_pending_per_initiator` + `expires_at` (the two
enum labels remain, by design). The two data migrations' `down()` delete only the rows they
inserted.

## Enumerations — native Postgres enum types

Enums are **native Postgres enum types** (`CREATE TYPE`), created and dropped by the
migration. The TypeScript mirrors live in `src/database/entities/enums.ts`; each
`@Column({ type: 'enum', enumName: … })` binds to the native type by name, and the
member string values match the native labels exactly. The native type is the source of
truth — TypeORM never creates it (synchronize is off).

| Native type | Labels | Used by |
|---|---|---|
| `account_kind` | `customer`, `system` | `account.kind` |
| `account_status` | `active`, `frozen` | `account.status` (default `active`) |
| `transaction_type` | `internal`, `external_outbound`, `external_inbound` | `transaction.type` |
| `transaction_status` | `PENDING`, `POSTED`, `FAILED`, `REVERSED`, `EXPIRED`, `CANCELLED` | `transaction.status` (`EXPIRED` / `CANCELLED` added by the Step-4 lifecycle migration) |
| `payee_status` | `pending`, `active`, `disabled` | `external_payee.status` (default `pending`) |
| `hold_status` | `PLACED`, `SETTLED`, `RELEASED`, `EXPIRED` | `hold.status` (default `PLACED`) |
| `user_limits_scope` | `global`, `customer` | `user_limits.scope` |
| `approval_action` | `reversal`, `user_limits_change`, `adjustment` | `approval_request.action_type` |
| `approval_status` | `PENDING`, `APPROVED`, `REJECTED`, `EXECUTED` | `approval_request.status` (default `PENDING`) |
| `idempotency_status` | `in_progress`, `completed` | `idempotency_key.status` |

## Money & type mapping decisions

- **Money is `bigint` minor units + a `currency` code — never float.** Every
  money-bearing column (`account.balance`/`held`/`spent_today`/`spent_month`,
  `transaction.amount`, `ledger_entry.delta`/`balance_after`, `hold.amount`,
  `user_limits.per_transaction_max`/`daily_max`/`monthly_max`) is `bigint`.
- **bigint → JS `string`.** TypeORM surfaces `bigint` as a JS `string` because a JS
  `number` cannot hold the full int64 range without precision loss. The entity fields
  are therefore typed `string`; **do not** do float/`Number` arithmetic on them (use
  `BigInt`/decimal-safe math in the domain layer). This is the safe TypeORM default —
  no custom transformer, no precision risk.
- **`minor_unit_scale`** on `currency` (MXN = 2 → centavos) makes the minor-unit
  interpretation explicit per currency, so `bigint` amounts are decodable for display.
- **UUID PKs** use `DEFAULT gen_random_uuid()` (Postgres core ≥ 13 — no extension). The
  entity declares the DB default (`default: () => 'gen_random_uuid()'`) so the database
  is the generator.
- **Time** is `timestamptz` (UTC instants; the server never localizes). `date` columns
  (`spent_today_date`, `spent_month_date`) are typed `string` (`YYYY-MM-DD`) as TypeORM
  surfaces them.

## Per-table constraints & indexes

**`currency`** — `code char(3)` PK; `name`, `minor_unit_scale` NOT NULL; `symbol`
nullable. Seeded `('MXN', 'Mexican Peso', 2, '$')`. Adding a currency is a data insert,
not a migration.

**`account`**
- `currency` → `currency.code` (`fk_account_currency`).
- `balance`, `held`, `spent_today`, `spent_month` — `bigint NOT NULL DEFAULT 0`.
- `held >= 0` — `chk_account_held_nonneg`.
- **No blanket `balance >= 0` check** — clearing (system) accounts may go negative (net
  in transit); customer overdraft is enforced at **debit time** (`available >= amount`,
  where `available = balance − held`), not by a DB constraint.
- `idx_account_owner (owner_id) WHERE kind = 'customer'` — partial owner lookup.
- `uq_account_system_key (system_key) WHERE kind = 'system'` — partial UNIQUE; system
  keys (e.g. `clearing:rail-outbound`) are unique among system accounts only.
- `owner_id` → `customer.id` (`fk_account_owner`, nullable — added in Step 3; not checked
  for system accounts' NULL owner).
- `account_number` — nullable `varchar`, the human destination identifier (unique 10-digit
  numeric on customer accounts, NULL on system). `uq_account_account_number` is a **plain**
  UNIQUE index — Postgres allows multiple NULLs, so system accounts never collide. Assigned
  by the seed/tests via `generateAccountNumber()`; there is no create-account endpoint yet.

**`customer`** (Step 3) — the money-domain user profile.
- `id varchar` PK — the Keycloak `sub`, the same value stored in `account.owner_id` (kept
  `varchar` so `owner_id` FKs to it with no type change / no risky ALTER).
- `name`, `phone`, `email` — `varchar NOT NULL`; `created_at` / `updated_at` `timestamptz`.
- `phone` and `email` are **UNIQUE** — `uq_customer_phone` / `uq_customer_email` (both NOT NULL,
  so no multi-NULL concern). `email` uniqueness is **case-insensitive**: `uq_customer_email` is a
  functional index on `LOWER(email)`, so `User@Example.com` and `user@example.com` collide (the
  original-case value is still stored in the column — only the uniqueness key is lowercased). A
  future email-lookup query must match on `LOWER(email)` to use this index. `uq_customer_phone`
  is plain (phone is digits — no case).
- Keycloak keeps only auth; this table owns the profile (name masked before it leaves the
  service — see the transfers `maskName` helper).

**`external_payee`**
- `owner_id`, `display_name`, `rail`, `destination_ref`, `cooling_off_until` NOT NULL;
  `status` defaults `pending`; `activated_at` nullable. **No FK on `owner_id`** (a payee is
  metadata, not owner-joined to `customer`) — so seeding a payee needs no customer parent row.
- `uq_payee (owner_id, rail, destination_ref)` — UNIQUE. A destination is **date-gated**: usable
  from `cooling_off_until` onward — `now() >= cooling_off_until` (checked in the domain layer at
  outbound time, a later step). There is **no** status lifecycle — `status` / `activated_at` stay at
  their defaults (`pending` / NULL), reserved for a future admin/self-disable flow, unused now.
  `cooling_off_until` is stamped from the **DB clock** at enrollment
  (`now() + make_interval(secs => PAYEE_COOLING_OFF_SECONDS)`) — see
  [domain.md](./domain.md#external-payee-enrollment-step-5).

**`transaction`** (the table name is a SQL keyword — quoted `"transaction"` everywhere)
- FKs (all `NO ACTION`): `debit_account_id`/`credit_account_id` → `account.id`
  (nullable pre-resolution), `payee_id` → `external_payee.id` (nullable),
  `reverses_transaction_id` → `transaction.id` (self, nullable), `currency` →
  `currency.code` (NOT NULL).
- `type`, `status`, `amount`, `initiated_by` NOT NULL. `status` has **no** default — the
  service sets `PENDING` at initiation.
- `expires_at timestamptz NULL` (Step-4 lifecycle migration) — the 2-minute pending deadline,
  stamped from the DB clock at initiate (`now() + interval '2 minutes'`); NULL on directly-posted
  movements. The single source of truth for lazy expiry (`now() >= expires_at`), **no scheduler**.
- `idx_tx_account (debit_account_id, created_at)` — backs `GET /accounts/:id/transactions`.
- `uq_one_pending_per_initiator` (Step-4) — a **partial** unique index on `("initiated_by") WHERE
  status = 'PENDING'`: at most one live PENDING transfer per user, enforced by the DB (not just a
  service check). Terminal rows (POSTED / EXPIRED / CANCELLED / …) are excluded, so an initiator
  retains any number of terminal transfers but only ever one pending. A concurrent same-initiator
  initiate collides here (23505) — the service maps that to a 409 conflict.

**`ledger_entry`** — append-only, double-entry, the source of truth
- FKs (NOT NULL): `transaction_id` → `transaction.id`, `account_id` → `account.id`,
  `currency` → `currency.code`.
- `delta`, `balance_after` `bigint NOT NULL`. Per `transaction_id`, `SUM(delta) = 0`;
  `balance_after` is the running fold (`balance_before + delta`).
- **`created_at` defaults to `clock_timestamp()`**, NOT `now()`/transaction-start. It is
  the per-account reconstruction ordering key — **per-account monotonic** because posting
  holds the account `FOR UPDATE`, serializing that account's inserts.
- `idx_ledger_account_created (account_id, created_at)` — per-account ledger fold +
  reconstruction order.

### Satellites (step 2)

**`hold`** — reservation ledger
- FKs (NOT NULL): `account_id` → `account.id` (`fk_hold_account`), `transaction_id` →
  `transaction.id` (`fk_hold_transaction`).
- `amount bigint NOT NULL`, `chk_hold_amount_positive` (`amount > 0`). `status` defaults
  `PLACED`; `external_ref` nullable until the rail assigns it.
- Lifecycle PLACED → SETTLED | RELEASED | EXPIRED (append-only). Only PLACED counts toward
  `account.held`; `SUM(amount) WHERE status='PLACED'` per account == `account.held`.
- `idx_hold_account_placed (account_id) WHERE status = 'PLACED'` — a partial index (**not**
  named in the manifest; added deliberately). Reason: the held-sum reconciliation invariant
  and every hold operation read the *active* holds of one account; this partial index scopes
  exactly to that hot set and stays tiny (PLACED holds only).

**`user_limits`** — global baseline + per-customer override
- `currency` → `currency.code` (`fk_user_limits_currency`, NOT NULL). Caps
  (`per_transaction_max`, `daily_max`, `monthly_max`) are `bigint`, **nullable = no cap**.
- `uq_user_limits_scope UNIQUE NULLS NOT DISTINCT (scope, owner_id)` (Postgres 16). The
  `NULLS NOT DISTINCT` is load-bearing: a plain unique treats NULLs as distinct and would
  allow **many** `global` rows (owner_id NULL); `NULLS NOT DISTINCT` makes two global rows
  collide, enforcing the single global row. `currency` is deliberately **not** in the key
  (matches the manifest). Resolution: customer row wins over global; missing → global.
- Table name is `user_limits` to avoid the SQL reserved word `LIMIT`.

**`outbox_event`** — transactional outbox
- `transaction_id` → `transaction.id` (`fk_outbox_transaction`, NOT NULL); `payload jsonb`.
- `id` IS the `event_id` the analytics consumer dedups on.
- `idx_outbox_unpublished (created_at) WHERE published_at IS NULL` — partial index for the
  relay poll (claimed `FOR UPDATE SKIP LOCKED`, stamped `published_at` when published).
- **Relay read side (spec 04 step 6).** `IOutboxEventRepository.pollUnpublished(qr, limit)` claims
  a batch of unpublished rows oldest-first with `FOR UPDATE SKIP LOCKED` (so concurrent relay
  instances claim disjoint rows), and `markPublished(qr, ids)` stamps `published_at = now()` in the
  same tx — after the XADD, for at-least-once delivery. See
  [domain.md](./domain.md#step-6--outbox-relay-worker).

**`audit_log`** — immutable admin-action log
- `id bigint GENERATED ALWAYS AS IDENTITY` PK (append-only order; DB-generated, mapped via
  `@PrimaryGeneratedColumn`). `actor_id`, `action` NOT NULL; `metadata jsonb` nullable.
- `(target_type, target_id)` is a **polymorphic** pointer — intentionally **not** an FK.
- Append-only, **convention-only** — see the note below.

**`approval_request`** — maker-checker four-eyes
- `target_transaction_id` → `transaction.id` (`fk_approval_target_transaction`, nullable
  for non-transaction actions). `payload jsonb NOT NULL`; `status` defaults `PENDING`.
- `chk_approval_four_eyes` (`checker_id IS NULL OR checker_id <> maker_id`) backstops the
  service-side guarded transition — the DB check can only fire once a checker is set.
- Only `APPROVED` may transition to `EXECUTED` (enforced in the service).

**`idempotency_key`** — at-most-once replay safety
- **Composite PK `(owner_id, key)`** (`pk_idempotency_key`) — a key is unique per caller,
  not globally, so callers can't collide or probe each other. `transaction_id` →
  `transaction.id` (`fk_idem_transaction`, nullable while `in_progress`).
- `request_fingerprint` is the server-computed hash of the canonical business tuple.
- `idx_idem_expires (expires_at)` — the 24h cleanup sweep (Postgres has no row TTL).
- `idx_idem_fingerprint (owner_id, request_fingerprint, created_at)` — the 60s soft
  duplicate-suppression lookup (distinct keys, same request).

## Append-only enforcement is convention-only at this step (by design)

Both `ledger_entry` (a reversal appends new rows) and `audit_log` (one row per admin
action) are **append-only** — never `UPDATE`/`DELETE`. **At this step that is enforced by
convention only.** There is intentionally **no** DB-level trigger and **no** `REVOKE` on
either table:

- The balance service connects to Postgres as the **schema owner**, so a `REVOKE` against
  that same role would be meaningless (the owner can always regrant / bypass).
- Real DB-level enforcement (a distinct low-privilege app role with `INSERT`-only grants,
  and/or a block-UPDATE/DELETE trigger) is a **deliberately deferred hardening step**,
  approved by the developer — **not an oversight**. A reviewer should not read the
  absent guard as a missing constraint; it is scheduled hardening, tracked separately.

Until then, append-only is upheld by the domain layer: ledger mutations funnel through
the single posting operation, and audit rows are only ever inserted (spec 04, later steps).

## System seed — the two clearing accounts

The two per-rail **clearing accounts** are seeded by a migration, `SeedSystemAccounts1788998400000`
(`…/migrations/1788998400000-SeedSystemAccounts.ts`), so they exist on boot:

| `system_key` | kind | owner_id | currency |
|---|---|---|---|
| `clearing:rail-outbound` | `system` | NULL | MXN |
| `clearing:rail-inbound` | `system` | NULL | MXN |

- **Why a migration, not `tools/seed`.** These are **system constants** the service needs
  to run — the accounting counter-leg for all external money — exactly like the MXN
  `currency` row (seeded by `CreateBalanceCore`). They are not demo data, so they live in a
  boot migration rather than the seed tool.
- **Idempotent.** `up()` inserts both rows with
  `ON CONFLICT ("system_key") WHERE "kind" = 'system' DO NOTHING`, whose arbiter is the
  partial unique index `uq_account_system_key` — a re-run is a no-op. `spent_today_date` /
  `spent_month_date` are supplied (`CURRENT_DATE`, `date_trunc('month', CURRENT_DATE)::date`)
  because they are NOT NULL without a DB default; balance/held/spend counters default to 0,
  `status` to `active`, `id` to `gen_random_uuid()`. `down()` deletes the two rows.
- **Deliberately NOT seeded here:** any customer or demo data. Those belong to **spec 08 /
  `tools/seed`** (customers are provisioned in Keycloak and keyed by `sub`), not to the schema's
  boot migrations. (The **global baseline `user_limits`** row IS a system constant and is seeded —
  by its own data migration, [below](#system-seed--the-global-baseline-limits).)

## System seed — the global baseline limits

The single GLOBAL baseline `user_limits` row is seeded by a migration,
`SeedBaselineUserLimits1789257600000` (`…/migrations/1789257600000-SeedBaselineUserLimits.ts`), so
the reducer's limit check (spec 04 Limits, step 7) always has a cap to resolve on boot:

| scope | owner_id | currency | per_transaction_max | daily_max | monthly_max |
|---|---|---|---|---|---|
| `global` | NULL | MXN | `5000000` (50,000.00) | `10000000` (100,000.00) | `100000000` (1,000,000.00) |

- **Why a migration, not `tools/seed`.** The baseline caps are a **system constant** — every
  customer-initiated outbound is checked against them until an admin sets a per-customer override —
  exactly like the clearing accounts and the MXN `currency` row. Not demo data, so a boot migration.
- **Idempotent.** `up()` does `INSERT … ON CONFLICT ON CONSTRAINT "uq_user_limits_scope" DO NOTHING`
  (the `UNIQUE NULLS NOT DISTINCT (scope, owner_id)` constraint that actually enforces the single
  NULL-owner global row), so a re-run is a no-op; `id` defaults to `gen_random_uuid()`, timestamps
  to `now()`. `down()` deletes that one global row.
- **Deliberately NOT seeded here:** per-customer override rows (`scope='customer'`). Those come from
  the admin `PUT /limits` surface (a later step), not a boot migration.

## Repository layer (minimal, per-aggregate)

Each aggregate has a repository exposed **behind an interface + a Symbol DI token**, with a
TypeORM implementation — the same interface-behind-token pattern as the foundation's
`IHealthRepository` / `HealthRepository`. Per the repo-wide **interface/impl separation**
convention (see [`CLAUDE.md`](../../../CLAUDE.md#interface--implementation-separation)), the
pair lives in **sibling subfolders** under `src/database/repositories/`:
`interfaces/<name>.repository.interface.ts` (token + interface) and
`impl/<name>.repository.ts` (the `@Injectable` impl using `@InjectRepository`, which imports
its interface from `../interfaces/`). Consumers import the token + interface from
`interfaces/`; only `persistence.module.ts` references `impl/` (to bind each token).

`PersistenceModule` (`src/database/persistence.module.ts`) registers the eleven entity
repositories via `TypeOrmModule.forFeature([...])`, binds each token to its impl
(`{ provide: <NAME>_REPOSITORY, useClass: … }`), and **exports the tokens** so the domain
modules inject the interfaces. It is imported by `AccountsModule` (spec 04's first domain
slice) — the first thing to pull `PersistenceModule` into the running `AppModule` graph;
later domain modules import it the same way. See [domain.md](./domain.md#module-structure).

| Token | Interface | Methods |
|---|---|---|
| `ACCOUNT_REPOSITORY` | `IAccountRepository` | `findById`, `create`, `findByOwner`, `findByIdAndOwner(id, ownerId)`, `findBySystemKey`, `findByAccountNumber(accountNumber)`, `lockByIdForUpdate(queryRunner, id)`, `updateBalanceInTx(queryRunner, id, newBalance)`, `updateHeldInTx(queryRunner, id, newHeld)`, `lockOwnerForAccountCreation(qr, ownerId)` (tx-scoped advisory lock — self-service create), `countCustomerAccountsByOwner(qr, ownerId)` (the per-customer cap check), `createInTx(qr, data)` (tx-joined insert) |
| `CUSTOMER_REPOSITORY` | `ICustomerRepository` | `findById`, `create`, `existsByIdInTx(qr, id)` (tx-joined FK precondition for self-service create) |
| `LEDGER_ENTRY_REPOSITORY` | `ILedgerEntryRepository` | `findById`, `create`, `findByAccount(accountId, limit)` |
| `TRANSACTION_REPOSITORY` | `ITransactionRepository` | `findById`, `create`, `insertInTx`, `insertPendingInTx` (DB-clock `expires_at`), `findByIdInTx`, `findPendingByInitiator` (→ single row or null), `findPendingByInitiatorInTx`, `transitionToPostedInTx`, `expireOverduePendingByInitiator`, `supersedeActivePendingByInitiator`, `expireIfOverdue`, `expireIfOverdueInTx`, `transitionToCancelled`, `transitionToCancelledInTx`, `transitionToReversedInTx` (guarded POSTED→REVERSED — step 5c) |
| `HOLD_REPOSITORY` | `IHoldRepository` | `findById`, `create`, `insertInTx` (PLACED), `findByTransactionInTx`, `settleInTx` (guarded PLACED→SETTLED), `releaseInTx(qr, id, RELEASED\|EXPIRED)` (guarded PLACED→terminal), `recordExternalRefInTx(qr, id, externalRef)` (guarded `external_ref IS NULL` — step 5c) |
| `EXTERNAL_PAYEE_REPOSITORY` | `IExternalPayeeRepository` | `findById`, `create`, `findByOwner`, `createEnrollment(ownerId, displayName, rail, destinationRef, coolingOffSeconds)` (DB-clock `cooling_off_until`) |
| `USER_LIMITS_REPOSITORY` | `IUserLimitsRepository` | `findById`, `create`, `findByOwner` |
| `OUTBOX_EVENT_REPOSITORY` | `IOutboxEventRepository` | `findById`, `create`, `insertInTx`, `pollUnpublished(qr, limit)` (claim unpublished rows `FOR UPDATE SKIP LOCKED` — step 6), `markPublished(qr, ids)` (stamp `published_at = now()` — step 6) |
| `AUDIT_LOG_REPOSITORY` | `IAuditLogRepository` | `findById`, `create` |
| `APPROVAL_REQUEST_REPOSITORY` | `IApprovalRequestRepository` | `findById`, `create` |
| `IDEMPOTENCY_KEY_REPOSITORY` | `IIdempotencyKeyRepository` | `findByOwnerAndKey(ownerId, key)`, `create`, `findByOwnerAndKeyInTx`, `claimInTx` (INSERT … ON CONFLICT DO NOTHING), `markCompletedInTx`, `findRecentByFingerprintInTx` |

- **`create(data)`** persists a new row (`repo.save(repo.create(data))`) and returns it. No
  generic `save`/update primitive is exposed — updates are status transitions the domain
  step owns. Repositories carry **no domain logic** (no `postTransaction`, no multi-entity
  orchestration, no business rules).
- **`Account.lockByIdForUpdate`** issues `SELECT … FOR UPDATE` on the account row inside a
  caller-supplied `QueryRunner` transaction — the concurrency primitive the posting reducer
  is built on (ADR-13). `findBySystemKey` resolves the seeded clearing accounts.
- **`IdempotencyKey`** is keyed on its composite PK `(owner_id, key)`, so lookup is
  `findByOwnerAndKey` rather than `findById`. **Caveat:** because that PK is
  **client-supplied**, `create()` (`repo.save(repo.create(data))`) behaves as an **UPSERT** —
  a `create()` for an already-present `(owner_id, key)` silently **UPDATEs** the row instead
  of raising a `23505` unique violation. **Resolved in the domain layer (spec 04 step 3):**
  the idempotency wrapper claims the key with `claimInTx` — an explicit
  `INSERT … ON CONFLICT ("owner_id","key") DO NOTHING RETURNING "key"` whose returned-row
  count is the claim signal (1 = we won, 0 = a concurrent holder). It **never** uses
  `create()`/`.save()` for the claim, so the upsert can't silently overwrite the holder. See
  [domain.md](./domain.md#idempotency--soft-duplicate-step-3).
- **Owner-scoped reads.** `findByOwner` returns a customer's rows as a list (a customer has
  several accounts/payees). The single-resource, per-id anti-IDOR read
  (`WHERE id = :id AND owner_id = :sub` → 404) is now wired by the accounts domain step as a
  typed repository method, `IAccountRepository.findByIdAndOwner(id, ownerId)` — the
  token-bound repo is the seam the domain service already depends on, so the anti-IDOR
  predicate stays with its query without leaking `Repository<Entity>` into the service (see
  [domain.md](./domain.md#object-level-authorization-anti-idor-adr-3)). The generic
  `common/authz/owner-scoped.ts` `findOwnedOrFail` helper remains the sanctioned pattern for
  ad-hoc owner-scoped reads. `ILedgerEntryRepository.findByAccount(accountId, limit)` backs
  the per-account statement (`GET /api/accounts/:id/transactions`) — newest-first
  (`created_at DESC, id DESC`), always bounded by `limit`.
- **`Hold` lifecycle (spec 04 step 5b).** The reservation ledger's guarded, tx-aware seam:
  `insertInTx` appends a `PLACED` hold; `findByTransactionInTx` reads the (single) hold backing a
  transfer; `settleInTx` / `releaseInTx` flip `PLACED → SETTLED` / `PLACED → RELEASED|EXPIRED`
  (each guarded on `status = 'PLACED'`, returning `affected > 0`). The transfers service calls
  these alongside `IAccountRepository.updateHeldInTx` under the source's `FOR UPDATE` lock, so
  `SUM(PLACED holds per account) == account.held` holds at every commit; the reconciliation SUM
  query itself lives in tests, not as a repo method.
- **Rail-webhook idempotency gates (spec 04 step 5c).** Two more guarded, tx-aware transitions
  back the mocked-rail callbacks, each a single UPDATE whose predicate IS the idempotency gate:
  `ITransactionRepository.transitionToReversedInTx(qr, id)` flips `POSTED → REVERSED` (`WHERE id AND
  status = 'POSTED'`, stamping `failure_reason = 'rail_settlement_failed'`) — the FAILURE callback's
  gate, so a retried/concurrent failure gets 0 rows and posts no second compensating movement (there
  is no `reversed_at` column; the compensating transaction's `posted_at` + `reverses_transaction_id`
  is the audit record). `IHoldRepository.recordExternalRefInTx(qr, id, externalRef)` sets
  `external_ref` only `WHERE external_ref IS NULL` — the SUCCESS callback's reconcile, so a retried
  success never overwrites and writes NO balance/held/ledger. See
  [domain.md](./domain.md#step-5c--external-rail-webhooks).
- **Deferred to the domain step (driven by real callers):** ledger reconstruction / delta-sum;
  transaction-by-debit-account history; and the remaining status-transition helpers. These are
  intentionally absent now to avoid speculative, caller-less query surface. (The idempotency
  soft-duplicate-window lookup — `findRecentByFingerprintInTx` — landed with spec 04 step 3; the
  `Hold` lifecycle methods with step 5b; the rail-webhook gates —
  `transitionToReversedInTx` / `recordExternalRefInTx` — with step 5c; and the outbox relay poll —
  `pollUnpublished` (FOR UPDATE SKIP LOCKED) + `markPublished` — with step 6.)
