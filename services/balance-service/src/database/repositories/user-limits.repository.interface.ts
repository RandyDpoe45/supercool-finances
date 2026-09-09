import { DeepPartial } from 'typeorm';
import { UserLimits } from '../entities/user-limits.entity';

/** DI token for {@link IUserLimitsRepository}. */
export const USER_LIMITS_REPOSITORY = Symbol('USER_LIMITS_REPOSITORY');

/** Persistence port for {@link UserLimits} (owner-scoped override rows). Global/customer
 * resolution logic is a domain-step concern. */
export interface IUserLimitsRepository {
  findById(id: string): Promise<UserLimits | null>;
  create(data: DeepPartial<UserLimits>): Promise<UserLimits>;
  /** Customer-scope limit rows for a customer (`owner_id`); global rows have `owner_id` NULL. */
  findByOwner(ownerId: string): Promise<UserLimits[]>;
}
