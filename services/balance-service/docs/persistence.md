# Balance Service — Persistence layer (spec 04, step 1: the money spine)

This document describes the **first slice** of the balance service's Postgres schema:
the FK-self-contained **money spine**. The design of record is
[`specs/DATA-MODEL.md`](../../../specs/DATA-MODEL.md) (Part 1) +
[`specs/balance-schema.yaml`](../../../specs/balance-schema.yaml); this page records
**what was built and the mapping decisions**, so a reader/reviewer does not have to
reverse-engineer them from the migration.

Schema changes are **migration-only** (`synchronize: false`, `migrationsRun: true` —
see [foundation docs](./README.md#migrations-on-boot)). Entities and migrations are
referenced **by class** in `src/database/data-source.options.ts`, never by glob.

## What this step includes (and what it defers)

**Included** — five tables + the native enum types they use:

| Table | Role |
|---|---|
| `currency` | ISO 4217 reference/lookup; seeded with **MXN** only. |
| `account` | Balance-bearing account (customer or system/clearing); materialized `balance` / `held` + fixed-window spend counters. |
| `external_payee` | Enrolled external beneficiary, cooling-off gated. |
| `transaction` | Header grouping the balancing ledger legs of one movement. |
| `ledger_entry` | Append-only double-entry ledger — the source of truth for money movement. |

**Deferred to step 2** (not in this migration): `hold`, `user_limits`, `outbox_event`,
`audit_log`, `approval_request`, `idempotency_key`.

Migration: `CreateBalanceCore1788825600000`
(`src/database/migrations/1788825600000-CreateBalanceCore.ts`). It creates the enum
types and tables in FK dependency order and seeds MXN; `down()` drops the tables in
reverse order and removes the enum types.

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

The step-2 enums (`hold_status`, `user_limits_scope`, `approval_action`,
`approval_status`, `idempotency_status`) are intentionally **not** created yet.

## Money & type mapping decisions

- **Money is `bigint` minor units + a `currency` code — never float.** Every
  money-bearing column (`account.balance`/`held`/`spent_today`/`spent_month`,
  `transaction.amount`, `ledger_entry.delta`/`balance_after`) is `bigint`.
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

## Append-only enforcement is convention-only at this step (by design)

`ledger_entry` (and later `audit_log`) is **append-only** — never `UPDATE`/`DELETE`, a
reversal appends new rows. **At this step that is enforced by convention only.** There
is intentionally **no** DB-level trigger and **no** `REVOKE` on the table:

- The balance service connects to Postgres as the **schema owner**, so a `REVOKE` against
  that same role would be meaningless (the owner can always regrant / bypass).
- Real DB-level enforcement (a distinct low-privilege app role with `INSERT`-only grants,
  and/or a block-UPDATE/DELETE trigger) is a **deliberately deferred hardening step**,
  approved by the developer — **not an oversight**. A reviewer should not read the
  absent guard as a missing constraint; it is scheduled hardening, tracked separately.

Until then, append-only is upheld by the domain layer funnelling all mutations through
the single posting operation (spec 04, later steps).
