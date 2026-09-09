/**
 * Spec 04 — Balance Service, Step-4b: the TransfersService branch + ordering logic. Written FROM
 * the spec (Transfers: internal transfers stay PENDING at initiate and post on OTP-confirm, with
 * the funds check at confirm-time; OTP is user-scoped + single-use; anti-IDOR: the debit/source
 * account must be owned by the caller) and the developer-locked contract, NOT from the
 * implementor's code.
 *
 * Pure unit test — no DB, no real Redis, runs in the DEFAULT `npm test`. The service's collaborators
 * (idempotency wrapper, posting reducer, OTP service, account & transaction repositories, the
 * DataSource) are MOCKED, but the LOGIC UNDER TEST — which branch fires and in what ORDER — is the
 * service's own and is NOT mocked away. Assertions are on real behaviour (rejects with a specific
 * domain error / returns the posted transfer) and on the money-safety ORDERING (the OTP is consumed
 * BEFORE the pending transfer is posted, so a posting failure still burns the code).
 *
 * Injection is driven through a Nest TestingModule + `useMocker` (NOT positional `new`), so the
 * proof is INDEPENDENT of the constructor argument ORDER — the collaborators are matched by their
 * DI tokens (resolved through the single harness seam), and any unanticipated dependency is
 * auto-mocked. If the implementor's tokens diverge, `tests/support/harness.ts` is the single edit.
 *
 * ASSUMED service contract (spec/task-derived — the coordination point; escalate, don't conform a
 * proof to a wrong shape): `initiateTransfer(params)`, `confirmTransfer(params)`,
 * `listPendingAuthorizations(ownerId)`; posting exposes `postPendingInTx(queryRunner, transactionId,
 * command)`. The params objects below carry field-name aliases (ownerId/sub, transferId/id, …) so
 * the proof is robust to the exact key names.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getDataSourceToken } from '@nestjs/typeorm';

import {
  getTransfersService,
  getTransfersServiceToken,
  getIdempotencyServiceToken,
  getPostingServiceToken,
  getOtpServiceToken,
  getRepositoryToken,
  getAppConfigToken,
  getDomainErrors,
} from '../support/harness';

const TransfersService = getTransfersService();
const de = getDomainErrors();

const OWNER = 'sub-alice';

/** An auto-mock for any dependency we do not explicitly wire: every property access yields a
 *  jest.fn(), and it is callable — so an unanticipated collaborator never blocks instantiation. */
function autoMock(): any {
  const cache = new Map<PropertyKey, any>();
  const target: any = () => undefined;
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') return undefined; // must not look like a thenable
      if (!cache.has(prop)) cache.set(prop, jest.fn());
      return cache.get(prop);
    },
    apply: () => undefined,
  });
}

interface Mocks {
  idempotency: any;
  posting: any;
  otp: any;
  accountRepo: any;
  transactionRepo: any;
  dataSource: any;
  appConfig: any;
  callLog: string[];
  state: {
    consumeResult: any;
    postingResult: any;
    postingError: any;
    executeParams: any;
  };
}

function makeMocks(): Mocks {
  const callLog: string[] = [];
  const state = {
    consumeResult: { ok: true, remainingAttempts: 3, lockedOut: false },
    postingResult: undefined as any,
    postingError: undefined as any,
    executeParams: undefined as any,
  };

  const fakeManager = {
    query: jest.fn(async () => []),
    save: jest.fn(async (e: any) => e),
    insert: jest.fn(async () => ({ identifiers: [{ id: 'tx-op' }], raw: [{ id: 'tx-op' }] })),
    create: jest.fn((_c: any, d: any) => ({ id: 'tx-op', ...(d ?? {}) })),
    getRepository: jest.fn(() => ({
      save: jest.fn(async (e: any) => e),
      insert: jest.fn(async () => ({ identifiers: [{ id: 'tx-op' }] })),
      create: jest.fn((d: any) => ({ id: 'tx-op', ...(d ?? {}) })),
    })),
  };
  const fakeQueryRunner: any = {
    manager: fakeManager,
    isTransactionActive: true,
    connect: jest.fn(async () => undefined),
    startTransaction: jest.fn(async () => undefined),
    commitTransaction: jest.fn(async () => undefined),
    rollbackTransaction: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    query: jest.fn(async () => []),
  };

  const idempotency = {
    // Passthrough: runs the wrapped operation (so an ownership check performed INSIDE the op still
    // fires) and records the params (so we can assert the fingerprint input if needed).
    execute: jest.fn(async (params: any, op?: any) => {
      callLog.push('execute');
      state.executeParams = params;
      if (typeof op === 'function') {
        const r = await op(fakeQueryRunner);
        return { transactionId: r?.transactionId ?? 'tx-op', replayed: false };
      }
      return { transactionId: 'tx-canned', replayed: false };
    }),
  };

  const posting = {
    postPendingInTx: jest.fn(async (_qr: any, transactionId: string) => {
      callLog.push('postPendingInTx');
      if (state.postingError) throw state.postingError;
      return state.postingResult ?? { id: transactionId, status: 'POSTED' };
    }),
    postTransaction: jest.fn(async () => ({ id: 'tx-op', status: 'POSTED' })),
  };

  const otp = {
    consume: jest.fn(async () => {
      callLog.push('consume');
      return state.consumeResult;
    }),
    generate: jest.fn(async () => ({ code: '123456', ttlSeconds: 300 })),
  };

  // Defaults are the HAPPY shapes so the confirm branches (which anti-IDOR the DEBIT account via
  // findByIdAndOwner) get past the ownership gate; individual tests override to the failing shape.
  const ownedAccount = {
    id: 'src-1',
    ownerId: OWNER,
    currency: 'MXN',
    status: 'active',
    kind: 'customer',
  };
  const accountRepo = {
    findByIdAndOwner: jest.fn(async () => ownedAccount),
    findById: jest.fn(async () => ({
      id: 'dst-1',
      ownerId: 'other-owner',
      currency: 'MXN',
      status: 'active',
      kind: 'customer',
    })),
    lockByIdForUpdate: jest.fn(async () => ownedAccount),
  };

  const transactionRepo = {
    findByIdAndOwner: jest.fn(async () => null),
    findById: jest.fn(async () => null),
    findPendingByInitiator: jest.fn(async () => []),
    insertInTx: jest.fn(async (_qr: any, d: any) => ({ id: 'tx-op', ...(d ?? {}) })),
    create: jest.fn(async (d: any) => ({ id: 'tx-op', ...(d ?? {}) })),
    save: jest.fn(async (e: any) => e),
  };

  const dataSource = {
    transaction: jest.fn(async (arg1: any, arg2: any) => {
      const cb = typeof arg1 === 'function' ? arg1 : arg2;
      return cb(fakeManager);
    }),
    createQueryRunner: jest.fn(() => fakeQueryRunner),
    query: jest.fn(async () => []),
  };

  const appConfig = { otp: { hashSecret: 'x'.repeat(24) }, internalServiceToken: 'svc' };

  return {
    idempotency,
    posting,
    otp,
    accountRepo,
    transactionRepo,
    dataSource,
    appConfig,
    callLog,
    state,
  };
}

const TRANSFERS_TOKEN = getTransfersServiceToken();
const IDEMPOTENCY_TOKEN = getIdempotencyServiceToken();
const POSTING_TOKEN = getPostingServiceToken();
const OTP_TOKEN = getOtpServiceToken();
const ACCOUNT_REPO_TOKEN = getRepositoryToken('ACCOUNT_REPOSITORY', 'account');
const TRANSACTION_REPO_TOKEN = getRepositoryToken('TRANSACTION_REPOSITORY', 'transaction');
const APP_CONFIG_TOKEN = getAppConfigToken();
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

async function setup(): Promise<{ service: any; mocks: Mocks }> {
  const mocks = makeMocks();
  const moduleRef = await Test.createTestingModule({
    providers: [{ provide: TRANSFERS_TOKEN, useClass: TransfersService }],
  })
    .useMocker((token) => {
      if (token === IDEMPOTENCY_TOKEN) return mocks.idempotency;
      if (token === POSTING_TOKEN) return mocks.posting;
      if (token === OTP_TOKEN) return mocks.otp;
      if (token === ACCOUNT_REPO_TOKEN) return mocks.accountRepo;
      if (token === TRANSACTION_REPO_TOKEN) return mocks.transactionRepo;
      if (token === APP_CONFIG_TOKEN) return mocks.appConfig;
      if (isDataSourceToken(token)) return mocks.dataSource;
      return autoMock();
    })
    .compile();
  const service = moduleRef.get(TRANSFERS_TOKEN, { strict: false });
  return { service, mocks };
}

function initiateParams(overrides: Record<string, unknown> = {}): any {
  return {
    ownerId: OWNER,
    sub: OWNER,
    sourceAccountId: 'src-1',
    destinationAccountId: 'dst-1',
    amount: '2000',
    currency: 'MXN',
    idempotencyKey: 'key-1',
    key: 'key-1',
    confirmDuplicate: false,
    ...overrides,
  };
}

function confirmParams(overrides: Record<string, unknown> = {}): any {
  return {
    ownerId: OWNER,
    sub: OWNER,
    transferId: 'transfer-1',
    id: 'transfer-1',
    transactionId: 'transfer-1',
    code: '123456',
    ...overrides,
  };
}

function pendingTransfer(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'transfer-1',
    status: 'PENDING',
    type: 'internal',
    amount: '2000',
    currency: 'MXN',
    debitAccountId: 'src-1',
    creditAccountId: 'dst-1',
    initiatedBy: OWNER,
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

function expectDomainCode(err: any, acceptedCodes: string[], klass?: any): void {
  expect(err).toBeDefined();
  if (klass) expect(err).toBeInstanceOf(klass);
  expect(acceptedCodes).toContain(err?.code);
}

describe('TransfersService.initiateTransfer — validation + anti-IDOR (no money moves)', () => {
  it('rejects a self-transfer (source === destination) with InvalidTransferError and never posts', async () => {
    const { service, mocks } = await setup();
    // Make the account resolvable so the ONLY failing invariant is source === destination.
    mocks.accountRepo.findByIdAndOwner.mockResolvedValue({
      id: 'src-1',
      ownerId: OWNER,
      currency: 'MXN',
      status: 'active',
    });

    const res = await capture(
      service.initiateTransfer(
        initiateParams({ sourceAccountId: 'same', destinationAccountId: 'same' }),
      ),
    );

    expect(res.ok).toBe(false);
    expectDomainCode(res.error, ['INVALID_TRANSFER'], de.InvalidTransferError);
    // A rejected initiate must never move money.
    expect(mocks.posting.postPendingInTx).not.toHaveBeenCalled();
    expect(mocks.posting.postTransaction).not.toHaveBeenCalled();
  });

  it('rejects when the SOURCE account is not owned by the caller (findByIdAndOwner → null): 404-class error, no post', async () => {
    const { service, mocks } = await setup();
    // The source account lookup for this caller returns null (missing OR owned by someone else —
    // indistinguishable by design, anti-IDOR). Cover both the pre-check and in-operation designs by
    // returning null from both finders.
    mocks.accountRepo.findByIdAndOwner.mockResolvedValue(null);
    mocks.accountRepo.findById.mockResolvedValue(null);
    mocks.transactionRepo.findByIdAndOwner.mockResolvedValue(null);

    const res = await capture(service.initiateTransfer(initiateParams()));

    expect(res.ok).toBe(false);
    // 404-mapping domain error (ACCOUNT_NOT_FOUND or TRANSFER_NOT_FOUND — both map to 404). The
    // security-relevant invariant is that a non-owned source never reaches money movement.
    expectDomainCode(res.error, ['ACCOUNT_NOT_FOUND', 'TRANSFER_NOT_FOUND']);
    expect(mocks.posting.postPendingInTx).not.toHaveBeenCalled();
    expect(mocks.posting.postTransaction).not.toHaveBeenCalled();
  });
});

describe('TransfersService.confirmTransfer — OTP gating, ordering, and lifecycle guard', () => {
  it('returns an already-POSTED transfer WITHOUT consuming the OTP or posting again (idempotent replay-confirm)', async () => {
    const { service, mocks } = await setup();
    const posted = pendingTransfer({ status: 'POSTED' });
    mocks.transactionRepo.findByIdAndOwner.mockResolvedValue(posted);
    mocks.transactionRepo.findById.mockResolvedValue(posted);

    const res = await capture(service.confirmTransfer(confirmParams()));

    expect(res.ok).toBe(true);
    expect(res.value?.status).toBe('POSTED');
    // The money-once guarantee for a replayed confirm: no OTP burned, no second movement.
    expect(mocks.otp.consume).not.toHaveBeenCalled();
    expect(mocks.posting.postPendingInTx).not.toHaveBeenCalled();
  });

  it('rejects confirming a transfer that is neither PENDING nor POSTED (e.g. FAILED) with TransferNotPendingError and never posts', async () => {
    const { service, mocks } = await setup();
    const dead = pendingTransfer({ status: 'FAILED' });
    mocks.transactionRepo.findByIdAndOwner.mockResolvedValue(dead);
    mocks.transactionRepo.findById.mockResolvedValue(dead);

    const res = await capture(service.confirmTransfer(confirmParams()));

    expect(res.ok).toBe(false);
    expectDomainCode(res.error, ['TRANSFER_NOT_PENDING'], de.TransferNotPendingError);
    expect(mocks.posting.postPendingInTx).not.toHaveBeenCalled();
  });

  it('rejects confirming a missing / non-owned transfer with TransferNotFoundError before touching the OTP', async () => {
    const { service, mocks } = await setup();
    mocks.transactionRepo.findByIdAndOwner.mockResolvedValue(null);
    mocks.transactionRepo.findById.mockResolvedValue(null);

    const res = await capture(service.confirmTransfer(confirmParams()));

    expect(res.ok).toBe(false);
    expectDomainCode(res.error, ['TRANSFER_NOT_FOUND'], de.TransferNotFoundError);
    // A confirm against a transfer that is not the caller's must not even spend their OTP.
    expect(mocks.otp.consume).not.toHaveBeenCalled();
    expect(mocks.posting.postPendingInTx).not.toHaveBeenCalled();
  });

  it('maps an OTP lockout (consume → {ok:false, lockedOut:true}) to OtpLockedOutError and does NOT post', async () => {
    const { service, mocks } = await setup();
    mocks.transactionRepo.findByIdAndOwner.mockResolvedValue(pendingTransfer());
    mocks.transactionRepo.findById.mockResolvedValue(pendingTransfer());
    mocks.state.consumeResult = { ok: false, remainingAttempts: 0, lockedOut: true };

    const res = await capture(service.confirmTransfer(confirmParams()));

    expect(res.ok).toBe(false);
    expectDomainCode(res.error, ['OTP_LOCKED_OUT'], de.OtpLockedOutError);
    expect(mocks.posting.postPendingInTx).not.toHaveBeenCalled();
  });

  it('maps a wrong OTP (consume → {ok:false, lockedOut:false}) to InvalidOtpError and does NOT post', async () => {
    const { service, mocks } = await setup();
    mocks.transactionRepo.findByIdAndOwner.mockResolvedValue(pendingTransfer());
    mocks.transactionRepo.findById.mockResolvedValue(pendingTransfer());
    mocks.state.consumeResult = { ok: false, remainingAttempts: 2, lockedOut: false };

    const res = await capture(service.confirmTransfer(confirmParams()));

    expect(res.ok).toBe(false);
    expectDomainCode(res.error, ['INVALID_OTP'], de.InvalidOtpError);
    expect(mocks.posting.postPendingInTx).not.toHaveBeenCalled();
  });

  it('on a valid OTP (consume → {ok:true}) posts the pending transfer via postPendingInTx(_, transactionId, _) and returns it POSTED', async () => {
    const { service, mocks } = await setup();
    const transfer = pendingTransfer();
    mocks.transactionRepo.findByIdAndOwner.mockResolvedValue(transfer);
    mocks.transactionRepo.findById.mockResolvedValue(transfer);
    mocks.state.consumeResult = { ok: true, remainingAttempts: 3, lockedOut: false };
    mocks.state.postingResult = { ...transfer, status: 'POSTED' };

    const res = await capture(service.confirmTransfer(confirmParams()));

    expect(res.ok).toBe(true);
    expect(res.value?.status).toBe('POSTED');
    expect(mocks.otp.consume).toHaveBeenCalledTimes(1);
    expect(mocks.posting.postPendingInTx).toHaveBeenCalledTimes(1);
    // The posting is keyed to THIS transfer's id (arg[1] per the postPendingInTx(qr, txId, cmd) contract).
    expect(mocks.posting.postPendingInTx.mock.calls[0][1]).toBe(transfer.id);
  });

  it('SAFETY ORDERING: the OTP is consumed BEFORE posting — a posting failure still leaves the code burned', async () => {
    const { service, mocks } = await setup();
    const transfer = pendingTransfer();
    mocks.transactionRepo.findByIdAndOwner.mockResolvedValue(transfer);
    mocks.transactionRepo.findById.mockResolvedValue(transfer);
    mocks.state.consumeResult = { ok: true, remainingAttempts: 3, lockedOut: false };
    // The posting step blows up (e.g. INSUFFICIENT_FUNDS at confirm-time under the lock).
    mocks.state.postingError = Object.assign(new Error('insufficient funds'), {
      code: 'INSUFFICIENT_FUNDS',
    });

    const res = await capture(service.confirmTransfer(confirmParams()));

    expect(res.ok).toBe(false); // the failure propagates
    // The single-use code was consumed (burned) EVEN THOUGH posting failed — a replay of the same
    // code cannot re-drive the transfer. This is the ordering safety property.
    expect(mocks.otp.consume).toHaveBeenCalledTimes(1);
    expect(mocks.posting.postPendingInTx).toHaveBeenCalledTimes(1);
    const consumeIdx = mocks.callLog.indexOf('consume');
    const postIdx = mocks.callLog.indexOf('postPendingInTx');
    expect(consumeIdx).toBeGreaterThanOrEqual(0);
    expect(postIdx).toBeGreaterThan(consumeIdx); // consume happened first
  });
});
