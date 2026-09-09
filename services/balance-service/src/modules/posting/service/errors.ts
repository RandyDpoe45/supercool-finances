import { DomainError } from '../../../common/errors/domain-error';

/**
 * Domain errors raised by the posting reducer ({@link PostingService}). Plain,
 * framework-agnostic classes extending {@link DomainError}; each carries a stable `code`.
 * NO HTTP coupling here — the status mapping is added at the endpoint step.
 */

/** The command is malformed before any DB work — the balancing / shape invariants the
 * reducer requires do not hold (too few legs, non-zero sum, non-positive amount, a
 * zero-delta leg, duplicate account ids, missing currency). */
export class InvalidPostingCommandError extends DomainError {
  readonly code = 'INVALID_POSTING_COMMAND';

  constructor(reason: string) {
    super(`Invalid posting command: ${reason}`);
  }
}

/** A leg references an account that does not exist (checked under the row lock). */
export class AccountNotFoundError extends DomainError {
  readonly code = 'ACCOUNT_NOT_FOUND';

  constructor(readonly accountId: string) {
    super(`Account not found: ${accountId}`);
  }
}

/** A customer debit would drive `available (= balance − held)` negative — an overdraft. */
export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(readonly accountId: string) {
    super(`Insufficient funds on account ${accountId}`);
  }
}

/** A debit was attempted against a frozen customer account. */
export class AccountFrozenError extends DomainError {
  readonly code = 'ACCOUNT_FROZEN';

  constructor(readonly accountId: string) {
    super(`Account is frozen: ${accountId}`);
  }
}

/** The guarded `PENDING → POSTED` transition affected 0 rows: the header was already posted
 * (or otherwise not pending), so the reducer refuses to touch any balance — the "money moves
 * once" gate. The reducer OWNS this transition, so it owns the error. The `code` is
 * deliberately `'TRANSFER_NOT_PENDING'` (shared with the transfers service's own pre-check):
 * both mean the same thing to a caller and map to the same 409. */
export class TransactionNotPendingError extends DomainError {
  readonly code = 'TRANSFER_NOT_PENDING';

  constructor(readonly transactionId?: string) {
    super('Transaction is not in a pending state');
  }
}

/** A leg's account currency does not match the transaction currency. */
export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(
    readonly accountId: string,
    readonly accountCurrency: string,
    readonly transactionCurrency: string,
  ) {
    super(
      `Currency mismatch on account ${accountId}: account is ${accountCurrency}, ` +
        `transaction is ${transactionCurrency}`,
    );
  }
}
