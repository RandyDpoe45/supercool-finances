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
  /** Read one transaction inside the caller's transaction, so it sees that tx's own
   * uncommitted writes (e.g. a just-applied status transition). MUST run inside the given
   * queryRunner's active transaction. */
  findByIdInTx(queryRunner: QueryRunner, id: string): Promise<Transaction | null>;
  /** The initiator's PENDING transfers, newest-first — the OTP app's pending-authorizations
   * feed. `initiated_by` equals the debit-account owner by construction at initiate. */
  findPendingByInitiator(initiatedBy: string): Promise<Transaction[]>;
  /** Guarded `PENDING → POSTED` transition inside the caller's transaction:
   * `UPDATE ... SET status = POSTED, posted_at = now() WHERE id = :id AND status = 'PENDING'`.
   * Returns `true` iff exactly one row was updated; `false` (0 rows) means the transfer was
   * already posted / is not pending. This single guarded write is the "money moves once"
   * gate behind a confirm. MUST run inside the given queryRunner's active transaction. */
  transitionToPostedInTx(queryRunner: QueryRunner, id: string): Promise<boolean>;
}
