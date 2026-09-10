import { Transaction } from '../../../../database/entities/transaction.entity';
import { RailAckDto } from '../dto/rail-ack.dto';

/**
 * The anti-leak transport boundary for the rail webhook acks: an explicit whitelist that lists
 * EVERY output field by hand and MUST NOT spread the entity. A rail webhook is an untrusted
 * third party, so nothing beyond a fixed `status` marker and the transaction id may cross this
 * boundary — no amounts, accounts, PII, or internal transfer columns. Adding a field is a
 * deliberate act.
 */
export function serializeRailAck(transaction: Transaction): RailAckDto {
  return {
    status: 'ok',
    transactionId: transaction.id,
  };
}
