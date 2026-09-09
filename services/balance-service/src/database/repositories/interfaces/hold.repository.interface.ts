import { DeepPartial } from 'typeorm';
import { Hold } from '../../entities/hold.entity';

/** DI token for {@link IHoldRepository}. */
export const HOLD_REPOSITORY = Symbol('HOLD_REPOSITORY');

/** Persistence port for {@link Hold} (append-only reservation ledger). The PLACED-sum /
 * reconciliation query is deferred to the domain step. */
export interface IHoldRepository {
  findById(id: string): Promise<Hold | null>;
  create(data: DeepPartial<Hold>): Promise<Hold>;
}
