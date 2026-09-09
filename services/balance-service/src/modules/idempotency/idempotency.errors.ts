import { DomainError } from '../../common/errors/domain-error';

/**
 * Domain errors raised by {@link IdempotencyService}. Plain, framework-agnostic classes
 * extending {@link DomainError}; each carries a stable `code`. NO HTTP coupling — the status
 * mapping is added at the endpoint step (transfers, step 4).
 */

/** A semantically identical transfer (same owner + request fingerprint) was seen within the
 * soft-duplicate window under a DIFFERENT key. A SOFT block: the caller may retry with
 * `confirmDuplicate` to proceed (repeating an identical payment is legitimately valid). */
export class SuspectedDuplicateError extends DomainError {
  readonly code = 'SUSPECTED_DUPLICATE';

  constructor() {
    super(
      'A semantically identical transfer was seen within the last 60 seconds; ' +
        'confirm the duplicate to proceed',
    );
  }
}

/** The idempotency key was already used with DIFFERENT request parameters (fingerprint
 * mismatch) — key misuse, not a legitimate retry. */
export class IdempotencyKeyReuseError extends DomainError {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';

  constructor() {
    super('Idempotency key was already used with different request parameters');
  }
}

/** A request with this idempotency key is still in progress. Defensive: in the single-tx
 * design a concurrent caller blocks on the claim row lock until commit (→ completed) or
 * rollback (→ gone), so a committed `in_progress` is never externally observable. */
export class IdempotencyInProgressError extends DomainError {
  readonly code = 'IDEMPOTENCY_IN_PROGRESS';

  constructor() {
    super('A request with this idempotency key is already in progress');
  }
}
