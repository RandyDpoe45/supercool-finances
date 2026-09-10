import { Transaction } from '../../../../database/entities/transaction.entity';
import { SimulatedInboundDto } from '../dto/simulated-inbound.dto';

/**
 * The anti-leak transport boundary for the `/admin/external/inbound` response: an explicit
 * whitelist that lists every output field by hand and MUST NOT spread the entity. Adding a field
 * is a deliberate act. Timestamps render as ISO-8601 UTC instants (`postedAt` null only if the
 * movement were somehow unposted — an inbound credit posts immediately).
 */
export function serializeSimulatedInbound(transaction: Transaction): SimulatedInboundDto {
  return {
    transactionId: transaction.id,
    type: transaction.type,
    status: transaction.status,
    amount: transaction.amount,
    currency: transaction.currency,
    creditAccountId: transaction.creditAccountId,
    createdAt: transaction.createdAt.toISOString(),
    postedAt: transaction.postedAt ? transaction.postedAt.toISOString() : null,
  };
}
