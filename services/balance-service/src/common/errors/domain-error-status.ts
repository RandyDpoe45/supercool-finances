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
  // Admin ops (step 8a): the `PUT /limits` body violated the scope/ownerId invariant.
  INVALID_LIMITS: HttpStatus.BAD_REQUEST,

  // Resource does not exist (or is not owned — indistinguishable, anti-IDOR).
  ACCOUNT_NOT_FOUND: HttpStatus.NOT_FOUND,
  TRANSFER_NOT_FOUND: HttpStatus.NOT_FOUND,
  PAYEE_NOT_FOUND: HttpStatus.NOT_FOUND,
  // Self-service account creation (spec 04): the caller has no `customer` row (FK precondition).
  CUSTOMER_NOT_FOUND: HttpStatus.NOT_FOUND,
  // External rail webhooks (step 5c): the settlement target / inbound destination is unknown.
  SETTLEMENT_TARGET_NOT_FOUND: HttpStatus.NOT_FOUND,
  INBOUND_DESTINATION_NOT_FOUND: HttpStatus.NOT_FOUND,

  // Semantically valid but unprocessable given the money state.
  CURRENCY_MISMATCH: HttpStatus.UNPROCESSABLE_ENTITY,
  INSUFFICIENT_FUNDS: HttpStatus.UNPROCESSABLE_ENTITY,
  LIMIT_EXCEEDED: HttpStatus.UNPROCESSABLE_ENTITY,
  // Self-service account creation (spec 04): the per-customer account cap (5) is reached.
  ACCOUNT_LIMIT_REACHED: HttpStatus.UNPROCESSABLE_ENTITY,

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
  PAYEE_IN_COOLING_OFF: HttpStatus.CONFLICT,
  // External rail webhooks (step 5c): the callback contradicts the transfer's current money state.
  INVALID_SETTLEMENT_STATE: HttpStatus.CONFLICT,
  // Admin ops (step 8a): freeze/unfreeze targeted a system/clearing account (not freezable).
  ACCOUNT_NOT_FREEZABLE: HttpStatus.CONFLICT,
  // Admin ops (step 8b): maker-checker reversals — the target/approval conflicts with current state.
  TRANSACTION_NOT_REVERSIBLE: HttpStatus.CONFLICT,
  REVERSAL_ALREADY_REQUESTED: HttpStatus.CONFLICT,
  APPROVAL_NOT_PENDING: HttpStatus.CONFLICT,

  // Resource does not exist — the maker-checker approval id is unknown.
  APPROVAL_NOT_FOUND: HttpStatus.NOT_FOUND,

  // The actor is not permitted to perform the action (maker-checker: a maker cannot self-approve).
  SELF_APPROVAL_FORBIDDEN: HttpStatus.FORBIDDEN,

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
