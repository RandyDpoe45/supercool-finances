import { DomainError } from '../../../common/errors/domain-error';

/**
 * Domain errors raised by the transfers service ({@link TransfersService}) — and, for the
 * guarded PENDING→POSTED transition, by the posting reducer. Plain, framework-agnostic classes
 * extending {@link DomainError}; each carries a stable `code`. Messages are PII-light and safe
 * to surface: they carry no user id, account id, or one-time code, so the global filter can
 * return them verbatim. NO HTTP coupling here — the code→status mapping lives in
 * `common/errors/domain-error-status.ts`.
 */

/** The transfer does not exist, or the caller does not own the account being debited. Both
 * collapse to the SAME error so a caller cannot probe which transfer ids exist by watching the
 * status (anti-IDOR, ADR-3): the message never reveals which case occurred. */
export class TransferNotFoundError extends DomainError {
  readonly code = 'TRANSFER_NOT_FOUND';

  constructor() {
    super('Transfer not found');
  }
}

/** A confirm targeted a transfer that is not in the PENDING state — it was already posted (or
 * otherwise transitioned), so the guarded transition affected 0 rows. Distinct from a
 * successful idempotent replay of an already-POSTED confirm, which returns the transfer. */
export class TransferNotPendingError extends DomainError {
  readonly code = 'TRANSFER_NOT_PENDING';

  constructor() {
    super('Transfer is not pending');
  }
}

/** The supplied one-time code did not match the caller's active code (a retryable wrong
 * guess). Carries no code and no attempt count — the caller re-requests via the OTP flow. */
export class InvalidOtpError extends DomainError {
  readonly code = 'INVALID_OTP';

  constructor() {
    super('The one-time code is invalid');
  }
}

/** The attempt allowance for the active one-time code was exhausted; the code was burned and
 * the caller must generate a fresh one before confirming again. */
export class OtpLockedOutError extends DomainError {
  readonly code = 'OTP_LOCKED_OUT';

  constructor() {
    super('Too many invalid attempts; request a new one-time code');
  }
}

/** The transfer request is malformed at the domain level — a rule the wire schema does not (or
 * cannot) enforce: source equals destination, a non-positive amount, a missing currency, or a
 * non-customer account. */
export class InvalidTransferError extends DomainError {
  readonly code = 'INVALID_TRANSFER';

  constructor(reason: string) {
    super(`Invalid transfer: ${reason}`);
  }
}

/** A confirm (or other access) targeted a PENDING transfer whose 2-minute `expires_at` has
 * lapsed: it is no longer valid and was lazily transitioned to EXPIRED (DB clock). Distinct from
 * TRANSFER_NOT_PENDING (which is an already-terminal / never-pending transfer) so the caller can
 * tell "you waited too long" from "not confirmable" — maps to 410 Gone. The OTP is NOT consumed
 * when this is raised. Carries no ids or code. */
export class TransferExpiredError extends DomainError {
  readonly code = 'TRANSFER_EXPIRED';

  constructor() {
    super('The transfer has expired');
  }
}

/** A same-initiator initiate raced another and collided on the single-pending unique index
 * (`uq_one_pending_per_initiator`, SQLSTATE 23505): a user may hold at most one PENDING transfer
 * awaiting authorization at a time. The loser retries after resolving the existing pending —
 * maps to 409 Conflict. Carries no ids. */
export class PendingTransferConflictError extends DomainError {
  readonly code = 'PENDING_TRANSFER_CONFLICT';

  constructor() {
    super('A pending transfer awaiting authorization already exists');
  }
}

/** Initiate was called without a valid confirmation-of-payee token for THIS destination: the
 * caller either never resolved the destination, the token expired, or the token was bound to a
 * different destination. A transfer can only be initiated after the payer resolved+confirmed the
 * exact destination — without that, the caller is just querying. Carries no ids or token. */
export class DestinationNotConfirmedError extends DomainError {
  readonly code = 'DESTINATION_NOT_CONFIRMED';

  constructor() {
    super('The destination has not been confirmed; resolve it before initiating a transfer');
  }
}
