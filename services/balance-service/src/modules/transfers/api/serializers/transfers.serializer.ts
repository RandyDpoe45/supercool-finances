import { Transaction } from '../../../../database/entities/transaction.entity';
import {
  DestinationResolution,
  PendingAuthorization,
} from '../../service/interfaces/transfers.service.interface';
import { PendingAuthorizationDto } from '../dto/pending-authorization.dto';
import { ResolveDestinationDto } from '../dto/resolve-destination.dto';
import { TransferDto } from '../dto/transfer.dto';

/**
 * The anti-leak transport boundary for the transfers `/api` reads/writes: pure serializers that
 * list every output field EXPLICITLY and MUST NOT spread the entity — internal columns
 * (`initiatedBy`, `failureReason`, `failedAt`, `payeeId`, `reversesTransactionId`, and the raw
 * CREDIT account UUID) must never reach the wire. The SOURCE (debit) account id IS exposed as
 * `sourceAccountId` — it is the caller's own account, exactly as `AccountDto.id` is shown to its
 * owner. Adding a field is a deliberate act.
 *
 * The write methods return the plain `Transaction` entity (the client already holds / supplied
 * the destination), so `serializeTransfer` whitelists the entity directly. Only the pending READ
 * carries a domain projection ({@link PendingAuthorization}) — the destination human account
 * number + masked holder name resolved in the service — because masking the raw name (PII) is a
 * service-owned rule the raw entity cannot carry.
 */

/** `postedAt` is `null` while PENDING; `expiresAt` is `null` on directly-posted movements. All
 * timestamps render as ISO-8601 UTC instants. Takes the ENTITY — never spread it. */
export function serializeTransfer(transaction: Transaction): TransferDto {
  return {
    id: transaction.id,
    type: transaction.type,
    status: transaction.status,
    amount: transaction.amount,
    currency: transaction.currency,
    sourceAccountId: transaction.debitAccountId,
    createdAt: transaction.createdAt.toISOString(),
    expiresAt: transaction.expiresAt ? transaction.expiresAt.toISOString() : null,
    postedAt: transaction.postedAt ? transaction.postedAt.toISOString() : null,
  };
}

export function serializePendingAuthorization(
  pending: PendingAuthorization,
): PendingAuthorizationDto {
  const { transaction } = pending;
  return {
    transferId: transaction.id,
    type: transaction.type,
    amount: transaction.amount,
    currency: transaction.currency,
    sourceAccountId: transaction.debitAccountId,
    destinationAccountNumber: pending.destinationAccountNumber,
    destinationMaskedName: pending.destinationMaskedName,
    payeeDisplayName: pending.payeeDisplayName,
    createdAt: transaction.createdAt.toISOString(),
    expiresAt: transaction.expiresAt ? transaction.expiresAt.toISOString() : null,
  };
}

/** The confirmation-of-payee result: the masked name, currency, and single-use token. */
export function serializeResolveDestination(
  resolution: DestinationResolution,
): ResolveDestinationDto {
  return {
    maskedName: resolution.maskedName,
    currency: resolution.currency,
    confirmationToken: resolution.confirmationToken,
  };
}
