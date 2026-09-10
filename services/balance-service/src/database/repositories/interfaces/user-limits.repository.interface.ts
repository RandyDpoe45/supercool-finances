import { DeepPartial, QueryRunner } from 'typeorm';
import { UserLimits } from '../../entities/user-limits.entity';

/** DI token for {@link IUserLimitsRepository}. */
export const USER_LIMITS_REPOSITORY = Symbol('USER_LIMITS_REPOSITORY');

/** The three resolved caps for an owner + currency (each `null` = uncapped for that field). */
export interface ResolvedLimits {
  perTransactionMax: string | null;
  dailyMax: string | null;
  monthlyMax: string | null;
}

/** Persistence port for {@link UserLimits} (owner-scoped override rows). Global/customer
 * resolution logic is a domain-step concern. */
export interface IUserLimitsRepository {
  findById(id: string): Promise<UserLimits | null>;
  create(data: DeepPartial<UserLimits>): Promise<UserLimits>;
  /** Customer-scope limit rows for a customer (`owner_id`); global rows have `owner_id` NULL. */
  findByOwner(ownerId: string): Promise<UserLimits[]>;
  /**
   * Resolve the caps that apply to an owner + currency, inside the caller's transaction (joined
   * to the reducer's account-lock critical section). Row-level, customer-wins resolution: the
   * `customer` row (`owner_id = :ownerId`) wins wholesale when present, else the `global` row,
   * else `null` (uncapped). A NULL cap field inside the returned row is uncapped for that field.
   */
  resolveInTx(
    queryRunner: QueryRunner,
    ownerId: string,
    currency: string,
  ): Promise<ResolvedLimits | null>;
}
