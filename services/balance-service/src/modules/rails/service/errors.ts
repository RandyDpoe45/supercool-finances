import { DomainError } from '../../../common/errors/domain-error';

/**
 * Domain errors raised by the rails webhook service ({@link RailsService}). Plain,
 * framework-agnostic classes extending {@link DomainError}; each carries a stable `code` with
 * NO HTTP coupling — the status mapping lives in `common/errors/domain-error-status.ts`.
 */

/** The outbound settlement callback referenced a transaction id that does not exist — the rail
 * correlated on an id we never issued. A 404. */
export class SettlementTargetNotFoundError extends DomainError {
  readonly code = 'SETTLEMENT_TARGET_NOT_FOUND';

  constructor(readonly transactionId: string) {
    super(`Settlement target transaction not found: ${transactionId}`);
  }
}

/** The settlement callback cannot be applied given the transfer's current state: the target is
 * not an external outbound, or the requested outcome contradicts an already-recorded one (a
 * SUCCESS for an already-reversed transfer, or a FAILURE for an already-reconciled success).
 * A 409 — the callback is well-formed but conflicts with the money state. */
export class InvalidSettlementStateError extends DomainError {
  readonly code = 'INVALID_SETTLEMENT_STATE';

  constructor(reason: string) {
    super(`Invalid settlement state: ${reason}`);
  }
}

/** The inbound credit could not resolve its destination to a customer account by account
 * number (missing, or a non-customer/system account). A 404 — the credit cannot be applied. */
export class InboundDestinationNotFoundError extends DomainError {
  readonly code = 'INBOUND_DESTINATION_NOT_FOUND';

  constructor() {
    super('Inbound destination account not found');
  }
}
