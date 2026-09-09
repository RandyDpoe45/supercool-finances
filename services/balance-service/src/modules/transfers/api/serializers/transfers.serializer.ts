import { Transaction } from '../../../../database/entities/transaction.entity';
import { PendingAuthorizationDto } from '../dto/pending-authorization.dto';
import { TransferDto } from '../dto/transfer.dto';

/**
 * The anti-leak transport boundary for the transfers `/api` reads/writes: pure entity→DTO
 * serializers that list every output field EXPLICITLY and MUST NOT spread the entity —
 * internal columns (`initiatedBy`, `failureReason`, `failedAt`, `payeeId`,
 * `reversesTransactionId`, …) must never reach the wire. Adding a field is a deliberate act.
 *
 * An internal transfer is always a clean 2-leg pair, so `debitAccountId` (source) and
 * `creditAccountId` (destination) are always set on the entities these serializers receive.
 */

/** `postedAt` is `null` while PENDING; both timestamps render as ISO-8601 UTC instants. */
export function serializeTransfer(transfer: Transaction): TransferDto {
  return {
    id: transfer.id,
    type: transfer.type,
    status: transfer.status,
    amount: transfer.amount,
    currency: transfer.currency,
    sourceAccountId: transfer.debitAccountId ?? '',
    destinationAccountId: transfer.creditAccountId ?? '',
    createdAt: transfer.createdAt.toISOString(),
    postedAt: transfer.postedAt ? transfer.postedAt.toISOString() : null,
  };
}

export function serializePendingAuthorization(transfer: Transaction): PendingAuthorizationDto {
  return {
    transferId: transfer.id,
    type: transfer.type,
    amount: transfer.amount,
    currency: transfer.currency,
    sourceAccountId: transfer.debitAccountId ?? '',
    destinationAccountId: transfer.creditAccountId ?? '',
    createdAt: transfer.createdAt.toISOString(),
  };
}
