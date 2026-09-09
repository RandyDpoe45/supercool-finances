# Balance Service — Domain layer (spec 04)

The money core built on the [foundation](./README.md) and [persistence
layer](./persistence.md). This page records **what was built**; the design of record is
[`specs/04-balance-service.md`](../../../specs/04-balance-service.md).

The layer is built **bottom-up**, one scope-sized step per PR. This page grows a section
per step:

- **Step 1 — read surface** (below): two customer account reads, the domain module
  structure, and the money helper they need. No money movement, no locks.
- **Step 2 — the `postTransaction` reducer** ([below](#the-posttransaction-reducer-step-2)):
  the single balance-mutating operation, plus the domain-error base and the
  transaction-aware repository seam that land with the first write path.

Holds, limits, idempotency, OTP, transfers, and the outbox relay still arrive in later
steps.

## Module structure

`src/modules/accounts/` — the `Accounts` domain module.

| File | Role |
|---|---|
| `accounts.module.ts` | `imports: [PersistenceModule]`; declares the controller, provides the service. |
| `accounts.controller.ts` | `@Controller('api')` — the two read routes; calls the service (entities) then serializes to DTOs. |
| `accounts.service.ts` | Owner-scoped reads (returns **entities**) + `assertOwnerScope` + `STATEMENT_PAGE_LIMIT`. |
| `accounts.serializer.ts` | Pure explicit-whitelist serializers `serializeAccount` / `serializeStatementEntry` (entity→DTO). |
| `dto/account.dto.ts` | `AccountDto` — customer view of an account (the wire contract). |
| `dto/statement-entry.dto.ts` | `StatementEntryDto` — one ledger leg of a statement (the wire contract). |

`PersistenceModule` was merged unwired (no consumer). Importing it in `AccountsModule`,
and adding `AccountsModule` to `AppModule.imports`, is **what finally wires it into the
running app graph**. `DatabaseModule` already establishes the default TypeORM connection
and runs migrations on boot; `PersistenceModule`'s `forFeature(...)` reuses that same
connection — no second connection, no migration change.

## Endpoints

Both live under the existing global `/api` prefix, already scoped by the
`GatewayIdentityGuard` (Kong-injected `X-User-Id` required → 401 otherwise). The caller
id is read **only** via `@Identity()` — never the body or query.

### `GET /api/accounts`

Lists **only the caller's own** accounts (`owner_id = userId`). The repo's
`findByOwner(ownerId)` naturally excludes system/clearing accounts — their `owner_id` is
`NULL`, so no customer id matches.

- **200** → `{ accounts: AccountDto[] }`
- `AccountDto`: `{ id, currency, status, kind, balance, held, available }` — all strings.
  - Path: `AccountsController.listAccounts` → `AccountsService.listOwnedAccounts(userId)`
    (returns `Account[]`) → `IAccountRepository.findByOwner(userId)`; the controller maps
    each entity through `serializeAccount`.

### `GET /api/accounts/:id/transactions`

The per-account statement (that account's ledger legs), **newest-first, bounded**.

- `:id` is validated by `ParseUUIDPipe` — a malformed id yields **400** (`BAD_REQUEST`)
  **before** any DB access.
- The account is fetched **owner-scoped** and its existence verified; a missing,
  non-owned, or system account → **404** (`NOT_FOUND`).
- **200** → `{ accountId: string; entries: StatementEntryDto[] }`
- `StatementEntryDto`: `{ id, transactionId, delta, balanceAfter, currency, createdAt }`
  (`createdAt` is an ISO-8601 UTC string).
  - Path: `AccountsController.getAccountTransactions` →
    `AccountsService.getAccountStatement(id, userId)` (returns `{ account, entries }`) →
    `IAccountRepository.findByIdAndOwner(id, userId)` (ownership check) →
    `ILedgerEntryRepository.findByAccount(id, STATEMENT_PAGE_LIMIT)`; the controller maps
    each entity through `serializeStatementEntry` and echoes `account.id` as `accountId`.

## Object-level authorization (anti-IDOR, ADR-3)

Ownership is enforced **inside the query**, not as a separate pre-check, and the binding
lives in the repository:

- `IAccountRepository.findByIdAndOwner(id, ownerId)` → `findOne({ where: { id, ownerId } })`.
  A non-owned / missing / system account resolves `null`; the service throws
  `NotFoundException` → **404** (never **403**), so a caller cannot probe which account
  ids exist by watching the status code.
- The nested-resource rule holds: for `/:id/transactions` we verify **the account**
  (owned by the caller) before reading its ledger — we never trust the echoed id alone.

This is the same principle as the foundation's `common/authz/owner-scoped.ts`
`findOwnedOrFail` helper. Here it is expressed as a **typed repository method** rather
than the generic helper: the token-bound repository is the DI seam the service already
depends on, so the anti-IDOR predicate stays with the query it guards and needs no
`Repository<Entity>` leak into the domain service. The helper remains the sanctioned
pattern for ad-hoc owner-scoped reads.

## Layering & serialization

The service works in **entities/domain objects**; **DTO serialization is a transport
concern applied at the controller boundary** (repo-wide convention — see
[`CLAUDE.md` § Layering & serialization](../../../CLAUDE.md#layering--serialization)):

- `AccountsService` returns `Account` / `LedgerEntry` (and `{ account, entries }`) — it
  owns the authz (`assertOwnerScope`, ownership check → 404) and the bound, but never the
  wire shape.
- `AccountsController` maps each entity through an **explicit-whitelist serializer** in
  `accounts.serializer.ts` (`serializeAccount`, `serializeStatementEntry`) before
  responding. The serializers are **pure, plain functions** (no `@Injectable`).
- The serializers **list output fields explicitly and never spread the entity**, so
  internal columns (`ownerId`, `systemKey`, `spentToday`/`spentMonth` and their dates,
  `createdAt`/`updatedAt` on the account, …) can never leak onto the wire. A leaked
  internal field would be a security defect, so adding a DTO field is a deliberate act.
- **Derived / presentation fields are computed at serialize time** from shared helpers:
  `available` via `common/money`, `createdAt` via `Date.toISOString()`.

## Money & the `available` derivation

- Money is **`bigint` minor units surfaced as JS `string`** (int64 precision — never
  `Number`/float). See [persistence.md](./persistence.md#money--type-mapping-decisions).
- **Available balance is derived, never stored:** `available = balance − held`.
  `src/common/money/money.ts` `availableBalance(balance, held)` computes it with exact
  `BigInt` math, called at **serialize time** by `serializeAccount`. It lives in `common/`
  because it is cross-cutting — the posting operation (later step) reuses it. `available`
  MAY be negative for system/clearing accounts; customer overdraft is enforced at debit
  time (later step), not here.

## Bounded reads

`ILedgerEntryRepository.findByAccount(accountId, limit)` orders `created_at DESC, id DESC`
(the `id` tiebreak makes ties deterministic) and applies `take(limit)`. It is backed by
`idx_ledger_account_created`. The query is **always bounded** — `STATEMENT_PAGE_LIMIT`
(100) caps it; there is no unbounded variant, since an account's history grows without
limit.

## The `postTransaction` reducer (step 2)

`src/modules/posting/` — the money-safety **keystone**. `PostingService.postTransaction`
is the **single operation all balance mutations funnel through** (ADR-13), so the
append-only ledger and the materialized `balance` can never diverge. It has **no HTTP
surface** this step; the transfers / holds / admin layers (later steps) build a command
and call it. `PostingModule` (`imports: [PersistenceModule]`, provides + **exports**
`PostingService`) is wired into `AppModule`.

| File | Role |
|---|---|
| `posting.module.ts` | Provides/exports `PostingService`; imports `PersistenceModule`. |
| `posting.service.ts` | The reducer + its private helpers (`applyPosting`, `checkAndFold`, `validateCommand`). |
| `post-transaction.command.ts` | `PostTransactionCommand` / `PostingLeg` — the **domain** input (not a wire DTO). |
| `posting.errors.ts` | The concrete posting domain errors (extend `DomainError`). |
| `transaction-event.ts` | The balance-service **copy** of the transaction-event payload contract. |

### The command

`PostTransactionCommand` is a fully-formed, balancing movement to apply atomically:

```
PostTransactionCommand {
  type: TransactionType;                 // internal | external_outbound | external_inbound
  currency: string;                      // e.g. 'MXN'
  amount: string;                        // positive magnitude, minor units (bigint-as-string)
  legs: PostingLeg[];                    // signed deltas; must sum to zero
  initiatedBy: string;                   // actor recorded on the header
  payeeId?: string | null;
  reversesTransactionId?: string | null;
}
PostingLeg { accountId: string; delta: string }   // signed minor-units; '-'=debit, '+'=credit
```

The transaction id is generated **up front** (`randomUUID()`) so the legs and the outbox
row reference it without a DB round-trip.

### Validation (before any DB work)

`validateCommand` throws `InvalidPostingCommandError` unless: `currency` is present; there
are **≥ 2 legs**; every minor-unit string is **well-formed** (each `delta` a signed integer
`/^-?\d+$/`, `amount` an unsigned integer `/^\d+$/`); `amount > 0`; account ids are
**distinct**; **no zero-delta** leg; `Σ delta === 0` (double-entry); and `amount` **equals
the moved magnitude** (the sum of the positive-delta legs). Two of these are hardening:

- **Shape first.** The string-shape checks run **before any `BigInt()`**, so a malformed
  value (`'1.5'`, `'abc'`) yields this domain error rather than a raw `SyntaxError` that
  would later render a generic 500. All downstream `BigInt()` calls (the fold,
  `deriveDebitCredit`) are therefore safe.
- **`amount` must not lie.** Balances and the ledger fold from the legs, so a wrong `amount`
  is not a money-safety breach — but it would land in the transaction header and the
  analytics outbox payload. The cross-check (declared `amount` == total moved magnitude)
  keeps the emitted magnitude honest, for the 2-leg case and any balanced multi-leg.

All arithmetic is exact `BigInt` via `common/money` (`sumMinor`) — never `Number`/float.

### Mechanics (ADR-13)

**One DB transaction, READ COMMITTED.** Steps c–g run inside it:

1. **Lock** every affected account `FOR UPDATE` via `IAccountRepository.lockByIdForUpdate`,
   in **canonical ascending account-id order**. A single lock order across all posts is
   what removes the classic two-transfer opposite-order deadlock. A missing account →
   `AccountNotFoundError`.
2. **Check + fold** each leg against its locked account (`checkAndFold`, see rules below),
   computing `balance_after = balance_before + delta` (`addMinor`).
3. **Header first:** one `Transaction` row, status `POSTED`, `postedAt = now`, with
   `debit`/`credit` account ids derived from a clean 2-leg pair (negative leg = debit,
   positive = credit); **null** for both when the legs are not one such pair. The header is
   inserted **before** the ledger and outbox rows because both FK their `transaction_id` to
   it — the parent must exist first. The up-front `txId` lets this happen without a
   round-trip.
4. **Balance-then-ledger** under the lock: `updateBalanceInTx` sets the account `balance`
   (and `updated_at`) **first**, then `LedgerEntry.insertInTx` appends the leg carrying the
   resulting `balance_after`. `created_at` is **not** set — the `clock_timestamp()` default
   is the per-account reconstruction ordering key.
5. **Outbox:** exactly **one** `OutboxEvent` in the same tx (transactional outbox, ADR-5),
   then `commit`.

On any throw the tx is **rolled back** (guarded by `isTransactionActive`) and the query
runner is always **released**. **Only a deadlock** (SQLSTATE `40P01`, matched on the error
or its `driverError`) is retried — bounded to `MAX_DEADLOCK_RETRIES` (3) additional
attempts, each in a fresh transaction; every other error propagates.

### Per-leg rules (`checkAndFold`)

- **Currency:** every leg's account currency must equal `command.currency`, else
  `CurrencyMismatchError`.
- **Customer debit** (`kind === 'customer'`, `delta < 0`): a **frozen** account →
  `AccountFrozenError`; and the debit magnitude must be covered by
  **`available = balance − held`** (`availableMinor`) — `available < -delta` →
  `InsufficientFundsError`. Because the row is locked and `available` subtracts existing
  `held`, this is the single-row overdraft invariant.
- **System accounts** (`kind === 'system'`, the per-rail clearing accounts) are **exempt**
  from the frozen and funds checks — a clearing balance may legitimately go negative (net
  in transit). Credits (`delta > 0`) are never funds-checked.

### Deferred scope (NOT in the reducer yet)

Per-period **spend-counter / limit** updates (step 7), **hold / `held`** mutation (step 5),
and **idempotency-key** handling (step 3) are intentionally absent — but the funds check
**does** subtract existing `held` when computing `available`, so it is already
hold-aware. No endpoints, OTP, or transfer lifecycle here.

### Transaction-aware repository seam

Mirroring the `lockByIdForUpdate(queryRunner, …)` precedent, the reducer's writes join its
transaction through **tx-aware repository methods** that operate via `queryRunner.manager`
(the auto-commit `create` / `findById` methods are untouched, and no new DI tokens are
added):

| Method | Effect |
|---|---|
| `IAccountRepository.updateBalanceInTx(qr, id, newBalance)` | Targeted `UPDATE balance (+ updated_at)`. |
| `ILedgerEntryRepository.insertInTx(qr, data)` | Append one ledger leg (`created_at` left to default). |
| `ITransactionRepository.insertInTx(qr, data)` | Insert the transaction header. |
| `IOutboxEventRepository.insertInTx(qr, data)` | Insert the outbox row (same tx). |

Each `insertInTx` uses `manager.save(manager.create(Entity, data))` so DB-generated columns
(`id`, `created_at`) come back merged onto the returned entity; the ledger/outbox PKs are
DB-generated and the transaction id is a freshly-generated UUID, so every call can only
ever **INSERT**.

### Domain errors

Framework-agnostic error classes with **no** `@nestjs/common` coupling — the money rules
live in the service, not in transport. A small cross-cutting base
`common/errors/domain-error.ts` `DomainError` carries a stable machine-readable `code`
(distinct from any HTTP status); the posting errors extend it:

| Class | `code` | Meaning |
|---|---|---|
| `InvalidPostingCommandError` | `INVALID_POSTING_COMMAND` | Malformed command (shape / balancing). |
| `AccountNotFoundError` | `ACCOUNT_NOT_FOUND` | A leg references a missing account. |
| `InsufficientFundsError` | `INSUFFICIENT_FUNDS` | Customer debit exceeds `available`. |
| `AccountFrozenError` | `ACCOUNT_FROZEN` | Debit on a frozen customer account. |
| `CurrencyMismatchError` | `CURRENCY_MISMATCH` | Leg account currency ≠ transaction currency. |

**Deferred HTTP mapping.** The global `AllExceptionsFilter` currently derives `code` from
the HTTP status, so a `DomainError` reaching it today would render a generic 500. Mapping
each domain `code` to a status (e.g. `INSUFFICIENT_FUNDS` → 422, `ACCOUNT_FROZEN` → 409,
`ACCOUNT_NOT_FOUND` → 404, `INVALID_POSTING_COMMAND` → 400) is done at the **endpoint step**
when the write routes first throw these — there is no HTTP surface for the reducer yet.

### Outbox payload (provisional transaction-event contract)

`transaction-event.ts` holds the **balance-service's own copy** of the transaction-event
shape (per ADR-16 — the analytics server keeps an independent copy; the **spec** is the
contract of record that keeps them in sync). It is **provisional** for this step; the relay
and consumer steps may refine it, tracked via the spec. `event_type` is
`transaction.posted`; the `jsonb` `payload` is:

```
TransactionPostedPayload {
  txId: string;
  type: TransactionType;
  currency: string;
  amount: string;                 // positive magnitude, minor units
  legs: { accountId: string; delta: string; balanceAfter: string }[];
  occurredAt: string;             // ISO-8601 UTC
}
```

The payload types are declared as `type` aliases (not interfaces) so they satisfy the
entity's `Record<string, unknown>` column without an explicit index signature.

## Not in this slice (later steps)

Idempotency + soft-duplicate suppression, internal transfers + OTP, holds + external
outbound, the outbox **relay worker**, limits + external payees, and admin ops +
maker-checker + external rails. Statement pagination beyond the first page is likewise
deferred — the read slice returns only the most recent `STATEMENT_PAGE_LIMIT` legs.
