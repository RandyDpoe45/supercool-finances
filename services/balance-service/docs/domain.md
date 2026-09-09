# Balance Service — Domain layer (spec 04)

The money core built on the [foundation](./README.md) and [persistence
layer](./persistence.md). This page records **what was built**; the design of record is
[`specs/04-balance-service.md`](../../../specs/04-balance-service.md).

This is the **first, read-only slice**: two customer account reads, the domain module
structure, and the money helper they need. No money movement, no locks, no holds, no
OTP — those arrive in later steps. Domain-specific errors (a base class) also arrive
with the first write path; this slice uses standard Nest exceptions only.

## Module structure

`src/modules/accounts/` — the `Accounts` domain module.

| File | Role |
|---|---|
| `accounts.module.ts` | `imports: [PersistenceModule]`; declares the controller, provides the service. |
| `accounts.controller.ts` | `@Controller('api')` — the two read routes; delegates to the service. |
| `accounts.service.ts` | Owner-scoped reads + pure entity→DTO mappers + `STATEMENT_PAGE_LIMIT`. |
| `dto/account.dto.ts` | `AccountDto` — customer view of an account. |
| `dto/statement-entry.dto.ts` | `StatementEntryDto` — one ledger leg of a statement. |

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
    → `IAccountRepository.findByOwner(userId)` → `toAccountDto`.

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
    `AccountsService.getAccountStatement(id, userId)` →
    `IAccountRepository.findByIdAndOwner(id, userId)` (ownership check) →
    `ILedgerEntryRepository.findByAccount(id, STATEMENT_PAGE_LIMIT)` → `toStatementEntryDto`.

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

## Money & the `available` derivation

- Money is **`bigint` minor units surfaced as JS `string`** (int64 precision — never
  `Number`/float). See [persistence.md](./persistence.md#money--type-mapping-decisions).
- **Available balance is derived, never stored:** `available = balance − held`.
  `src/common/money/money.ts` `availableBalance(balance, held)` computes it with exact
  `BigInt` math. It lives in `common/` because it is cross-cutting — the posting
  operation (later step) reuses it. `available` MAY be negative for system/clearing
  accounts; customer overdraft is enforced at debit time (later step), not here.

## Bounded reads

`ILedgerEntryRepository.findByAccount(accountId, limit)` orders `created_at DESC, id DESC`
(the `id` tiebreak makes ties deterministic) and applies `take(limit)`. It is backed by
`idx_ledger_account_created`. The query is **always bounded** — `STATEMENT_PAGE_LIMIT`
(100) caps it; there is no unbounded variant, since an account's history grows without
limit.

## Not in this slice (later steps)

Money movement (`postTransaction`, the single balance-mutating reducer), holds, limits,
OTP, transfers, the outbox relay, admin ops, and a domain-error base class. Statement
pagination beyond the first page is likewise deferred — this slice returns only the most
recent `STATEMENT_PAGE_LIMIT` legs.
