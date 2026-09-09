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

Each migration's `down()` drops its tables (any order for the satellites; reverse FK
order for the spine) then removes its enum types — a clean inverse.

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
| `transaction_status` | `PENDING`, `POSTED`, `FAILED`, `REVERSED` | `transaction.status` |
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
- `status` defaults to `active`.

**`external_payee`**
- `owner_id`, `display_name`, `rail`, `destination_ref`, `cooling_off_until` NOT NULL;
  `status` defaults `pending`; `activated_at` nullable.
- `uq_payee (owner_id, rail, destination_ref)` — UNIQUE. A destination is usable only
  when `status = 'active'` AND `now() >= cooling_off_until` (enforced in the service).

**`transaction`** (the table name is a SQL keyword — quoted `"transaction"` everywhere)
- FKs (all `NO ACTION`): `debit_account_id`/`credit_account_id` → `account.id`
  (nullable pre-resolution), `payee_id` → `external_payee.id` (nullable),
  `reverses_transaction_id` → `transaction.id` (self, nullable), `currency` →
  `currency.code` (NOT NULL).
- `type`, `status`, `amount`, `initiated_by` NOT NULL. `status` has **no** default — the
  service sets `PENDING` at initiation.
- `idx_tx_account (debit_account_id, created_at)` — backs `GET /accounts/:id/transactions`.

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
- **Deliberately NOT seeded here:** global/default `user_limits`, and any customer or demo
  data. Those belong to **spec 08 / `tools/seed`** (customers are provisioned in Keycloak
  and keyed by `sub`), not to the schema's boot migrations.

## Repository layer (minimal, per-aggregate)

Each aggregate has a repository exposed **behind an interface + a Symbol DI token**, with a
TypeORM implementation — the same interface-behind-token pattern as the foundation's
`IHealthRepository` / `HealthRepository`. Files live in
`src/database/repositories/` (`<name>.repository.interface.ts` = token + interface;
`<name>.repository.ts` = `@Injectable` impl using `@InjectRepository`).

`PersistenceModule` (`src/database/persistence.module.ts`) registers the ten entity
repositories via `TypeOrmModule.forFeature([...])`, binds each token to its impl
(`{ provide: <NAME>_REPOSITORY, useClass: … }`), and **exports the tokens** so the domain
modules inject the interfaces. It is imported by `AccountsModule` (spec 04's first domain
slice) — the first thing to pull `PersistenceModule` into the running `AppModule` graph;
later domain modules import it the same way. See [domain.md](./domain.md#module-structure).

| Token | Interface | Methods |
|---|---|---|
| `ACCOUNT_REPOSITORY` | `IAccountRepository` | `findById`, `create`, `findByOwner`, `findByIdAndOwner(id, ownerId)`, `findBySystemKey`, `lockByIdForUpdate(queryRunner, id)` |
| `LEDGER_ENTRY_REPOSITORY` | `ILedgerEntryRepository` | `findById`, `create`, `findByAccount(accountId, limit)` |
| `TRANSACTION_REPOSITORY` | `ITransactionRepository` | `findById`, `create` |
| `HOLD_REPOSITORY` | `IHoldRepository` | `findById`, `create` |
| `EXTERNAL_PAYEE_REPOSITORY` | `IExternalPayeeRepository` | `findById`, `create`, `findByOwner` |
| `USER_LIMITS_REPOSITORY` | `IUserLimitsRepository` | `findById`, `create`, `findByOwner` |
| `OUTBOX_EVENT_REPOSITORY` | `IOutboxEventRepository` | `findById`, `create` |
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
- **Deferred to the domain step (driven by real callers):** outbox `pollUnpublished`
  (FOR UPDATE SKIP LOCKED) + `markPublished`; hold PLACED-sum / reconciliation; ledger
  reconstruction / delta-sum; transaction-by-debit-account history; and the remaining
  status-transition helpers. These are intentionally absent now to avoid speculative,
  caller-less query surface. (The idempotency soft-duplicate-window lookup —
  `findRecentByFingerprintInTx` — landed with spec 04 step 3.)
