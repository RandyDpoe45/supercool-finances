import { DomainError } from './domain-error';

/**
 * The single, centralized taxonomy deciding whether a confirm-time domain error is a BUSINESS
 * failure that must be PERSISTED as a terminal FAILED transaction (+ a `transaction.failed`
 * event) or a VALIDATION/STRUCTURAL error that MUST propagate WITHOUT a FAILED row.
 *
 * - **BUSINESS → persist FAILED** — a WELL-FORMED request the business rejects under the lock:
 *   `INSUFFICIENT_FUNDS`, `ACCOUNT_FROZEN`, `LIMIT_EXCEEDED`, and (external path) a payee that is
 *   not active / still in cooling-off (`PAYEE_IN_COOLING_OFF`). These are the states a user could
 *   legitimately hit at confirm (e.g. funds dropped between initiate and confirm), so the transfer
 *   becomes a terminal FAILED with a recorded reason.
 * - **VALIDATION/STRUCTURAL → propagate, NO FAILED row** — the request itself is malformed or
 *   impossible: `INVALID_POSTING_COMMAND`, `ACCOUNT_NOT_FOUND`, `CURRENCY_MISMATCH`,
 *   `TRANSFER_NOT_PENDING`. Persisting a FAILED transaction for these would mislabel a bad request
 *   as a business rejection, so they keep today's behavior (4xx, nothing persisted).
 *
 * Classification is by the stable domain `code`, not the concrete class, so it stays correct
 * across the two modules that raise these at confirm (the posting reducer and the transfers
 * service). Anything NOT in the business set — an unlisted domain code, or a raw non-DomainError
 * (a genuine 500-class fault) — is treated as NON-business and never writes a FAILED row: the
 * conservative default is to persist ONLY an explicitly-classified business failure.
 */
const BUSINESS_FAILURE_CODES: ReadonlySet<string> = new Set<string>([
  'INSUFFICIENT_FUNDS',
  'ACCOUNT_FROZEN',
  'LIMIT_EXCEEDED',
  'PAYEE_IN_COOLING_OFF',
]);

/**
 * True iff `error` is a {@link DomainError} whose `code` is a BUSINESS-rule failure that must be
 * persisted as a terminal FAILED transaction. A non-DomainError, or a DomainError with a
 * validation/structural `code`, is NOT a business failure (propagate without a FAILED row).
 */
export function isBusinessFailure(error: unknown): error is DomainError {
  return error instanceof DomainError && BUSINESS_FAILURE_CODES.has(error.code);
}
