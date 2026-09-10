import { Transaction } from '../../../../database/entities/transaction.entity';
import { AdminTransactionDto } from '../dto/admin-transaction.dto';

/**
 * The anti-leak transport boundary for the `/admin/transactions` list: an explicit whitelist that
 * lists every output field by hand and MUST NOT spread the entity. As an ADMIN view it deliberately
 * exposes both account legs, the initiator, and the internal transfer columns — but each is a
 * deliberate act, not an accident of shape. Timestamps render as ISO-8601 UTC instants (or null).
 */
export function serializeAdminTransaction(transaction: Transaction): AdminTransactionDto {
  return {
    id: transaction.id,
    type: transaction.type,
    status: transaction.status,
    amount: transaction.amount,
    currency: transaction.currency,
    debitAccountId: transaction.debitAccountId,
    creditAccountId: transaction.creditAccountId,
    payeeId: transaction.payeeId,
    reversesTransactionId: transaction.reversesTransactionId,
    initiatedBy: transaction.initiatedBy,
    failureReason: transaction.failureReason,
    createdAt: transaction.createdAt.toISOString(),
    postedAt: transaction.postedAt ? transaction.postedAt.toISOString() : null,
    failedAt: transaction.failedAt ? transaction.failedAt.toISOString() : null,
    expiresAt: transaction.expiresAt ? transaction.expiresAt.toISOString() : null,
  };
}
