import {
  DestinationResolution,
  PendingAuthorizationView,
  TransferView,
} from '../../service/interfaces/transfers.service.interface';
import { PendingAuthorizationDto } from '../dto/pending-authorization.dto';
import { ResolveDestinationDto } from '../dto/resolve-destination.dto';
import { TransferDto } from '../dto/transfer.dto';

/**
 * The anti-leak transport boundary for the transfers `/api` reads/writes: pure view→DTO
 * serializers that list every output field EXPLICITLY and MUST NOT spread the entity/view —
 * internal columns (`initiatedBy`, `failureReason`, `failedAt`, `payeeId`,
 * `reversesTransactionId`, and the raw debit/credit account UUIDs) must never reach the wire.
 * Adding a field is a deliberate act.
 *
 * The service resolves the human account numbers (and the destination masked name) onto a view
 * model; these serializers whitelist that view — the raw entity/PII never crosses this boundary.
 */

/** `postedAt` is `null` while PENDING; both timestamps render as ISO-8601 UTC instants. */
export function serializeTransfer(view: TransferView): TransferDto {
  const { transaction } = view;
  return {
    id: transaction.id,
    type: transaction.type,
    status: transaction.status,
    amount: transaction.amount,
    currency: transaction.currency,
    sourceAccountNumber: view.sourceAccountNumber,
    destinationAccountNumber: view.destinationAccountNumber,
    createdAt: transaction.createdAt.toISOString(),
    postedAt: transaction.postedAt ? transaction.postedAt.toISOString() : null,
  };
}

export function serializePendingAuthorization(
  view: PendingAuthorizationView,
): PendingAuthorizationDto {
  const { transaction } = view;
  return {
    transferId: transaction.id,
    type: transaction.type,
    amount: transaction.amount,
    currency: transaction.currency,
    sourceAccountNumber: view.sourceAccountNumber,
    destinationAccountNumber: view.destinationAccountNumber,
    destinationMaskedName: view.destinationMaskedName,
    createdAt: transaction.createdAt.toISOString(),
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
