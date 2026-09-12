/**
 * Spec 04 — Balance Service DOMAIN layer, Step 1: the AccountsService owner-scope guard.
 *
 * Security invariant (anti-IDOR, fail-closed): an empty/blank `ownerId` must NEVER reach a
 * repository. If it did, the `owner_id` predicate could be dropped and another user's rows
 * returned. The GatewayIdentityGuard makes an empty owner unreachable in production, but
 * this guard keeps the anti-IDOR predicate structurally impossible to lose under a future
 * refactor — so it deserves direct coverage.
 *
 * Pure unit test: `new AccountsService(mockAccountRepo, mockLedgerRepo)` with `jest.fn()`
 * repos (DI decorators are inert under plain instantiation), driven through the public
 * reads. No DB, no Nest container — runs in the DEFAULT `npm test`, never skipped. The
 * assertions are strictly observable behaviour: the call REJECTS (a 500-class internal
 * fault, not a 4xx) AND the repo was NOT touched (fails closed BEFORE any query) — plus a
 * positive control proving a real ownerId is the gate, not that everything throws.
 */
import 'reflect-metadata';
import { InternalServerErrorException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getDataSourceToken } from '@nestjs/typeorm';
import {
  getAccountsService,
  getAccountsServiceToken,
  getAuditServiceToken,
  getAuditLogRepositoryToken,
  getCustomerRepositoryToken,
  getDomainErrors,
  getRepositoryToken,
} from '../support/harness';

const AccountsService = getAccountsService();

const SOME_UUID = '11111111-1111-1111-1111-111111111111';

function makeService() {
  const accounts = {
    findByOwner: jest.fn(),
    findByIdAndOwner: jest.fn(),
  };
  const ledger = {
    findByAccount: jest.fn(),
  };
  const service = new AccountsService(accounts, ledger);
  return { service, accounts, ledger };
}

describe('AccountsService owner-scope guard — fails closed before any query (anti-IDOR)', () => {
  describe('listOwnedAccounts', () => {
    it.each([
      ['empty', ''],
      ['blank', '   '],
    ])('rejects a %s ownerId without ever calling the account repo', async (_label, ownerId) => {
      const { service, accounts } = makeService();

      await expect(service.listOwnedAccounts(ownerId)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      // The whole point: the guard trips BEFORE the query, so no unscoped read can leak.
      expect(accounts.findByOwner).not.toHaveBeenCalled();
    });

    it('positive control: a real ownerId passes the guard and queries the owner-scoped repo', async () => {
      const { service, accounts } = makeService();
      const rows = [{ id: 'a1' }];
      accounts.findByOwner.mockResolvedValue(rows);

      await expect(service.listOwnedAccounts('sub-alice')).resolves.toBe(rows);
      expect(accounts.findByOwner).toHaveBeenCalledTimes(1);
      expect(accounts.findByOwner).toHaveBeenCalledWith('sub-alice');
    });
  });

  describe('getAccountStatement', () => {
    it.each([
      ['empty', ''],
      ['blank', '   '],
    ])('rejects a %s ownerId without touching either repo', async (_label, ownerId) => {
      const { service, accounts, ledger } = makeService();

      await expect(service.getAccountStatement(SOME_UUID, ownerId)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
      expect(accounts.findByIdAndOwner).not.toHaveBeenCalled();
      expect(ledger.findByAccount).not.toHaveBeenCalled();
    });

    it('positive control: a real ownerId passes the guard and runs the owner-scoped lookup', async () => {
      const { service, accounts, ledger } = makeService();
      const account = { id: 'acc-1' };
      accounts.findByIdAndOwner.mockResolvedValue(account);
      ledger.findByAccount.mockResolvedValue([]);

      const res = await service.getAccountStatement('acc-1', 'sub-alice');

      // Ownership is verified on the account itself (both id AND owner), then the ledger
      // is read for that account under a bounded limit.
      expect(accounts.findByIdAndOwner).toHaveBeenCalledWith('acc-1', 'sub-alice');
      expect(ledger.findByAccount).toHaveBeenCalledTimes(1);
      expect(ledger.findByAccount.mock.calls[0][0]).toBe('acc-1');
      expect(typeof ledger.findByAccount.mock.calls[0][1]).toBe('number'); // bounded page limit
      expect(res.account).toBe(account);
    });
  });
});

/**
 * Spec 04 — Customer self-service account creation: `AccountsService.createAccount(ownerId, {label})`.
 *
 * Written FROM the developer-locked contract, NOT the implementation. The MONEY-SAFETY headline: a
 * self-service create NEVER seeds funds — the persisted account is minted at balance '0' / held '0'
 * (all spend counters '0'), owner-scoped to the caller (never a body field), and it writes NO audit /
 * ledger row (a create moves no money). The per-owner cap and the missing-customer precondition are
 * checked INSIDE the locked create critical section; only an account-number unique collision is
 * retried — every other error propagates on the first attempt.
 *
 * The collaborators (account/customer repos, audit service, DataSource) are MOCKED, but the
 * ORCHESTRATION under test (lock → customer-exists → cap-count → insert, all under ONE queryRunner;
 * which errors retry vs. propagate) is the service's own and is NOT mocked away. Injection is driven
 * through a Nest TestingModule + `useMocker` matched BY TOKEN (resolved through the harness seam), so
 * the proof is INDEPENDENT of constructor arg order. The service opens its tx through the PRODUCTION
 * transaction wrapper against the MOCKED DataSource (createQueryRunner → an in-memory fake runner),
 * so the "one tx" and "whole-tx retry" bindings are proven WITHOUT the test knowing the wrapper's
 * internals.
 */
describe('AccountsService.createAccount — money-safe mint, cap, retry (spec 04)', () => {
  const OWNER = 'sub-owner-create';
  const LABEL = 'My Savings';

  // The per-customer cap is spec-locked at 5 ("A customer may hold at most 5 customer accounts").
  const CAP = 5;

  interface Mocks {
    accountRepo: any;
    ledgerRepo: any;
    customerRepo: any;
    audit: any;
    dataSource: any;
    qr: any;
  }

  function makeMocks(): Mocks {
    const fakeManager = {
      query: jest.fn(async () => []),
      save: jest.fn(async (e: any) => e),
      getRepository: jest.fn(() => ({ save: jest.fn(async (e: any) => e) })),
    };
    const qr: any = {
      manager: fakeManager,
      isTransactionActive: true,
      connect: jest.fn(async () => undefined),
      startTransaction: jest.fn(async () => undefined),
      commitTransaction: jest.fn(async () => undefined),
      rollbackTransaction: jest.fn(async () => undefined),
      release: jest.fn(async () => undefined),
      query: jest.fn(async () => []),
    };

    const accountRepo = {
      lockOwnerForAccountCreation: jest.fn(async () => undefined),
      countCustomerAccountsByOwner: jest.fn(async () => 0),
      currentSpendWindowInTx: jest.fn(async () => ({
        today: '2026-09-12',
        monthStart: '2026-09-01',
      })),
      // Echo the insert payload back as the persisted entity (a DB-generated id + the fields written).
      createInTx: jest.fn(async (_qr: any, data: any) => ({ id: 'acc-created-uuid', ...data })),
      // Read seams other AccountsService methods use — present so the mock is a faithful repo.
      findByOwner: jest.fn(async () => []),
      findByIdAndOwner: jest.fn(async () => null),
    };
    const ledgerRepo = { findByAccount: jest.fn(async () => []) };
    const customerRepo = {
      existsByIdInTx: jest.fn(async () => true),
      findById: jest.fn(async () => ({ id: OWNER })),
    };
    const audit = {
      recordInTx: jest.fn(async () => undefined),
      record: jest.fn(async () => undefined),
    };

    const dataSource = { createQueryRunner: jest.fn(() => qr) };

    return { accountRepo, ledgerRepo, customerRepo, audit, dataSource, qr };
  }

  const ACCOUNTS_TOKEN = getAccountsServiceToken();
  const ACCOUNT_REPO_TOKEN = getRepositoryToken('ACCOUNT_REPOSITORY', 'account');
  const LEDGER_REPO_TOKEN = getRepositoryToken('LEDGER_ENTRY_REPOSITORY', 'ledger-entry');
  const AUDIT_TOKEN = getAuditServiceToken();
  const AUDIT_REPO_TOKEN = getAuditLogRepositoryToken();
  const CUSTOMER_REPO_TOKEN = getCustomerRepositoryToken();
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

  function autoMock(): any {
    const cache = new Map<PropertyKey, any>();
    const target: any = () => undefined;
    return new Proxy(target, {
      get(_t, prop) {
        if (prop === 'then') return undefined;
        if (!cache.has(prop)) cache.set(prop, jest.fn());
        return cache.get(prop);
      },
      apply: () => undefined,
    });
  }

  async function setup(): Promise<{ service: any; mocks: Mocks }> {
    const mocks = makeMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [{ provide: ACCOUNTS_TOKEN, useClass: AccountsService }],
    })
      .useMocker((token) => {
        if (token === ACCOUNT_REPO_TOKEN) return mocks.accountRepo;
        if (token === LEDGER_REPO_TOKEN) return mocks.ledgerRepo;
        if (token === CUSTOMER_REPO_TOKEN) return mocks.customerRepo;
        if (token === AUDIT_TOKEN) return mocks.audit;
        if (token === AUDIT_REPO_TOKEN) return mocks.audit;
        if (isDataSourceToken(token)) return mocks.dataSource;
        return autoMock();
      })
      .compile();
    const service = moduleRef.get(ACCOUNTS_TOKEN, { strict: false });
    return { service, mocks };
  }

  async function capture(p: Promise<any>): Promise<{ ok: boolean; value?: any; error?: any }> {
    try {
      return { ok: true, value: await p };
    } catch (error) {
      return { ok: false, error };
    }
  }

  /** A Postgres unique-violation shaped like TypeORM's QueryFailedError (code + constraint on the
   * error and on driverError — the create's helper checks both). */
  function uniqueViolation(constraint: string): Error {
    const err: any = new Error(`duplicate key value violates unique constraint "${constraint}"`);
    err.code = '23505';
    err.constraint = constraint;
    err.driverError = { code: '23505', constraint };
    return err;
  }

  it('MONEY-SAFETY: mints at balance/held/counters all "0", owner=caller, kind=customer, MXN/active, and writes NO audit/ledger row', async () => {
    const { service, mocks } = await setup();

    const res = await capture(service.createAccount(OWNER, { label: LABEL }));
    expect(res.ok).toBe(true);

    // Exactly ONE insert, and it is the money-safe mint.
    expect(mocks.accountRepo.createInTx).toHaveBeenCalledTimes(1);
    const insertCall = mocks.accountRepo.createInTx.mock.calls[0];
    const data = insertCall[insertCall.length - 1];

    // The headline invariant: a self-service create can NEVER seed funds.
    expect(data.balance).toBe('0');
    expect(data.held).toBe('0');
    expect(data.spentToday).toBe('0');
    expect(data.spentMonth).toBe('0');

    // Owner is the trusted caller id — NOT any body field.
    expect(data.ownerId).toBe(OWNER);
    // The customer-chosen label is passed through to persistence.
    expect(data.label).toBe(LABEL);
    // Fixed, seeded attributes (never taken from the request).
    expect(String(data.currency)).toBe('MXN');
    expect(String(data.kind)).toBe('customer');
    expect(String(data.status)).toBe('active');
    // A freshly generated 10-digit numeric account number.
    expect(String(data.accountNumber)).toMatch(/^\d{10}$/);

    // A create moves no money → NO audit row and NO ledger interaction.
    expect(mocks.audit.recordInTx).not.toHaveBeenCalled();
    expect(mocks.audit.record).not.toHaveBeenCalled();
    expect(mocks.ledgerRepo.findByAccount).not.toHaveBeenCalled();

    // Returns the persisted entity (the controller serializes it).
    expect(res.value.id).toBe('acc-created-uuid');
  });

  it('the lock → cap-count → insert critical section runs under the SAME queryRunner (atomic under the per-owner lock)', async () => {
    const { service, mocks } = await setup();
    await service.createAccount(OWNER, { label: LABEL });

    // The advisory lock is taken for the caller's own owner id.
    expect(mocks.accountRepo.lockOwnerForAccountCreation).toHaveBeenCalledTimes(1);
    const lockCall = mocks.accountRepo.lockOwnerForAccountCreation.mock.calls[0];
    expect(lockCall).toContain(OWNER);

    const lockQr = lockCall[0];
    const countQr = mocks.accountRepo.countCustomerAccountsByOwner.mock.calls[0][0];
    const insertQr = mocks.accountRepo.createInTx.mock.calls[0][0];
    // One transaction: the lock, the cap COUNT, and the INSERT share the SAME queryRunner — so the
    // count-then-insert can never race a concurrent create for the same owner.
    expect(countQr).toBe(lockQr);
    expect(insertQr).toBe(lockQr);
  });

  it('rejects an over-cap create with ACCOUNT_LIMIT_REACHED and inserts NOTHING (not retried)', async () => {
    const { service, mocks } = await setup();
    // The owner already holds the maximum number of customer accounts.
    mocks.accountRepo.countCustomerAccountsByOwner.mockResolvedValue(CAP);

    const res = await capture(service.createAccount(OWNER, { label: LABEL }));

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('ACCOUNT_LIMIT_REACHED');
    const { AccountLimitReachedError } = getDomainErrors() as any;
    if (AccountLimitReachedError) expect(res.error).toBeInstanceOf(AccountLimitReachedError);

    // No account minted, and the cap error is NOT retried (the whole tx ran exactly once).
    expect(mocks.accountRepo.createInTx).not.toHaveBeenCalled();
    expect(mocks.accountRepo.lockOwnerForAccountCreation).toHaveBeenCalledTimes(1);
  });

  it('rejects a caller with no customer row (CUSTOMER_NOT_FOUND) before any cap-count or insert', async () => {
    const { service, mocks } = await setup();
    mocks.customerRepo.existsByIdInTx.mockResolvedValue(false);

    const res = await capture(service.createAccount(OWNER, { label: LABEL }));

    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe('CUSTOMER_NOT_FOUND');
    // The FK precondition fails closed — no cap count, no insert, and not retried.
    expect(mocks.accountRepo.countCustomerAccountsByOwner).not.toHaveBeenCalled();
    expect(mocks.accountRepo.createInTx).not.toHaveBeenCalled();
    expect(mocks.accountRepo.lockOwnerForAccountCreation).toHaveBeenCalledTimes(1);
  });

  it('RETRIES on a uq_account_account_number collision: one 23505, then success — the transient collision is not surfaced', async () => {
    const { service, mocks } = await setup();
    // First insert collides on the account-number unique index; the second (fresh number) succeeds.
    mocks.accountRepo.createInTx
      .mockRejectedValueOnce(uniqueViolation('uq_account_account_number'))
      .mockImplementationOnce(async (_qr: any, data: any) => ({ id: 'acc-created-uuid', ...data }));

    const res = await capture(service.createAccount(OWNER, { label: LABEL }));

    // The create still resolves — the collision is regenerated-and-retried, never surfaced.
    expect(res.ok).toBe(true);
    expect(res.value.id).toBe('acc-created-uuid');
    // Two insert attempts (the whole tx re-ran), each with a fresh 10-digit number.
    expect(mocks.accountRepo.createInTx).toHaveBeenCalledTimes(2);
    expect(mocks.accountRepo.lockOwnerForAccountCreation).toHaveBeenCalledTimes(2);
    for (const call of mocks.accountRepo.createInTx.mock.calls) {
      const data = call[call.length - 1];
      expect(String(data.accountNumber)).toMatch(/^\d{10}$/);
    }
  });

  it('does NOT retry a unique violation on a DIFFERENT constraint — it propagates on the first attempt', async () => {
    const { service, mocks } = await setup();
    // A 23505 that is NOT the account-number index must never trigger the account-number retry.
    mocks.accountRepo.createInTx.mockRejectedValue(uniqueViolation('uq_some_other_constraint'));

    const res = await capture(service.createAccount(OWNER, { label: LABEL }));

    expect(res.ok).toBe(false);
    // Surfaced, not swallowed; the create attempted exactly once.
    expect(mocks.accountRepo.createInTx).toHaveBeenCalledTimes(1);
  });
});
