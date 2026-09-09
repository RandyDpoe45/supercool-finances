import { DeepPartial, QueryRunner } from 'typeorm';
import { Transaction } from '../entities/transaction.entity';

/** DI token for {@link ITransactionRepository}. */
export const TRANSACTION_REPOSITORY = Symbol('TRANSACTION_REPOSITORY');

/** Persistence port for {@link Transaction}. Status-transition helpers and
 * by-debit-account history are deferred to the domain step. */
export interface ITransactionRepository {
  findById(id: string): Promise<Transaction | null>;
  create(data: DeepPartial<Transaction>): Promise<Transaction>;
  /** Insert the transaction header inside the given queryRunner's transaction (the posting
   * reducer's single tx). Returns the inserted row with any DB-generated columns filled. */
  insertInTx(queryRunner: QueryRunner, data: DeepPartial<Transaction>): Promise<Transaction>;
}
