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
- **Step 3 — idempotency & soft-duplicate**
  ([below](#idempotency--soft-duplicate-step-3)): the generic at-most-once wrapper +
  60s duplicate-suppression, and the shared transaction-with-deadlock-retry helper.
- **Step 4a — OTP module + Redis client**
  ([below](#otp-module--redis-client-step-4a)): the user-scoped one-time code service
  (singleton gate + single-use), and the global lifecycle-managed Redis client it uses.
- **Step 4b — internal transfers**
  ([below](#step-4b--internal-transfers)): the customer↔customer transfer flow end-to-end —
  the `/api` transfers + OTP endpoints, the initiate=PENDING / confirm=post lifecycle, the
  QueryRunner-aware `postPendingInTx` posting seam, the DomainError→HTTP mapping, and the zod
  request validation.
- **Step 4c — confirmation of payee + customer representation**
  ([below](#confirmation-of-payee--customer-representation-step-4c)): the `customer` table, the
  human `account_number`, and the resolve→token→initiate gate that makes internal transfers
  human-usable (addressed by account number, with a masked payee name shown before initiate).
- **Step 5 — external payee enrollment**
  ([below](#external-payee-enrollment-step-5)): the `POST /api/payees` / `GET /api/payees`
  surface, the constant outbound rail, the env-configured cooling-off, and the DB-clock,
  date-gated usability. No money movement yet.
- **Step 5b — holds + external outbound transfers**
  ([below](#step-5b--holds--external-outbound-transfers)): the external-outbound transfer flow —
  `POST /api/transfers/external` places a hold + PENDING transaction, and the SHARED confirm
  **settles** it (customer → clearing) at OTP-confirm; the `Hold` reservation ledger + `account.held`
  lifecycle around the posting keystone.
- **Step 5c — external rail webhooks**
  ([below](#step-5c--external-rail-webhooks)): the mocked rail's third-party callbacks on a new
  **`/external`** surface (HMAC-signature trust domain) — the **outbound settlement callback** (SUCCESS
  reconciles via the hold `externalRef`, no new ledger post; FAILURE reverses `clearing → customer`
  with a customer-first lock + `POSTED → REVERSED` + `reverses_transaction_id`) and the **inbound
  credit** (`clearing:rail-inbound → customer` by account number, not OTP-gated, idempotent by the
  rail `externalRef`, frozen-can-be-credited); plus the `postFreshInTx` reducer seam.
- **Step 7 — limits enforcement**
  ([below](#step-7--limits-enforcement)): per-transaction / daily / monthly amount caps enforced
  **inside the reducer**, under the same `FOR UPDATE` lock as the funds check, on
  customer-initiated outbound only — resolve the caps (customer override else global baseline),
  lazily reset the fixed window off the DB clock (UTC), reject on breach (422 `LIMIT_EXCEEDED`),
  and increment the per-account `spent_today`/`spent_month` atomically with the post. The global
  baseline is seeded by a migration.

The outbox relay and admin ops still arrive in later steps.

## Module structure

`src/modules/accounts/` — the `Accounts` domain module.

The accounts feature follows the **controller-surface convention** (see
[`CLAUDE.md` § Controller surfaces](../../../CLAUDE.md#controller-surfaces)): the feature
module provides + exports the service and owns its surface controller file, while the `/api`
surface registry ({@link ApiModule}, `src/modules/api/api.module.ts`) **declares** the
controller and imports the feature module for the service. The service also follows the
**interface/impl separation** convention
([`CLAUDE.md`](../../../CLAUDE.md#interface--implementation-separation)): the module root
holds only `accounts.module.ts`; business logic lives under `service/` (interface + token in
`service/interfaces/`, concrete class in `service/impl/`, consumers inject the token); and the
controller lives in its own `api/` surface folder with its `dto/` and `serializers/`.

| File | Role |
|---|---|
| `accounts.module.ts` | Feature module (the only root file): `imports: [PersistenceModule]`, binds `{ provide: ACCOUNTS_SERVICE, useClass: AccountsService }`, `exports: [ACCOUNTS_SERVICE]`. **No controllers of its own.** |
| `service/interfaces/accounts.service.interface.ts` | `IAccountsService` + the `ACCOUNTS_SERVICE` Symbol token. |
| `service/impl/accounts.service.ts` | `AccountsService implements IAccountsService` — owner-scoped reads (returns **entities**) + `assertOwnerScope` + `STATEMENT_PAGE_LIMIT`. |
| `api/accounts-api.controller.ts` | `AccountsApiController`, `@Controller('api')` — the two read routes; **declared by `ApiModule`**; injects `@Inject(ACCOUNTS_SERVICE) accounts: IAccountsService`, calls it (entities) then serializes to DTOs. |
| `api/serializers/accounts.serializer.ts` | Pure explicit-whitelist serializers `serializeAccount` / `serializeStatementEntry` (entity→DTO). |
| `api/dto/account.dto.ts` | `AccountDto` — customer view of an account (the wire contract). |
| `api/dto/statement-entry.dto.ts` | `StatementEntryDto` — one ledger leg of a statement (the wire contract). |

`PersistenceModule` is imported by `AccountsModule`; `AccountsModule` is reached from the
graph via `ApiModule` (which `AppModule` imports), so the accounts feature is wired into the
running app **through its surface registry**, not directly by `AppModule`. `DatabaseModule`
already establishes the default TypeORM connection and runs migrations on boot;
`PersistenceModule`'s `forFeature(...)` reuses that same connection — no second connection,
no migration change.

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
  - Path: `AccountsApiController.listAccounts` → `AccountsService.listOwnedAccounts(userId)`
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
  - Path: `AccountsApiController.getAccountTransactions` →
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
- `AccountsApiController` maps each entity through an **explicit-whitelist serializer** in
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
and call it. `PostingModule` binds the reducer behind the `POSTING_SERVICE` token
(interface/impl split) and **exports** it; it is a **service-only feature module** — with no
controller yet, it is imported **transitionally by `AppModule`** so the service is resolvable
in the graph. Under the controller-surface convention it moves under its consuming surface
module once a controller uses it (the transfers `-api` controller, step 4).

The module root holds only `posting.module.ts`; everything else is under `service/`
(no controller yet). The service's contract types (`post-transaction.command.ts`,
`transaction-event.ts`) live in `service/interfaces/` alongside the interface, and the domain
errors at the `service/` root — so `service/interfaces/` never imports from `service/impl/`.

| File | Role |
|---|---|
| `posting.module.ts` | Binds `{ provide: POSTING_SERVICE, useClass: PostingService }`, exports the token; imports `PersistenceModule`. |
| `service/interfaces/posting.service.interface.ts` | `IPostingService` + the `POSTING_SERVICE` Symbol token. |
| `service/interfaces/post-transaction.command.ts` | `PostTransactionCommand` / `PostingLeg` — the **domain** input (not a wire DTO). |
| `service/interfaces/transaction-event.ts` | The balance-service **copy** of the transaction-event payload contract. |
| `service/errors.ts` | The concrete posting domain errors (extend `DomainError`). |
| `service/impl/posting.service.ts` | `PostingService implements IPostingService` — the reducer + its private helpers (`applyPosting`, `checkAndFold`, `validateCommand`). |

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

The transaction/retry mechanics are the shared **`runInTransactionWithRetry`** helper
(`src/common/db/run-in-transaction.ts`, [below](#shared-transaction--deadlock-retry-helper)):
on any throw the tx is **rolled back** (guarded by `isTransactionActive`) and the query
runner is always **released**; **only a deadlock** (SQLSTATE `40P01`, matched on the error or
its `driverError`) is retried — bounded to 3 additional attempts, each in a fresh
transaction; every other error propagates. `applyPosting` is the `fn` run inside it, so
`txId`/`lockOrder` (captured up front) stay stable across retries.

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

At step 2, per-period **spend-counter / limit** updates, **hold / `held`** mutation, and
**idempotency-key** handling were all intentionally absent — but the funds check **does**
subtract existing `held` when computing `available`, so it is already hold-aware. Since then:
spend-counter/limit enforcement moved **into** the reducer in **step 7** (only when the caller
opts in via `command.limitAccountId` — see [below](#step-7--limits-enforcement)); hold/`held`
mutation still lives in the transfers layer (step 5b); idempotency is the wrapper's job (step 3).

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
| `LimitExceededError` | `LIMIT_EXCEEDED` | Customer-initiated outbound would breach a per-transaction / daily / monthly cap (step 7; → 422). |
| `CurrencyMismatchError` | `CURRENCY_MISMATCH` | Leg account currency ≠ transaction currency. |
| `TransactionNotPendingError` | `TRANSFER_NOT_PENDING` | Guarded `PENDING → POSTED` transition affected 0 rows (already posted / not pending). Shares the `TRANSFER_NOT_PENDING` code with the transfers service's pre-check; both → 409. |

**HTTP mapping (added in step 4b).** The global `AllExceptionsFilter` now has a `DomainError`
branch that maps each domain `code` to its status via the single
[`domain-error-status.ts`](#domainerrorhttp-mapping) table (`INSUFFICIENT_FUNDS` → 422,
`ACCOUNT_FROZEN` → 409, `ACCOUNT_NOT_FOUND` → 404, `INVALID_POSTING_COMMAND` → 400), and returns
the domain `code` itself as the response `code`.

### Outbox payload (provisional transaction-event contract)

`service/interfaces/transaction-event.ts` holds the **balance-service's own copy** of the
transaction-event shape (per ADR-16 — the analytics server keeps an independent copy; the **spec** is the
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

## Idempotency & soft-duplicate (step 3)

`src/modules/idempotency/` — a **generic at-most-once wrapper** for money-moving requests
(spec 04 Transfers), **decoupled from posting**: any operation can run under an
`Idempotency-Key` with 60s soft duplicate-suppression. It has **no HTTP surface** this step;
`IdempotencyModule` binds the service behind the `IDEMPOTENCY_SERVICE` token (interface/impl
split) and **exports** it; it is a **service-only feature module**, imported **transitionally
by `AppModule`** until the transfers surface consumes it (step 4). The module root holds only
`idempotency.module.ts`; everything else is under `service/`.

| File | Role |
|---|---|
| `idempotency.module.ts` | Binds `{ provide: IDEMPOTENCY_SERVICE, useClass: IdempotencyService }`, exports the token; imports `PersistenceModule`. |
| `service/interfaces/idempotency.service.interface.ts` | `IIdempotencyService` + the `IDEMPOTENCY_SERVICE` token, plus the shared `IdempotencyParams` / `IdempotentOperation` / `IdempotencyOutcome` types (kept here so the interface never imports from `impl/`). |
| `service/impl/idempotency.service.ts` | `IdempotencyService implements IIdempotencyService` — the `execute(params, operation)` wrapper + its replay/claim flow. |
| `service/fingerprint.ts` | Pure `computeFingerprint(input)` — `sha256` hex over the canonical business tuple. Lives at the `service/` root so BOTH the interface (for `FingerprintInput`) and the impl import it without an interface→impl edge. |
| `service/errors.ts` | The domain errors (extend `DomainError`). |

### The `execute` contract

```
execute(params, operation): Promise<{ transactionId: string; replayed: boolean }>

params = {
  ownerId: string;
  key: string;                          // the client Idempotency-Key
  fingerprintInput: { type; source: string|null; destination: string|null; amount; currency };
  confirmDuplicate?: boolean;           // override a suspected soft-duplicate
}
operation = (queryRunner) => Promise<{ transactionId: string }>   // the movement, run IN-TX
```

`replayed` is `true` when a prior completed result was returned (money moved 0 additional
times) and `false` when the operation ran fresh.

### One-transaction atomicity model

Everything runs in **ONE transaction** (READ COMMITTED) via the shared
[`runInTransactionWithRetry`](#shared-transaction--deadlock-retry-helper) helper, so a
deadlock retries and **any error rolls back the key claim together with the movement** — a
failed attempt leaves **no** key behind and stays fully retryable. The flow:

1. **Fingerprint** — `computeFingerprint(fingerprintInput)` once, outside the (retryable) tx.
2. **Replay check** — `findByOwnerAndKeyInTx(ownerId, key)`. If a row exists: fingerprint
   mismatch → `IdempotencyKeyReuseError`; `completed` (with its linked transaction) → return
   `{ transactionId, replayed: true }`; else → `IdempotencyInProgressError` (defensive).
3. **Soft-duplicate** (skipped when `confirmDuplicate`) — `findRecentByFingerprintInTx`
   (same owner + fingerprint, `created_at > now − 60s`, a DIFFERENT key). A hit →
   `SuspectedDuplicateError` (a **soft** block: an identical payment is legitimately valid, so
   the caller may re-issue with `confirmDuplicate`).
   Note this is a **committed-sibling heuristic**: it reliably catches a *sequential* resubmit
   (the first request already committed), but under `READ COMMITTED` two truly simultaneous
   requests with different keys can't see each other's uncommitted claim, so a sub-second
   concurrent new-key double-submit may slip through. That's acceptable — the idempotency key
   is the hard at-most-once control; soft-duplicate is defense-in-depth. Don't over-trust it.
4. **Claim** — `claimInTx` (`INSERT … ON CONFLICT DO NOTHING`), `status = in_progress`,
   `expires_at = now + 24h`. If the claim returns **false** (a concurrent caller won the race
   between steps 2 and 4), re-read and resolve exactly as step 2.
5. **Operate** — `const { transactionId } = await operation(queryRunner)` (the movement, in
   the same tx).
6. **Complete** — `markCompletedInTx(ownerId, key, transactionId)`; the wrapper commits and
   returns `{ transactionId, replayed: false }`.

### The `ON CONFLICT` claim resolves the upsert caveat

The composite PK `(owner_id, key)` is **client-supplied**, so `create()`/`.save()` would
**UPSERT** — silently overwriting a concurrent holder instead of failing (see
[persistence.md](./persistence.md)). `claimInTx` instead does an explicit
`INSERT … ON CONFLICT ("owner_id","key") DO NOTHING RETURNING "key"`; a returned row means
**this** call inserted (claimed), zero means a holder already exists. Under READ COMMITTED a
second concurrent claim **blocks on the claim row lock** until the first tx commits (→
`completed`, the second replays) or rolls back (→ gone, the second claims). Because of that
lock-wait, a committed `in_progress` is **never externally observable** — which is why the
in-progress paths are labeled defensive (kept for safety, not an expected outcome).

### Domain errors

Framework-agnostic classes extending `common/errors/domain-error.ts` `DomainError`, each with
a stable `code` and no HTTP coupling (mapping deferred to the transfers endpoint step):

| Class | `code` | Meaning |
|---|---|---|
| `SuspectedDuplicateError` | `SUSPECTED_DUPLICATE` | Identical request under a different key within 60s (soft; confirmable). |
| `IdempotencyKeyReuseError` | `IDEMPOTENCY_KEY_REUSED` | Same key, different request parameters (fingerprint mismatch). |
| `IdempotencyInProgressError` | `IDEMPOTENCY_IN_PROGRESS` | A request with this key is in progress (defensive). |

### Shared transaction + deadlock-retry helper

`src/common/db/run-in-transaction.ts` `runInTransactionWithRetry(dataSource, fn, opts?)` is
the single seam every money-mutating operation opens its transaction through: create + connect
a `QueryRunner`, `startTransaction` (default `READ COMMITTED`), run `fn`, commit; on a deadlock
(`40P01`, via `isDeadlockError`) roll back and retry in a fresh tx (bounded, default 3); on any
other error roll back and rethrow; **always** release. Both `IdempotencyService.execute` and
`PostingService.postTransaction` use it — the latter a **behavior-preserving** refactor of its
former inline loop (same isolation, retry bound, rollback/release, and deadlock detection).

### Wired in step 4b (transfers)

`POST /api/transfers` now runs `execute` around the PENDING-header insert (the `operation`), so
a **replayed `Idempotency-Key` creates the transfer once** — see
[Step 4b](#step-4b--internal-transfers). Note the wrapped operation for an internal transfer is
the **PENDING creation**, not the money movement: money moves at confirm, gated by the OTP
single-use + the guarded PENDING→POSTED transition.

## OTP module + Redis client (step 4a)

The user-scoped second factor for authorizing a user's **own** transfers (spec 04 OTP
module). This step delivers the **capability only** — the OTP service and its Redis client.
The generate/confirm endpoints, the `GET /api/pending-authorizations` route, and the transfer
lifecycle that consumes a code all land in **step 4b**; there is **no HTTP surface** here.

### Redis client

`src/redis/` — a single lifecycle-managed **ioredis** client bound behind the `REDIS_CLIENT`
Symbol token, mirroring the `src/database/` infra layout (parallel to `DatabaseModule`).
`RedisModule` is **`@Global`**, so it is imported **once** in `AppModule` and the token is
resolvable everywhere: the OTP service uses it now, and the step-6 outbox relay reuses the
**same** client.

| File | Role |
|---|---|
| `redis/redis.tokens.ts` | The `REDIS_CLIENT` Symbol token — consumers inject the connection via it, never construct their own. |
| `redis/redis.module.ts` | `@Global` module: `useFactory` builds the client from the injected `AppConfig` (`config.redis.url`); implements `OnModuleDestroy` to `quit()` on shutdown. |

Boot-resilience choices (the non-obvious *why*):

- **`lazyConnect: true`** — no socket is opened until the first command. Booting `AppModule`
  while Redis is down neither connects nor throws, so any test/boot that creates `AppModule`
  without a live Redis stays green.
- **`'error'` handler attached in the factory** — ioredis emits `'error'` on connection
  trouble; an unhandled EventEmitter `'error'` is *thrown* and would crash the process. The
  handler swallows it (ioredis owns reconnect/backoff), so a transient outage degrades
  commands, not the process. Command-level failures still reject their own promises.
- **`maxRetriesPerRequest: null`** — never hard-cap retries of a queued command across a
  reconnect.
- **`onModuleDestroy() → client.quit()`** (guarded with `.catch(() => 'OK')`) — a graceful
  QUIT that won't surface as a rejected `app.close()` if Redis is unreachable at shutdown.
  Safe on a never-connected lazy client too (ioredis does a transient connect then
  disconnects; still resolves).

### OTP module

`src/modules/otp/` — follows the module layout convention: the module root holds only
`otp.module.ts`; the service lives under `service/` (interface + `OTP_SERVICE` token in
`service/interfaces/`, the concrete class in `service/impl/`, the domain error at the
`service/` root so `service/interfaces/` never imports from `impl/`). It is a **service-only
feature module** — it binds `{ provide: OTP_SERVICE, useClass: OtpService }` and **exports**
the token, and is imported **transitionally by `AppModule`** until the transfers surface module
consumes it (step 4b). It does **not** import `RedisModule` (that module is `@Global`). The
service injects two tokens: `REDIS_CLIENT` and `APP_CONFIG` — the latter supplies the
`OTP_HASH_SECRET` pepper used to hash codes at rest (below).

| File | Role |
|---|---|
| `otp.module.ts` | Binds `{ provide: OTP_SERVICE, useClass: OtpService }`, exports the token. No controller. |
| `service/interfaces/otp.service.interface.ts` | `IOtpService` + the `OTP_SERVICE` token + `OtpGenerationResult` + `OtpConsumeResult`. |
| `service/errors.ts` | `OtpAlreadyActiveError` (`OTP_ALREADY_ACTIVE`), extends `DomainError`. |
| `service/impl/otp.service.ts` | `OtpService implements IOtpService` — the generate/consume logic, plus the `OTP_CODE_LENGTH` / `OTP_TTL_SECONDS` / `OTP_MAX_ATTEMPTS` constants. |

**Codes are hashed at rest.** Redis **never** holds the plaintext code. Both key shapes below
carry a **keyed hash** — `codeHash = HMAC-SHA256(OTP_HASH_SECRET, "<sub>:<code>")` (`digest('hex')`).
The pepper (`OTP_HASH_SECRET`, injected via `APP_CONFIG`, min 16 chars) means a Redis-only
attacker cannot brute-force the small 10^6 code space offline; mixing `<sub>` into the message
makes identical codes for different users hash differently. The HMAC is **deterministic** given
the pepper, so the hash slots straight into the composite-key design — verification stays
"does the hashed key exist", with **no plaintext compare anywhere**.

**Keys & constants.** Two keys per user, **both TTL-bound to `OTP_TTL_SECONDS`**:

- **`otp:<sub>`** (`sub` = the user id) — the user-scoped record, stored as the JSON string
  `{ codeHash, attempts }`. One record does **triple duty**: (a) the **singleton gate** (created
  with `SET … EX 300 NX`), (b) the **attempt counter**, (c) the **reverse-lookup** that lets a
  lockout/regenerate delete the composite key by userId (the stored `codeHash` names it).
- **`otp:<sub>:<codeHash>`** — a marker (value `'1'`), the **`GETDEL` target**. The code's
  **hash** is IN the key name, so the key's existence *is* the verification — there is no
  stored-vs-supplied compare, and no plaintext ever reaches Redis.

`OTP_CODE_LENGTH = 6` (6-digit numeric), `OTP_TTL_SECONDS = 300` (5-minute TTL), and
`OTP_MAX_ATTEMPTS = 3` (attempts per code before lockout) are **prototype defaults, not
env-configurable yet**.

**Code generation.** A code is minted from a CSPRNG — `crypto.randomInt(0, 10 ** 6)` zero-
padded to 6 digits — never `Math.random`. The plaintext is hashed immediately (`hash(sub, code)`)
and only the hash is persisted; the plaintext leaves the service **only** in the `generate`
return value, for out-of-band delivery, and is **never stored**.

**Singleton gate (`generate`).** Meta-first, and the write itself is the gate:
`SET otp:<sub> {"codeHash","attempts":0} EX 300 NX`. `NX` stores only when no record exists; a
**`null`** reply means the slot is already taken → the service throws `OtpAlreadyActiveError`.
Then it writes the marker `SET otp:<sub>:<codeHash> '1' EX 300`. A user MAY generate without a
pending transfer (harmless), but never a **second** code while one is live; generate **resets
the attempt allowance** for the fresh code. The slot frees only when the code is **consumed**,
**locked out**, or its **TTL expires**. The gate being an atomic `SET NX` (not read-then-write)
means two concurrent generations cannot both win. Meta-first ordering is deliberate: the record
is authoritative, and a crash between the two writes self-heals — a missing marker just makes
every consume miss until the record clears on TTL/lockout.

**Single-use + typo-tolerant verification (`consume`).** The supplied code is hashed with the
same keyed HMAC, then verification is the **existence of the composite key**, consumed via one
atomic `GETDEL otp:<sub>:<hash(supplied)>`:

- **Correct code** — hashes to the existing composite key, so `GETDEL` returns the marker and
  deletes it atomically; the service then `DEL otp:<sub>` to free the slot and clear the counter,
  and returns `{ ok: true, remainingAttempts: 0, lockedOut: false }`. Because two confirmations of
  the same code cannot both find the marker (one gets `'1'`, the other `null`), a code
  authorizes **exactly one** transaction — the money-safety single-use invariant.
- **Wrong code** — hashes to a **non-existent** composite key, so the `GETDEL` is a **no-op** and
  the real code **survives** (typo-tolerant). The service then reads `otp:<sub>`: if it is `null`
  (no active code / expired) it returns `{ ok: false, remainingAttempts: 0, lockedOut: false }`
  **without creating anything** (never resurrect a TTL-less key). Otherwise it bumps `attempts`:
  on exhaustion (`attempts + 1 >= OTP_MAX_ATTEMPTS`) it **burns** the composite
  (`DEL otp:<sub>:<stored-codeHash>` + `DEL otp:<sub>`) and returns
  `{ ok: false, remainingAttempts: 0, lockedOut: true }`; otherwise it persists the bumped count
  with an **`XX`-guarded** `SET … XX KEEPTTL` and returns
  `{ ok: false, remainingAttempts: OTP_MAX_ATTEMPTS - used, lockedOut: false }`.

`consume` returns a rich `OtpConsumeResult` (`{ ok, remainingAttempts, lockedOut }`), never a
bare boolean and never throws for a wrong code.

**App-side (best-effort) counter.** The single-use guarantee rides on the atomic `GETDEL` of the
composite key, **not** on the counter — the counter is a best-effort throttle. A rare concurrent
double-wrong may under-count by one; that is acceptable because it never weakens single-use. The
bumped count is written with **`SET … XX KEEPTTL`** (ioredis / Redis 6+): `KEEPTTL` so counting a
wrong attempt does **not** extend the code's remaining life, and **`XX`** so the write is a no-op
(null reply) rather than a create if a concurrent successful `consume` `DEL`'d the record between
this branch's `GET` and `SET`. Without `XX`, that resurrected record would have **no TTL** and
would jam the `SET … EX … NX` singleton gate in `generate` forever — a permanent self-lockout with
no self-heal. On the null reply the branch writes nothing and returns the no-active-code result.

## Step 4b — internal transfers

The customer↔customer transfer flow end-to-end: two-phase and OTP-gated. A transfer is created
**PENDING** at initiate (no money moves) and **posts on OTP-confirm**, with the funds check
performed at confirm-time under the account lock. This step also lands the reusable
DomainError→HTTP mapping and the zod request-validation pipe that the write surface needs.

### Module structure

`src/modules/transfers/` — the transfers FEATURE module (module-layout + controller-surface
conventions): the root holds only `transfers.module.ts`; business logic under `service/`; the
controller in its own `api/` surface folder with `dto/` + `serializers/`.

| File | Role |
|---|---|
| `transfers.module.ts` | Feature module: `imports: [PersistenceModule, PostingModule, IdempotencyModule, OtpModule]`, binds `{ provide: TRANSFERS_SERVICE, useClass: TransfersService }`, exports the token. **No controllers of its own.** |
| `service/interfaces/transfers.service.interface.ts` | `ITransfersService` + `TRANSFERS_SERVICE` token + the `InitiateTransferParams` / `ConfirmTransferParams` contract types. |
| `service/errors.ts` | Transfers-owned domain errors (extend `DomainError`): `TransferNotFoundError`, `TransferNotPendingError`, `InvalidOtpError`, `OtpLockedOutError`, `InvalidTransferError`. |
| `service/impl/transfers.service.ts` | `TransfersService implements ITransfersService` — initiate / confirm / listPendingAuthorizations; injects the DataSource + `ACCOUNT_REPOSITORY` / `TRANSACTION_REPOSITORY` / `IDEMPOTENCY_SERVICE` / `OTP_SERVICE` / `POSTING_SERVICE` tokens. |
| `api/transfers-api.controller.ts` | `TransfersApiController`, `@Controller('api')` — the three routes; **declared by `ApiModule`**. |
| `api/dto/*.dto.ts` | `TransferDto`, `PendingAuthorizationDto` (wire contracts). |
| `api/dto/transfers.schema.ts` | zod schemas for the bodies + the `Idempotency-Key` header. |
| `api/serializers/transfers.serializer.ts` | Explicit-whitelist `serializeTransfer` / `serializePendingAuthorization`. |

The OTP feature gains its first `/api` surface controller under `src/modules/otp/api/`
(`otp-api.controller.ts` + `dto/otp.dto.ts` + `serializers/otp.serializer.ts`), also **declared
by `ApiModule`**. `OtpModule` still just provides + exports `OTP_SERVICE`.

### Endpoints

All under the global `/api` prefix (the `GatewayIdentityGuard` has required the Kong
`X-User-Id`); the caller id is read **only** via `@Identity()`, never the body/query.

| Route | Effect |
|---|---|
| `POST /api/transfers` | Initiate an internal transfer → creates a **PENDING** transaction (no money moves). Body `{ sourceAccountId, destinationAccountId, amount, currency, confirmDuplicate? }`; required `Idempotency-Key` header. **201**, `TransferDto`. |
| `POST /api/otp` | Mint the caller's user-scoped one-time code (mocked out-of-band delivery). **201**, `OtpDto { code, ttlSeconds }`. Singleton-gated → `OtpAlreadyActiveError` (409) if a code is already active. |
| `POST /api/transfers/:id/confirm` | Verify+consume the OTP, then post the pending transfer (money moves). Body `{ code }`; `:id` via `ParseUUIDPipe`. **200**, the posted `TransferDto`. |
| `GET /api/pending-authorizations` | The caller's PENDING transfers, newest-first (the OTP app's feed). **200**, `{ authorizations: PendingAuthorizationDto[] }`. |

`TransferDto` = `{ id, type, status, amount, currency, sourceAccountId, destinationAccountId,
createdAt, postedAt }` — `debitAccountId`→`sourceAccountId`, `creditAccountId`→`destinationAccountId`,
timestamps ISO-8601, `postedAt` null while PENDING. Internal columns (`initiatedBy`,
`failureReason`, …) are never serialized.

### The lifecycle (initiate = PENDING, confirm = post)

**Initiate** (`TransfersService.initiateTransfer`):

1. **Validate** (defense-in-depth; the wire schema also enforces): source ≠ destination; `amount`
   a positive unsigned minor-unit integer; currency present.
2. **Anti-IDOR + existence**: the **source** is owner-scoped (`findByIdAndOwner(source, ownerId)`;
   null → `TransferNotFoundError`/404, never revealing non-ownership); the **destination** is
   resolved by id alone (`findById`; null → `TransferNotFoundError`) — you transfer *to* another
   customer's account. Both must be **customer** accounts (`InvalidTransferError` otherwise) whose
   currency matches the request (`CurrencyMismatchError` otherwise).
3. **Claim + create under the `Idempotency-Key`**: `idempotency.execute({ …, fingerprintInput:
   { type: 'internal', source, destination, amount, currency }, confirmDuplicate }, (qr) =>
   insert a PENDING `Transaction` header)`. A replayed key returns the original id;
   `SUSPECTED_DUPLICATE` / `IDEMPOTENCY_KEY_REUSED` propagate from the wrapper.
4. Load and return the PENDING transfer.

**Confirm** (`TransfersService.confirmTransfer`):

1. Load the transfer (`findById`; null → `TransferNotFoundError`).
2. **Anti-IDOR on the nested resource** — the account being **debited**, not just the id:
   `findByIdAndOwner(transfer.debitAccountId, ownerId)`; null → `TransferNotFoundError`.
3. **Idempotent replay**: an already-**POSTED** transfer is returned as-is; anything else
   non-PENDING → `TransferNotPendingError`.
4. **Consume the OTP** (`otp.consume(ownerId, code)`): `!ok && lockedOut` → `OtpLockedOutError`
   (429); `!ok` → `InvalidOtpError` (401).
5. **Post**: build the double-entry `PostTransactionCommand` (debit source `−amount`, credit
   destination `+amount`) and run `runInTransactionWithRetry(dataSource, (qr) =>
   posting.postPendingInTx(qr, transferId, command))`.

The OTP is consumed **before** the post transaction: the single-use `GETDEL` is the
authorization gate, so if the post then throws (insufficient funds under the lock, etc.) the
code is spent and the transfer stays PENDING — a retry needs a **fresh** code. This matches the
spec's confirm-time funds check.

### The `postPendingInTx` posting seam

`applyPosting` in `PostingService` was generalized so its shared steps — **lock** accounts in
canonical ascending id order → per-leg **`checkAndFold`** (currency / frozen / funds) →
**balance-then-ledger** → **one outbox row** — are reused by two entry points that differ ONLY
in the **header step** (an `applyHeader` callback):

- `postTransaction(command)` — **unchanged behavior**: opens its own tx and **INSERTs** a new
  POSTED header.
- `postPendingInTx(queryRunner, transactionId, command)` — runs **inside the caller's tx** (no
  new tx), and its header step is a **guarded transition** on the EXISTING header:
  `ITransactionRepository.transitionToPostedInTx` runs `UPDATE transaction SET status = POSTED,
  posted_at = now() WHERE id = :id AND status = 'PENDING'`. **0 rows** → `TransactionNotPendingError`
  (someone else already posted / not pending), thrown **before** any balance mutation; on success
  the row is re-read within the tx (`findByIdInTx`) and returned. The confirm-time **funds check
  under the lock** happens in the shared `checkAndFold`. The reducer OWNS this guarded transition,
  so it owns the error (posting-module `service/errors.ts`); it carries the same
  `TRANSFER_NOT_PENDING` code as the transfers service's stale-read pre-check, so both map to 409.

Re-run safety under the deadlock retry: `postPendingInTx` runs inside the transfers service's
`runInTransactionWithRetry`, and a deadlock rolls the WHOLE tx back — including the transition —
so status returns to PENDING and a retry re-locks, re-reads, and re-transitions cleanly.

### Money-once (the two independent gates)

- **Idempotency-Key at initiate** dedups duplicate transfer **creation** (a retry/replay yields
  the same PENDING transfer, not a second one).
- At confirm, the **OTP single-use** (`GETDEL`, one confirm wins) **plus** the **guarded
  PENDING→POSTED transition** (the `WHERE status = 'PENDING'` predicate is the single-write gate)
  ensure the movement posts **exactly once**, even under concurrent confirms.

### DomainError→HTTP mapping

The global `AllExceptionsFilter` gained an `else if (exception instanceof DomainError)` branch
that maps the stable domain `code` to an HTTP status via a single table
(`common/errors/domain-error-status.ts`, `domainErrorHttpStatus(code)`, default **400**). The
response `ErrorResponse.code` is the **domain code itself** (e.g. `INSUFFICIENT_FUNDS`), and the
message is the domain error's (authored PII-light, safe to surface). No controller maps errors;
there is no second filter. Every domain code is 4xx, so a `DomainError` never reaches the 5xx
generic-message path.

| Domain `code` | Status |
|---|---|
| `INVALID_POSTING_COMMAND`, `INVALID_TRANSFER` | 400 |
| `ACCOUNT_NOT_FOUND`, `TRANSFER_NOT_FOUND`, `SETTLEMENT_TARGET_NOT_FOUND`, `INBOUND_DESTINATION_NOT_FOUND` | 404 |
| `CURRENCY_MISMATCH`, `INSUFFICIENT_FUNDS`, `LIMIT_EXCEEDED` | 422 |
| `ACCOUNT_FROZEN`, `TRANSFER_NOT_PENDING`, `PENDING_TRANSFER_CONFLICT`, `SUSPECTED_DUPLICATE`, `IDEMPOTENCY_KEY_REUSED`, `IDEMPOTENCY_IN_PROGRESS`, `OTP_ALREADY_ACTIVE`, `DESTINATION_NOT_CONFIRMED`, `PAYEE_ALREADY_ENROLLED`, `INVALID_SETTLEMENT_STATE` | 409 |
| `TRANSFER_EXPIRED` | 410 |
| `INVALID_OTP` | 401 |
| `OTP_LOCKED_OUT` | 429 |

(`TRANSFER_EXPIRED` / `PENDING_TRANSFER_CONFLICT` added by the pending-lifecycle step below;
`SETTLEMENT_TARGET_NOT_FOUND` / `INBOUND_DESTINATION_NOT_FOUND` / `INVALID_SETTLEMENT_STATE` by
step 5c; `LIMIT_EXCEEDED` by step 7.)

### zod request validation

`common/validation/zod-validation.pipe.ts` `ZodValidationPipe` (implements `PipeTransform`) runs
`schema.parse(value)` and, on a `ZodError`, throws `BadRequestException` (→ 400 `BAD_REQUEST` via
the filter) with a SAFE message — only the failing field **names**, never the offending values or
raw internals (anti-reflection). It validates the request bodies (`@Body(new ZodValidationPipe(
schema))`) and the `Idempotency-Key` header (applied manually, since `@Headers()` — unlike
`@Body`/`@Param` — does not accept a pipe; a missing/empty header → 400). Path `:id` keeps
`ParseUUIDPipe`. This is a security control: it rejects malformed / unexpected input at the edge
before it reaches the domain services.

### New repository methods

Added to `ITransactionRepository` (interface/impl split, following the tx-aware `…InTx` seam):

| Method | Effect |
|---|---|
| `findPendingByInitiator(initiatedBy)` | The initiator's PENDING transfers, newest-first — the pending-authorizations feed. |
| `transitionToPostedInTx(qr, id)` | Guarded `PENDING → POSTED` UPDATE (`WHERE id AND status = 'PENDING'`); returns `affected > 0`. |
| `findByIdInTx(qr, id)` | Read one transaction inside the caller's tx (sees its own uncommitted writes) — used to return the just-posted header from `postPendingInTx`. |

`insertInTx` is reused for the PENDING header.

### Module wiring

- `ApiModule` (`/api` surface registry) now imports `[AccountsModule, TransfersModule, OtpModule]`
  and declares `[ApiController, AccountsApiController, TransfersApiController, OtpApiController]`.
- `TransfersModule` imports `PostingModule` + `IdempotencyModule` + `OtpModule`, so those three
  former **service-only** feature modules are now reached through it (and `OtpModule` also directly
  by `ApiModule` for `OtpApiController`). `AppModule` therefore **no longer** imports
  `PostingModule` / `IdempotencyModule` / `OtpModule` transitionally; it keeps the `@Global`
  `RedisModule` and the rest.

## Confirmation of payee + customer representation (step 4c)

Makes internal transfers **human-usable**: a customer addresses a transfer by the payee's
**human account number**, and sees a **masked payee name** to sanity-check *who* they are
paying **before** committing. The money/OTP machinery of step 4b is unchanged — this swaps how
the destination is *addressed* and adds a confirmation gate in front of initiate.

> **Data-model update.** This **supersedes** the earlier note that a customer's `sub → name`
> mapping was Keycloak/UI-only. The balance DB now owns the customer profile (name/phone/email)
> in its own `customer` table; **Keycloak keeps only authentication**. `account.owner_id` is the
> Keycloak `sub` and is now an **FK to `customer.id`**.

### Customer representation + account number (persistence)

- **`customer` table** (`src/database/entities/customer.entity.ts`, migration
  `1789084800000-CreateCustomerAndAccountNumber`): `id varchar PRIMARY KEY` (the Keycloak `sub`
  — `varchar` to match `account.owner_id`'s existing type, so **no** `owner_id` type change and
  **no** risky ALTER), `name` / `phone` / `email` (all `NOT NULL`, with `phone` / `email` **UNIQUE**
  via `uq_customer_phone` / `uq_customer_email` — `email` **case-insensitively**, as a functional
  index on `LOWER(email)`, so a future email lookup must query on `LOWER(email)`), `created_at` / `updated_at`.
  Nothing else. Bound behind `CUSTOMER_REPOSITORY` (`findById` / `create`) in `PersistenceModule`.
- **`account.account_number`** (`varchar NULL`): the human destination identifier — a unique
  **10-digit numeric** string on **customer accounts only** (system/clearing accounts keep NULL).
  A **plain** `UNIQUE` index (`uq_account_account_number`) enforces uniqueness; Postgres allows
  multiple NULLs, so the system accounts never collide. `IAccountRepository.findByAccountNumber`
  resolves a number to an account.
- **`fk_account_owner`** (`account.owner_id → customer.id`): nullable, so it is **not** checked
  for system accounts (NULL owner). No customer accounts exist in the migration chain, so adding
  the constraint cannot fail on existing data.
- **`generateAccountNumber()`** (`src/modules/accounts/service/impl/account-number.ts`): a **pure**
  helper minting a 10-digit zero-padded number from `crypto.randomInt`. There is **no
  create-account endpoint** this step, so nothing generates at runtime yet — the seed (spec 08)
  and tests use it to assign numbers; the DB unique index enforces uniqueness (callers retry on
  a unique violation).

`AccountDto` / `serializeAccount` now expose the owner's own `accountNumber` (owner-scoped reads
already ensure a caller only sees their own accounts' numbers).

### The resolve → token → initiate gate

The flow that fronts initiate. **Resolving is a pure query** (no transaction); **initiating
requires the token** it returns — a transfer can *only* be initiated once the caller resolved
and confirmed **that** destination.

| Route | Effect |
|---|---|
| `POST /api/transfers/resolve-destination` | Body `{ accountNumber }` (10-digit). Resolves to the payee's **masked name** + a **confirmation token** (single-purpose, caller + destination-bound, TTL-expiring — GET-validated, so an idempotent initiate retry within the window still succeeds). **200**, `ResolveDestinationDto { maskedName, currency, confirmationToken }`. No money moves. |
| `POST /api/transfers` | Now addresses the payee by `destinationAccountNumber` and **requires** `confirmationToken`. Body `{ sourceAccountId (uuid), destinationAccountNumber (\d{10}), amount, currency, confirmationToken, confirmDuplicate? }` + `Idempotency-Key` header. |

**`resolveDestination(params)` → `DestinationResolution { maskedName, currency, confirmationToken }`:**

1. `accounts.findByAccountNumber(accountNumber)`; a missing account, a non-customer (system)
   account, or a customer with a NULL owner all collapse to the **same** `TransferNotFoundError`
   (**404**) — never reveal which case, nor that system accounts exist (anti-IDOR / anti-enum).
2. `customers.findById(account.ownerId)` → the holder; `maskName(holder.name)`. A missing holder
   (unreachable under the FK) also collapses to 404 rather than surfacing an empty name.
3. Mint `confirmationToken = crypto.randomBytes(24).toString('hex')`; store in Redis at
   **`xfer:confirm:<ownerId>:<token>`** = JSON `{ destinationAccountId, accountNumber }` with
   `EX CONFIRM_TOKEN_TTL_SECONDS` (**300s**). The key embeds the **caller** `ownerId`, so another
   user's token cannot be replayed.
4. Return the masked name, the destination currency, and the token. **No transaction.**

**`initiateTransfer` — the token gate.** After validating the amount/currency, owner-scoping the
source (`findByIdAndOwner` → 404), and resolving the destination by number (non-customer → 404;
`source.id === destination.id` → `InvalidTransferError`; currency mismatch → `CurrencyMismatchError`),
it **`GET`s** (not `GETDEL` — an idempotent initiate retry within the TTL still works) the
`xfer:confirm:<ownerId>:<token>` key: a **missing** token **or** a stored `destinationAccountId`
that does **not** equal the resolved destination id → **`DestinationNotConfirmedError`** (code
`DESTINATION_NOT_CONFIRMED` → **409**). Only then does the existing idempotency-wrapped PENDING
insert run (unchanged), now keyed on the resolved destination id.

### The masking rule

`maskName(name)` (`src/modules/transfers/service/impl/mask-name.ts`, **pure**): split on whitespace
(runs collapse), each token → its **first 3 characters + exactly two asterisks** (fixed, uniform,
non-length-revealing), joined by single spaces. `"Juan Perez"` → `"Jua** Per**"`; empty/blank →
`""`. It is applied **in the service** so the raw name (PII) never crosses the service boundary —
neither the controller nor any DTO ever sees it.

### Read DTOs — source account id + destination account number & masked name

The transfer entity stores debit/credit account **UUIDs**. The **source** is the caller's OWN
account, so it stays the account **id** (`sourceAccountId` = the transaction's `debitAccountId`,
exactly as `AccountDto.id` is exposed to its owner — no lookup); only the **destination** (credit)
UUID is resolved to its human account **number**. The service **enriches** read results into view
models (mirroring `getAccountStatement`'s `{ account, entries }`), and the controller whitelists
them — the raw credit UUID and the PII name never reach the wire:

- **`TransferView { transaction, sourceAccountId, destinationAccountNumber }`** →
  `TransferDto { id, type, status, amount, currency, sourceAccountId, destinationAccountNumber,
  createdAt, postedAt }` (the credit UUID is **dropped**; `sourceAccountId` comes straight from
  `debitAccountId`, no lookup). Returned by both `initiateTransfer` and `confirmTransfer` (the
  posted transfer serializes the same way).
- **`PendingAuthorizationView { …, destinationMaskedName }`** → `PendingAuthorizationDto
  { transferId, type, amount, currency, sourceAccountId, destinationAccountNumber,
  destinationMaskedName, createdAt }` — `destinationMaskedName` is `maskName` of the destination
  account's holder, so the OTP app shows who the payment is to. Only the **destination** needs a
  per-row account/customer lookup (prototype); the source is the raw id.

> **Superseded by the pending-lifecycle step below.** `TransferView` is **removed** — the write
> methods now return the `Transaction` entity directly (`serializeTransfer(transaction)`), and
> `TransferDto` drops `destinationAccountNumber` and adds `expiresAt`. `PendingAuthorizationView`
> is renamed to the domain projection **`PendingAuthorization`** and `PendingAuthorizationDto` adds
> `expiresAt`; the pending feed is now the SINGLE-object `GET /api/pending-authorization`. See
> [Pending authorization: single + time-boxed](#pending-authorization-single--time-boxed-review-fix-step).

### What did NOT change

The OTP / confirm / posting money machinery is behaviorally intact: initiate still creates a
PENDING header under the `Idempotency-Key`; confirm still consumes the OTP (`GETDEL`) then posts
via the guarded PENDING→POSTED transition under the account lock. This step only changed how the
destination is **addressed** (account number, not raw UUID) and added the **confirmation-token
gate** in front of initiate. No create-account / create-customer endpoint is added — the seed
(spec 08) and tests populate `customer` rows and account numbers.

## Pending authorization: single + time-boxed (review-fix step)

A pending transfer is now **single per user** and **time-boxed to 2 minutes**, with an **explicit
cancel** and **lazy expiry**. This also lands a layering fix (services return entities; only the
pending read returns a domain projection). Two design decisions are LOCKED: the TTL is enforced by
a nullable `expires_at` column + **lazy** expiry against the **DB clock** (`now()`, **no
scheduler**); and initiating while an active pending exists **auto-supersedes** the old one
(→ CANCELLED, retained).

### Schema (Step-4 migration `AddTransactionLifecycle1789171200000`)

- `transaction_status` gains **`EXPIRED`** and **`CANCELLED`** (terminal, **retained** for
  compliance — never deleted). See [persistence.md](./persistence.md#tables--migrations) for the
  ADD-VALUE-in-a-transaction PG note.
- `transaction.expires_at timestamptz NULL` — the 2-minute deadline, stamped from the DB clock at
  initiate (`now() + interval '2 minutes'`), NULL on directly-posted movements.
- `uq_one_pending_per_initiator` — a **partial** unique index `("initiated_by") WHERE status =
  'PENDING'`: at most one live pending per user, enforced by the DB, and the concurrency backstop
  against a double-initiate race.

### Lifecycle rules

- **Single pending (structural).** The partial unique index — not just a service check — caps a
  user at one PENDING transfer. A truly-concurrent same-initiator initiate (two different
  `Idempotency-Key`s at once) collides on it (SQLSTATE 23505); the service catches that (matched on
  the constraint name) and throws **`PendingTransferConflictError`** (`PENDING_TRANSFER_CONFLICT` →
  **409**). The idempotent same-key **replay never re-inserts**, so it never trips this.
- **Auto-supersede at initiate.** Inside the idempotency-wrapped transaction, BEFORE inserting the
  new pending: (1) `expireOverduePendingByInitiator` (overdue pending → EXPIRED, DB clock), then
  (2) `supersedeActivePendingByInitiator` (any remaining active pending → CANCELLED,
  `failure_reason = 'superseded'`, retained), then (3) `insertPendingInTx` (the new PENDING with a
  DB-clock `expires_at`). So a fresh initiate always leaves exactly one live pending — the new one.
- **Lazy expiry (no scheduler).** An overdue PENDING transfer transitions to EXPIRED on the next
  **access** — confirm, the pending read, or the next initiate — judged by `now() >= expires_at`
  via a guarded single-statement UPDATE (`expireIfOverdue` for a specific id;
  `expireOverduePendingByInitiator` for the initiate sweep). The DB clock is the single source of
  truth.
- **Confirm checks expiry BEFORE consuming the OTP (money-safety).** `confirmTransfer` loads +
  owner-scopes the transfer, returns an already-POSTED one idempotently, rejects a terminal
  EXPIRED/CANCELLED (and any non-PENDING) with `TransferNotPendingError` (409), then calls
  `expireIfOverdue(id)`: if it flips the row, it WAS overdue → throw **`TransferExpiredError`**
  (`TRANSFER_EXPIRED` → **410**) WITHOUT consuming the code, so an expired transfer never burns the
  caller's one-time code. Only a validly-PENDING (not overdue) transfer proceeds to consume the OTP
  and post. A concurrent transition is caught by a re-read before the OTP is consumed; the ultimate
  money-once gate remains the OTP single-use + the guarded PENDING→POSTED transition.
- **Explicit cancel.** `cancelTransfer({ ownerId, transferId })` loads + owner-scopes on the DEBIT
  account exactly like confirm (404 on missing/non-owned). POSTED → `TransferNotPendingError`
  (cannot cancel posted money, 409); already CANCELLED / EXPIRED → returned as-is (idempotent);
  PENDING → guarded `transitionToCancelled` (`failure_reason = 'cancelled_by_user'`), then reload +
  return the (now CANCELLED, or concurrently-terminal) entity. Terminal rows are retained.

### Endpoints (changed)

| Route | Effect |
|---|---|
| `POST /api/transfers/:id/cancel` | Cancel the caller's pending transfer (guarded `PENDING → CANCELLED`, retained). `:id` via `ParseUUIDPipe`. **200**, `TransferDto`. |
| `GET /api/pending-authorization` | The caller's **SINGLE** active pending transfer, or none. Reading lazily expires an overdue pending. **200**, `{ authorization: PendingAuthorizationDto \| null }` (a single object or null — **not** an array; supersedes the earlier plural `GET /api/pending-authorizations` → `{ authorizations: [] }`). |

`TransferDto` now **drops** `destinationAccountNumber` (the client supplied it at initiate / holds
the id) and **adds** `expiresAt` (ISO-8601 or null). `PendingAuthorizationDto` **adds** `expiresAt`.
Both still whitelist explicitly and never leak `initiatedBy` / `failureReason` / `failedAt` /
`payeeId` / `reversesTransactionId` / the raw credit UUID.

### Layering fix (review comment)

The service now returns **domain objects / entities**, and the controller serializes:

- `initiateTransfer` / `confirmTransfer` / `cancelTransfer` return the plain **`Transaction`**
  entity — `serializeTransfer(transaction)` whitelists it. The old `TransferView` and the
  write-path enrichment helpers (`toTransferView`, `accountNumberOf`) are **removed** (their
  surface was too narrow and only fed the write path; the client already holds the destination).
- The pending READ is the one exception: `getPendingAuthorization(ownerId)` returns a **domain
  projection** `PendingAuthorization { transaction, destinationAccountNumber, destinationMaskedName }`
  (renamed from `PendingAuthorizationView`). **Masking stays in the service** — resolving the
  destination holder and masking the raw name (PII) is a service-owned security rule, so the read
  returns a projection rather than the raw entity. The source account id is left on the
  `transaction` (`debitAccountId`) for the controller to whitelist at serialize time.

### New / changed repository methods

Added to / changed on `ITransactionRepository` (all guarded, DB-clock, following the `…InTx` seam):

| Method | Effect |
|---|---|
| `insertPendingInTx(qr, data)` | Insert a PENDING transfer with `expires_at = now() + interval '2 minutes'` (DB clock, parameterized INSERT), re-read within the tx. `insertInTx` stays as-is for the posting path. |
| `findPendingByInitiator(id)` | Now returns a **single** `Transaction \| null` (was a list) — the index guarantees ≤1; `take 1` is defensive. |
| `expireOverduePendingByInitiator(qr, id)` | `PENDING & overdue → EXPIRED` for all of an initiator's rows (initiate sweep). |
| `supersedeActivePendingByInitiator(qr, id)` | remaining `PENDING → CANCELLED` (`'superseded'`) for an initiator (initiate). |
| `expireIfOverdue(id)` | Guarded single-statement `PENDING & overdue → EXPIRED`; returns `affected > 0`. Used by confirm / read. |
| `transitionToCancelled(id)` | Guarded single-statement `PENDING → CANCELLED` (`'cancelled_by_user'`); returns `affected > 0`. Used by the cancel endpoint. |

### Forward implication

The single-pending rule spans **all** user-initiated transfer types. When step 5 adds **external
outbound**, its initiate shares the SAME `uq_one_pending_per_initiator` index and the same
expire → supersede → insert sequence (plus its hold), so a user still holds at most one pending
authorization across internal and external-outbound alike.

## External payee enrollment (step 5)

The first step of the external rail: a customer **enrolls** a beneficiary they can later send
money to. This step is **enrollment only** — no holds, no outbound money movement, no migration
(the `external_payee` table/entity/repo already exist). Enrollment is **not** OTP-gated and has
**no resolve/confirm step** (there is no external name to look up — the user supplies the
`displayName`); the **cooling-off delay is the anti-fraud control**.

### Module structure

`src/modules/payees/` — the payees FEATURE module (module-layout + controller-surface
conventions): the root holds only `payees.module.ts`; business logic under `service/`; the
controller in its own `api/` surface folder with `dto/` + `serializers/`.

| File | Role |
|---|---|
| `payees.module.ts` | Feature module: `imports: [PersistenceModule]`, binds `{ provide: PAYEES_SERVICE, useClass: PayeesService }`, exports the token. **No controllers of its own.** `APP_CONFIG` (the injected cooling-off window) is `@Global`, so it is not imported here. |
| `service/interfaces/payees.service.interface.ts` | `IPayeesService` + `PAYEES_SERVICE` token + the `RegisterPayeeParams` contract type. |
| `service/errors.ts` | `PayeeAlreadyEnrolledError` (`PAYEE_ALREADY_ENROLLED`), extends `DomainError`. |
| `service/impl/payees.service.ts` | `PayeesService implements IPayeesService` — enroll + list; injects `EXTERNAL_PAYEE_REPOSITORY` + `APP_CONFIG`; the `uq_payee` 23505→409 translation helper. |
| `api/payees-api.controller.ts` | `PayeesApiController`, `@Controller('api')` — the two routes; **declared by `ApiModule`**. |
| `api/dto/payee.dto.ts` | `PayeeDto` (the wire contract). |
| `api/dto/payees.schema.ts` | zod `registerPayeeSchema` for the body (`.strict()` — rejects unknown keys). |
| `api/serializers/payees.serializer.ts` | Explicit-whitelist `serializePayee` (entity→DTO). |

### Endpoints

Both under the global `/api` prefix (the `GatewayIdentityGuard` has required the Kong
`X-User-Id`); the caller id is read **only** via `@Identity()`, never the body/query.

| Route | Effect |
|---|---|
| `POST /api/payees` | Enroll an external beneficiary. Body `{ displayName, destinationRef }` — the outbound **rail is NOT accepted from the caller** (a server-side constant). Stamps the DB-clock `coolingOffUntil`. **201**, `PayeeDto`. A duplicate `(owner_id, rail, destination_ref)` → `PayeeAlreadyEnrolledError` (**409**). |
| `GET /api/payees` | List the caller's enrolled payees. **200**, `{ payees: PayeeDto[] }`. |

`PayeeDto` = `{ id, displayName, destinationRef, coolingOffUntil, usable, createdAt }` —
timestamps ISO-8601 UTC. Internal columns `ownerId`, `rail` (a system constant), `status` and
`activatedAt` (reserved & unused) are **never** serialized. `usable` is a presentation-derived
hint (`now() >= coolingOffUntil`) computed at serialize time; the **authoritative** usability gate
is date-checked against the DB clock at outbound time (a later step), never trusted from the flag.

### The constant outbound rail

`src/common/rails/outbound-rail.ts` exports `OUTBOUND_RAIL = 'rail-outbound'` — the single rail
all external outbound clears through in the prototype. It is **not** user-supplied (the enrollment
body carries no `rail`); the service sets it. It names the counter-leg clearing account
`clearing:${OUTBOUND_RAIL}` (`clearing:rail-outbound`, seeded by `SeedSystemAccounts`), which the
later holds/outbound step debits against. Kept in `common/` because that step reuses the same
constant.

### Date-gated usability (no status lifecycle)

Usability is **date-gated, not status-driven** (a LOCKED developer decision):

- Enrollment stamps `cooling_off_until = now() + PAYEE_COOLING_OFF_SECONDS` (env-configured,
  default **24h**; `config.payees.coolingOffSeconds`). A payee is a valid destination from that
  instant on — `now() >= cooling_off_until`.
- There is **no** PENDING→ACTIVE transition and **no** `activated_at` stamping. The entity's
  `status` stays at its DB default (`pending`) and `activated_at` stays NULL — **both are reserved
  for a future admin/self-disable flow and are unused now**. Nothing reads them as a usability gate.

`IExternalPayeeRepository.createEnrollment(ownerId, displayName, rail, destinationRef,
coolingOffSeconds)` performs a parameterized INSERT that sets `cooling_off_until` on the **DB
clock** — `now() + make_interval(secs => <n>)` — so the deadline is authoritative and consistent
with the DB-defaulted `created_at` (both resolve to the enrolling transaction's `now()`). The
`<n>` is the validated positive integer from config (never user input), safe to inline into the
interval expression; every row value is parameterized. `status` / `created_at` / `activated_at`
keep their DB defaults, and the row is re-read so the returned entity carries them. It does **not**
app-clock the cooling-off.

### Duplicate → 409

`PayeesService.registerPayee` sets `rail = OUTBOUND_RAIL` and calls `createEnrollment` with the
configured cooling-off. A duplicate `(owner_id, rail, destination_ref)` collides on the `uq_payee`
unique index (SQLSTATE 23505); the service detects that with an `isPayeeUniqueViolation` helper
(matched on the constraint name `uq_payee`, checking the error or its `driverError` — same shape as
the transfers single-pending helper) and throws `PayeeAlreadyEnrolledError` (`PAYEE_ALREADY_ENROLLED`
→ **409**, added to `domain-error-status.ts`). With a single constant rail this is effectively one
enrollment per external account per customer. `listPayees` is a straight `findByOwner`.

### Config

`PAYEE_COOLING_OFF_SECONDS` (`z.coerce.number().int().positive().default(86400)`) is added to
`env.schema.ts` and surfaced as `AppConfig.payees.coolingOffSeconds` (a `PayeesConfig` interface,
mirroring `OtpConfig`) in `configuration.ts`. Tests / compose override the default.

## Step 5b — holds + external outbound transfers

The external-outbound money flow: a customer sends to an **enrolled payee** (spec 04 step 5),
two-phase and OTP-gated like an internal transfer, but reserving funds with a **hold** at initiate
and **settling** that hold — moving the money customer → outbound clearing — at OTP-confirm. The
initiate is a **dedicated endpoint**; confirm / cancel / the pending feed are **shared** with
internal transfers and branch on the transaction **type**. Three developer decisions are LOCKED:
address by enrolled **`payeeId`**; a dedicated `POST /api/transfers/external` initiate but a
**shared** `POST /api/transfers/:id/confirm`; and **settle at confirm** (the step-5c rail callback
finalizes the clearing side, not built here).

### Endpoint

| Route | Effect |
|---|---|
| `POST /api/transfers/external` | Initiate an external outbound to an enrolled payee. Body `{ sourceAccountId (uuid), payeeId (uuid), amount, currency, confirmDuplicate? }` (`.strict()`), required `Idempotency-Key` header. **Places a hold** + creates a **PENDING** `external_outbound` transaction — **no balance moves**. **201**, `TransferDto` (the same write DTO; `sourceAccountId` = the debit account, `expiresAt` = the 2-minute deadline). |

Confirm (`POST /api/transfers/:id/confirm`), cancel (`POST /api/transfers/:id/cancel`) and the feed
(`GET /api/pending-authorization`) are the SAME routes as internal — the service branches on the
loaded transaction's `type`. The pending feed's `PendingAuthorizationDto` gains **`payeeDisplayName`**
(the enrolled payee's label, unmasked — the caller's own label, not PII) for external rows;
`destinationAccountNumber` / `destinationMaskedName` are null for external, and `payeeDisplayName`
is null for internal.

### Initiate — place a hold (no balance moves)

`TransfersService.initiateExternalTransfer(params)`:

1. **Shape** — positive minor-unit `amount`, currency present (defense-in-depth; the zod schema
   also enforces, `.strict()`).
2. **Source** — `findByIdAndOwner(sourceAccountId, ownerId)` → `TransferNotFoundError` (404) if
   missing/non-owned; `source.currency !== currency` → `CurrencyMismatchError` (422).
3. **Payee** — `externalPayees.findById(payeeId)`; **missing OR not owned by the caller** →
   `PayeeNotFoundError` (404, anti-IDOR — the two cases are indistinguishable, never revealing
   another user's payee). **Cooling-off gate on the DB clock**: `readDbNow()` (a `SELECT now()`,
   never the app clock) `< payee.coolingOffUntil` → `PayeeInCoolingOffError` (409).
4. **Clearing** — `findBySystemKey('clearing:rail-outbound')` is the credit side; its absence is a
   system misconfiguration (a missing seed) → an internal **500-class** `Error`, not a client
   fault; `clearing.currency !== currency` → `CurrencyMismatchError`.
5. **Under the idempotency wrapper** (`fingerprint = { type: 'external_outbound', source,
   destination: payeeId, amount, currency }`), inside its single READ COMMITTED, deadlock-retried
   transaction:
   1. **Release-then-supersede the prior single pending** — the single-active-pending rule spans
      types. `findPendingByInitiatorInTx` loads the initiator's current pending; if it is
      `external_outbound`, its hold is **released FIRST** (locking its source, guarded
      `PLACED → EXPIRED` if the prior is overdue by the DB clock else `→ RELEASED`, `held -=
      holdAmount` — but only when the guarded release actually flipped, so a concurrently-settled
      prior never double-decrements). Then the existing `expireOverduePendingByInitiator` +
      `supersedeActivePendingByInitiator` sweeps flip the prior transaction (overdue → EXPIRED, else
      → CANCELLED `'superseded'`). The hold status agrees with the transaction status because both
      use the **same tx `now()`** (`transaction_timestamp`, constant in the tx).
   2. **Place the hold + PENDING txn** — lock the source `FOR UPDATE`; require
      `available = balance − held ≥ amount` (`InsufficientFundsError`) and a non-frozen source
      (`AccountFrozenError`); `insertPendingInTx` the `external_outbound` header (DB-clock
      `expires_at`, `debit = source`, `credit = clearing`, `payeeId`); `updateHeldInTx(source,
      held + amount)`; `holds.insertInTx` a `PLACED` hold on the `rail-outbound` rail carrying the
      header's `expires_at`. **No balance change.**
   - The `uq_one_pending_per_initiator` partial index still guards a truly-concurrent
     same-initiator initiate → 23505 → `PendingTransferConflictError` (409). The idempotent
     same-key replay returns the original id without re-running any of this.

### Confirm — branch on type; settle at confirm

`confirmTransfer` is shared. After the existing owner-scope + POSTED-idempotent-return + expiry
check + OTP consume, it branches on `current.type`:

- **internal** → the unchanged `postPendingInTx` path (no hold).
- **external_outbound** → **settle** in ONE `runInTransactionWithRetry` transaction
  (`settleExternalTransfer`), in this **exact order**:
  1. **Lock the source** `FOR UPDATE`; read its current `held`.
  2. **`updateHeldInTx(source, held − amount)` FIRST.** This is essential: the funds are already
     reserved, so releasing the held **before** the reducer's debit makes the reducer's
     `available = balance − held` funds check pass. The initiate-time check guaranteed
     `balance − held_before ≥ amount` and set `held = held_before + amount`, so after the decrement
     `held = held_before` and `available = balance − held_before ≥ amount`. Without the decrement
     first, the reservation would be **double-counted** and the debit would spuriously fail.
  3. **`postPendingInTx`** posts the **customer → clearing** double-entry (`[{source, −amount},
     {clearing, +amount}]`), transitions PENDING → POSTED, and writes **one** outbox row — the
     single balance/ledger/outbox keystone. Its guarded transition throws if the transfer is no
     longer PENDING, which **rolls the whole tx back** (undoing the held decrement), so the held
     decrement can never persist without the post.
  4. **`settleInTx(holdId)`** flips the hold `PLACED → SETTLED`.

  The OTP is consumed **before** this tx (existing ordering), so a settle failure spends the code
  and leaves the transfer PENDING — retryable with a fresh code until expiry, exactly like internal.
  The **hold is never double-counted**: the reducer's balance debit is the SOLE source of the
  customer's outflow, and `held` nets to zero for the transfer. Money leaves the customer into the
  outbound clearing account (the net **in transit**); the **step-5c** rail callback finalizes the
  clearing side (not built here).

### Cancel / expiry — release the hold

For an `external_outbound` pending, both the explicit **cancel** (`cancelTransfer`) and the **lazy
expiry** access points (the pending READ, and the pre-OTP expiry check in confirm) must **release
the hold** in the SAME transaction as the status flip, under the source lock:

- **Cancel** (`cancelExternalPendingReleasingHold`): lock source → guarded
  `transitionToCancelledInTx` (`PENDING → CANCELLED`) → if it flipped, release the hold
  (`PLACED → RELEASED`) + `held -= amount`.
- **Expiry** (`expireExternalPendingReleasingHold`, used by the read feed and the confirm pre-OTP
  check): lock source → guarded `expireIfOverdueInTx` (`PENDING & overdue → EXPIRED`, DB clock) →
  if it flipped, release the hold (`PLACED → EXPIRED`) + `held -= amount`; returns whether it
  expired (so confirm rejects with `TransferExpiredError` **without** consuming the OTP).

Internal cancel/expiry stay on the plain single-statement `transitionToCancelled` / `expireIfOverdue`
(no hold). Releasing/expiring returns the reservation with **no ledger entry** — only settlement
writes to the main ledger.

### Concurrency & lock ordering (the deadlock-free invariant)

Every hold-mutating path — initiate, settle, cancel, expiry — locks the **SOURCE account `FOR
UPDATE` before touching the transaction row**, a single consistent order that removes the classic
opposite-order deadlock (e.g. a cancel racing a settle: without source-first ordering, one would
hold the transaction-row lock wanting the source while the other holds the source wanting the
transaction row). All of it runs in ONE READ COMMITTED, deadlock-retried transaction. The guarded
transitions (`WHERE status = 'PENDING'` on the transaction, `WHERE status = 'PLACED'` on the hold)
make every concurrent loser a **0-row no-op** rather than a double-apply, and the `held` decrement
is applied **only** when the guarded hold release actually flipped — so `SUM(PLACED holds per
account) == account.held` holds at every commit and `held >= 0` (DB-enforced) is never violated.

**Source-before-clearing (a forward invariant for step 5c).** An external settle locks the
customer **source** first (to read/adjust `held`), then `postPendingInTx` locks the affected rows
canonically by ascending id — which includes the `clearing:rail-outbound` account. Within step 5b
this cannot deadlock (external settles are the only ops touching a customer account **and** the
clearing account, and two settles share only the clearing row — no 2-cycle). Step 5c's rail
callback (compensating reversal / inbound credit) **will** touch both a customer account and a
clearing account, so it MUST acquire the **customer account before the clearing account** — the
same source-first order a settle uses — otherwise a 5c op locking `clearing → customer` could
deadlock against a settle holding `source → clearing`. Encode this as the rule for every future
clearing-touching operation.

### New domain errors

| Class | `code` | Status | Meaning |
|---|---|---|---|
| `PayeeNotFoundError` | `PAYEE_NOT_FOUND` | 404 | The addressed payee is missing or not owned by the caller (anti-IDOR — indistinguishable). |
| `PayeeInCoolingOffError` | `PAYEE_IN_COOLING_OFF` | 409 | `now() < cooling_off_until` (DB clock) — the payee cannot receive money yet. |

Both extend `DomainError` (transfers `service/errors.ts`) and are mapped in
`domain-error-status.ts`. The reducer's `InsufficientFundsError` / `CurrencyMismatchError` /
`AccountFrozenError` are reused at their existing codes.

### Reconciliation invariant

`SUM(amount) WHERE status = 'PLACED'` per account **==** `account.held` at every commit — the
holds analogue of `sum(ledger delta) == account.balance`. A place increments both sides
(`held += amount`, a new PLACED row); a settle nets the transfer to zero (`held -= amount`, hold
→ SETTLED); a release/expiry decrements both (`held -= amount`, hold → RELEASED/EXPIRED). Clearing
is a system account (exempt from the funds/frozen checks, may go negative — net in transit).

## Step 5c — external rail webhooks

The mocked external rail's **third-party callbacks**: the **outbound settlement callback** (the rail
reports whether an external outbound completed) and the **inbound credit** (the rail pushes money
into a customer account). Both are money-critical and both are **idempotent** — a retried webhook is
a safe no-op. Every movement here still funnels through the single posting reducer
(balance + ledger + outbox). Three developer decisions are LOCKED: the callbacks live on a **new
`/external` surface** authenticated by an **HMAC request signature** (a distinct trust domain);
outbound **SUCCESS is reconcile-only** (record the rail ref, NO new ledger post); and **both** the
outbound callback and the inbound webhook are built in this step.

### The `/external` surface + rail-signature guard (a distinct trust domain)

`/external` is a **third distinct trust domain**, separate from `/api` (customers behind the
gateway, `X-User-Id`) and `/internal` (our own network peers, `X-Service-Token`): the caller is an
external rail, not a user or a peer service. It authenticates with a **Stripe-style HMAC request
signature** over the RAW request body — never a user JWT, never the service token.

- **rawBody capture.** The app boots as `NestFactory.create(AppModule, { rawBody: true })`, so the
  untouched request-body bytes are available on `req.rawBody` (a Buffer). The signature is verified
  over exactly those bytes — **not reparsed JSON**, which a serializer round-trip could subtly alter
  (key order, number formatting). Global capture is harmless; only the `/external` guard reads it.
- `src/common/identity/rail-signature.guard.ts` `RailSignatureGuard` (implements `CanActivate`) is
  bound **globally** (`APP_GUARD`, registered in `AppModule` alongside the gateway + service guards).
  It **scopes itself** to the `external` prefix (`prefixSegment(request.path) !== 'external'` →
  returns true, another guard's concern; a case-insensitive match so `/EXTERNAL/*` stays guarded).
  For an `/external` request it verifies, in order:
  1. **Parse** `X-Rail-Signature: t=<unix-seconds>,v1=<hex>` (tolerant of field order/whitespace).
     Both fields are REQUIRED; `t` must be an integer and `v1` non-empty hex. Missing/malformed → 401.
  2. **Replay guard** — `nowSeconds = Math.floor(Date.now()/1000)`; if `|nowSeconds − t| > 300` → 401.
  3. **Raw body present** — `req.rawBody` must exist (fail-closed: a missing raw body → 401, never a
     silent pass).
  4. **HMAC compare** — recompute `HMAC-SHA256(config.rails.webhookSigningSecret, "<t>.<rawBody>")`
     (hex) and compare against `v1` with the length-guarded `timingSafeEqual` helper (the same
     `constantTimeEquals` as the service-identity guard). Mismatch → 401.

  Every failure raises `UnauthorizedException` with a **generic message** ("Invalid or missing rail
  signature") that never reveals which check failed. There is **NO health carve-out** (health lives
  on `/internal`). The per-`externalRef` idempotency in `RailsService` remains UNCHANGED as
  defense-in-depth inside the replay window (a retried webhook is still a safe no-op).
- `src/modules/external/external.module.ts` `ExternalModule` is the `/external` **surface registry**
  (mirroring `ApiModule` / `InternalModule`): it **declares** `RailsExternalController` and imports
  `RailsModule` for the `RAILS_SERVICE` the controller injects. `AppModule` imports `ExternalModule`
  and binds `RailSignatureGuard`.

### Module structure

`src/modules/rails/` — the rails FEATURE module (module-layout + controller-surface conventions):
the root holds only `rails.module.ts`; business logic under `service/`; the controller in its own
`external/` surface folder with `dto/` + `serializers/`.

| File | Role |
|---|---|
| `rails.module.ts` | Feature module: `imports: [PersistenceModule, PostingModule, IdempotencyModule]`, binds `{ provide: RAILS_SERVICE, useClass: RailsService }`, exports the token. **No controllers of its own.** |
| `service/interfaces/rails.service.interface.ts` | `IRailsService` + `RAILS_SERVICE` token + `OutboundSettlementParams` / `InboundCreditParams` contract types. |
| `service/errors.ts` | Rails-owned domain errors (extend `DomainError`): `SettlementTargetNotFoundError`, `InvalidSettlementStateError`, `InboundDestinationNotFoundError`. |
| `service/impl/rails.service.ts` | `RailsService implements IRailsService` — `settleOutbound` / `creditInbound`; injects the DataSource + `ACCOUNT_REPOSITORY` / `TRANSACTION_REPOSITORY` / `HOLD_REPOSITORY` / `POSTING_SERVICE` / `IDEMPOTENCY_SERVICE`. |
| `external/rails-external.controller.ts` | `RailsExternalController`, `@Controller('external')` — the two webhook routes; **declared by `ExternalModule`**. |
| `external/dto/rails.schema.ts` | zod `settlementCallbackSchema` / `inboundCreditSchema` (both `.strict()`). |
| `external/dto/rail-ack.dto.ts` | `RailAckDto` — the minimal ack wire contract. |
| `external/serializers/rails.serializer.ts` | Explicit-whitelist `serializeRailAck` (entity → the minimal ack; no PII/internal leak). |

`src/common/rails/inbound-rail.ts` exports `INBOUND_RAIL = 'rail-inbound'` (the mirror of
`OUTBOUND_RAIL`), naming the `clearing:rail-inbound` account the inbound credit debits.

### Endpoints

Both under the global `/external` prefix (the `RailSignatureGuard` has verified the HMAC
`X-Rail-Signature` over the raw body). Bodies
validated by the `ZodValidationPipe` (`.strict()`, malformed → 400). Both return **200** with a
minimal `RailAckDto` `{ status: 'ok', transactionId }` (idempotent, so a retry returns the same ack).

| Route | Effect |
|---|---|
| `POST /external/rails/settlement-callback` | Outbound completion. Body `{ transactionId (uuid), status ('success'\|'failure'), externalRef }`. SUCCESS reconciles (record the rail ref, no new ledger post); FAILURE reverses (`clearing → customer`, original → REVERSED). `transactionId` in the ack is the ORIGINAL transfer id. |
| `POST /external/rails/inbound` | External inbound credit. Body `{ accountNumber (10-digit), amount, currency, externalRef }`. Posts a fresh `external_inbound` movement (`clearing:rail-inbound → customer`). `transactionId` in the ack is the newly-posted (or replayed) inbound id. |

### `postFreshInTx` — the fresh-movement-in-tx reducer seam

`PostingService` gains a third entry point beside `postTransaction` (own tx, insert POSTED header)
and `postPendingInTx` (caller's tx, transition PENDING → POSTED): **`postFreshInTx(queryRunner,
command)`** runs INSIDE the caller's transaction (no new tx) and **INSERTS a fresh POSTED header**
(a `randomUUID` id), reusing the SAME shared `applyPosting` steps (lock canonically → per-leg
`checkAndFold` → balance-then-ledger → one outbox row) with the `insertPostedHeader` callback. It
lets the rail reversal + inbound post a fresh movement within an **already-open, source-locked**
transaction. `postTransaction` / `postPendingInTx` behavior is unchanged, and `lockOrderFor` stays
as-is — callers that touch a customer **and** a clearing account **explicitly lock the customer
first** (see below), so the effective acquisition order is customer → clearing.

### Outbound settlement callback (`settleOutbound`)

Loads the transfer by id (missing → `SettlementTargetNotFoundError` **404**); it must be
`external_outbound` else `InvalidSettlementStateError` **409**. Both branches then, as their
**first in-tx step, lock the customer (source, `debitAccountId`) row `FOR UPDATE`** and read the
state machine `(transaction.status, hold.externalRef)` **only after** that lock — so the decision
is judged from a serialized, up-to-date view:

- **SUCCESS — reconcile only.** In ONE tx: **lock the customer FIRST**, then if the settled hold's
  `external_ref` is already set → **idempotent no-op** (return the transfer); else if the transfer is
  already `REVERSED` → `InvalidSettlementStateError` (a failed transfer can't later succeed); else if
  the transfer is **not `POSTED`** (a stale success on a PENDING/EXPIRED/CANCELLED external_outbound)
  → `InvalidSettlementStateError`; else `recordExternalRefInTx(hold.id, externalRef)` (guarded
  `external_ref IS NULL`). **NO ledger movement, NO balance/held change** — the money already moved
  customer → `clearing:rail-outbound` at OTP-confirm; this only stamps the rail reference for
  reconciliation, now under the customer lock. The `status = POSTED` check is symmetric with the
  failure's `WHERE status = POSTED` transition guard.
- **FAILURE — compensating reversal.** In ONE `runInTransactionWithRetry` tx, in this **exact
  order**: **lock the customer (debit) account FIRST** (`lockByIdForUpdate`), then if already
  `REVERSED` → idempotent no-op; else if the hold `external_ref` is already set (already reconciled
  success) → `InvalidSettlementStateError`; else run the guarded **`transitionToReversedInTx(originalId)`**
  (`POSTED → REVERSED`; **0 rows → a concurrent caller already reversed → no-op / re-read**, never a
  second compensating post), then **`postFreshInTx`** a fresh POSTED movement crediting the customer
  and debiting `clearing:rail-outbound` — legs `[{ clearing, −amount }, { customer, +amount }]`,
  `reversesTransactionId = originalId`. The customer leg is a **CREDIT**, so a **frozen** customer is
  still refunded, and `clearing` (a system account) may go negative. Returns the ORIGINAL transfer
  (now REVERSED — the id the rail correlated on).

**Success XOR failure — never both, never two of the same.** The two branches guard on **disjoint
rows** — success on the hold's `external_ref IS NULL`, failure on the transaction's `status = POSTED`
— so a *simultaneous* `success` + `failure` for one transfer could otherwise both commit under READ
COMMITTED (a double-apply on a third-party trust boundary: refunded AND reconciled-as-delivered). To
prevent that, **both branches take the customer (source) row lock as their first in-tx step and read
the state machine only afterwards**: the second-arriving callback blocks until the first commits,
then re-reads its committed effect and rejects (`INVALID_SETTLEMENT_STATE`) or no-ops. The
customer-first lock also keeps the effective order **customer → clearing** for the failure's
`postFreshInTx` (the reducer's canonical locking would otherwise pick lock order by account id), and
the guarded `POSTED → REVERSED` transition remains the **idempotency gate** against a *retried*
failure (0 rows → posts nothing). Success touches no clearing account; it locks the customer purely
to serialize against a concurrent failure.

### Inbound credit (`creditInbound`)

Resolves the destination via `findByAccountNumber` → it must be a **customer** account (missing OR a
system/clearing account collapses to the SAME `InboundDestinationNotFoundError` **404** — never
reveal system accounts). Currency must match the account **and** the `clearing:rail-inbound` account
(`CurrencyMismatchError` otherwise; a missing inbound-clearing seed is a 500-class internal fault).
Then, **idempotent by the rail `externalRef`**:

```
idempotency.execute(
  { ownerId: destination.ownerId, key: `rail-inbound:${externalRef}`,
    fingerprintInput: { type: 'external_inbound', source: clearingId, destination: destination.id,
                        amount, currency },
    confirmDuplicate: true },
  async (qr) => { lockByIdForUpdate(qr, destination.id); postFreshInTx(qr, command); }
)
```

where the command's legs are `[{ clearing:rail-inbound, −amount }, { customer, +amount }]`, type
`external_inbound`. **`confirmDuplicate: true` bypasses the 60s soft-duplicate**: the rail
`externalRef` is the authoritative dedup, so two legitimate inbound credits with the same fingerprint
(same account/amount/currency) within 60s must BOTH process — a **duplicate ref** (same key) returns
the original transaction (**no double-credit**), while **distinct refs always process**. It is **NOT
OTP-gated** (approved by the originating institution) and a **FROZEN customer may still be credited**:
the customer leg is a CREDIT, and the reducer's `checkAndFold` only blocks customer **DEBITS**. The
customer is locked FIRST (source-before-clearing).

### New repository methods

Added (interface/impl split, following the tx-aware `…InTx` seam):

| Method | Effect |
|---|---|
| `ITransactionRepository.transitionToReversedInTx(qr, id)` | Guarded `POSTED → REVERSED` UPDATE (`WHERE id AND status = 'POSTED'`, + `failure_reason = 'rail_settlement_failed'`); returns `affected > 0`. The idempotency gate for the FAILURE callback — 0 rows means a concurrent/retried reversal, so no second compensating post. There is no `reversed_at` column; the compensating tx (its `posted_at` + `reverses_transaction_id`) is the audit record. |
| `IHoldRepository.recordExternalRefInTx(qr, id, externalRef)` | Reconcile a SUCCESS: `SET external_ref = :externalRef WHERE id AND external_ref IS NULL`; returns `affected > 0`. The `external_ref IS NULL` predicate is the idempotency gate (a retried success never overwrites). NO balance/held/ledger change. |

### New domain errors

| Class | `code` | Status | Meaning |
|---|---|---|---|
| `SettlementTargetNotFoundError` | `SETTLEMENT_TARGET_NOT_FOUND` | 404 | The settlement callback referenced a transaction id we never issued. |
| `InvalidSettlementStateError` | `INVALID_SETTLEMENT_STATE` | 409 | The callback conflicts with the transfer's money state (wrong type; success for a reversed transfer; failure for a reconciled success). |
| `InboundDestinationNotFoundError` | `INBOUND_DESTINATION_NOT_FOUND` | 404 | The inbound credit could not resolve its destination to a customer account by number. |

All extend `DomainError` (rails `service/errors.ts`) and are mapped in `domain-error-status.ts`. The
reducer's `CurrencyMismatchError` is reused at its existing code (422).

### Source-before-clearing, reaffirmed (the deadlock-free invariant)

Step 5b established the forward rule: **every operation that touches a customer account AND a
clearing account must lock the customer BEFORE the clearing account**. Step 5c honors it — both the
failure reversal and the inbound credit acquire the customer's `FOR UPDATE` lock (`lockByIdForUpdate`)
**before** calling `postFreshInTx` (whose canonical ascending-id locking then reaches the clearing
account). So a 5c op and a concurrent 5b settle both acquire locks in the customer → clearing order
and can never deadlock by opposite ordering; the bounded deadlock-retry (`runInTransactionWithRetry`,
`40P01`) is the residual backstop. The materialized-holds invariants are untouched by these paths:
outbound holds are already SETTLED from 5b, so reconcile/reverse don't change `held`, and
`SUM(PLACED holds) == held` / `held >= 0` continue to hold. `clearing:rail-inbound` may go negative
(a system account, exempt — net in transit).

## Step 7 — limits enforcement

Per-transaction, daily, and monthly **amount** caps (fixed calendar windows — never rolling, no
count-based velocity), enforced **inside the reducer** under the SAME `FOR UPDATE` account lock as
the funds check. Because the lock, the check, and the counter increment all sit in one critical
section, a concurrent race can never push a counter past its cap — the same guarantee that makes
the overdraft check safe. No new lock, no second transaction, no scheduler.

### Where it lives (and where it does not)

- The check + increment are a **new phase of `applyPosting`** (`PostingService`), between the
  per-leg `checkAndFold` (funds/currency/frozen) and the balance-mutation loop for the *check*,
  and between the balance/ledger fold and the outbox insert for the *counter write* — so a breach
  throws BEFORE any balance moves, and the counters commit in the SAME tx as the movement.
- It runs **only when the caller opts in** via `command.limitAccountId` (the customer debit leg).
  This is set on the **shared confirm-time command** in `TransfersService.confirmTransfer`, which
  backs BOTH outbound flows — the internal `postPendingInTx` post and the external
  `settleExternalTransfer` settle. Inbound credits and reversals post through `postFreshInTx`
  **without** it, so they never touch a counter (spec 04: inbound / reversals never count, and a
  rail-failure reversal does **not** give the slot back — the fixed window holds it until reset).

### The model — per-account counters, per-owner caps

- **Counters are per-account** (`account.spent_today` / `spent_month`, with their `*_date` window
  markers), incremented on the debited account only.
- **Caps are per-owner or global.** `IUserLimitsRepository.resolveInTx(qr, ownerId, currency)`
  resolves them **row-level, customer-wins**: the `customer` row (`owner_id = ownerId`) wins
  **wholesale** when present, else the `global` baseline row, else `null` (uncapped). A NULL cap
  **field** inside the chosen row is uncapped for that field. This per-account-counter /
  per-owner-cap asymmetry is **from the spec** — spend is **not** aggregated across a customer's
  several accounts.

### The fixed-window lazy reset (DB clock, UTC)

`IAccountRepository.currentSpendWindowInTx(qr)` reads the boundaries off the **DB clock in UTC**
(`(now() AT TIME ZONE 'UTC')::date` for `today`, `date_trunc('month', …)` for `monthStart`),
consistent with how `expires_at` / hold expiry use the DB clock. Both surface as ISO `YYYY-MM-DD`
strings, which sort **chronologically == lexicographically**, so the stale check is a plain string
`<`: if `spent_today_date < today` the day rolled over → the effective today-spend is `0` before
the add (same for the month against `monthStart`). The reset is **lazy** — it happens on the next
spend, no scheduler ever zeroes a counter.

### The check (BigInt minor units, first breach wins)

All arithmetic is exact `BigInt` on minor-unit strings (never `Number`/float). With
`amount = BigInt(command.amount)`, `newToday = effToday + amount`, `newMonth = effMonth + amount`:

1. `perTransactionMax != null && amount > perTransactionMax` → `LimitExceededError('per_transaction')`
2. `dailyMax != null && newToday > dailyMax` → `LimitExceededError('daily')`
3. `monthlyMax != null && newMonth > monthlyMax` → `LimitExceededError('monthly')`

First breach wins. On success the reducer writes `spent_today = newToday`, `spent_today_date =
today`, `spent_month = newMonth`, `spent_month_date = monthStart` via
`IAccountRepository.updateSpendCountersInTx` (the limits-side sibling of `updateBalanceInTx`).
A malformed directive — `limitAccountId` not among the legs, not a debit (`delta >= 0`), or not a
customer account — throws `InvalidPostingCommandError` (defensive; the transfers layer only ever
points it at the customer sender).

### The domain error

`LimitExceededError` (posting `service/errors.ts`, `code = 'LIMIT_EXCEEDED'`) carries the breached
cap kind (`per_transaction` / `daily` / `monthly`) and the account id; it names the cap in its
message (safe — it is the owner's own limit). Mapped to **422** in `domain-error-status.ts`, in the
"unprocessable given the money state" group beside `INSUFFICIENT_FUNDS`.

### New repository methods

Added (interface/impl split, following the tx-aware `…InTx` seam):

| Method | Effect |
|---|---|
| `IUserLimitsRepository.resolveInTx(qr, ownerId, currency)` | Resolve the applicable caps (customer row wins over global; `null` if neither). Two bound queries; a global row is selected by `owner_id IS NULL`. |
| `IAccountRepository.currentSpendWindowInTx(qr)` | `{ today, monthStart }` off the DB clock in UTC as ISO `YYYY-MM-DD` strings. |
| `IAccountRepository.updateSpendCountersInTx(qr, id, spentToday, spentTodayDate, spentMonth, spentMonthDate)` | Targeted UPDATE of the four counter columns (+ `updated_at`); values pre-computed by the reducer. |

### The seeded global baseline

`SeedBaselineUserLimits1789257600000` (`…/migrations/1789257600000-SeedBaselineUserLimits.ts`)
seeds the ONE global baseline `user_limits` row on boot — a system constant, like the clearing
accounts and the MXN currency (spec 04: "the global baseline is seeded, like the system accounts").
Idempotent `INSERT … ON CONFLICT ON CONSTRAINT "uq_user_limits_scope" DO NOTHING`; `down()` deletes
that global row. Per-customer overrides and the admin `PUT /limits` surface are a later step.

| scope | owner_id | currency | per_transaction_max | daily_max | monthly_max |
|---|---|---|---|---|---|
| `global` | NULL | MXN | `5000000` (50,000.00) | `10000000` (100,000.00) | `100000000` (1,000,000.00) |

## Not in this slice (later steps)

The outbox **relay worker** (SKIP LOCKED across instances) and admin ops + maker-checker (including
the admin `PUT /limits` **configuration** surface and the admin-triggered *simulated* inbound, a
separate deferred admin-surface concern). Statement pagination beyond the first page is likewise
deferred — the read slice returns only the most recent `STATEMENT_PAGE_LIMIT` legs.
