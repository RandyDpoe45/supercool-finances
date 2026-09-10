/**
 * Spec 04 — Balance Service, STEP 8b: the reducer's `forced` bypass flag, driven as a PURE unit (no
 * DB, only a Nest TestingModule + mocked collaborators) so it runs in the DEFAULT `npm test`. Written
 * FROM the spec's "/admin Maker-checker" bullet + the developer-locked step-8b contract, NOT from the
 * implementor's code:
 *
 *   - A `PostTransactionCommand` carrying `forced: true` (set ONLY by an admin reversal) applies its
 *     CUSTOMER DEBIT leg WITHOUT the counterparty's overdraft + frozen checks — so the debit ALWAYS
 *     folds, and the account may go NEGATIVE (still a balanced double-entry: no money created/lost,
 *     authorized by four-eyes). Proven by: NO throw + `updateBalanceInTx` is called for that account
 *     with the arithmetic fold `balance + delta`, which is negative here.
 *   - The bypass is GUARDED by the flag: with `forced` FALSY the SAME command throws normally —
 *     `AccountFrozenError` on a frozen debit, `InsufficientFundsError` on an underfunded one — and
 *     posts NOTHING (no balance write, the tx rolls back). This is the control that proves `forced`
 *     did not simply delete the checks.
 *
 * The collaborators (DataSource, account/ledger/transaction/outbox/user-limits repos) are MOCKED, but
 * the LOGIC UNDER TEST (the frozen/funds gate, the `forced` bypass, the exact folded balance written)
 * is the reducer's OWN and is NOT mocked away. Injection is driven through a Nest TestingModule +
 * `useMocker` (matched by DI token), so the proof is INDEPENDENT of constructor arg order. Every
 * assertion gates on the OBSERVABLE contract (throw-or-not + the balance value written + whether the
 * tx committed), never on an internal call sequence. The AUTHORITATIVE money proof (a real REVERSED
 * transfer whose counterparty goes negative on Postgres, plus the no-leak control) lives in
 * tests/integration/reversals.integration.spec.ts; this unit pins the reducer branch a pure test
 * catches fast.
 *
 * NOTE: written ahead of / in parallel with the step-8b `forced` flag. Against a reducer that has not
 * yet landed the bypass these are RED (with teeth): a frozen/underfunded forced debit that STILL
 * throws fails the "no throw + negative fold" assertions.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getDataSourceToken } from '@nestjs/typeorm';

import { getPostingService, getRepositoryToken, getDomainErrors } from '../support/harness';

const PostingService = getPostingService();
const de: any = getDomainErrors();
const AccountFrozenError = de.AccountFrozenError;
const InsufficientFundsError = de.InsufficientFundsError;

const ACCOUNT_REPO_TOKEN = getRepositoryToken('ACCOUNT_REPOSITORY', 'account');
const LEDGER_REPO_TOKEN = getRepositoryToken('LEDGER_ENTRY_REPOSITORY', 'ledger-entry');
const TRANSACTION_REPO_TOKEN = getRepositoryToken('TRANSACTION_REPOSITORY', 'transaction');
const OUTBOX_REPO_TOKEN = getRepositoryToken('OUTBOX_EVENT_REPOSITORY', 'outbox-event');
const USER_LIMITS_REPO_TOKEN = getRepositoryToken('USER_LIMITS_REPOSITORY', 'user-limits');
const DS_TOKEN = (() => {
  try {
    return getDataSourceToken();
  } catch {
    return undefined;
  }
})();

function isDataSourceToken(token: any): boolean {
  if (token === DataSource) return true;
  if (DS_TOKEN && token === DS_TOKEN) return true;
  return typeof token === 'string' && /datasource|connection/i.test(token);
}

// The counterparty being force-debited (the beneficiary of the original transfer, who "spent the
// funds") — a CUSTOMER account. The credit leg is a benign SYSTEM account (exempt from funds/frozen),
// so the ONLY leg whose gate matters is the customer debit.
const CP = 'acc-counterparty';
const SYS = 'acc-system';
const OWNER = 'sub-beneficiary';
const MXN = 'MXN';

function customerAccount(overrides: Record<string, unknown> = {}): any {
  return {
    id: CP,
    ownerId: OWNER,
    kind: 'customer',
    systemKey: null,
    currency: MXN,
    status: 'active',
    balance: '1000',
    held: '0',
    spentToday: '0',
    spentTodayDate: '2026-09-10',
    spentMonth: '0',
    spentMonthDate: '2026-09-01',
    ...overrides,
  };
}

function systemAccount(overrides: Record<string, unknown> = {}): any {
  return {
    id: SYS,
    ownerId: null,
    kind: 'system',
    systemKey: 'clearing:test',
    currency: MXN,
    status: 'active',
    balance: '0',
    held: '0',
    spentToday: '0',
    spentTodayDate: '2026-09-10',
    spentMonth: '0',
    spentMonthDate: '2026-09-01',
    ...overrides,
  };
}

interface Mocks {
  accountRepo: any;
  ledgerRepo: any;
  transactionRepo: any;
  outboxRepo: any;
  userLimitsRepo: any;
  dataSource: any;
  queryRunner: any;
  cp: any;
}

function makeMocks(cp: any): Mocks {
  const sys = systemAccount();
  const queryRunner: any = {
    isTransactionActive: true,
    connect: jest.fn(async () => undefined),
    startTransaction: jest.fn(async () => undefined),
    commitTransaction: jest.fn(async () => undefined),
    rollbackTransaction: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    query: jest.fn(async () => []),
    manager: {},
  };

  const accountRepo = {
    lockByIdForUpdate: jest.fn(async (_qr: any, id: string) =>
      id === cp.id ? cp : id === sys.id ? sys : null,
    ),
    updateBalanceInTx: jest.fn(async () => undefined),
    updateHeldInTx: jest.fn(async () => undefined),
    currentSpendWindowInTx: jest.fn(async () => ({
      today: '2026-09-10',
      monthStart: '2026-09-01',
    })),
    updateSpendCountersInTx: jest.fn(async () => undefined),
  };
  const ledgerRepo = { insertInTx: jest.fn(async () => ({ id: 'ledger-1' })) };
  const transactionRepo = {
    insertInTx: jest.fn(async (_qr: any, data: any) => ({
      id: 'tx-comp',
      status: 'POSTED',
      ...data,
    })),
    transitionToPostedInTx: jest.fn(async () => true),
    findByIdInTx: jest.fn(async () => ({ id: 'tx-comp', status: 'POSTED' })),
  };
  const outboxRepo = { insertInTx: jest.fn(async () => ({ id: 'outbox-1' })) };
  const userLimitsRepo = { resolveInTx: jest.fn(async () => null) };
  const dataSource = { createQueryRunner: jest.fn(() => queryRunner) };

  return {
    accountRepo,
    ledgerRepo,
    transactionRepo,
    outboxRepo,
    userLimitsRepo,
    dataSource,
    queryRunner,
    cp,
  };
}

async function setup(cp: any): Promise<{ service: any; mocks: Mocks }> {
  const mocks = makeMocks(cp);
  const moduleRef = await Test.createTestingModule({ providers: [PostingService] })
    .useMocker((token) => {
      if (token === ACCOUNT_REPO_TOKEN) return mocks.accountRepo;
      if (token === LEDGER_REPO_TOKEN) return mocks.ledgerRepo;
      if (token === TRANSACTION_REPO_TOKEN) return mocks.transactionRepo;
      if (token === OUTBOX_REPO_TOKEN) return mocks.outboxRepo;
      if (token === USER_LIMITS_REPO_TOKEN) return mocks.userLimitsRepo;
      if (isDataSourceToken(token)) return mocks.dataSource;
      return {};
    })
    .compile();
  const service = moduleRef.get(PostingService, { strict: false });
  return { service, mocks };
}

/** A compensating-reversal-shaped command: debit the counterparty CP by `amount`, credit the system
 *  account. `reversesTransactionId` mirrors what a real reversal carries; `forced` toggles the bypass.
 *  NO `limitAccountId` — a reversal never counts against the spend counters. */
function reversalCommand(amount: number, forced: boolean): any {
  return {
    type: 'internal',
    currency: MXN,
    amount: String(amount),
    legs: [
      { accountId: CP, delta: String(-amount) },
      { accountId: SYS, delta: String(amount) },
    ],
    initiatedBy: 'admin-checker',
    reversesTransactionId: 'orig-tx-1',
    ...(forced ? { forced: true } : {}),
  };
}

async function capture(p: Promise<any>): Promise<{ ok: boolean; value?: any; error?: any }> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

/** The `newBalance` written for a specific account (the 3rd arg of updateBalanceInTx(qr, id, bal)),
 *  or `undefined` if the account was never written. */
function balanceWrittenFor(mocks: Mocks, accountId: string): string | undefined {
  const call = mocks.accountRepo.updateBalanceInTx.mock.calls.find(
    (c: any[]) => c[1] === accountId,
  );
  return call ? String(call[2]) : undefined;
}

describe('PostingService — the `forced` bypass (admin reversal FORCED debit; spec 04 step 8b)', () => {
  it('forced debit of a FROZEN + underfunded customer folds to a NEGATIVE balance WITHOUT throwing (no frozen/overdraft block), and commits', async () => {
    // The beneficiary is frozen AND has already spent most of the funds (balance 1000 < the 4000
    // reversal). A NORMAL debit would hit BOTH the frozen and the overdraft gate.
    const cp = customerAccount({ status: 'frozen', balance: '1000', held: '0' });
    const { service, mocks } = await setup(cp);

    const res = await capture(service.postTransaction(reversalCommand(4000, true)));

    // The FORCED admin correction always executes — no ACCOUNT_FROZEN / INSUFFICIENT_FUNDS throw.
    expect(res.ok).toBe(true);

    // The counterparty's balance is folded to balance + delta = 1000 + (-4000) = -3000 (NEGATIVE):
    // money-safety, this is the double-entry debit landing, not a silent skip.
    const cpBalance = balanceWrittenFor(mocks, CP);
    expect(cpBalance).toBe('-3000');
    expect(BigInt(cpBalance as string) < 0n).toBe(true);

    // The mirrored credit leg still folds (the system account gains +4000): a balanced double-entry.
    expect(balanceWrittenFor(mocks, SYS)).toBe('4000');

    // A reversal never touches the spend counters (no limitAccountId on the command).
    expect(mocks.accountRepo.updateSpendCountersInTx).not.toHaveBeenCalled();

    // It posted (committed), not rolled back.
    expect(mocks.queryRunner.commitTransaction).toHaveBeenCalled();
    expect(mocks.queryRunner.rollbackTransaction).not.toHaveBeenCalled();
  });

  it('forced debit of an ACTIVE but underfunded customer folds NEGATIVE without an overdraft throw', async () => {
    const cp = customerAccount({ status: 'active', balance: '1000', held: '0' });
    const { service, mocks } = await setup(cp);

    const res = await capture(service.postTransaction(reversalCommand(4000, true)));

    expect(res.ok).toBe(true);
    expect(balanceWrittenFor(mocks, CP)).toBe('-3000'); // 1000 − 4000
    expect(mocks.queryRunner.commitTransaction).toHaveBeenCalled();
  });

  // ---- Controls: with `forced` FALSY the same command is blocked and posts nothing ----

  it('CONTROL: the SAME debit WITHOUT forced against a FROZEN account throws ACCOUNT_FROZEN and writes no balance', async () => {
    // Funded (balance 10000) so the ONLY blocker is the freeze — proving the frozen gate is what
    // `forced` bypasses (not merely the funds gate).
    const cp = customerAccount({ status: 'frozen', balance: '10000', held: '0' });
    const { service, mocks } = await setup(cp);

    const res = await capture(service.postTransaction(reversalCommand(4000, false)));

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('ACCOUNT_FROZEN');
    if (AccountFrozenError) expect(res.error).toBeInstanceOf(AccountFrozenError);
    // No money moved: the counterparty balance was never written and the tx rolled back.
    expect(balanceWrittenFor(mocks, CP)).toBeUndefined();
    expect(mocks.queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(mocks.queryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  it('CONTROL: the SAME debit WITHOUT forced against an ACTIVE underfunded account throws INSUFFICIENT_FUNDS and posts nothing', async () => {
    const cp = customerAccount({ status: 'active', balance: '1000', held: '0' });
    const { service, mocks } = await setup(cp);

    const res = await capture(service.postTransaction(reversalCommand(4000, false)));

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('INSUFFICIENT_FUNDS');
    if (InsufficientFundsError) expect(res.error).toBeInstanceOf(InsufficientFundsError);
    expect(balanceWrittenFor(mocks, CP)).toBeUndefined();
    expect(mocks.queryRunner.commitTransaction).not.toHaveBeenCalled();
  });
});
