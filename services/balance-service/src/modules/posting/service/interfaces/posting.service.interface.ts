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

  /**
   * Post a FRESH balancing movement INSIDE the caller's transaction (no new tx) — the
   * in-transaction sibling of {@link postTransaction}. Symmetric to {@link postPendingInTx}
   * except the header step INSERTS a new POSTED header (a fresh `randomUUID` id) rather than
   * transitioning an existing one. Locks the affected accounts (canonical ascending id order),
   * runs the same per-leg checks (currency / frozen / insufficient-funds), inserts the POSTED
   * header, folds the legs into balances + the ledger, and emits one outbox row — all against
   * the caller's queryRunner. Returns the posted header.
   *
   * Used by the rail settlement/inbound webhooks to post a fresh movement (a compensating
   * reversal, or an inbound credit) WITHIN an already-open, source-locked transaction — so the
   * customer lock is acquired BEFORE this reducer's canonical locking reaches the clearing
   * account (the source-before-clearing invariant, docs/domain.md). Re-run-safe under
   * {@link runInTransactionWithRetry}: a deadlock rolls the whole tx back and retries; the
   * caller re-generates its id-stable closure and re-runs.
   */
  postFreshInTx(queryRunner: QueryRunner, command: PostTransactionCommand): Promise<Transaction>;
}
