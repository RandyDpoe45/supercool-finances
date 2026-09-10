/**
 * Spec 04 — Balance Service, step 8a (single-actor /admin): `AccountsService.setFrozen(actorId,
 * accountId, frozen)` — the freeze/unfreeze domain operation, driven as a PURE unit (no DB) so it
 * runs in the DEFAULT `npm test`. Written FROM the spec's "/admin Endpoints" bullet + the
 * developer-locked contract, NOT from the implementor's code:
 *
 *   - Every MUTATING admin action writes ONE `audit_log` row in the SAME tx as the change. So a
 *     successful freeze/unfreeze must call BOTH `accountRepo.updateStatusInTx` (flip `status`) AND
 *     `auditService.recordInTx` (append the audit row) — and pass BOTH the SAME queryRunner (one tx).
 *   - The audit row carries actor + action (`account.freeze` / `account.unfreeze`) + target + a
 *     before/after view of the change.
 *   - A freeze targeting a MISSING account writes NO audit row and rejects (nothing half-applied) —
 *     the money-safety observable (an audit for a change that never happened is a defect).
 *
 * The collaborators (account repo, audit service, DataSource) are MOCKED, but the ORCHESTRATION
 * under test (which repo/audit calls fire, in the same tx, and whether they fire at all when the
 * account is absent) is the service's own and is NOT mocked away. Injection is driven through a Nest
 * TestingModule + `useMocker` matched BY TOKEN (resolved through the single harness seam), so the
 * proof is INDEPENDENT of constructor arg order. The service opens its tx through the production
 * transaction wrapper against the MOCKED DataSource (createQueryRunner → an in-memory fake runner),
 * so the "one tx" binding is proven WITHOUT the test knowing the wrapper's internals.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getDataSourceToken } from '@nestjs/typeorm';

import {
  getAccountsService,
  getAccountsServiceToken,
  getAuditServiceToken,
  getAuditLogRepositoryToken,
  getRepositoryToken,
} from '../support/harness';

const AccountsService = getAccountsService();

// Developer-locked audit `action` constants (spec 04 step 8a brief).
const ACTION_FREEZE = 'account.freeze';
const ACTION_UNFREEZE = 'account.unfreeze';

const ACTOR = 'admin-42';
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';

/** A committed customer account row, active by default. */
function customerAccount(overrides: Record<string, unknown> = {}): any {
  return {
    id: ACCOUNT_ID,
    ownerId: 'sub-owner',
    kind: 'customer',
    currency: 'MXN',
    status: 'active',
    balance: '5000',
    held: '0',
    ...overrides,
  };
}

interface Mocks {
  accountRepo: any;
  ledgerRepo: any;
  audit: any;
  dataSource: any;
  qr: any;
  state: { account: any };
}

function makeMocks(): Mocks {
  const state = { account: customerAccount() as any };

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
    // The pre-read/lock the operation uses to fetch the BEFORE status (and to detect a missing
    // account). Both the in-tx and plain reads return the SAME configurable row so the test is
    // robust to whichever the service uses; `null` models a missing account.
    lockByIdForUpdate: jest.fn(async () => state.account),
    findByIdInTx: jest.fn(async () => state.account),
    findById: jest.fn(async () => state.account),
    // The guarded status flip (spec-locked repo method). Returns true (one row) by default.
    updateStatusInTx: jest.fn(async () => true),
  };
  const ledgerRepo = { findByAccount: jest.fn(async () => []) };

  const audit = {
    recordInTx: jest.fn(async () => undefined),
    record: jest.fn(async () => undefined),
  };

  const dataSource = {
    createQueryRunner: jest.fn(() => qr),
    transaction: jest.fn(async (arg1: any, arg2: any) => {
      const cb = typeof arg1 === 'function' ? arg1 : arg2;
      return cb(fakeManager);
    }),
    query: jest.fn(async () => []),
  };

  return { accountRepo, ledgerRepo, audit, dataSource, qr, state };
}

const ACCOUNTS_TOKEN = getAccountsServiceToken();
const AUDIT_TOKEN = getAuditServiceToken();
const AUDIT_REPO_TOKEN = getAuditLogRepositoryToken();
const ACCOUNT_REPO_TOKEN = getRepositoryToken('ACCOUNT_REPOSITORY', 'account');
const LEDGER_REPO_TOKEN = getRepositoryToken('LEDGER_ENTRY_REPOSITORY', 'ledger-entry');
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
      if (token === AUDIT_TOKEN) return mocks.audit;
      if (token === AUDIT_REPO_TOKEN) return mocks.audit; // if it injects the repo directly
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

/** The audit entry the service passed to recordInTx (2nd arg after the queryRunner). */
function auditEntryOf(audit: any): any {
  const call = audit.recordInTx.mock.calls[0];
  // recordInTx(queryRunner, entry) — entry is the LAST arg regardless of exact arity.
  return call[call.length - 1];
}

describe('AccountsService.setFrozen — flips status + audits in ONE tx (spec 04 step 8a)', () => {
  it('freeze (frozen=true): flips status to frozen AND writes one audit row, both under the SAME queryRunner', async () => {
    const { service, mocks } = await setup();

    const res = await capture(service.setFrozen(ACTOR, ACCOUNT_ID, true));
    expect(res.ok).toBe(true);

    // The status flip fired for THIS account, to the frozen label.
    expect(mocks.accountRepo.updateStatusInTx).toHaveBeenCalledTimes(1);
    const statusCall = mocks.accountRepo.updateStatusInTx.mock.calls[0];
    expect(statusCall).toContain(ACCOUNT_ID); // targeted the right account id
    expect(statusCall.map((a: unknown) => String(a))).toContain('frozen'); // → frozen

    // Exactly one audit row, with the freeze action, the actor, and the target account.
    expect(mocks.audit.recordInTx).toHaveBeenCalledTimes(1);
    const entry = auditEntryOf(mocks.audit);
    const serialized = JSON.stringify(entry);
    expect(serialized).toContain(ACTION_FREEZE);
    expect(serialized).toContain(ACTOR);
    expect(serialized).toContain(ACCOUNT_ID);

    // ONE tx: the status flip and the audit append share the SAME queryRunner object (arg 0).
    const statusQr = statusCall[0];
    const auditQr = mocks.audit.recordInTx.mock.calls[0][0];
    expect(auditQr).toBe(statusQr);
  });

  it('unfreeze (frozen=false): flips status to active AND writes an account.unfreeze audit row', async () => {
    const { service, mocks } = await setup();
    mocks.state.account = customerAccount({ status: 'frozen' });

    const res = await capture(service.setFrozen(ACTOR, ACCOUNT_ID, false));
    expect(res.ok).toBe(true);

    expect(mocks.accountRepo.updateStatusInTx).toHaveBeenCalledTimes(1);
    expect(
      mocks.accountRepo.updateStatusInTx.mock.calls[0].map((a: unknown) => String(a)),
    ).toContain('active');
    expect(mocks.audit.recordInTx).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(auditEntryOf(mocks.audit))).toContain(ACTION_UNFREEZE);
  });

  it('a MISSING account writes NO audit row and rejects (nothing half-applied)', async () => {
    const { service, mocks } = await setup();
    // The account is absent: every read seam returns null.
    mocks.state.account = null;
    mocks.accountRepo.updateStatusInTx.mockResolvedValue(false); // a guarded UPDATE would touch 0 rows

    const res = await capture(service.setFrozen(ACTOR, ACCOUNT_ID, true));

    expect(res.ok).toBe(false);
    // Classify by the STABLE domain code, not the class identity: `setFrozen` may throw an
    // `AccountNotFoundError` from a different module than the one `getDomainErrors()` resolves, so a
    // cross-module `instanceof` is unreliable. `ACCOUNT_NOT_FOUND` maps to 404 at the HTTP edge.
    expect(res.error?.code).toBe('ACCOUNT_NOT_FOUND');
    // The safety-critical invariant: NO audit is written for a change that did not happen. (Whether
    // the missing account is detected by a pre-read or by the guarded UPDATE touching 0 rows is an
    // implementation detail; either way the audit append must NOT fire.)
    expect(mocks.audit.recordInTx).not.toHaveBeenCalled();
    expect(mocks.audit.record).not.toHaveBeenCalled();
  });
});
