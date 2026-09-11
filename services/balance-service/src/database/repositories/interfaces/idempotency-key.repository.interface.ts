import { DeepPartial, QueryRunner } from 'typeorm';
import { IdempotencyStatus } from '../../entities/enums';
import { IdempotencyKey } from '../../entities/idempotency-key.entity';

/** DI token for {@link IIdempotencyKeyRepository}. */
export const IDEMPOTENCY_KEY_REPOSITORY = Symbol('IDEMPOTENCY_KEY_REPOSITORY');

/** The fields written when a caller CLAIMS an idempotency key (the initial `in_progress`
 * insert). Separate from {@link IdempotencyKey} so the claim shape is explicit. */
export interface IdempotencyClaim {
  ownerId: string;
  key: string;
  requestFingerprint: string;
  status: IdempotencyStatus;
  expiresAt: Date;
}

/** Persistence port for {@link IdempotencyKey}. Keyed on the composite PK `(owner_id, key)`,
 * so lookup is by owner + key rather than a single id. The tx-aware methods operate inside a
 * caller-supplied `QueryRunner`'s transaction (the idempotency wrapper's single tx). */
export interface IIdempotencyKeyRepository {
  findByOwnerAndKey(ownerId: string, key: string): Promise<IdempotencyKey | null>;
  create(data: DeepPartial<IdempotencyKey>): Promise<IdempotencyKey>;
  /** Owner+key lookup inside the given transaction — the replay check. */
  findByOwnerAndKeyInTx(
    queryRunner: QueryRunner,
    ownerId: string,
    key: string,
  ): Promise<IdempotencyKey | null>;
  /**
   * Atomically claim the key: `INSERT … ON CONFLICT ("owner_id","key") DO NOTHING`. Returns
   * `true` iff THIS call inserted the row (won the claim), `false` if a concurrent caller
   * already holds it. An EXPLICIT insert — never `.save()`/`create`, which would UPSERT on the
   * client-supplied composite PK (see docs/persistence.md) and silently overwrite the holder.
   */
  claimInTx(queryRunner: QueryRunner, data: IdempotencyClaim): Promise<boolean>;
  /** Transition a claimed key to `completed` and link its resulting transaction, in-tx. */
  markCompletedInTx(
    queryRunner: QueryRunner,
    ownerId: string,
    key: string,
    transactionId: string,
  ): Promise<void>;
  /**
   * Atomically INSERT a COMPLETED key linked to `transactionId` (the initiate-time fresh-FAILED
   * path, where no prior claim survives — the operation tx rolled back): an explicit parameterized
   * `INSERT (owner_id, key, request_fingerprint, status='completed', transaction_id, expires_at)
   * ON CONFLICT (owner_id, key) DO NOTHING RETURNING "key"`. Returns `true` iff THIS call inserted
   * the row (won the completion); `false` on conflict (a concurrent same-key caller already holds or
   * completed the key — the wrapper resolves it). Blocks on a concurrent UNCOMMITTED same-key row
   * until it resolves (the serialization point). The linked transaction MUST already be inserted in
   * the SAME tx (fk_idem_transaction). Never `.save()` (which would upsert on the composite PK).
   */
  completeFreshInTx(
    queryRunner: QueryRunner,
    ownerId: string,
    key: string,
    requestFingerprint: string,
    transactionId: string,
    expiresAt: Date,
  ): Promise<boolean>;
  /**
   * The soft duplicate-suppression lookup: the most recent OTHER key for the same owner +
   * `request_fingerprint` created after `sinceEpochMs`. Backed by `idx_idem_fingerprint`.
   * `excludeKey` omits the caller's own (not-yet-claimed) key.
   */
  findRecentByFingerprintInTx(
    queryRunner: QueryRunner,
    ownerId: string,
    fingerprint: string,
    sinceEpochMs: number,
    excludeKey: string,
  ): Promise<IdempotencyKey | null>;
}
