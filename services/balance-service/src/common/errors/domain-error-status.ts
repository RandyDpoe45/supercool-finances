import { HttpStatus } from '@nestjs/common';

/**
 * The single source of truth mapping a {@link DomainError}'s stable `code` to its HTTP
 * status. The global {@link AllExceptionsFilter} consults this so the transport status is
 * decided in ONE place, not scattered across controllers, and the response `code` stays the
 * domain code itself (e.g. `INSUFFICIENT_FUNDS`) — never re-derived from the status.
 *
 * Every domain code a service surface can raise is 4xx (a broken business invariant is the
 * caller's fault, never a server fault), so a DomainError never reaches the filter's 5xx
 * generic-message path. An UNKNOWN code defaults to 400 (a client error) rather than 500 —
 * a missing entry must not masquerade as an internal fault.
 */
const DOMAIN_ERROR_STATUS: Readonly<Record<string, number>> = {
  // Malformed / invalid request shape.
  INVALID_POSTING_COMMAND: HttpStatus.BAD_REQUEST,
  INVALID_TRANSFER: HttpStatus.BAD_REQUEST,

  // Resource does not exist (or is not owned — indistinguishable, anti-IDOR).
  ACCOUNT_NOT_FOUND: HttpStatus.NOT_FOUND,
  TRANSFER_NOT_FOUND: HttpStatus.NOT_FOUND,

  // Semantically valid but unprocessable given the money state.
  CURRENCY_MISMATCH: HttpStatus.UNPROCESSABLE_ENTITY,
  INSUFFICIENT_FUNDS: HttpStatus.UNPROCESSABLE_ENTITY,

  // Conflict with current state / a concurrent or duplicate request.
  ACCOUNT_FROZEN: HttpStatus.CONFLICT,
  TRANSFER_NOT_PENDING: HttpStatus.CONFLICT,
  PENDING_TRANSFER_CONFLICT: HttpStatus.CONFLICT,
  SUSPECTED_DUPLICATE: HttpStatus.CONFLICT,
  IDEMPOTENCY_KEY_REUSED: HttpStatus.CONFLICT,
  IDEMPOTENCY_IN_PROGRESS: HttpStatus.CONFLICT,
  OTP_ALREADY_ACTIVE: HttpStatus.CONFLICT,
  DESTINATION_NOT_CONFIRMED: HttpStatus.CONFLICT,
  PAYEE_ALREADY_ENROLLED: HttpStatus.CONFLICT,

  // The resource was valid but is no longer available (a lapsed pending transfer).
  TRANSFER_EXPIRED: HttpStatus.GONE,

  // Second-factor failures.
  INVALID_OTP: HttpStatus.UNAUTHORIZED,
  OTP_LOCKED_OUT: HttpStatus.TOO_MANY_REQUESTS,
};

/** Resolve the HTTP status for a domain `code`; unknown codes default to 400 (client error). */
export function domainErrorHttpStatus(code: string): number {
  return DOMAIN_ERROR_STATUS[code] ?? HttpStatus.BAD_REQUEST;
}
