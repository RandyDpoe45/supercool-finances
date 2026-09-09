import { DeepPartial, QueryRunner } from 'typeorm';
import { Account } from '../entities/account.entity';

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
  /** Resolves a seeded system/clearing account by its stable `system_key`. */
  findBySystemKey(systemKey: string): Promise<Account | null>;
  /** `SELECT ... FOR UPDATE` on the account row — the concurrency primitive posting relies
   * on. MUST run inside the given queryRunner's active transaction. */
  lockByIdForUpdate(queryRunner: QueryRunner, id: string): Promise<Account | null>;
}
