import { DeepPartial, QueryRunner } from 'typeorm';
import { Transaction } from '../../entities/transaction.entity';

/** DI token for {@link ITransactionRepository}. */
export const TRANSACTION_REPOSITORY = Symbol('TRANSACTION_REPOSITORY');

/** Persistence port for {@link Transaction}. */
export interface ITransactionRepository {
  findById(id: string): Promise<Transaction | null>;
  create(data: DeepPartial<Transaction>): Promise<Transaction>;
  /** Insert the transaction header inside the given queryRunner's transaction (the posting
   * reducer's single tx). Returns the inserted row with any DB-generated columns filled. */
  insertInTx(queryRunner: QueryRunner, data: DeepPartial<Transaction>): Promise<Transaction>;
  /** Insert a PENDING transfer header inside the caller's transaction, stamping `expires_at`
   * FROM THE DB CLOCK (`now() + interval '2 minutes'`) — never the app clock — so the 2-minute
   * deadline is authoritative and monotonic with `created_at`. Returns the inserted row (re-read
   * within the tx). A same-initiator collision on `uq_one_pending_per_initiator` surfaces as a
   * 23505 the caller maps to a conflict. MUST run inside the given queryRunner's active tx. */
  insertPendingInTx(queryRunner: QueryRunner, data: DeepPartial<Transaction>): Promise<Transaction>;
  /** Read one transaction inside the caller's transaction, so it sees that tx's own
   * uncommitted writes (e.g. a just-applied status transition). MUST run inside the given
   * queryRunner's active transaction. */
  findByIdInTx(queryRunner: QueryRunner, id: string): Promise<Transaction | null>;
  /** The initiator's single active PENDING transfer (newest-first, defensively `take 1` — the
   * `uq_one_pending_per_initiator` partial index guarantees at most one), or `null`. Backs the
   * OTP app's pending-authorization feed; `initiated_by` equals the debit-account owner by
   * construction at initiate. */
  findPendingByInitiator(initiatedBy: string): Promise<Transaction | null>;
  /** Guarded `PENDING → POSTED` transition inside the caller's transaction:
   * `UPDATE ... SET status = POSTED, posted_at = now() WHERE id = :id AND status = 'PENDING'`.
   * Returns `true` iff exactly one row was updated; `false` (0 rows) means the transfer was
   * already posted / is not pending. This single guarded write is the "money moves once"
   * gate behind a confirm. MUST run inside the given queryRunner's active transaction. */
  transitionToPostedInTx(queryRunner: QueryRunner, id: string): Promise<boolean>;
  /** Lazy-expiry sweep for ALL of an initiator's overdue PENDING transfers, inside the caller's
   * transaction: `UPDATE ... SET status = EXPIRED, failed_at = now() WHERE initiated_by = :id AND
   * status = 'PENDING' AND expires_at IS NOT NULL AND expires_at <= now()`. The DB clock (`now()`)
   * is the single source of truth. Runs BEFORE the supersede step at initiate. */
  expireOverduePendingByInitiator(queryRunner: QueryRunner, initiatedBy: string): Promise<void>;
  /** Auto-supersede any remaining ACTIVE (non-overdue) PENDING transfer for an initiator, inside
   * the caller's transaction: `UPDATE ... SET status = CANCELLED, failure_reason = 'superseded',
   * failed_at = now() WHERE initiated_by = :id AND status = 'PENDING'`. Runs AFTER the expire
   * step at initiate, so only non-overdue actives remain to be cancelled. */
  supersedeActivePendingByInitiator(queryRunner: QueryRunner, initiatedBy: string): Promise<void>;
  /** Guarded lazy expiry of ONE overdue PENDING transfer (single atomic statement on the plain
   * repo): `UPDATE ... SET status = EXPIRED, failed_at = now() WHERE id = :id AND status =
   * 'PENDING' AND expires_at IS NOT NULL AND expires_at <= now()`. Returns `true` iff it flipped
   * the row (it WAS overdue). Used by confirm / read to expire a specific id via the DB clock. */
  expireIfOverdue(id: string): Promise<boolean>;
  /** Guarded explicit cancel of ONE pending transfer (single atomic statement on the plain repo):
   * `UPDATE ... SET status = CANCELLED, failure_reason = 'cancelled_by_user', failed_at = now()
   * WHERE id = :id AND status = 'PENDING'`. Returns `true` iff it flipped the row; `false` means
   * it was already terminal (concurrently posted / expired / cancelled). Terminal rows are
   * retained, never deleted. */
  transitionToCancelled(id: string): Promise<boolean>;
}
