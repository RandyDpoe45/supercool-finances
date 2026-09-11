import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { runInTransactionWithRetry } from '../../../../common/db/run-in-transaction';
import { IdempotencyStatus } from '../../../../database/entities/enums';
import { IdempotencyKey } from '../../../../database/entities/idempotency-key.entity';
import {
  IDEMPOTENCY_KEY_REPOSITORY,
  IIdempotencyKeyRepository,
} from '../../../../database/repositories/interfaces/idempotency-key.repository.interface';
import { computeFingerprint } from '../fingerprint';
import {
  IdempotencyInProgressError,
  IdempotencyKeyReuseError,
  SuspectedDuplicateError,
} from '../errors';
import {
  IdempotencyFailureRecorder,
  IdempotencyOutcome,
  IdempotencyParams,
  IdempotentOperation,
  IIdempotencyService,
} from '../interfaces/idempotency.service.interface';

/** Soft duplicate-suppression window: an identical request under a DIFFERENT key seen within
 * this window is a suspected double-submit (spec 04 Transfers). */
const SOFT_DUPLICATE_WINDOW_MS = 60_000;

/** Idempotency keys expire 24h after creation (the cleanup sweep prunes them). */
const KEY_TTL_MS = 24 * 60 * 60 * 1000;

/** Internal control-flow signal (NOT a domain error): the failure-recorder lost the completion
 * race and a concurrent same-key caller already COMMITTED a terminal COMPLETED key. Thrown to roll
 * this side's orphan FAILED insert back, then caught by {@link IdempotencyService.recordFailureOutcome}
 * to replay the winner's linked transaction. Never leaves the service. */
class FailureRaceResolved extends Error {
  constructor(readonly transactionId: string) {
    super('idempotency failure-completion race resolved by a concurrent caller');
  }
}

/** Internal control-flow signal (NOT a domain error): the failure-recorder lost the completion race
 * but the winner's key is not (yet) an observable COMPLETED row. Thrown to roll this side's orphan
 * FAILED insert back; {@link IdempotencyService.recordFailureOutcome} maps it to a transport
 * in-progress error. Defensive — see the concurrency note there. */
class FailureRaceInProgress extends Error {
  constructor() {
    super('idempotency failure-completion race lost with no committed terminal outcome');
  }
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
export class IdempotencyService implements IIdempotencyService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(IDEMPOTENCY_KEY_REPOSITORY) private readonly keys: IIdempotencyKeyRepository,
  ) {}

  /**
   * Run `operation` at most once for `(ownerId, key)`. Replays a prior completed result;
   * rejects key reuse with different params ({@link IdempotencyKeyReuseError}); soft-blocks a
   * suspected duplicate ({@link SuspectedDuplicateError}) unless `confirmDuplicate`.
   *
   * `onFailure` is an OPT-IN business-failure hook. When the happy/validation single-tx path
   * throws, the wrapper offers the error to the recorder in a FRESH tx (see
   * {@link recordFailureOutcome}); a BUSINESS failure persists a terminal FAILED transaction and
   * COMPLETES the key linked to it, so `execute` returns that FAILED outcome instead of throwing;
   * a VALIDATION/STRUCTURAL error (or an absent `onFailure`) leaves the key released (the operation
   * tx rolled back) and rethrows the original error. Every existing caller that omits `onFailure`
   * is UNCHANGED.
   */
  async execute(
    params: IdempotencyParams,
    operation: IdempotentOperation,
    onFailure?: IdempotencyFailureRecorder,
  ): Promise<IdempotencyOutcome> {
    // a. The fingerprint is deterministic — computed once, outside the (retryable) tx.
    const fingerprint = computeFingerprint(params.fingerprintInput);
    try {
      return await runInTransactionWithRetry(this.dataSource, (queryRunner) =>
        this.runOnce(queryRunner, params, fingerprint, operation),
      );
    } catch (error) {
      if (!onFailure) {
        throw error;
      }
      const outcome = await this.recordFailureOutcome(params, fingerprint, error, onFailure);
      if (outcome) {
        return outcome;
      }
      // The recorder declined (validation/structural, or a non-persistable error): the operation
      // tx already rolled back (key released, nothing persisted), so propagate the ORIGINAL error.
      throw error;
    }
  }

  /**
   * Resolve a failed `operation` into a terminal outcome, in a NEW tx (the operation tx already
   * rolled back — the `in_progress` claim was released and NOTHING was persisted). This:
   *
   * 1. asks `onFailure` to build the FAILED transaction: a BUSINESS failure persists it (via the
   *    posting reducer, the sole event emitter) and returns its id; a validation/structural error
   *    returns `null` — nothing persisted, so we return `null` (the empty tx commits harmlessly and
   *    `execute` rethrows the original);
   * 2. COMPLETES the key linked to that FAILED transaction via `completeFreshInTx`
   *    (`INSERT … ON CONFLICT DO NOTHING`). `won === true` → this call recorded the outcome.
   *
   * Concurrency / exactly-once: two same-key initiates that both business-fail race here.
   * `completeFreshInTx`'s `ON CONFLICT DO NOTHING` BLOCKS on a concurrent UNCOMMITTED same-key row
   * until it resolves, so on a conflict the winner has already COMMITTED a terminal key + its ONE
   * FAILED transaction. The loser throws {@link FailureRaceResolved} (carrying the winner's linked
   * id) to roll ITS orphan FAILED insert back and replay the winner's outcome — so there is exactly
   * ONE FAILED transaction and ONE `transaction.failed` event per logical failed attempt. A
   * conflict with no committed COMPLETED row (a same-key claim still in flight — only possible if
   * the sibling later commits a POSTED success, which cannot happen once this side has business-
   * failed the identical request) defensively surfaces as {@link IdempotencyInProgressError}.
   * The whole block runs inside `runInTransactionWithRetry`, so a genuine deadlock retries; a
   * sentinel throw is NOT a deadlock, so it rolls the orphan back and is caught below.
   */
  private async recordFailureOutcome(
    params: IdempotencyParams,
    fingerprint: string,
    error: unknown,
    onFailure: IdempotencyFailureRecorder,
  ): Promise<IdempotencyOutcome | null> {
    try {
      return await runInTransactionWithRetry(this.dataSource, async (queryRunner) => {
        const failedTxId = await onFailure(queryRunner, error);
        if (!failedTxId) {
          // Validation/structural: nothing persisted. The empty tx commits harmlessly; execute
          // rethrows the original error and the key stays released (fully retryable).
          return null;
        }
        const won = await this.keys.completeFreshInTx(
          queryRunner,
          params.ownerId,
          params.key,
          fingerprint,
          failedTxId,
          new Date(Date.now() + KEY_TTL_MS),
        );
        if (won) {
          return { transactionId: failedTxId, replayed: false };
        }
        // Lost the race: a concurrent same-key caller already resolved the key. On the ON CONFLICT
        // block release, the winner's row is committed — re-read it and replay ITS terminal outcome
        // (rolling our orphan FAILED insert back via the throw), so exactly one FAILED survives.
        const existing = await this.keys.findByOwnerAndKeyInTx(
          queryRunner,
          params.ownerId,
          params.key,
        );
        if (existing?.status === IdempotencyStatus.Completed && existing.transactionId) {
          throw new FailureRaceResolved(existing.transactionId);
        }
        throw new FailureRaceInProgress();
      });
    } catch (raceError) {
      // The sentinels are thrown OUTSIDE-observable only here: the tx already rolled the orphan
      // FAILED insert back (a non-deadlock throw is not retried). Translate them into the terminal
      // outcome / transport error; any other error (a genuine fault) propagates.
      if (raceError instanceof FailureRaceResolved) {
        return { transactionId: raceError.transactionId, replayed: true };
      }
      if (raceError instanceof FailureRaceInProgress) {
        throw new IdempotencyInProgressError();
      }
      throw raceError;
    }
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
