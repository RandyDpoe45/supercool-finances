import { DomainError } from '../../../common/errors/domain-error';

/**
 * Domain errors raised by the maker-checker approval service ({@link ApprovalService}). Plain,
 * framework-agnostic classes extending {@link DomainError}; each carries a stable `code` with NO
 * HTTP coupling — the status mapping lives in `common/errors/domain-error-status.ts`. Messages are
 * PII-light and safe to surface verbatim (no actor ids, account ids, or amounts).
 */

/** The reversal target is not reversible: it is not a POSTED internal transfer / POSTED
 * external_inbound credit, or (at execute time) it was already reversed. External outbound is NOT
 * admin-reversible — its reversal is the rail-failure callback path. A 409 (conflicts with the
 * transaction's current money state). */
export class TransactionNotReversibleError extends DomainError {
  readonly code = 'TRANSACTION_NOT_REVERSIBLE';

  constructor() {
    super('The transaction is not reversible in its current state');
  }
}

/** A reversal proposal already exists for this target (a PENDING or EXECUTED approval). The
 * guarded `POSTED → REVERSED` transition at execute time is the hard backstop; this is the
 * best-effort propose-time duplicate guard. A 409. */
export class ReversalAlreadyRequestedError extends DomainError {
  readonly code = 'REVERSAL_ALREADY_REQUESTED';

  constructor() {
    super('A reversal has already been requested for this transaction');
  }
}

/** The approval id does not exist. A 404. */
export class ApprovalNotFoundError extends DomainError {
  readonly code = 'APPROVAL_NOT_FOUND';

  constructor() {
    super('Approval request not found');
  }
}

/** The approval is not a PENDING reversal (already executed / rejected, or a concurrent checker
 * decided it first — the guarded transition affected 0 rows). A 409. */
export class ApprovalNotPendingError extends DomainError {
  readonly code = 'APPROVAL_NOT_PENDING';

  constructor() {
    super('The approval request is not pending');
  }
}

/** The maker of a reversal cannot approve or reject their own proposal (four-eyes). The DB CHECK
 * (`checker_id <> maker_id`) backstops this. A 403. */
export class SelfApprovalForbiddenError extends DomainError {
  readonly code = 'SELF_APPROVAL_FORBIDDEN';

  constructor() {
    super('The maker of a reversal cannot decide their own request');
  }
}
