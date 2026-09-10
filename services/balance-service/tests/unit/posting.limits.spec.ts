/**
 * Spec 04 — Balance Service, STEP 7: LIMITS ENFORCEMENT in the posting reducer, driven as a PURE
 * unit (no DB, no Nest infra beyond a TestingModule) so it runs in the DEFAULT `npm test`. Written
 * FROM the spec's "Limits" module bullet + the developer-locked contract, NOT from the implementor's
 * code:
 *
 *   - A movement opts into limit enforcement by setting `command.limitAccountId` to the CUSTOMER
 *     debit-leg id. Under that account's `FOR UPDATE` lock the reducer resolves the caps
 *     (`IUserLimitsRepository.resolveInTx(qr, ownerId, currency)`), lazily resets the fixed windows
 *     off the DB clock (`IAccountRepository.currentSpendWindowInTx(qr) → {today, monthStart}`;
 *     a `spent_*_date` before the boundary zeroes its counter), checks the caps in the order
 *     per-transaction → daily → monthly, and — only if none is breached — increments the counters
 *     via `IAccountRepository.updateSpendCountersInTx(qr, accountId, spentToday, spentTodayDate,
 *     spentMonth, spentMonthDate)`.
 *   - A breach throws `LimitExceededError` (code `LIMIT_EXCEEDED`, `cap` naming which limit); the
 *     counters are NOT advanced and the transaction is rolled back (money-safety: no post).
 *   - A NULL cap field is uncapped for that dimension. The boundary is `<=` (a spend landing exactly
 *     ON the cap succeeds).
 *   - Command guards: a `limitAccountId` that is not a leg, or names a CREDIT leg, is rejected
 *     BEFORE any DB work (`InvalidPostingCommandError`, no transaction opened); one naming a
 *     NON-CUSTOMER account is rejected (`InvalidPostingCommandError`) with no counter advance.
 *
 * The collaborators (the DataSource, the account/ledger/transaction/outbox/user-limits repos) are
 * MOCKED — but the LOGIC UNDER TEST (the reset arithmetic, the per-tx/daily/monthly comparison, the
 * throw-vs-increment decision, the exact counter values written) is the reducer's OWN and is NOT
 * mocked away. Injection is driven through a Nest TestingModule + `useMocker` (matched by DI token),
 * so the proof is INDEPENDENT of constructor arg ORDER — the step-7 addition of the user-limits
 * dependency needs no test edit. Every assertion gates on the OBSERVABLE contract (throw + `cap`, the
 * args to `updateSpendCountersInTx`, whether the tx committed), never on an internal call sequence.
 *
 * NOTE: written ahead of / in parallel with the step-7 implementation, so against a reducer that has
 * not yet landed limit enforcement these are RED (with teeth): a reducer that ignores `limitAccountId`
 * neither throws on a breach nor calls `updateSpendCountersInTx`, failing the assertions below.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getDataSourceToken } from '@nestjs/typeorm';

import { getPostingService, getRepositoryToken, getDomainErrors } from '../support/harness';

const PostingService = getPostingService();
const de: any = getDomainErrors();
const LimitExceededError = de.LimitExceededError;
const InvalidPostingCommandError = de.InvalidPostingCommandError;

if (!InvalidPostingCommandError) {
  throw new Error(
    '[unit] could not resolve InvalidPostingCommandError through the harness seam (getDomainErrors).',
  );
}

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

const SRC = 'acc-src';
const DST = 'acc-sys'; // a SYSTEM credit leg (exempt from funds/frozen/limits) — keeps the credit benign
const OWNER = 'sub-owner-1';
const MXN = 'MXN';

interface State {
  /** ResolvedLimits shape (camelCase, minor-unit strings or null). */
  limits: {
    perTransactionMax: string | null;
    dailyMax: string | null;
    monthlyMax: string | null;
  } | null;
  /** currentSpendWindowInTx return. */
  window: { today: string; monthStart: string };
  /** The locked debit (customer) account row — carries the four spend counters. */
  src: any;
  /** The locked credit (system) account row. */
  dst: any;
}

interface Mocks {
  accountRepo: any;
  ledgerRepo: any;
  transactionRepo: any;
  outboxRepo: any;
  userLimitsRepo: any;
  dataSource: any;
  queryRunner: any;
  state: State;
}

function customerAccount(overrides: Record<string, unknown> = {}): any {
  return {
    id: SRC,
    ownerId: OWNER,
    kind: 'customer',
    systemKey: null,
    currency: MXN,
    status: 'active',
    balance: '1000000000', // ample funds so the overdraft check never gates the limit proof
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
    id: DST,
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

function makeMocks(state: State): Mocks {
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
      id === state.src.id ? state.src : id === state.dst.id ? state.dst : null,
    ),
    updateBalanceInTx: jest.fn(async () => undefined),
    updateHeldInTx: jest.fn(async () => undefined),
    currentSpendWindowInTx: jest.fn(async () => state.window),
    updateSpendCountersInTx: jest.fn(async () => undefined),
  };

  const ledgerRepo = { insertInTx: jest.fn(async () => ({ id: 'ledger-1' })) };
  const transactionRepo = {
    insertInTx: jest.fn(async (_qr: any, data: any) => ({
      id: data?.id ?? 'tx-1',
      status: 'POSTED',
      ...data,
    })),
    transitionToPostedInTx: jest.fn(async () => true),
    findByIdInTx: jest.fn(async () => ({ id: 'tx-1', status: 'POSTED' })),
  };
  const outboxRepo = { insertInTx: jest.fn(async () => ({ id: 'outbox-1' })) };
  const userLimitsRepo = { resolveInTx: jest.fn(async () => state.limits) };

  const dataSource = { createQueryRunner: jest.fn(() => queryRunner) };

  return {
    accountRepo,
    ledgerRepo,
    transactionRepo,
    outboxRepo,
    userLimitsRepo,
    dataSource,
    queryRunner,
    state,
  };
}

async function setup(state: State): Promise<{ service: any; mocks: Mocks }> {
  const mocks = makeMocks(state);
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

/** A limit-bearing internal command: customer SRC debited `amount`, system DST credited, with
 *  `limitAccountId = SRC` opting SRC into limit enforcement. */
function limitCommand(amount: number, overrides: Record<string, unknown> = {}): any {
  return {
    type: 'internal',
    currency: MXN,
    amount: String(amount),
    legs: [
      { accountId: SRC, delta: String(-amount) },
      { accountId: DST, delta: String(amount) },
    ],
    initiatedBy: OWNER,
    limitAccountId: SRC,
    ...overrides,
  };
}

function defaultState(overrides: Partial<State> = {}): State {
  return {
    limits: { perTransactionMax: '100000000', dailyMax: '100000000', monthlyMax: '100000000' },
    window: { today: '2026-09-10', monthStart: '2026-09-01' },
    src: customerAccount(),
    dst: systemAccount(),
    ...overrides,
  };
}

async function capture(p: Promise<any>): Promise<{ ok: boolean; value?: any; error?: any }> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

function expectLimitExceeded(error: any, cap: string): void {
  expect(error).toBeDefined();
  expect(error?.code).toBe('LIMIT_EXCEEDED');
  expect(error?.cap).toBe(cap);
  if (LimitExceededError) expect(error).toBeInstanceOf(LimitExceededError);
}

/** The single spy every "no post" proof gates on: the counter was NOT advanced and the tx did NOT
 *  commit (it rolled back) — the reducer refused to move money. */
function expectNoPost(mocks: Mocks): void {
  expect(mocks.accountRepo.updateSpendCountersInTx).not.toHaveBeenCalled();
  expect(mocks.queryRunner.commitTransaction).not.toHaveBeenCalled();
  expect(mocks.queryRunner.rollbackTransaction).toHaveBeenCalled();
}

/** The (qr, accountId, spentToday, spentTodayDate, spentMonth, spentMonthDate) args of the ONE
 *  counter write. */
function counterArgs(mocks: Mocks): {
  accountId: string;
  spentToday: string;
  spentTodayDate: string;
  spentMonth: string;
  spentMonthDate: string;
} {
  expect(mocks.accountRepo.updateSpendCountersInTx).toHaveBeenCalledTimes(1);
  const c = mocks.accountRepo.updateSpendCountersInTx.mock.calls[0];
  return {
    accountId: c[1],
    spentToday: String(c[2]),
    spentTodayDate: String(c[3]),
    spentMonth: String(c[4]),
    spentMonthDate: String(c[5]),
  };
}

// ---------------------------------------------------------------------------------------------
// Under-cap: increments the counters (window advanced), commits
// ---------------------------------------------------------------------------------------------

describe('PostingService limits — under the cap: increments the fixed-window counters and posts', () => {
  it('increments spent_today/spent_month by the amount and writes the current window dates', async () => {
    const state = defaultState({
      limits: { perTransactionMax: '100000', dailyMax: '100000', monthlyMax: '100000' },
      src: customerAccount({ spentToday: '4000', spentMonth: '7000' }),
    });
    const { service, mocks } = await setup(state);

    const res = await capture(service.postTransaction(limitCommand(6000)));
    expect(res.ok).toBe(true);

    const args = counterArgs(mocks);
    expect(args.accountId).toBe(SRC);
    expect(args.spentToday).toBe('10000'); // 4000 + 6000
    expect(args.spentMonth).toBe('13000'); // 7000 + 6000
    expect(args.spentTodayDate).toBe('2026-09-10'); // the DB-clock window boundary
    expect(args.spentMonthDate).toBe('2026-09-01');
    expect(mocks.queryRunner.commitTransaction).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// Per-transaction cap
// ---------------------------------------------------------------------------------------------

describe('PostingService limits — per-transaction cap', () => {
  it('rejects an amount ABOVE per_transaction_max with LimitExceededError(per_transaction); no counter advance, no commit', async () => {
    const state = defaultState({
      limits: { perTransactionMax: '5000', dailyMax: '100000000', monthlyMax: '100000000' },
    });
    const { service, mocks } = await setup(state);

    const res = await capture(service.postTransaction(limitCommand(5001)));

    expect(res.ok).toBe(false);
    expectLimitExceeded(res.error, 'per_transaction');
    expectNoPost(mocks);
  });

  it('allows an amount EXACTLY at per_transaction_max (boundary is <=, not <)', async () => {
    const state = defaultState({
      limits: { perTransactionMax: '5000', dailyMax: '100000000', monthlyMax: '100000000' },
    });
    const { service, mocks } = await setup(state);

    const res = await capture(service.postTransaction(limitCommand(5000)));

    expect(res.ok).toBe(true);
    expect(counterArgs(mocks).spentToday).toBe('5000');
  });
});

// ---------------------------------------------------------------------------------------------
// Daily cap (fixed-window accumulation)
// ---------------------------------------------------------------------------------------------

describe('PostingService limits — daily cap', () => {
  it('allows a spend landing EXACTLY on daily_max and records spent_today == the cap', async () => {
    const state = defaultState({
      limits: { perTransactionMax: '100000000', dailyMax: '10000', monthlyMax: '100000000' },
      src: customerAccount({ spentToday: '9999' }),
    });
    const { service, mocks } = await setup(state);

    const res = await capture(service.postTransaction(limitCommand(1))); // 9999 + 1 == 10000
    expect(res.ok).toBe(true);
    expect(counterArgs(mocks).spentToday).toBe('10000');
  });

  it('rejects the spend that would push spent_today ONE over daily_max with LimitExceededError(daily)', async () => {
    const state = defaultState({
      limits: { perTransactionMax: '100000000', dailyMax: '10000', monthlyMax: '100000000' },
      src: customerAccount({ spentToday: '9999' }),
    });
    const { service, mocks } = await setup(state);

    const res = await capture(service.postTransaction(limitCommand(2))); // 9999 + 2 == 10001 > 10000
    expect(res.ok).toBe(false);
    expectLimitExceeded(res.error, 'daily');
    expectNoPost(mocks);
  });
});

// ---------------------------------------------------------------------------------------------
// Monthly cap
// ---------------------------------------------------------------------------------------------

describe('PostingService limits — monthly cap', () => {
  it('allows a spend landing EXACTLY on monthly_max and records spent_month == the cap', async () => {
    const state = defaultState({
      limits: { perTransactionMax: '100000000', dailyMax: '100000000', monthlyMax: '20000' },
      src: customerAccount({ spentMonth: '15000' }),
    });
    const { service, mocks } = await setup(state);

    const res = await capture(service.postTransaction(limitCommand(5000))); // 15000 + 5000 == 20000
    expect(res.ok).toBe(true);
    expect(counterArgs(mocks).spentMonth).toBe('20000');
  });

  it('rejects the spend that would push spent_month over monthly_max with LimitExceededError(monthly)', async () => {
    const state = defaultState({
      limits: { perTransactionMax: '100000000', dailyMax: '100000000', monthlyMax: '20000' },
      src: customerAccount({ spentMonth: '15000' }),
    });
    const { service, mocks } = await setup(state);

    const res = await capture(service.postTransaction(limitCommand(5001))); // 20001 > 20000
    expect(res.ok).toBe(false);
    expectLimitExceeded(res.error, 'monthly');
    expectNoPost(mocks);
  });
});

// ---------------------------------------------------------------------------------------------
// Check ORDER: per-transaction, then daily, then monthly
// ---------------------------------------------------------------------------------------------

describe('PostingService limits — the caps are checked per-transaction → daily → monthly', () => {
  it('reports per_transaction when BOTH the per-transaction AND daily caps would be breached', async () => {
    const state = defaultState({
      limits: { perTransactionMax: '5000', dailyMax: '5000', monthlyMax: '100000000' },
      src: customerAccount({ spentToday: '4000' }),
    });
    const { service } = await setup(state);
    // 6000 > 5000 (per-tx) AND 4000 + 6000 = 10000 > 5000 (daily). Per-tx is checked first.
    const res = await capture(service.postTransaction(limitCommand(6000)));
    expect(res.ok).toBe(false);
    expectLimitExceeded(res.error, 'per_transaction');
  });

  it('reports daily when the daily AND monthly caps would both be breached (per-tx is fine)', async () => {
    const state = defaultState({
      limits: { perTransactionMax: '100000000', dailyMax: '5000', monthlyMax: '5000' },
      src: customerAccount({ spentToday: '4000', spentMonth: '4000' }),
    });
    const { service } = await setup(state);
    // 3000 <= per-tx; 4000 + 3000 = 7000 > 5000 daily AND > 5000 monthly. Daily is checked first.
    const res = await capture(service.postTransaction(limitCommand(3000)));
    expect(res.ok).toBe(false);
    expectLimitExceeded(res.error, 'daily');
  });
});

// ---------------------------------------------------------------------------------------------
// Lazy window reset off the DB clock (the stale-date proof)
// ---------------------------------------------------------------------------------------------

describe('PostingService limits — lazy fixed-window reset (DB-clock UTC boundary)', () => {
  it('DAY rollover: a spent_today_date before today zeroes spent_today BEFORE the add (no stale carry-over)', async () => {
    const state = defaultState({
      limits: { perTransactionMax: '100000000', dailyMax: '10000', monthlyMax: '100000000' },
      window: { today: '2026-09-10', monthStart: '2026-09-01' },
      // A large stale spent_today from a PRIOR day. Without a reset, 9000 + 5000 = 14000 > 10000
      // would (wrongly) throw daily — so a green result here proves the zero-then-add reset.
      src: customerAccount({ spentToday: '9000', spentTodayDate: '2026-09-09' }),
    });
    const { service, mocks } = await setup(state);

    const res = await capture(service.postTransaction(limitCommand(5000)));
    expect(res.ok).toBe(true);
    const args = counterArgs(mocks);
    expect(args.spentToday).toBe('5000'); // reset to 0, then + 5000 (NOT 9000 + 5000)
    expect(args.spentTodayDate).toBe('2026-09-10'); // stamped with the current window date
  });

  it('MONTH rollover: a spent_month_date before the current month-start zeroes spent_month before the add', async () => {
    const state = defaultState({
      limits: { perTransactionMax: '100000000', dailyMax: '100000000', monthlyMax: '100000' },
      window: { today: '2026-09-10', monthStart: '2026-09-01' },
      src: customerAccount({
        spentMonth: '90000',
        spentMonthDate: '2026-08-01', // a prior month → stale
        spentToday: '0',
        spentTodayDate: '2026-09-10',
      }),
    });
    const { service, mocks } = await setup(state);

    const res = await capture(service.postTransaction(limitCommand(50000)));
    expect(res.ok).toBe(true);
    const args = counterArgs(mocks);
    expect(args.spentMonth).toBe('50000'); // reset to 0, then + 50000 (NOT 90000 + 50000)
    expect(args.spentMonthDate).toBe('2026-09-01');
  });
});

// ---------------------------------------------------------------------------------------------
// NULL cap field == uncapped for that dimension
// ---------------------------------------------------------------------------------------------

describe('PostingService limits — a NULL cap field is uncapped', () => {
  it('does NOT enforce per_transaction when perTransactionMax is null (only the set caps govern)', async () => {
    const state = defaultState({
      // per-tx uncapped; daily generous → a very large single spend is allowed.
      limits: { perTransactionMax: null, dailyMax: '100000000', monthlyMax: '100000000' },
    });
    const { service, mocks } = await setup(state);

    const res = await capture(service.postTransaction(limitCommand(50000000)));
    expect(res.ok).toBe(true);
    expect(counterArgs(mocks).spentToday).toBe('50000000');
  });

  it('does NOT throw when resolveInTx returns null (no global, no customer row → wholly uncapped)', async () => {
    const state = defaultState({ limits: null });
    const { service } = await setup(state);

    const res = await capture(service.postTransaction(limitCommand(999999999)));
    expect(res.ok).toBe(true); // uncapped ⇒ never LIMIT_EXCEEDED
  });
});

// ---------------------------------------------------------------------------------------------
// Command guards on limitAccountId
// ---------------------------------------------------------------------------------------------

describe('PostingService limits — limitAccountId validation (a malformed directive posts NOTHING)', () => {
  // These gate on the SPEC contract — the directive is rejected as InvalidPostingCommandError and NO
  // money moves (the counter never advances, the tx never commits) — NOT on WHERE the check runs
  // (the spec does not pin pre-DB vs under-lock; a defect that silently posted despite a bad
  // directive still fails `commitTransaction not called`).
  it('rejects a limitAccountId that is not one of the legs with InvalidPostingCommandError; posts nothing', async () => {
    const { service, mocks } = await setup(defaultState());

    const res = await capture(
      service.postTransaction(limitCommand(1000, { limitAccountId: 'acc-not-a-leg' })),
    );

    expect(res.ok).toBe(false);
    expect(res.error).toBeInstanceOf(InvalidPostingCommandError);
    expectNoPost(mocks); // counter not advanced, tx rolled back — never posted
  });

  it('rejects a limitAccountId that names the CREDIT leg (a credit is not a spend) with InvalidPostingCommandError; posts nothing', async () => {
    const { service, mocks } = await setup(defaultState());

    // DST is the +amount (credit) leg — limits count debits (outbound spend), never credits.
    const res = await capture(service.postTransaction(limitCommand(1000, { limitAccountId: DST })));

    expect(res.ok).toBe(false);
    expect(res.error).toBeInstanceOf(InvalidPostingCommandError);
    expectNoPost(mocks);
  });

  it('rejects a limitAccountId that resolves to a NON-CUSTOMER (system) account with InvalidPostingCommandError; posts nothing', async () => {
    // The debit leg is a SYSTEM account, and limitAccountId points at it. System accounts have no
    // owner spend to count, so opting one into limit enforcement is a programming error.
    const systemDebit = systemAccount({ id: SRC });
    const customerCredit = customerAccount({ id: DST });
    const state = defaultState({ src: systemDebit, dst: customerCredit });
    const { service, mocks } = await setup(state);

    const res = await capture(service.postTransaction(limitCommand(1000, { limitAccountId: SRC })));

    expect(res.ok).toBe(false);
    expect(res.error).toBeInstanceOf(InvalidPostingCommandError);
    expectNoPost(mocks);
  });
});
