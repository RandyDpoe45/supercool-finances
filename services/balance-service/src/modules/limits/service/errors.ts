import { DomainError } from '../../../common/errors/domain-error';

/**
 * Domain errors raised by the limits service ({@link LimitsService}). Plain, framework-agnostic
 * classes extending {@link DomainError}; each carries a stable `code`. NO HTTP coupling here — the
 * code→status mapping lives in `common/errors/domain-error-status.ts`.
 */

/** The `PUT /limits` body violated the scope/ownerId invariant: a `global` row must NOT carry an
 * `ownerId`, and a `customer` override MUST carry one. Maps to 400 Bad Request. The message names
 * only the rule (no owner id echoed back). */
export class InvalidLimitsError extends DomainError {
  readonly code = 'INVALID_LIMITS';

  constructor(message: string) {
    super(message);
  }
}
