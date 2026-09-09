/**
 * Spec 04 — Balance Service DOMAIN layer, Step 2: the `postTransaction` command guards.
 *
 * `PostingService.postTransaction` validates the command's STRUCTURAL / balancing invariants
 * BEFORE it touches the database (ADR-13 "step a: shape/balancing invariants, before any DB
 * work"). That gate is purely testable: `new PostingService(mockDataSource, ...mockRepos)`
 * with `jest.fn()` collaborators (DI decorators are inert under plain instantiation, same
 * shape as accounts.service.spec.ts), feed a malformed command, and assert BOTH that it
 * REJECTS with `InvalidPostingCommandError` AND that `dataSource.createQueryRunner` was NEVER
 * called — proving the reducer fails on validation before opening a transaction. A defect
 * that skipped a guard (or ran it AFTER opening the tx) fails one of the two assertions.
 *
 * No DB, no Nest container — runs in the DEFAULT `npm test`, never skipped. The service +
 * error class are resolved through the single harness seam (getPostingService /
 * getDomainErrors).
 *
 * NOTE: the "malformed minor-unit string" and "amount disagrees with the moved magnitude"
 * guards encode INTENDED behaviour agreed for this step; if the implementor has not yet
 * landed them, those two cases fail here (a red test with teeth), which is the point.
 */
import 'reflect-metadata';
import { getPostingService, getDomainErrors } from '../support/harness';

const PostingService = getPostingService();
const { InvalidPostingCommandError } = getDomainErrors();

if (!InvalidPostingCommandError) {
  throw new Error(
    '[unit] could not resolve InvalidPostingCommandError through the harness seam ' +
      '(getDomainErrors). If the implementor named/placed it differently, add it to ' +
      'tests/support/harness.ts:getDomainErrors — the single coordination point.',
  );
}

const A = 'acc-aaaaaaaa';
const B = 'acc-bbbbbbbb';
const C = 'acc-cccccccc';

/** A fully-valid internal transfer command (A −100 / B +100, sum 0, amount 100). Each test
 *  mutates a shallow copy to isolate exactly one broken invariant. */
function base(): any {
  return {
    type: 'internal',
    currency: 'MXN',
    amount: '100',
    legs: [
      { accountId: A, delta: '-100' },
      { accountId: B, delta: '100' },
    ],
    initiatedBy: 'sub-alice',
  };
}

function makeService() {
  // createQueryRunner is the tripwire: a command that fails validation must never reach it.
  const dataSource = { createQueryRunner: jest.fn() };
  const accounts = { lockByIdForUpdate: jest.fn(), updateBalanceInTx: jest.fn() };
  const ledger = { insertInTx: jest.fn() };
  const transactions = { insertInTx: jest.fn() };
  const outbox = { insertInTx: jest.fn() };
  const service = new PostingService(dataSource, accounts, ledger, transactions, outbox);
  return { service, dataSource };
}

describe('PostingService.postTransaction — command guards fail BEFORE any DB work', () => {
  it.each<[string, any]>([
    ['fewer than 2 legs', { ...base(), legs: [{ accountId: A, delta: '100' }] }],
    ['amount <= 0', { ...base(), amount: '0' }],
    [
      'duplicate account ids across legs',
      {
        ...base(),
        // A duplicated id would make the second balance-fold overwrite the first (money lost),
        // so distinctness is a money-safety guard, not cosmetics.
        legs: [
          { accountId: A, delta: '-100' },
          { accountId: A, delta: '100' },
        ],
      },
    ],
    [
      'a zero-delta leg',
      {
        ...base(),
        legs: [
          { accountId: A, delta: '-100' },
          { accountId: B, delta: '100' },
          { accountId: C, delta: '0' },
        ],
      },
    ],
    [
      'legs whose deltas do not sum to zero',
      {
        ...base(),
        legs: [
          { accountId: A, delta: '-100' },
          { accountId: B, delta: '150' },
        ],
      },
    ],
    // --- guards for INTENDED behaviour (may be red until the implementor lands them) ---
    [
      'a malformed minor-unit delta string',
      {
        ...base(),
        legs: [
          { accountId: A, delta: '1.5' },
          { accountId: B, delta: '-1.5' },
        ],
      },
    ],
    ['a malformed minor-unit amount string', { ...base(), amount: 'abc' }],
    [
      'an amount that disagrees with the legs moved magnitude',
      // legs move ±100 but amount claims 50 — the header amount must equal what actually moved,
      // or the emitted event / statement misreports the transfer size.
      { ...base(), amount: '50' },
    ],
  ])(
    'rejects %s with InvalidPostingCommandError and never opens a transaction',
    async (_label, command) => {
      const { service, dataSource } = makeService();

      await expect(service.postTransaction(command)).rejects.toBeInstanceOf(
        InvalidPostingCommandError,
      );
      expect(dataSource.createQueryRunner).not.toHaveBeenCalled();
    },
  );

  it('positive control: a well-formed command PASSES validation and reaches createQueryRunner', async () => {
    const { service, dataSource } = makeService();
    // Minimal DB stub: entering the tx path is enough to prove validation is the gate; let the
    // (irrelevant) failure that follows bubble — we assert only that the gate was passed.
    const qr = {
      connect: jest.fn().mockRejectedValue(new Error('stub: no real datasource')),
      startTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      isTransactionActive: false,
    };
    dataSource.createQueryRunner.mockReturnValue(qr);

    // It rejects (the stub connection fails) but crucially NOT on validation…
    await expect(service.postTransaction(base())).rejects.not.toBeInstanceOf(
      InvalidPostingCommandError,
    );
    // …because validation passed and the reducer proceeded to open the transaction.
    expect(dataSource.createQueryRunner).toHaveBeenCalledTimes(1);
    expect(qr.connect).toHaveBeenCalledTimes(1);
  });
});
