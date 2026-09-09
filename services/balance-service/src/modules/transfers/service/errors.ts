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
