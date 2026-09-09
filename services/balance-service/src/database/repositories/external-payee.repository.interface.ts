import { DeepPartial } from 'typeorm';
import { ExternalPayee } from '../entities/external-payee.entity';

/** DI token for {@link IExternalPayeeRepository}. */
export const EXTERNAL_PAYEE_REPOSITORY = Symbol('EXTERNAL_PAYEE_REPOSITORY');

/** Persistence port for {@link ExternalPayee} (owner-scoped). */
export interface IExternalPayeeRepository {
  findById(id: string): Promise<ExternalPayee | null>;
  create(data: DeepPartial<ExternalPayee>): Promise<ExternalPayee>;
  /** All payees enrolled by a customer (`owner_id`). */
  findByOwner(ownerId: string): Promise<ExternalPayee[]>;
}
