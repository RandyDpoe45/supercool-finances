import { DeepPartial, QueryRunner } from 'typeorm';
import { Account } from '../../entities/account.entity';
import { AccountStatus } from '../../entities/enums';

/** DI token for {@link IAccountRepository}. Consumers depend on the interface, never the
 * concrete TypeORM implementation (ADR: depend on interfaces/tokens). */
export const ACCOUNT_REPOSITORY = Symbol('ACCOUNT_REPOSITORY');

/** Filter for the admin account query ({@link IAccountRepository.queryAccounts}). `ownerId` is
 * optional (absent → any owner, including system accounts); the already-clamped `limit`/`offset`
 * (the service bounds them) are required. */
export interface AccountQueryFilter {
  ownerId?: string;
  limit: number;
  offset: number;
}

/** Persistence port for {@link Account}. Minimal surface for this step; domain-driven
 * queries (reconstruction, spend-window logic, etc.) arrive with their callers. */
export interface IAccountRepository {
  findById(id: string): Promise<Account | null>;
  create(data: DeepPartial<Account>): Promise<Account>;
  /** All accounts owned by a customer (`owner_id`); a customer may have several. */
  findByOwner(ownerId: string): Promise<Account[]>;
  /** Admin-scoped account query (spec 04 "Admin ops" — `GET /accounts`, view ANY account). A
   * parameterized SELECT with the optional `ownerId` filter bound, `ORDER BY created_at DESC` (id
   * tiebreak for determinism), `LIMIT`/`OFFSET` from the (already-clamped) filter. This is a plain
   * read (no `FOR UPDATE`) and is DELIBERATELY NOT owner-scoped — it returns any account (customer
   * OR system) for the role-gated admin surface. */
  queryAccounts(filter: AccountQueryFilter): Promise<Account[]>;
  /** Single account scoped to its owner — ownership is enforced INSIDE the query
   * (`WHERE id = :id AND owner_id = :sub`); a non-owned or missing row resolves `null`
   * so the caller returns 404, never 403 (anti-IDOR / BOLA, ADR-3). System accounts
   * (`owner_id` NULL) never match a customer `ownerId`. */
  findByIdAndOwner(id: string, ownerId: string): Promise<Account | null>;
  /** Resolves a seeded system/clearing account by its stable `system_key`. */
  findBySystemKey(systemKey: string): Promise<Account | null>;
  /** Resolves a customer account by its human `account_number` (the transfer destination
   * identifier). System accounts have a NULL number and never match. Backed by the
   * `uq_account_account_number` unique index. */
  findByAccountNumber(accountNumber: string): Promise<Account | null>;
  /** `SELECT ... FOR UPDATE` on the account row — the concurrency primitive posting relies
   * on. MUST run inside the given queryRunner's active transaction. */
  lockByIdForUpdate(queryRunner: QueryRunner, id: string): Promise<Account | null>;
  /** Serialize concurrent self-service account creates PER OWNER via a transaction-scoped Postgres
   * advisory lock (`pg_advisory_xact_lock(hashtext(ownerId))`). There is no owner row to `FOR
   * UPDATE` lock (the per-customer account CAP is a COUNT invariant, not a single-row one), so this
   * advisory lock is what makes the "count then insert" critical section atomic: a concurrent
   * double-create for the same owner blocks here until the first commits, so the cap can never be
   * exceeded by a race. Released automatically at transaction end (commit/rollback). MUST run inside
   * the given queryRunner's active transaction. */
  lockOwnerForAccountCreation(queryRunner: QueryRunner, ownerId: string): Promise<void>;
  /** Count the owner's CUSTOMER accounts (`owner_id = ownerId AND kind = 'customer'`), joined to the
   * given queryRunner's transaction — the per-customer account-cap check for self-service creation.
   * MUST run under {@link lockOwnerForAccountCreation} so the count-then-insert cannot race. */
  countCustomerAccountsByOwner(queryRunner: QueryRunner, ownerId: string): Promise<number>;
  /** Insert an account joined to the given queryRunner's transaction (via `queryRunner.manager`, so
   * the INSERT is part of the locked create critical section — unlike {@link create}, which uses the
   * default manager and is NOT tx-joined). Returns the persisted entity (its DB-generated `id` is
   * populated via RETURNING). */
  createInTx(queryRunner: QueryRunner, data: DeepPartial<Account>): Promise<Account>;
  /** Targeted UPDATE of the materialized `balance` (and `updated_at`) for one account,
   * joined to the given queryRunner's transaction. The posting reducer calls this under the
   * account's `FOR UPDATE` lock, BEFORE inserting the ledger entry (balance-then-ledger,
   * ADR-13). `newBalance` is a canonical minor-unit string. */
  updateBalanceInTx(queryRunner: QueryRunner, id: string, newBalance: string): Promise<void>;
  /** Targeted UPDATE of the account `status` (and `updated_at`) for one account, joined to the
   * given queryRunner's transaction. The admin freeze/unfreeze op calls this under the account's
   * `FOR UPDATE` lock, in the SAME tx as its audit row. A frozen account can still be credited —
   * the reducer only blocks customer DEBITS on a frozen account. */
  updateStatusInTx(queryRunner: QueryRunner, id: string, status: AccountStatus): Promise<void>;
  /** Targeted UPDATE of the materialized `held` (and `updated_at`) for one account, joined to
   * the given queryRunner's transaction — the reservation-side sibling of
   * {@link updateBalanceInTx}. The transfers service calls this under the account's `FOR UPDATE`
   * lock when a hold is placed (`held += amount`), released/expired, or settled (`held -= amount`),
   * so the `SUM(PLACED holds) == account.held` invariant holds at every commit. `newHeld` is a
   * canonical minor-unit string; the `held >= 0` DB check must never be violated. */
  updateHeldInTx(queryRunner: QueryRunner, id: string, newHeld: string): Promise<void>;
  /** The current fixed-window boundaries off the DB clock in UTC (`today` = today's date,
   * `monthStart` = the first of the current month), each an ISO `YYYY-MM-DD` string. Used by the
   * reducer to lazily reset the per-account spend counters: a `spent_*_date` lexically before the
   * matching boundary is stale (ISO dates sort chronologically) and its counter zeroes before the
   * add. Uses the DB clock (not the app clock), consistent with `expires_at` / hold expiry. */
  currentSpendWindowInTx(queryRunner: QueryRunner): Promise<{ today: string; monthStart: string }>;
  /** Targeted UPDATE of the four fixed-window spend counters (and `updated_at`) for one account,
   * joined to the given queryRunner's transaction — the limits-side sibling of
   * {@link updateBalanceInTx}. The reducer calls this under the account's `FOR UPDATE` lock, after
   * the balance/ledger fold and before the outbox insert, when `limitAccountId` opted the movement
   * into limit enforcement. The values (post-reset, post-add counters + the current window dates)
   * are computed by the reducer; the counters can never exceed the cap because both the check and
   * this write happen under the same lock. Money values are canonical minor-unit strings; dates are
   * ISO `YYYY-MM-DD`. */
  updateSpendCountersInTx(
    queryRunner: QueryRunner,
    accountId: string,
    spentToday: string,
    spentTodayDate: string,
    spentMonth: string,
    spentMonthDate: string,
  ): Promise<void>;
}
