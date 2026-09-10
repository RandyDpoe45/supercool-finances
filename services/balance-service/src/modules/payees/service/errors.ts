import { DomainError } from '../../../common/errors/domain-error';

/**
 * Domain errors raised by the payees service ({@link PayeesService}). Plain, framework-agnostic
 * classes extending {@link DomainError}; each carries a stable `code`. Messages are PII-light and
 * safe to surface verbatim (no owner id, no destination ref). NO HTTP coupling here — the
 * code→status mapping lives in `common/errors/domain-error-status.ts`.
 */

/** The caller already enrolled a payee for this destination on the (constant) outbound rail: the
 * `(owner_id, rail, destination_ref)` insert collided on the `uq_payee` unique index (SQLSTATE
 * 23505). With a single constant rail this is effectively one enrollment per external account per
 * customer. Maps to 409 Conflict. Carries no owner id or destination ref. */
export class PayeeAlreadyEnrolledError extends DomainError {
  readonly code = 'PAYEE_ALREADY_ENROLLED';

  constructor() {
    super('A payee for this destination is already enrolled');
  }
}
