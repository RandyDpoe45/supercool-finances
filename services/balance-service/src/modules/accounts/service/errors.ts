import { DomainError } from '../../../common/errors/domain-error';

/**
 * Domain errors raised by the accounts service ({@link AccountsService}). Plain, framework-agnostic
 * classes extending {@link DomainError}; each carries a stable `code`. NO HTTP coupling here — the
 * code→status mapping lives in `common/errors/domain-error-status.ts`.
 */

/** The freeze/unfreeze target does not exist. Reuses the shared `ACCOUNT_NOT_FOUND` code (→ 404),
 * the same way the transfers pre-check and the posting reducer share `TRANSFER_NOT_PENDING`. */
export class AccountNotFoundError extends DomainError {
  readonly code = 'ACCOUNT_NOT_FOUND';

  constructor(accountId: string) {
    super(`Account ${accountId} not found`);
  }
}

/** The freeze/unfreeze target is a system/clearing account, not a customer account. Freezing is a
 * customer-account control only (a clearing account is internal plumbing — its debits/credits are
 * the rails machinery, never a customer's), so the request is rejected. Maps to 409 Conflict. */
export class AccountNotFreezableError extends DomainError {
  readonly code = 'ACCOUNT_NOT_FREEZABLE';

  constructor(accountId: string) {
    super(`Account ${accountId} is a system account and cannot be frozen`);
  }
}
