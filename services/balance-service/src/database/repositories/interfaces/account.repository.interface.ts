import { DeepPartial, QueryRunner } from 'typeorm';
import { Account } from '../../entities/account.entity';

/** DI token for {@link IAccountRepository}. Consumers depend on the interface, never the
 * concrete TypeORM implementation (ADR: depend on interfaces/tokens). */
export const ACCOUNT_REPOSITORY = Symbol('ACCOUNT_REPOSITORY');

/** Persistence port for {@link Account}. Minimal surface for this step; domain-driven
 * queries (reconstruction, spend-window logic, etc.) arrive with their callers. */
export interface IAccountRepository {
  findById(id: string): Promise<Account | null>;
  create(data: DeepPartial<Account>): Promise<Account>;
  /** All accounts owned by a customer (`owner_id`); a customer may have several. */
  findByOwner(ownerId: string): Promise<Account[]>;
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
  /** Targeted UPDATE of the materialized `balance` (and `updated_at`) for one account,
   * joined to the given queryRunner's transaction. The posting reducer calls this under the
   * account's `FOR UPDATE` lock, BEFORE inserting the ledger entry (balance-then-ledger,
   * ADR-13). `newBalance` is a canonical minor-unit string. */
  updateBalanceInTx(queryRunner: QueryRunner, id: string, newBalance: string): Promise<void>;
  /** Targeted UPDATE of the materialized `held` (and `updated_at`) for one account, joined to
   * the given queryRunner's transaction — the reservation-side sibling of
   * {@link updateBalanceInTx}. The transfers service calls this under the account's `FOR UPDATE`
   * lock when a hold is placed (`held += amount`), released/expired, or settled (`held -= amount`),
   * so the `SUM(PLACED holds) == account.held` invariant holds at every commit. `newHeld` is a
   * canonical minor-unit string; the `held >= 0` DB check must never be violated. */
  updateHeldInTx(queryRunner: QueryRunner, id: string, newHeld: string): Promise<void>;
}
