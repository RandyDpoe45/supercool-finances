import { QueryRunner } from 'typeorm';
import { Transaction } from '../../../../database/entities/transaction.entity';
import { PostTransactionCommand } from './post-transaction.command';

/** DI token for {@link IPostingService}. Consumers depend on the interface via this token,
 * never the concrete reducer class. */
export const POSTING_SERVICE = Symbol('POSTING_SERVICE');

/** The single balance-mutating operation all money movement funnels through (ADR-13). */
export interface IPostingService {
  /**
   * Apply a fresh balancing money movement atomically: opens its OWN transaction (deadlock-
   * retried), INSERTS a new POSTED transaction header, then folds the legs into balances +
   * the ledger and emits one outbox row. Returns the posted header.
   */
  postTransaction(command: PostTransactionCommand): Promise<Transaction>;

  /**
   * Post an ALREADY-PENDING transfer, running INSIDE the caller's transaction (no new tx) —
   * the confirm-time half of the two-phase internal-transfer lifecycle. Locks the affected
   * accounts, runs the same per-leg checks (currency / frozen / insufficient-funds — the
   * confirm-time funds check under the lock), then does a guarded `PENDING → POSTED`
   * transition on the EXISTING header (never a new insert). If the transition affects 0 rows
   * (already posted / not pending) it throws {@link TransactionNotPendingError} before any
   * balance mutation. Otherwise it folds the legs into balances + the ledger and emits one
   * outbox row, all against `transactionId`, and returns the posted header.
   *
   * Re-run-safe under {@link runInTransactionWithRetry}: a deadlock rolls the whole tx back
   * (including the transition), so a retry re-locks, re-reads, and re-transitions from PENDING.
   */
  postPendingInTx(
    queryRunner: QueryRunner,
    transactionId: string,
    command: PostTransactionCommand,
  ): Promise<Transaction>;
}
