import { DeepPartial, QueryRunner } from 'typeorm';
import { Customer } from '../../entities/customer.entity';

/** DI token for {@link ICustomerRepository}. Consumers depend on the interface, never the
 * concrete TypeORM implementation (ADR: depend on interfaces/tokens). */
export const CUSTOMER_REPOSITORY = Symbol('CUSTOMER_REPOSITORY');

/** Persistence port for {@link Customer}. Minimal surface: resolve a holder by id (the
 * Keycloak `sub`, which equals `account.owner_id`) and create one (seed/tests populate —
 * there is no create-customer endpoint in this step). */
export interface ICustomerRepository {
  findById(id: string): Promise<Customer | null>;
  create(data: DeepPartial<Customer>): Promise<Customer>;
  /** Whether a customer row with this id exists, joined to the given queryRunner's transaction.
   * Self-service account creation calls this under the per-owner advisory lock: the
   * `account.owner_id → customer.id` FK requires the caller's customer row to exist, so an absent
   * one is surfaced as a domain 404 rather than a raw FK violation. */
  existsByIdInTx(queryRunner: QueryRunner, id: string): Promise<boolean>;
}
