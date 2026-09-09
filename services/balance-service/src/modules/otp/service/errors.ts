import { DomainError } from '../../../common/errors/domain-error';

/**
 * Domain errors raised by the OTP service ({@link OtpService}). Plain, framework-agnostic
 * classes extending {@link DomainError}; each carries a stable `code`. NO HTTP coupling here —
 * the status mapping is added at the endpoint step (4b).
 */

/** A second code was requested while one is still active (singleton gate). Message is kept
 * PII-light — it carries no user id or code. */
export class OtpAlreadyActiveError extends DomainError {
  readonly code = 'OTP_ALREADY_ACTIVE';

  constructor() {
    super('An active one-time code already exists for this user');
  }
}
