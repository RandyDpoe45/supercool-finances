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

## Not in this slice (later steps)

Money movement (`postTransaction`, the single balance-mutating reducer), holds, limits,
OTP, transfers, the outbox relay, admin ops, and a domain-error base class. Statement
pagination beyond the first page is likewise deferred — this slice returns only the most
recent `STATEMENT_PAGE_LIMIT` legs.
