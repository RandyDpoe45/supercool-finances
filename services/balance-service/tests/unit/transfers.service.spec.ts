/**
 * Spec 04 — Balance Service, Transfers + the confirmation-of-payee follow-up. The
 * TransfersService branch/ordering logic, driven as a PURE unit (no DB, no real Redis) so it runs
 * in the DEFAULT `npm test`. Written FROM the spec + the developer-locked contract, NOT from the
 * implementor's code:
 *   - internal transfers stay PENDING at initiate and post on OTP-confirm (funds check at confirm);
 *   - the OTP is user-scoped + single-use, consumed BEFORE the post (a post failure still burns it);
 *   - anti-IDOR: the debit/source account must be owned by the caller;
 *   - confirmation-of-payee: `resolveDestination` is a QUERY (masked name + a caller-bound token,
 *     no transaction); `initiateTransfer` creates a PENDING transfer ONLY with a valid token bound
 *     to the caller AND to THIS destination, else `DestinationNotConfirmedError`.
 *   - PR #19 single + time-boxed pending: `confirmTransfer` checks EXPIRY before consuming the OTP
 *     (overdue → `TransferExpiredError`, code NOT burned; already EXPIRED/CANCELLED →
 *     `TransferNotPendingError`); `cancelTransfer` is a guarded, owner-scoped `PENDING→CANCELLED`
 *     (idempotent on a terminal row); `getPendingAuthorization` returns the caller's single active
 *     pending as a masked read model, or null.
 *
 * The service's collaborators (idempotency wrapper, posting reducer, OTP service, account &
 * customer repositories, the Redis client, the DataSource) are MOCKED — but the LOGIC UNDER TEST
 * (which branch fires, in what ORDER, and whether the money machinery is even reached) is the
 * service's own and is NOT mocked away. The Redis mock is an in-memory store, so the confirmation
 * token round-trips through the SAME key the service writes and reads — the caller/destination
 * binding is proven END-TO-END at the unit level WITHOUT the test knowing the stored record shape.
 *
 * Injection is driven through a Nest TestingModule + `useMocker` (NOT positional `new`), so the
 * proof is INDEPENDENT of constructor arg ORDER — collaborators are matched by DI token (resolved
 * through the single harness seam). If the implementor's tokens diverge, harness.ts is the one edit.
 *
 * ASSUMED service contract (spec/task-derived): `resolveDestination({ownerId, accountNumber})`,
 * `initiateTransfer(params)` (params carry sourceAccountId, destinationAccountNumber,
 * confirmationToken, amount, currency, idempotencyKey, confirmDuplicate?), `confirmTransfer(params)`,
 * `cancelTransfer(params)`, `getPendingAuthorization(ownerId)`. Post the PR #19 layering fix
 * initiate/confirm/cancel return the Transaction ENTITY and getPendingAuthorization returns a
 * `{ transaction, destinationAccountNumber, destinationMaskedName }` read model (or null); the
 * `statusOf`/`idOf` unwrappers below accept either the entity or a `{transaction}` wrapper. Posting
 * exposes `postPendingInTx(queryRunner, transactionId, command)`.
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
  getCustomerRepositoryToken,
  getRedisClientToken,
  getAppConfigToken,
  getDomainErrors,
  getDomainErrorBase,
} from '../support/harness';

const TransfersService = getTransfersService();
// `any` so the best-effort error-class map tolerates keys added by the PR #19 harness update
// (TransferExpiredError / PendingTransferConflictError) without a compile-time coupling — these
// classes are used only for a secondary `instanceof` signal; the primary assertion is the `.code`.
const de: any = getDomainErrors();
const DomainErrorBase: any = getDomainErrorBase();

/** A concrete DomainError carrying the INSUFFICIENT_FUNDS business code — a confirm-time BUSINESS
 * failure (`isBusinessFailure` ⇒ true), so the confirm catch delegates to `posting.recordFailedInTx`.
 * Prefers the real reducer error class; falls back to a synthetic DomainError with the same code so
 * the delegation branch is driven even if the concrete class is not resolvable. */
class SyntheticInsufficientFundsError extends DomainErrorBase {
  readonly code = 'INSUFFICIENT_FUNDS';
  constructor() {
    super('insufficient funds (synthetic business failure)');
  }
}
function insufficientFundsError(): any {
  return typeof de.InsufficientFundsError === 'function'
    ? new de.InsufficientFundsError('src-1')
    : new SyntheticInsufficientFundsError();
}

const OWNER = 'sub-alice';

/** An auto-mock for any dependency we do not explicitly wire. */
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
  customerRepo: any;
  transactionRepo: any;
  redis: any;
  redisStore: Map<string, string>;
  dataSource: any;
  appConfig: any;
  callLog: string[];
  state: {
    consumeResult: any;
    postingResult: any;
    postingError: any;
    source: any;
    byNumber: Map<string, any>;
    byId: Map<string, any>;
    holdersById: Map<string, any>;
    findByIdResult: any; // transactionRepo.findById for the created id (initiate happy path)
    // The caller's single active pending transfer (findPendingByInitiator's return), or null.
    pendingRow: any;
  };
}

function customerAccount(id: string, ownerId: string, accountNumber: string): any {
  return { id, ownerId, kind: 'customer', currency: 'MXN', status: 'active', accountNumber };
}

function makeMocks(): Mocks {
  const callLog: string[] = [];
  const redisStore = new Map<string, string>();

  const destX = customerAccount('dst-x', 'owner-x', '2222222222');
  const destY = customerAccount('dst-y', 'owner-y', '3333333333');
  const source = customerAccount('src-1', OWNER, '1111111111');

  const state = {
    consumeResult: { ok: true, remainingAttempts: 3, lockedOut: false },
    postingResult: undefined as any,
    postingError: undefined as any,
    source,
    byNumber: new Map<string, any>([
      ['2222222222', destX],
      ['3333333333', destY],
    ]),
    byId: new Map<string, any>([
      ['src-1', source],
      ['dst-x', destX],
      ['dst-y', destY],
    ]),
    holdersById: new Map<string, any>([
      ['owner-x', { id: 'owner-x', name: 'Juan Perez', phone: '5215555550100', email: 'x@t.test' }],
      ['owner-y', { id: 'owner-y', name: 'Ana', phone: '5215555550101', email: 'y@t.test' }],
    ]),
    findByIdResult: null as any,
    // The caller's single active pending transfer (what findPendingByInitiator returns), or null.
    pendingRow: null as any,
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
    // Passthrough: runs the wrapped operation (so anything performed INSIDE the op still fires).
    execute: jest.fn(async (_params: any, op?: any) => {
      callLog.push('execute');
      if (typeof op === 'function') {
        const r = await op(fakeQueryRunner);
        return { transactionId: r?.transactionId ?? 'tx-op', replayed: false };
      }
      return { transactionId: 'tx-op', replayed: false };
    }),
  };

  const posting = {
    postPendingInTx: jest.fn(async (_qr: any, transactionId: string) => {
      callLog.push('postPendingInTx');
      if (state.postingError) throw state.postingError;
      return state.postingResult ?? { id: transactionId, status: 'POSTED' };
    }),
    postTransaction: jest.fn(async () => ({ id: 'tx-op', status: 'POSTED' })),
    // P2a: the reducer OWNS the confirm-time FAILED-header write + the single `transaction.failed`
    // event (sole emitter). transfers now DELEGATES to this on a business failure, then (external
    // only, when it returns true) releases the hold and rethrows. Returns true = it flipped
    // PENDING→FAILED and emitted. The OUTBOX_EVENT_REPOSITORY injection was removed from transfers.
    recordFailedInTx: jest.fn(async () => {
      callLog.push('recordFailedInTx');
      return true;
    }),
  };

  const otp = {
    consume: jest.fn(async () => {
      callLog.push('consume');
      return state.consumeResult;
    }),
    generate: jest.fn(async () => ({ code: '123456', ttlSeconds: 300 })),
  };

  const accountRepo = {
    // Owner-scoped source lookup: returns the owned source by default (null ⇒ non-owned/missing).
    findByIdAndOwner: jest.fn(async () => state.source),
    // Human-number destination lookup.
    findByAccountNumber: jest.fn(async (num: string) => state.byNumber.get(num) ?? null),
    // Id lookup (view-model number resolution).
    findById: jest.fn(async (id: string) => state.byId.get(id) ?? null),
    lockByIdForUpdate: jest.fn(async () => state.source),
  };

  const customerRepo = {
    findById: jest.fn(async (id: string) => state.holdersById.get(id) ?? null),
  };

  const redis = {
    get: jest.fn(async (key: string) => {
      callLog.push('redis.get');
      return redisStore.has(key) ? redisStore.get(key)! : null;
    }),
    set: jest.fn(async (key: string, val: string) => {
      callLog.push('redis.set');
      redisStore.set(key, val);
      return 'OK';
    }),
    del: jest.fn(async (...keys: string[]) => {
      for (const k of keys) redisStore.delete(k);
      return keys.length;
    }),
  };

  // The real ITransactionRepository surface (developer-confirmed):
  //  - findPendingByInitiator(initiatedBy) → the SINGLE pending transfer or null (NOT an array);
  //  - insertPendingInTx(qr, data) → the created PENDING row (carries `.id`);
  //  - expireOverduePendingByInitiator / supersedeActivePendingByInitiator(qr, initiatedBy) → void
  //    (the initiate op's expire-then-supersede-then-insert sequence);
  //  - expireIfOverdue(id) → boolean, the AUTHORITY for "is this pending overdue?" (flips
  //    PENDING→EXPIRED, returns true iff it flipped) — confirm/read gate on THIS, not on a JS clock;
  //  - transitionToCancelled(id) → boolean (guarded PENDING→CANCELLED).
  // A Proxy fallback returns a fresh jest.fn for any other access so an incidental call never
  // throws a TypeError and masks the assertion under test.
  const transactionRepoBase: any = {
    findById: jest.fn(async () => state.findByIdResult),
    findPendingByInitiator: jest.fn(async () => state.pendingRow),
    insertPendingInTx: jest.fn(async (_qr: any, d: any) => ({ id: 'tx-op', ...(d ?? {}) })),
    expireOverduePendingByInitiator: jest.fn(async () => undefined),
    supersedeActivePendingByInitiator: jest.fn(async () => undefined),
    expireIfOverdue: jest.fn(async () => false),
    transitionToCancelled: jest.fn(async () => true),
    // Legacy owner-scoped finder kept for any pre-existing wiring; confirm's owner scope is the
    // account-repo check (accounts.findByIdAndOwner on the debit account).
    findByIdAndOwner: jest.fn(async () => null),
  };
  const transactionRepo: any = new Proxy(transactionRepoBase, {
    get(target, prop, receiver) {
      if (typeof prop !== 'string') return Reflect.get(target, prop, receiver);
      if (prop === 'then') return undefined; // must not look like a thenable
      if (prop in target) return target[prop];
      // An unmocked method is fine to ACCESS (jest/util may probe the object), but CALLING it means
      // the service reached for a repo method the mock never stubbed — surface that loudly rather
      // than silently resolving `undefined` and letting a test pass that should fail.
      const fn = jest.fn(() => {
        throw new Error(`unexpected transactionRepo.${prop} call — add it to the mock base`);
      });
      target[prop] = fn;
      return fn;
    },
  });

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
    customerRepo,
    transactionRepo,
    redis,
    redisStore,
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
const CUSTOMER_REPO_TOKEN = getCustomerRepositoryToken();
const TRANSACTION_REPO_TOKEN = getRepositoryToken('TRANSACTION_REPOSITORY', 'transaction');
const REDIS_TOKEN = getRedisClientToken();
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
      if (token === CUSTOMER_REPO_TOKEN) return mocks.customerRepo;
      if (token === TRANSACTION_REPO_TOKEN) return mocks.transactionRepo;
      if (token === REDIS_TOKEN) return mocks.redis;
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
    destinationAccountNumber: '2222222222',
    amount: '2000',
    currency: 'MXN',
    idempotencyKey: 'key-1',
    key: 'key-1',
    confirmationToken: 'tok-placeholder',
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
    creditAccountId: 'dst-x',
    initiatedBy: OWNER,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    postedAt: null,
    // Non-overdue by default so the new confirm-time expiry gate treats it as still-valid; the
    // overdue proof overrides this with a past date.
    expiresAt: new Date(Date.now() + 120_000),
    ...overrides,
  };
}

function cancelParams(overrides: Record<string, unknown> = {}): any {
  return {
    ownerId: OWNER,
    sub: OWNER,
    transferId: 'transfer-1',
    id: 'transfer-1',
    transactionId: 'transfer-1',
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

/** The service returns VIEW models (`{ transaction, ... }`); unwrap to the header status/id. */
function statusOf(v: any): string | undefined {
  return v?.transaction?.status ?? v?.status;
}
function idOf(v: any): string | undefined {
  return v?.transaction?.id ?? v?.id ?? v?.transactionId;
}

function expectDomainCode(err: any, acceptedCodes: string[], klass?: any): void {
  expect(err).toBeDefined();
  if (klass) expect(err).toBeInstanceOf(klass);
  expect(acceptedCodes).toContain(err?.code);
}

// ---------------------------------------------------------------------------------------------
// resolveDestination — the confirmation-of-payee QUERY (no transaction)
// ---------------------------------------------------------------------------------------------

describe('TransfersService.resolveDestination — masked name + a caller-bound token, no money', () => {
  it('resolves a CUSTOMER destination to its MASKED holder name, currency, and a non-empty token', async () => {
    const { service, mocks } = await setup();
    // Destination 2222222222 → dst-x owned by owner-x, whose customer name is "Juan Perez".

    const res = await capture(
      service.resolveDestination({ ownerId: OWNER, sub: OWNER, accountNumber: '2222222222' }),
    );

    expect(res.ok).toBe(true);
    // The name is masked by the fixed-two-asterisks rule (see mask-name.spec) — the RAW name never
    // appears. "Juan Perez" → "Jua** Per**".
    expect(res.value?.maskedName).toBe('Jua** Per**');
    expect(JSON.stringify(res.value)).not.toContain('Juan Perez');
    expect(res.value?.currency).toBe('MXN');
    expect(typeof res.value?.confirmationToken).toBe('string');
    expect((res.value?.confirmationToken as string).length).toBeGreaterThan(0);

    // QUERY ONLY: no transaction is created, the idempotency wrapper is never touched.
    expect(mocks.transactionRepo.insertPendingInTx).not.toHaveBeenCalled();
    expect(mocks.idempotency.execute).not.toHaveBeenCalled();

    // The token is stored bound to the CALLER (owner id in the key) with a 300s TTL (contract).
    expect(mocks.redis.set).toHaveBeenCalledTimes(1);
    const setArgs = mocks.redis.set.mock.calls[0];
    expect(String(setArgs[0])).toContain(OWNER); // caller-bound key
    expect(setArgs.map((a: unknown) => String(a))).toContain('300'); // 300-second TTL
  });

  it('rejects an UNKNOWN account number with TransferNotFound and issues NO token (no reveal)', async () => {
    const { service, mocks } = await setup();
    mocks.accountRepo.findByAccountNumber.mockResolvedValue(null);

    const res = await capture(
      service.resolveDestination({ ownerId: OWNER, sub: OWNER, accountNumber: '9999999999' }),
    );

    expect(res.ok).toBe(false);
    expectDomainCode(res.error, ['TRANSFER_NOT_FOUND'], de.TransferNotFoundError);
    expect(mocks.redis.set).not.toHaveBeenCalled(); // an unresolved destination mints no token
    expect(mocks.customerRepo.findById).not.toHaveBeenCalled(); // never even looked up a holder
  });

  it('rejects a SYSTEM/clearing account (kind != customer) with TransferNotFound and issues NO token', async () => {
    const { service, mocks } = await setup();
    // A system account resolvable by the number must be indistinguishable from "not found" — never
    // reveal that system accounts exist (anti-enumeration).
    mocks.accountRepo.findByAccountNumber.mockResolvedValue({
      id: 'clearing-1',
      ownerId: null,
      kind: 'system',
      currency: 'MXN',
      status: 'active',
      accountNumber: '2222222222',
    });

    const res = await capture(
      service.resolveDestination({ ownerId: OWNER, sub: OWNER, accountNumber: '2222222222' }),
    );

    expect(res.ok).toBe(false);
    expectDomainCode(res.error, ['TRANSFER_NOT_FOUND'], de.TransferNotFoundError);
    expect(mocks.redis.set).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// initiateTransfer — the confirmation gate (money machinery must NOT run without a valid token)
// ---------------------------------------------------------------------------------------------

describe('TransfersService.initiateTransfer — confirmation-of-payee gate', () => {
  it('rejects when NO valid confirmation token is present → DESTINATION_NOT_CONFIRMED, idempotency NEVER invoked', async () => {
    const { service, mocks } = await setup();
    // Source owned, destination resolvable, currency matches — the ONLY failing gate is the
    // missing/unknown confirmation token (nothing was stored for this token).
    const res = await capture(
      service.initiateTransfer(initiateParams({ confirmationToken: 'never-resolved' })),
    );

    expect(res.ok).toBe(false);
    expectDomainCode(res.error, ['DESTINATION_NOT_CONFIRMED'], de.DestinationNotConfirmedError);
    // The gate is a PRECONDITION: a transfer must NOT be created without a valid token. A missing
    // gate would let the idempotency wrapper run and mint a PENDING header.
    expect(mocks.idempotency.execute).not.toHaveBeenCalled();
    expect(mocks.transactionRepo.insertPendingInTx).not.toHaveBeenCalled();
    expect(mocks.posting.postPendingInTx).not.toHaveBeenCalled();
  });

  it('rejects a token bound to a DIFFERENT destination (destination-binding) and creates no PENDING', async () => {
    const { service, mocks } = await setup();
    // Resolve destination 2222222222 (dst-x) → a token bound to dst-x.
    const resolved = await service.resolveDestination({
      ownerId: OWNER,
      accountNumber: '2222222222',
    });
    const token = resolved.confirmationToken as string;

    // Present that token while initiating to a DIFFERENT destination number (3333333333 → dst-y).
    const res = await capture(
      service.initiateTransfer(
        initiateParams({ destinationAccountNumber: '3333333333', confirmationToken: token }),
      ),
    );

    expect(res.ok).toBe(false);
    expectDomainCode(res.error, ['DESTINATION_NOT_CONFIRMED'], de.DestinationNotConfirmedError);
    expect(mocks.idempotency.execute).not.toHaveBeenCalled();
    expect(mocks.transactionRepo.insertPendingInTx).not.toHaveBeenCalled();
  });

  it("rejects caller B using caller A's token (caller-binding) and creates no PENDING", async () => {
    const { service, mocks } = await setup();
    // Alice (OWNER) resolves the destination → a token bound to Alice.
    const resolved = await service.resolveDestination({
      ownerId: OWNER,
      accountNumber: '2222222222',
    });
    const token = resolved.confirmationToken as string;

    // Bob presents Alice's token. The token key embeds the caller, so Bob's lookup misses.
    const res = await capture(
      service.initiateTransfer(
        initiateParams({ ownerId: 'sub-bob', sub: 'sub-bob', confirmationToken: token }),
      ),
    );

    expect(res.ok).toBe(false);
    expectDomainCode(res.error, ['DESTINATION_NOT_CONFIRMED'], de.DestinationNotConfirmedError);
    expect(mocks.idempotency.execute).not.toHaveBeenCalled();
  });

  it('PROCEEDS with a valid token (resolved by THIS caller for THIS destination): the PENDING transfer is created', async () => {
    const { service, mocks } = await setup();
    // A valid resolve→initiate round-trip: the same caller, same destination number, real token.
    const resolved = await service.resolveDestination({
      ownerId: OWNER,
      accountNumber: '2222222222',
    });
    const token = resolved.confirmationToken as string;
    // The idempotency op inserts 'tx-op'; the service then loads it — wire that read.
    mocks.state.findByIdResult = pendingTransfer({ id: 'tx-op', creditAccountId: 'dst-x' });

    const res = await capture(
      service.initiateTransfer(initiateParams({ confirmationToken: token })),
    );

    expect(res.ok).toBe(true);
    // The gate let a legitimate transfer through — this catches an "always-rejects" regression.
    expect(mocks.idempotency.execute).toHaveBeenCalledTimes(1);
    expect(mocks.transactionRepo.insertPendingInTx).toHaveBeenCalledTimes(1);
    expect(statusOf(res.value)).toBe('PENDING');
    expect(idOf(res.value)).toBe('tx-op');
  });
});

// ---------------------------------------------------------------------------------------------
// initiateTransfer — shape / anti-IDOR invariants (still no money moves on rejection)
// ---------------------------------------------------------------------------------------------

describe('TransfersService.initiateTransfer — validation + anti-IDOR (no money moves)', () => {
  it('rejects a self-transfer (destination number resolves to the SOURCE account) with InvalidTransferError, no post', async () => {
    const { service, mocks } = await setup();
    // The destination number resolves to the SAME account id as the source ⇒ a self-transfer.
    mocks.accountRepo.findByIdAndOwner.mockResolvedValue(
      customerAccount('acc-self', OWNER, '1111111111'),
    );
    mocks.accountRepo.findByAccountNumber.mockResolvedValue(
      customerAccount('acc-self', OWNER, '4444444444'),
    );

    const res = await capture(
      service.initiateTransfer(
        initiateParams({ sourceAccountId: 'acc-self', destinationAccountNumber: '4444444444' }),
      ),
    );

    expect(res.ok).toBe(false);
    expectDomainCode(res.error, ['INVALID_TRANSFER'], de.InvalidTransferError);
    // The self-transfer check fires BEFORE the money machinery: nothing is created.
    expect(mocks.idempotency.execute).not.toHaveBeenCalled();
    expect(mocks.posting.postPendingInTx).not.toHaveBeenCalled();
  });

  it('rejects when the SOURCE account is not owned by the caller (findByIdAndOwner → null): 404-class, no post', async () => {
    const { service, mocks } = await setup();
    // A non-owned OR missing source is indistinguishable (anti-IDOR): findByIdAndOwner returns null.
    mocks.accountRepo.findByIdAndOwner.mockResolvedValue(null);

    const res = await capture(service.initiateTransfer(initiateParams()));

    expect(res.ok).toBe(false);
    expectDomainCode(res.error, ['ACCOUNT_NOT_FOUND', 'TRANSFER_NOT_FOUND']);
    // A non-owned source never reaches destination resolution, the token gate, or money movement.
    expect(mocks.idempotency.execute).not.toHaveBeenCalled();
    expect(mocks.posting.postPendingInTx).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// confirmTransfer — OTP gating, ordering, and lifecycle guard (unchanged from 4b, view-wrapped)
// ---------------------------------------------------------------------------------------------

describe('TransfersService.confirmTransfer — OTP gating, ordering, and lifecycle guard', () => {
  it('returns an already-POSTED transfer WITHOUT consuming the OTP or posting again (idempotent replay-confirm)', async () => {
    const { service, mocks } = await setup();
    const posted = pendingTransfer({ status: 'POSTED', postedAt: new Date() });
    mocks.transactionRepo.findByIdAndOwner.mockResolvedValue(posted);
    mocks.transactionRepo.findById.mockResolvedValue(posted);

    const res = await capture(service.confirmTransfer(confirmParams()));

    expect(res.ok).toBe(true);
    expect(statusOf(res.value)).toBe('POSTED');
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

  it('rejects a missing / non-owned transfer with TransferNotFoundError before touching the OTP', async () => {
    const { service, mocks } = await setup();
    mocks.transactionRepo.findByIdAndOwner.mockResolvedValue(null);
    mocks.transactionRepo.findById.mockResolvedValue(null);

    const res = await capture(service.confirmTransfer(confirmParams()));

    expect(res.ok).toBe(false);
    expectDomainCode(res.error, ['TRANSFER_NOT_FOUND'], de.TransferNotFoundError);
    expect(mocks.otp.consume).not.toHaveBeenCalled();
    expect(mocks.posting.postPendingInTx).not.toHaveBeenCalled();
  });

  it('maps an OTP lockout (consume → {ok:false, lockedOut:true}) to OtpLockedOutError and does NOT post', async () => {
    const { service, mocks } = await setup();
    mocks.transactionRepo.findById.mockResolvedValue(pendingTransfer());
    mocks.state.consumeResult = { ok: false, remainingAttempts: 0, lockedOut: true };

    const res = await capture(service.confirmTransfer(confirmParams()));

    expect(res.ok).toBe(false);
    expectDomainCode(res.error, ['OTP_LOCKED_OUT'], de.OtpLockedOutError);
    expect(mocks.posting.postPendingInTx).not.toHaveBeenCalled();
  });

  it('maps a wrong OTP (consume → {ok:false, lockedOut:false}) to InvalidOtpError and does NOT post', async () => {
    const { service, mocks } = await setup();
    mocks.transactionRepo.findById.mockResolvedValue(pendingTransfer());
    mocks.state.consumeResult = { ok: false, remainingAttempts: 2, lockedOut: false };

    const res = await capture(service.confirmTransfer(confirmParams()));

    expect(res.ok).toBe(false);
    expectDomainCode(res.error, ['INVALID_OTP'], de.InvalidOtpError);
    expect(mocks.posting.postPendingInTx).not.toHaveBeenCalled();
  });

  it('on a valid OTP posts the pending transfer via postPendingInTx(_, transactionId, _) and returns it POSTED', async () => {
    const { service, mocks } = await setup();
    const transfer = pendingTransfer();
    mocks.transactionRepo.findById.mockResolvedValue(transfer);
    mocks.state.consumeResult = { ok: true, remainingAttempts: 3, lockedOut: false };
    mocks.state.postingResult = { ...transfer, status: 'POSTED', postedAt: new Date() };

    const res = await capture(service.confirmTransfer(confirmParams()));

    expect(res.ok).toBe(true);
    expect(statusOf(res.value)).toBe('POSTED');
    expect(mocks.otp.consume).toHaveBeenCalledTimes(1);
    expect(mocks.posting.postPendingInTx).toHaveBeenCalledTimes(1);
    // The posting is keyed to THIS transfer's id (arg[1] per postPendingInTx(qr, txId, cmd)).
    expect(mocks.posting.postPendingInTx.mock.calls[0][1]).toBe(transfer.id);
  });

  it('SAFETY ORDERING: the OTP is consumed BEFORE posting — a posting failure still leaves the code burned', async () => {
    const { service, mocks } = await setup();
    const transfer = pendingTransfer();
    mocks.transactionRepo.findById.mockResolvedValue(transfer);
    mocks.state.consumeResult = { ok: true, remainingAttempts: 3, lockedOut: false };
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
    // TAXONOMY at the unit level: this failure is a RAW Error (NOT a DomainError), so it is NOT a
    // business failure — no FAILED persistence is delegated. Guards against an over-eager "persist
    // FAILED on any caught error" regression (a raw 500-class fault must propagate untouched).
    expect(mocks.posting.recordFailedInTx).not.toHaveBeenCalled();
  });

  it('a confirm-time BUSINESS failure (funds dropped) DELEGATES the terminal FAILED persistence to posting.recordFailedInTx and RETHROWS the same error (OTP burned once, no double-processing)', async () => {
    const { service, mocks } = await setup();
    const transfer = pendingTransfer(); // internal → no hold; the FAILED write is delegated, not local
    mocks.transactionRepo.findById.mockResolvedValue(transfer);
    mocks.state.consumeResult = { ok: true, remainingAttempts: 3, lockedOut: false };
    // A REAL DomainError business rejection at post time (isBusinessFailure ⇒ true).
    const businessError = insufficientFundsError();
    mocks.state.postingError = businessError;

    const res = await capture(service.confirmTransfer(confirmParams()));

    // The SAME business error propagates — the client still gets the correct 4xx, never a 500 and
    // never a swallowed error.
    expect(res.ok).toBe(false);
    expect(res.error).toBe(businessError);
    expect(res.error.code).toBe('INSUFFICIENT_FUNDS');

    // Money-safety invariants that must survive the P2a refactor: the post was attempted once and
    // the single-use OTP was consumed exactly once (burned — a replay cannot re-drive it).
    expect(mocks.posting.postPendingInTx).toHaveBeenCalledTimes(1);
    expect(mocks.otp.consume).toHaveBeenCalledTimes(1);

    // The FAILED-header write + the single `transaction.failed` event are now DELEGATED to the
    // reducer (transfers no longer flips the header / writes the outbox itself). Called EXACTLY ONCE
    // (no double-processing), keyed to THIS transfer, carrying the error's code as the reason and a
    // null payee (internal has none) — per recordFailedInTx(queryRunner, transactionId, reason, payee).
    expect(mocks.posting.recordFailedInTx).toHaveBeenCalledTimes(1);
    const call = mocks.posting.recordFailedInTx.mock.calls[0];
    expect(call[1]).toBe(transfer.id);
    expect(call[2]).toBe('INSUFFICIENT_FUNDS');
    expect(call[3] ?? null).toBeNull();

    // Ordering: the delegation happens AFTER the post failed (it is a compensating persist, not a
    // pre-emptive one) and after the OTP was consumed.
    const consumeIdx = mocks.callLog.indexOf('consume');
    const postIdx = mocks.callLog.indexOf('postPendingInTx');
    const failIdx = mocks.callLog.indexOf('recordFailedInTx');
    expect(postIdx).toBeGreaterThan(consumeIdx);
    expect(failIdx).toBeGreaterThan(postIdx);
  });
});

// ---------------------------------------------------------------------------------------------
// confirmTransfer — 2-minute expiry gate: expiry is checked BEFORE the OTP is consumed
// ---------------------------------------------------------------------------------------------

describe('TransfersService.confirmTransfer — expiry gate (checked BEFORE consuming the OTP)', () => {
  it('MONEY-SAFETY: an OVERDUE pending transfer throws TransferExpiredError and does NOT burn the OTP or post', async () => {
    const { service, mocks } = await setup();
    // A PENDING transfer the DB-clock authority reports overdue: `expireIfOverdue` flips it to
    // EXPIRED and returns true; the confirm path gates on THIS before touching the single-use code.
    const overdue = pendingTransfer({ expiresAt: new Date(Date.now() - 60_000) });
    mocks.transactionRepo.findById.mockResolvedValue(overdue);
    mocks.transactionRepo.expireIfOverdue.mockResolvedValue(true);
    mocks.state.consumeResult = { ok: true, remainingAttempts: 3, lockedOut: false };

    const res = await capture(service.confirmTransfer(confirmParams()));

    expect(res.ok).toBe(false);
    expectDomainCode(res.error, ['TRANSFER_EXPIRED'], de.TransferExpiredError);
    // The whole point of "expiry before OTP": the code is NEVER consumed, and nothing posts.
    expect(mocks.otp.consume).not.toHaveBeenCalled();
    expect(mocks.posting.postPendingInTx).not.toHaveBeenCalled();
  });

  it('DETERMINISTIC 410: a concurrent access that expires the transfer between the DB-clock check and the re-read still yields TransferExpiredError (not 409), OTP untouched', async () => {
    const { service, mocks } = await setup();
    // Initial load: PENDING and not yet overdue by the DB clock, so THIS caller's `expireIfOverdue`
    // returns false. But a concurrent initiate/read/confirm flips it to EXPIRED before the re-read.
    const pending = pendingTransfer();
    const expiredByRace = pendingTransfer({ status: 'EXPIRED' });
    mocks.transactionRepo.findById
      .mockResolvedValueOnce(pending) // initial load
      .mockResolvedValue(expiredByRace); // the re-read sees the concurrent EXPIRED
    mocks.transactionRepo.expireIfOverdue.mockResolvedValue(false);
    mocks.state.consumeResult = { ok: true, remainingAttempts: 3, lockedOut: false };

    const res = await capture(service.confirmTransfer(confirmParams()));

    expect(res.ok).toBe(false);
    expectDomainCode(res.error, ['TRANSFER_EXPIRED'], de.TransferExpiredError);
    // Still money-safe AND now precise: EXPIRED (410), and the single-use code is never consumed.
    expect(mocks.otp.consume).not.toHaveBeenCalled();
    expect(mocks.posting.postPendingInTx).not.toHaveBeenCalled();
  });

  it('rejects confirming an already-EXPIRED transfer with TransferNotPendingError (terminal, no OTP, no post)', async () => {
    const { service, mocks } = await setup();
    const expired = pendingTransfer({ status: 'EXPIRED' });
    mocks.transactionRepo.findByIdAndOwner.mockResolvedValue(expired);
    mocks.transactionRepo.findById.mockResolvedValue(expired);

    const res = await capture(service.confirmTransfer(confirmParams()));

    expect(res.ok).toBe(false);
    expectDomainCode(res.error, ['TRANSFER_NOT_PENDING'], de.TransferNotPendingError);
    expect(mocks.otp.consume).not.toHaveBeenCalled();
    expect(mocks.posting.postPendingInTx).not.toHaveBeenCalled();
  });

  it('rejects confirming a CANCELLED (superseded) transfer with TransferNotPendingError and never posts', async () => {
    const { service, mocks } = await setup();
    const cancelled = pendingTransfer({ status: 'CANCELLED', failureReason: 'superseded' });
    mocks.transactionRepo.findByIdAndOwner.mockResolvedValue(cancelled);
    mocks.transactionRepo.findById.mockResolvedValue(cancelled);

    const res = await capture(service.confirmTransfer(confirmParams()));

    expect(res.ok).toBe(false);
    expectDomainCode(res.error, ['TRANSFER_NOT_PENDING'], de.TransferNotPendingError);
    expect(mocks.posting.postPendingInTx).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// cancelTransfer — guarded PENDING→CANCELLED, owner-scoped, idempotent on a terminal row
// ---------------------------------------------------------------------------------------------

describe('TransfersService.cancelTransfer — guarded transition + owner scope', () => {
  it('rejects a missing / non-owned transfer (owner-scoped lookup → null) with TransferNotFoundError', async () => {
    const { service, mocks } = await setup();
    // The owner-scoped lookup (by transfer id + the caller as the debit-account owner) misses.
    mocks.transactionRepo.findByIdAndOwner.mockResolvedValue(null);
    mocks.transactionRepo.findById.mockResolvedValue(null);

    const res = await capture(service.cancelTransfer(cancelParams()));

    expect(res.ok).toBe(false);
    expectDomainCode(res.error, ['TRANSFER_NOT_FOUND'], de.TransferNotFoundError);
  });

  it('rejects cancelling a POSTED transfer with TransferNotPendingError (money already moved)', async () => {
    const { service, mocks } = await setup();
    const posted = pendingTransfer({ status: 'POSTED', postedAt: new Date() });
    mocks.transactionRepo.findByIdAndOwner.mockResolvedValue(posted);
    mocks.transactionRepo.findById.mockResolvedValue(posted);

    const res = await capture(service.cancelTransfer(cancelParams()));

    expect(res.ok).toBe(false);
    expectDomainCode(res.error, ['TRANSFER_NOT_PENDING'], de.TransferNotPendingError);
  });

  it('is idempotent on an already-CANCELLED transfer: returns it CANCELLED without throwing', async () => {
    const { service, mocks } = await setup();
    const cancelled = pendingTransfer({ status: 'CANCELLED', failureReason: 'superseded' });
    mocks.transactionRepo.findByIdAndOwner.mockResolvedValue(cancelled);
    mocks.transactionRepo.findById.mockResolvedValue(cancelled);

    const res = await capture(service.cancelTransfer(cancelParams()));

    expect(res.ok).toBe(true);
    expect(statusOf(res.value)).toBe('CANCELLED');
  });
});

// ---------------------------------------------------------------------------------------------
// getPendingAuthorization — the caller's SINGLE active pending transfer, or null, masked
// ---------------------------------------------------------------------------------------------

describe('TransfersService.getPendingAuthorization — single active pending or null (masked name)', () => {
  it('returns null when the caller has no active pending transfer (findPendingByInitiator → null)', async () => {
    const { service, mocks } = await setup();
    mocks.state.pendingRow = null; // findPendingByInitiator resolves null

    const res = await capture(service.getPendingAuthorization(OWNER));

    expect(res.ok).toBe(true);
    expect(res.value ?? null).toBeNull();
  });

  it('returns the single pending as a read model carrying the destination MASKED name (raw name withheld)', async () => {
    const { service, mocks } = await setup();
    // findPendingByInitiator returns THIS single pending; it credits dst-x (owned by owner-x, holder
    // "Juan Perez", number 2222222222); expireIfOverdue reports it still valid (false).
    const pending = pendingTransfer({
      id: 'pend-1',
      creditAccountId: 'dst-x',
      debitAccountId: 'src-1',
    });
    mocks.state.pendingRow = pending;
    mocks.transactionRepo.expireIfOverdue.mockResolvedValue(false);

    const res = await capture(service.getPendingAuthorization(OWNER));

    expect(res.ok).toBe(true);
    expect(res.value).toBeTruthy();
    // Read model shape: { transaction, destinationAccountNumber, destinationMaskedName }.
    expect(idOf(res.value)).toBe('pend-1');
    expect(res.value.destinationMaskedName).toBe('Jua** Per**'); // masked in the SERVICE
    expect(res.value.destinationAccountNumber).toBe('2222222222'); // dst-x's human number
    expect(JSON.stringify(res.value)).not.toContain('Juan Perez'); // the raw holder name never crosses
  });
});
