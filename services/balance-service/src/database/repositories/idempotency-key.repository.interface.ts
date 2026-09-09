import { DeepPartial } from 'typeorm';
import { IdempotencyKey } from '../entities/idempotency-key.entity';

/** DI token for {@link IIdempotencyKeyRepository}. */
export const IDEMPOTENCY_KEY_REPOSITORY = Symbol('IDEMPOTENCY_KEY_REPOSITORY');

/** Persistence port for {@link IdempotencyKey}. Keyed on the composite PK `(owner_id, key)`,
 * so lookup is by owner + key rather than a single id. The 60s soft-duplicate-window lookup
 * (by `request_fingerprint`) is deferred to the domain step. */
export interface IIdempotencyKeyRepository {
  findByOwnerAndKey(ownerId: string, key: string): Promise<IdempotencyKey | null>;
  create(data: DeepPartial<IdempotencyKey>): Promise<IdempotencyKey>;
}
