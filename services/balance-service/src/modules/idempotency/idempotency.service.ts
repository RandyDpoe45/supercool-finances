import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { runInTransactionWithRetry } from '../../common/db/run-in-transaction';
import { IdempotencyStatus } from '../../database/entities/enums';
import { IdempotencyKey } from '../../database/entities/idempotency-key.entity';
import {
  IDEMPOTENCY_KEY_REPOSITORY,
  IIdempotencyKeyRepository,
} from '../../database/repositories/idempotency-key.repository.interface';
import { computeFingerprint, FingerprintInput } from './fingerprint';
import {
  IdempotencyInProgressError,
  IdempotencyKeyReuseError,
  SuspectedDuplicateError,
} from './idempotency.errors';

/** Soft duplicate-suppression window: an identical request under a DIFFERENT key seen within
 * this window is a suspected double-submit (spec 04 Transfers). */
const SOFT_DUPLICATE_WINDOW_MS = 60_000;

/** Idempotency keys expire 24h after creation (the cleanup sweep prunes them). */
const KEY_TTL_MS = 24 * 60 * 60 * 1000;

/** Inputs to {@link IdempotencyService.execute}. */
export interface IdempotencyParams {
  ownerId: string;
  key: string;
  fingerprintInput: FingerprintInput;
  /** When true, override a suspected soft-duplicate and proceed (an explicit confirm). */
  confirmDuplicate?: boolean;
}

/** The wrapped money movement: runs INSIDE the wrapper's transaction and returns the id of
 * the transaction it posted. */
export type IdempotentOperation = (queryRunner: QueryRunner) => Promise<{ transactionId: string }>;

/** Outcome of {@link IdempotencyService.execute}: the resulting transaction id and whether
 * this call replayed a prior result (money moved 0 additional times) or performed it fresh. */
export interface IdempotencyOutcome {
  transactionId: string;
  replayed: boolean;
}

/**
 * A GENERIC at-most-once wrapper for money-moving requests (spec 04 Transfers), decoupled from
 * posting: any operation can be run under an `Idempotency-Key` with soft-duplicate suppression.
 *
 * Atomicity model: everything happens in ONE transaction (READ COMMITTED, via the shared
 * {@link runInTransactionWithRetry} — so a deadlock retries and every error rolls back the
 * claim WITH the movement, leaving a failed attempt fully retryable). The key claim is an
 * explicit `INSERT … ON CONFLICT DO NOTHING`, which resolves the composite-PK upsert caveat
 * (docs/persistence.md): a concurrent caller BLOCKS on the claim row lock until this tx commits
 * (→ `completed`, the other replays) or rolls back (→ gone, the other claims). Consequently a
 * committed `in_progress` is never externally observable, so the in-progress paths are
 * defensive.
 */
@Injectable()
export class IdempotencyService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(IDEMPOTENCY_KEY_REPOSITORY) private readonly keys: IIdempotencyKeyRepository,
  ) {}

  /**
   * Run `operation` at most once for `(ownerId, key)`. Replays a prior completed result;
   * rejects key reuse with different params ({@link IdempotencyKeyReuseError}); soft-blocks a
   * suspected duplicate ({@link SuspectedDuplicateError}) unless `confirmDuplicate`.
   */
  async execute(
    params: IdempotencyParams,
    operation: IdempotentOperation,
  ): Promise<IdempotencyOutcome> {
    // a. The fingerprint is deterministic — computed once, outside the (retryable) tx.
    const fingerprint = computeFingerprint(params.fingerprintInput);
    return runInTransactionWithRetry(this.dataSource, (queryRunner) =>
      this.runOnce(queryRunner, params, fingerprint, operation),
    );
  }

  private async runOnce(
    queryRunner: QueryRunner,
    params: IdempotencyParams,
    fingerprint: string,
    operation: IdempotentOperation,
  ): Promise<IdempotencyOutcome> {
    // b. Replay check: an existing key resolves to a replay / reuse-error / in-progress.
    const existing = await this.keys.findByOwnerAndKeyInTx(queryRunner, params.ownerId, params.key);
    if (existing) {
      return this.resolveExisting(existing, fingerprint);
    }

    // c. Soft-duplicate: a DIFFERENT recent key with the same fingerprint (unless confirmed).
    if (!params.confirmDuplicate) {
      const recent = await this.keys.findRecentByFingerprintInTx(
        queryRunner,
        params.ownerId,
        fingerprint,
        Date.now() - SOFT_DUPLICATE_WINDOW_MS,
        params.key,
      );
      if (recent) {
        throw new SuspectedDuplicateError();
      }
    }

    // d. Claim the key. If a concurrent caller won the race between (b) and (d), the claim
    //    returns false; re-read and resolve exactly as (b).
    const claimed = await this.keys.claimInTx(queryRunner, {
      ownerId: params.ownerId,
      key: params.key,
      requestFingerprint: fingerprint,
      status: IdempotencyStatus.InProgress,
      expiresAt: new Date(Date.now() + KEY_TTL_MS),
    });
    if (!claimed) {
      const concurrent = await this.keys.findByOwnerAndKeyInTx(
        queryRunner,
        params.ownerId,
        params.key,
      );
      if (!concurrent) {
        // The conflicting row would have to have vanished mid-tx — unreachable; treat as busy.
        throw new IdempotencyInProgressError();
      }
      return this.resolveExisting(concurrent, fingerprint);
    }

    // e. Run the money movement inside this same transaction.
    const { transactionId } = await operation(queryRunner);

    // f. Mark the key completed and link the transaction; commit is the wrapper's job.
    await this.keys.markCompletedInTx(queryRunner, params.ownerId, params.key, transactionId);
    return { transactionId, replayed: false };
  }

  /** Resolve an already-present key: fingerprint mismatch → reuse error; completed → replay;
   * otherwise (in_progress, or the unreachable completed-without-transaction invariant breach)
   * → defensive in-progress error. */
  private resolveExisting(existing: IdempotencyKey, fingerprint: string): IdempotencyOutcome {
    if (existing.requestFingerprint !== fingerprint) {
      throw new IdempotencyKeyReuseError();
    }
    if (existing.status === IdempotencyStatus.Completed && existing.transactionId) {
      return { transactionId: existing.transactionId, replayed: true };
    }
    throw new IdempotencyInProgressError();
  }
}
