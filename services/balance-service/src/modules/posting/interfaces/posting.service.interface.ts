import { Transaction } from '../../../database/entities/transaction.entity';
import { PostTransactionCommand } from '../post-transaction.command';

/** DI token for {@link IPostingService}. Consumers depend on the interface via this token,
 * never the concrete reducer class. */
export const POSTING_SERVICE = Symbol('POSTING_SERVICE');

/** The single balance-mutating operation all money movement funnels through (ADR-13). */
export interface IPostingService {
  postTransaction(command: PostTransactionCommand): Promise<Transaction>;
}
