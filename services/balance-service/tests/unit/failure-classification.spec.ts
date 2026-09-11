/**
 * Spec 04 — Balance Service, FAILED-transaction persistence: the confirm-time failure-classification
 * gate `isBusinessFailure(error)`. This is the money-safety PREDICATE that decides which confirm-time
 * errors become a PERSISTED terminal FAILED transaction (+ a `transaction.failed` event) and which
 * propagate as a plain 4xx WITHOUT persisting anything. Getting it wrong either way is a real defect:
 *   - too PERMISSIVE (a validation/structural error mis-classified as business) mislabels a malformed
 *     request as a legitimate business rejection and manufactures a spurious FAILED record + event;
 *   - too STRICT (a genuine business rejection mis-classified) reverts to the old silent behavior
 *     (the transfer stuck PENDING / a hold stuck until TTL).
 *
 * The DB-backed proofs (failed-persistence.integration.spec.ts) drive the WHOLE confirm path, but the
 * taxonomy TRIPWIRE — confirming an already-terminal transfer throws TRANSFER_NOT_PENDING at the
 * pre-check, OUTSIDE the try/catch that consults this predicate — never actually exercises the
 * allowlist. So this pure unit test is where the predicate itself is pinned. Written FROM the
 * developer-locked taxonomy, NOT the implementation:
 *   - BUSINESS  → true : INSUFFICIENT_FUNDS, ACCOUNT_FROZEN, LIMIT_EXCEEDED, PAYEE_IN_COOLING_OFF.
 *   - STRUCTURAL→ false: INVALID_POSTING_COMMAND, ACCOUNT_NOT_FOUND, CURRENCY_MISMATCH,
 *                        TRANSFER_NOT_PENDING.
 *   - a DomainError with an UNLISTED code → false (only the allowlist is business).
 *   - a NON-DomainError carrying a matching `code` → false (the `instanceof DomainError` guard: a
 *     raw fault must never be persisted as a business failure).
 *
 * Pure — NO DB, NO Nest — so it runs in the DEFAULT `npm test`. The predicate + the DomainError base
 * + the concrete error classes are resolved through the harness (the single src seam).
 */
import { getIsBusinessFailure, getDomainErrorBase, getDomainErrors } from '../support/harness';

const isBusinessFailure = getIsBusinessFailure();
const DomainError = getDomainErrorBase();
const errs = getDomainErrors() as Record<string, any>;

/**
 * A concrete `DomainError` carrying an ARBITRARY caller-supplied `code`. It exercises the
 * predicate's exact logic — `instanceof DomainError` AND `code ∈ allowlist` — WITHOUT coupling to
 * any module's concrete error constructor, so the allowlist is pinned deterministically.
 */
class CodedDomainError extends DomainError {
  constructor(public readonly code: string) {
    super(`test error: ${code}`);
  }
}

const BUSINESS_CODES = [
  'INSUFFICIENT_FUNDS',
  'ACCOUNT_FROZEN',
  'LIMIT_EXCEEDED',
  'PAYEE_IN_COOLING_OFF',
] as const;

const STRUCTURAL_CODES = [
  'INVALID_POSTING_COMMAND',
  'ACCOUNT_NOT_FOUND',
  'CURRENCY_MISMATCH',
  'TRANSFER_NOT_PENDING',
] as const;

describe('isBusinessFailure — the confirm-time FAILED-persistence taxonomy gate (pure)', () => {
  it('a control DomainError instance IS an instanceof DomainError (harness wiring sanity)', () => {
    // Guards against a false pass where everything returns false for the wrong reason (a broken
    // DomainError resolution would make the `instanceof` guard reject even the real classes).
    expect(new CodedDomainError('INSUFFICIENT_FUNDS')).toBeInstanceOf(DomainError);
  });

  describe('BUSINESS domain codes → true (persist a terminal FAILED transaction)', () => {
    it.each(BUSINESS_CODES)('%s is a business failure', (code) => {
      expect(isBusinessFailure(new CodedDomainError(code))).toBe(true);
    });
  });

  describe('VALIDATION / STRUCTURAL domain codes → false (propagate, NO FAILED row)', () => {
    it.each(STRUCTURAL_CODES)('%s is NOT a business failure', (code) => {
      expect(isBusinessFailure(new CodedDomainError(code))).toBe(false);
    });
  });

  it('a DomainError with an UNLISTED code is NOT a business failure (only the allowlist is business)', () => {
    // The conservative default: anything not explicitly enumerated must NOT persist a FAILED row.
    expect(isBusinessFailure(new CodedDomainError('SOME_UNLISTED_CODE'))).toBe(false);
    expect(isBusinessFailure(new CodedDomainError('INTERNAL_ERROR'))).toBe(false);
    expect(isBusinessFailure(new CodedDomainError(''))).toBe(false);
  });

  it('a NON-DomainError carrying a matching `code` is NOT a business failure (the instanceof guard)', () => {
    // A genuine 500-class fault (or an impostor) with `code: 'INSUFFICIENT_FUNDS'` must never be
    // mistaken for a business rejection and persisted as FAILED.
    const impostor = Object.assign(new Error('boom'), { code: 'INSUFFICIENT_FUNDS' });
    expect(isBusinessFailure(impostor)).toBe(false);
    // Plain objects / primitives / nullish with a business code are likewise rejected.
    expect(isBusinessFailure({ code: 'INSUFFICIENT_FUNDS' })).toBe(false);
    expect(isBusinessFailure('INSUFFICIENT_FUNDS')).toBe(false);
    expect(isBusinessFailure(null)).toBe(false);
    expect(isBusinessFailure(undefined)).toBe(false);
  });

  // Cross-check against the REAL concrete error classes the confirm path actually throws: this
  // catches a code TYPO in a class OR in the allowlist that the synthetic-code cases above cannot
  // (those mint the code themselves, so they'd agree with a matching typo on both sides). Each case
  // is asserted only when its class resolves through the harness (all do today); an unresolved one
  // is skipped loudly rather than crashing.
  describe('the REAL confirm-time error classes classify by their own `.code`', () => {
    const realCases: Array<{ name: string; make: () => unknown; expected: boolean }> = [
      {
        name: 'InsufficientFundsError',
        make: () => new errs.InsufficientFundsError('acc-1'),
        expected: true,
      },
      {
        name: 'AccountFrozenError',
        make: () => new errs.AccountFrozenError('acc-1'),
        expected: true,
      },
      {
        name: 'LimitExceededError',
        make: () => new errs.LimitExceededError('per_transaction', 'acc-1'),
        expected: true,
      },
      {
        name: 'PayeeInCoolingOffError',
        make: () => new errs.PayeeInCoolingOffError(),
        expected: true,
      },
      {
        name: 'InvalidPostingCommandError',
        make: () => new errs.InvalidPostingCommandError('bad'),
        expected: false,
      },
      {
        name: 'AccountNotFoundError',
        make: () => new errs.AccountNotFoundError('acc-1'),
        expected: false,
      },
      {
        name: 'CurrencyMismatchError',
        make: () => new errs.CurrencyMismatchError('acc-1', 'MXN', 'USD'),
        expected: false,
      },
      {
        name: 'TransactionNotPendingError',
        make: () => new errs.TransactionNotPendingError('tx-1'),
        expected: false,
      },
    ];

    for (const c of realCases) {
      const resolved = typeof errs[c.name] === 'function';
      const run = resolved ? it : it.skip;
      run(`${c.name} → ${c.expected}`, () => {
        const error = c.make();
        // It really is a DomainError (so a `false` below can only come from the allowlist, not the
        // instanceof guard), and it classifies as the taxonomy dictates.
        expect(error).toBeInstanceOf(DomainError);
        expect(isBusinessFailure(error)).toBe(c.expected);
      });
    }
  });
});
