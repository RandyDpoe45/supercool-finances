/**
 * Spec 04 — Balance Service, Transfers: EXTERNAL OUTBOUND branch of the TransfersService, driven as
 * a PURE unit (no DB, no real Redis) so it runs in the DEFAULT `npm test`. Written FROM the spec
 * (Transfers "External outbound", "Holds (reservation ledger)") + the developer-locked step-5b brief,
 * NOT from the implementor's code:
 *   - `initiateExternalTransfer` addresses an ENROLLED payee by `payeeId`: a missing / non-owned payee
 *     is a 404 (`PayeeNotFoundError`) and a payee still in cooling-off is a 409 (`PayeeInCoolingOffError`)
 *     — both are PRECONDITIONS that fire BEFORE the money machinery (idempotency wrapper NEVER invoked,
 *     no hold placed, no ledger post);
 *   - on a clean initiate the money op runs and PLACES A HOLD but does NOT post to the ledger (no
 *     balance moves at initiate — the reservation only);
 *   - CONFIRM of an external transfer settles at confirm: it calls `updateHeldInTx` to DECREMENT held
 *     BEFORE the ledger post (the ordering that lets a fully-reserved balance still settle) and marks
 *     the backing hold SETTLED; CONFIRM of an INTERNAL transfer posts WITHOUT touching any hold.
 *
 * The collaborators are MOCKED, but the LOGIC UNDER TEST (which branch fires, whether the money
 * machinery is reached, and — for confirm — in what ORDER held is decremented vs. the post) is the
 * service's own and is NOT mocked away. Every mutating collaborator records its calls into a SHARED,
 * time-ordered call log tagged by target, and unknown methods are captured by a logging Proxy — so the
 * ordering proof is robust to the exact method names the implementor chooses for the hold plumbing
 * (only `updateHeldInTx` is fixed by the brief and asserted by name). Injection is driven through a
 * Nest TestingModule + `useMocker` (matched by DI token), so the proof is independent of constructor
 * arg order.
 *
 * Seams are resolved defensively (the implementor authors the harness accessors + the new domain
 * errors in parallel): if the TransfersService / tokens / `initiateExternalTransfer` are not yet
 * resolvable the suite honest-SKIPs with a loud message rather than crashing the default run. The
 * money-safety observables (held reserved-not-moved, hold place/settle/release, reconciliation) are
 * proven authoritatively against a REAL DB in tests/integration/transfers-external.integration.spec.ts;
 * this unit suite targets the branch/ordering logic that a pure test can pin quickly.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getDataSourceToken } from '@nestjs/typeorm';

import * as harness from '../support/harness';

function tryResolve<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

const TransfersService = tryResolve(() => harness.getTransfersService());
const TRANSFERS_TOKEN = tryResolve(() => harness.getTransfersServiceToken());
const IDEMPOTENCY_TOKEN = tryResolve(() => harness.getIdempotencyServiceToken());
const POSTING_TOKEN = tryResolve(() => harness.getPostingServiceToken());
const OTP_TOKEN = tryResolve(() => harness.getOtpServiceToken());
const ACCOUNT_REPO_TOKEN = tryResolve(() =>
  harness.getRepositoryToken('ACCOUNT_REPOSITORY', 'account'),
);
const TRANSACTION_REPO_TOKEN = tryResolve(() =>
  harness.getRepositoryToken('TRANSACTION_REPOSITORY', 'transaction'),
);
const EXTERNAL_PAYEE_REPO_TOKEN = tryResolve(() =>
  harness.getRepositoryToken('EXTERNAL_PAYEE_REPOSITORY', 'external-payee'),
);
// The new step-5b harness accessor if present; otherwise resolve the Symbol via the generic repo
// probe (HOLD_REPOSITORY lives in database/repositories/interfaces/hold.repository.interface.ts).
const HOLD_REPO_TOKEN =
  tryResolve(() => (harness as any).getHoldRepositoryToken?.()) ??
  tryResolve(() => harness.getRepositoryToken('HOLD_REPOSITORY', 'hold'));
const CUSTOMER_REPO_TOKEN = tryResolve(() => harness.getCustomerRepositoryToken());
const REDIS_TOKEN = tryResolve(() => harness.getRedisClientToken());
const APP_CONFIG_TOKEN = tryResolve(() => harness.getAppConfigToken());
const de: any = harness.getDomainErrors();

const DS_TOKEN = tryResolve(() => getDataSourceToken());

// The step-5b method the implementor authors in parallel. Checked STATICALLY on the prototype (no
// DI) so, until it lands, the suite honest-SKIPs rather than failing the default `npm test` — a skip
// is never a false pass.
const hasExternalInitiate = Boolean(
  TransfersService &&
  (TransfersService as any).prototype &&
  typeof (TransfersService as any).prototype.initiateExternalTransfer === 'function',
);

const canRun = Boolean(
  TransfersService &&
  TRANSFERS_TOKEN &&
  ACCOUNT_REPO_TOKEN &&
  TRANSACTION_REPO_TOKEN &&
  EXTERNAL_PAYEE_REPO_TOKEN &&
  HOLD_REPO_TOKEN &&
  hasExternalInitiate,
);

if (!canRun) {
  console.info(
    '[unit] SKIPPED transfers-external.service suite: could not resolve TransfersService / its token / ' +
      'ACCOUNT|TRANSACTION|EXTERNAL_PAYEE|HOLD repository tokens (or TransfersService.initiateExternalTransfer ' +
      'is not yet defined) via tests/support/harness.ts. Add the path/export there (the single coordination ' +
      'point) — the suite activates once the step-5b method exists.',
  );
}

const suite = canRun ? describe : describe.skip;

const OWNER = 'sub-alice';

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

interface CallEntry {
  target: string;
  method: string;
  args: any[];
}

interface State {
  payee: any; // what the external-payee finder returns (null ⇒ missing / non-owned)
  source: any; // the locked/owned source account
  clearing: any; // resolved clearing (system) account
  hold: any; // the PLACED hold the confirm/cancel path loads
  consumeResult: any;
  findByIdResult: any; // the transfer confirm/cancel loads
}

interface Mocks {
  idempotency: any;
  posting: any;
  otp: any;
  accountRepo: any;
  transactionRepo: any;
  externalPayeeRepo: any;
  holdRepo: any;
  customerRepo: any;
  redis: any;
  dataSource: any;
  appConfig: any;
  callLog: CallEntry[];
  state: State;
}

function makeMocks(): Mocks {
  const callLog: CallEntry[] = [];
  const log = (target: string, method: string, args: any[]) =>
    callLog.push({ target, method, args });

  const state: State = {
    payee: {
      id: 'payee-1',
      ownerId: OWNER,
      displayName: 'Acme Payments',
      destinationRef: '123456789012',
      rail: 'rail-outbound',
      coolingOffUntil: new Date(Date.now() - 60_000), // usable by default (past)
      status: 'pending',
    },
    source: {
      id: 'src-1',
      ownerId: OWNER,
      kind: 'customer',
      currency: 'MXN',
      status: 'active',
      balance: '10000',
      held: '0',
      accountNumber: '1111111111',
    },
    clearing: {
      id: 'clearing-1',
      ownerId: null,
      kind: 'system',
      currency: 'MXN',
      status: 'active',
      systemKey: 'clearing:rail-outbound',
    },
    hold: {
      id: 'hold-1',
      accountId: 'src-1',
      transactionId: 'tx-op',
      amount: '4000',
      status: 'PLACED',
    },
    consumeResult: { ok: true, remainingAttempts: 3, lockedOut: false },
    findByIdResult: null,
  };

  // The DB-clock read (`SELECT now()`) the service uses for the cooling-off gate and expiry math —
  // return a real "now" so the gate is judged on a live clock (any other raw SQL → []).
  const nowAwareQuery = async (sql?: unknown) =>
    /now\(\)/i.test(String(sql)) ? [{ now: new Date() }] : [];

  const fakeManager = {
    query: jest.fn(nowAwareQuery),
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
    query: jest.fn(nowAwareQuery),
  };

  const idempotency = {
    execute: jest.fn(async (_params: any, op?: any) => {
      log('idempotency', 'execute', [_params]);
      if (typeof op === 'function') {
        const r = await op(fakeQueryRunner);
        return { transactionId: r?.transactionId ?? r?.id ?? 'tx-op', replayed: false };
      }
      return { transactionId: 'tx-op', replayed: false };
    }),
  };

  const posting = {
    postPendingInTx: jest.fn(async (_qr: any, transactionId: string, cmd: any) => {
      log('posting', 'postPendingInTx', [transactionId, cmd]);
      return { ...(state.findByIdResult ?? {}), id: transactionId, status: 'POSTED' };
    }),
    postTransaction: jest.fn(async (cmd: any) => {
      log('posting', 'postTransaction', [cmd]);
      return { id: 'tx-op', status: 'POSTED' };
    }),
  };

  const otp = {
    consume: jest.fn(async () => {
      log('otp', 'consume', []);
      return state.consumeResult;
    }),
    generate: jest.fn(async () => ({ code: '123456', ttlSeconds: 300 })),
  };

  // A logging Proxy: explicit methods (return values matter) live on `known`; any OTHER accessed
  // method is captured lazily — logged and returning `finderDefault()` for finder-shaped names, else
  // undefined — so a call the service makes for hold/held plumbing is RECORDED (provable order) rather
  // than throwing and masking the assertion, and finder-shaped calls still yield a usable value.
  function loggingRepo(
    name: string,
    known: Record<string, (...a: any[]) => any>,
    finderDefault: () => any,
  ): any {
    const base: any = {};
    for (const [m, impl] of Object.entries(known)) {
      base[m] = jest.fn(async (...args: any[]) => {
        log(name, m, args);
        return impl(...args);
      });
    }
    return new Proxy(base, {
      get(target: any, prop, receiver) {
        if (typeof prop !== 'string') return Reflect.get(target, prop, receiver);
        if (prop === 'then') return undefined;
        if (prop in target) return target[prop];
        const isFinder = /find|get|lock|load|read|resolve|by/i.test(prop);
        const fn = jest.fn(async (...args: any[]) => {
          log(name, prop, args);
          return isFinder ? finderDefault() : undefined;
        });
        target[prop] = fn;
        return fn;
      },
    });
  }

  const accountRepo = loggingRepo(
    'account',
    {
      findByIdAndOwner: () => state.source,
      lockByIdForUpdate: () => state.source,
      findById: () => state.source,
      findBySystemKey: () => state.clearing,
    },
    () => state.clearing, // any other finder-shaped call resolves the clearing/system account
  );

  const transactionRepo = loggingRepo(
    'transaction',
    {
      findById: () => state.findByIdResult,
      findByIdAndOwner: () => state.findByIdResult,
      findPendingByInitiator: () => null,
      // The repo stamps a DB-clock `expires_at` on the PENDING header; mirror that so the service's
      // "header carries a TTL" invariant (which the PLACED hold's expiry mirrors) is satisfied.
      insertPendingInTx: (_qr: any, d: any) => ({
        id: 'tx-op',
        expiresAt: new Date(Date.now() + 120_000),
        ...(d ?? {}),
      }),
      expireOverduePendingByInitiator: () => undefined,
      supersedeActivePendingByInitiator: () => undefined,
      expireIfOverdue: () => false,
      transitionToCancelled: () => true,
    },
    () => null,
  );

  const externalPayeeRepo = loggingRepo(
    'externalPayee',
    {
      // The owner-scoped payee lookup — whatever the implementor names it, finder-shaped fallbacks
      // also return state.payee, so the ownership/cooling-off branch is driven by the SAME value.
      findByIdAndOwner: () => state.payee,
      findByOwnerAndId: () => state.payee,
      findById: () => state.payee,
    },
    () => state.payee,
  );

  const holdRepo = loggingRepo(
    'hold',
    {
      // The confirm/cancel path loads the PLACED hold via some finder; all finder-shaped calls
      // return it. Mutations (place/settle/release) are non-finder → logged, return undefined.
      findByTransactionId: () => state.hold,
      lockByTransactionIdForUpdate: () => state.hold,
      findById: () => state.hold,
    },
    () => state.hold,
  );

  const customerRepo = {
    findById: jest.fn(async () => ({
      id: OWNER,
      name: 'Alice',
      phone: '5210000000000',
      email: 'a@t.test',
    })),
  };

  const redisStore = new Map<string, string>();
  const redis = {
    get: jest.fn(async (key: string) => (redisStore.has(key) ? redisStore.get(key)! : null)),
    set: jest.fn(async (key: string, val: string) => {
      redisStore.set(key, val);
      return 'OK';
    }),
    del: jest.fn(async (...keys: string[]) => {
      for (const k of keys) redisStore.delete(k);
      return keys.length;
    }),
  };

  const dataSource = {
    transaction: jest.fn(async (arg1: any, arg2: any) => {
      const cb = typeof arg1 === 'function' ? arg1 : arg2;
      return cb(fakeManager);
    }),
    createQueryRunner: jest.fn(() => fakeQueryRunner),
    query: jest.fn(nowAwareQuery),
  };

  const appConfig = {
    otp: { hashSecret: 'x'.repeat(24) },
    internalServiceToken: 'svc',
    payees: { coolingOffSeconds: 3600 },
  };

  return {
    idempotency,
    posting,
    otp,
    accountRepo,
    transactionRepo,
    externalPayeeRepo,
    holdRepo,
    customerRepo,
    redis,
    dataSource,
    appConfig,
    callLog,
    state,
  };
}

function isDataSourceToken(token: any): boolean {
  if (token === DataSource) return true;
  if (DS_TOKEN && token === DS_TOKEN) return true;
  return typeof token === 'string' && /datasource|connection/i.test(token);
}

async function setup(): Promise<{ service: any; mocks: Mocks }> {
  const mocks = makeMocks();
  const moduleRef = await Test.createTestingModule({
    providers: [{ provide: TRANSFERS_TOKEN as symbol, useClass: TransfersService }],
  })
    .useMocker((token) => {
      if (IDEMPOTENCY_TOKEN && token === IDEMPOTENCY_TOKEN) return mocks.idempotency;
      if (POSTING_TOKEN && token === POSTING_TOKEN) return mocks.posting;
      if (OTP_TOKEN && token === OTP_TOKEN) return mocks.otp;
      if (token === ACCOUNT_REPO_TOKEN) return mocks.accountRepo;
      if (token === TRANSACTION_REPO_TOKEN) return mocks.transactionRepo;
      if (token === EXTERNAL_PAYEE_REPO_TOKEN) return mocks.externalPayeeRepo;
      if (token === HOLD_REPO_TOKEN) return mocks.holdRepo;
      if (CUSTOMER_REPO_TOKEN && token === CUSTOMER_REPO_TOKEN) return mocks.customerRepo;
      if (REDIS_TOKEN && token === REDIS_TOKEN) return mocks.redis;
      if (APP_CONFIG_TOKEN && token === APP_CONFIG_TOKEN) return mocks.appConfig;
      if (isDataSourceToken(token)) return mocks.dataSource;
      return autoMock();
    })
    .compile();
  const service = moduleRef.get(TRANSFERS_TOKEN as symbol, { strict: false });
  return { service, mocks };
}

function initiateParams(overrides: Record<string, unknown> = {}): any {
  const key = 'key-ext-1';
  return {
    ownerId: OWNER,
    sub: OWNER,
    sourceAccountId: 'src-1',
    payeeId: 'payee-1',
    amount: '4000',
    currency: 'MXN',
    idempotencyKey: key,
    key,
    ...overrides,
  };
}

function confirmParams(overrides: Record<string, unknown> = {}): any {
  return {
    ownerId: OWNER,
    sub: OWNER,
    transferId: 'tx-op',
    id: 'tx-op',
    transactionId: 'tx-op',
    code: '123456',
    ...overrides,
  };
}

function externalPending(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'tx-op',
    status: 'PENDING',
    type: 'external_outbound',
    amount: '4000',
    currency: 'MXN',
    debitAccountId: 'src-1',
    creditAccountId: 'clearing-1',
    payeeId: 'payee-1',
    initiatedBy: OWNER,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    postedAt: null,
    expiresAt: new Date(Date.now() + 120_000),
    ...overrides,
  };
}

function internalPending(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'tx-op',
    status: 'PENDING',
    type: 'internal',
    amount: '4000',
    currency: 'MXN',
    debitAccountId: 'src-1',
    creditAccountId: 'dst-x',
    initiatedBy: OWNER,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    postedAt: null,
    expiresAt: new Date(Date.now() + 120_000),
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

function statusOf(v: any): string | undefined {
  return v?.transaction?.status ?? v?.status;
}

function firstIndex(log: CallEntry[], pred: (e: CallEntry) => boolean): number {
  return log.findIndex(pred);
}

// ---------------------------------------------------------------------------------------------
// initiateExternalTransfer — payee gates fire BEFORE the money machinery
// ---------------------------------------------------------------------------------------------

suite(
  'TransfersService.initiateExternalTransfer — enrolled-payee preconditions (no money moves on rejection)',
  () => {
    it('rejects a MISSING / non-owned payee with a 404-class PayeeNotFound — idempotency NEVER invoked, no hold, no post', async () => {
      const { service, mocks } = await setup();
      mocks.state.payee = null; // the owner-scoped payee lookup misses

      const res = await capture(service.initiateExternalTransfer(initiateParams()));

      expect(res.ok).toBe(false);
      expect(['PAYEE_NOT_FOUND', 'TRANSFER_NOT_FOUND']).toContain(res.error?.code);
      if (de.PayeeNotFoundError) expect(res.error).toBeInstanceOf(de.PayeeNotFoundError);
      // The gate is a PRECONDITION: no reservation, no idempotency claim, no ledger post.
      expect(mocks.idempotency.execute).not.toHaveBeenCalled();
      expect(mocks.posting.postPendingInTx).not.toHaveBeenCalled();
      expect(mocks.posting.postTransaction).not.toHaveBeenCalled();
      expect(mocks.callLog.some((e) => e.target === 'hold')).toBe(false); // no hold placed
    });

    it('rejects a payee still in COOLING-OFF with 409 PayeeInCoolingOff — idempotency NEVER invoked, no hold, no post', async () => {
      const { service, mocks } = await setup();
      // Owned by the caller but its cooling-off window is still in the FUTURE (now() < cooling_off_until).
      mocks.state.payee = {
        id: 'payee-1',
        ownerId: OWNER,
        displayName: 'Acme Payments',
        destinationRef: '123456789012',
        rail: 'rail-outbound',
        coolingOffUntil: new Date(Date.now() + 3_600_000),
        status: 'pending',
      };

      const res = await capture(service.initiateExternalTransfer(initiateParams()));

      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe('PAYEE_IN_COOLING_OFF');
      if (de.PayeeInCoolingOffError) expect(res.error).toBeInstanceOf(de.PayeeInCoolingOffError);
      expect(mocks.idempotency.execute).not.toHaveBeenCalled();
      expect(mocks.posting.postPendingInTx).not.toHaveBeenCalled();
      expect(mocks.callLog.some((e) => e.target === 'hold')).toBe(false);
    });

    it('on a clean initiate the money op runs and PLACES A HOLD but does NOT post to the ledger (initiate reserves, never moves)', async () => {
      const { service, mocks } = await setup();
      // The idempotency op inserts the PENDING external txn; the service then loads it.
      mocks.state.findByIdResult = externalPending();

      const res = await capture(service.initiateExternalTransfer(initiateParams()));

      expect(res.ok).toBe(true);
      // The gates passed → the money op ran under the idempotency claim exactly once.
      expect(mocks.idempotency.execute).toHaveBeenCalledTimes(1);
      // A reservation was made: the hold repository was touched during initiate.
      expect(mocks.callLog.some((e) => e.target === 'hold')).toBe(true);
      // But NO money moved at initiate: the ledger-posting reducer is NEVER called.
      expect(mocks.posting.postPendingInTx).not.toHaveBeenCalled();
      expect(mocks.posting.postTransaction).not.toHaveBeenCalled();
      // The created header is a PENDING external_outbound.
      expect(statusOf(res.value)).toBe('PENDING');
    });
  },
);

// ---------------------------------------------------------------------------------------------
// confirmTransfer — external SETTLES (held decremented BEFORE the post); internal touches no hold
// ---------------------------------------------------------------------------------------------

suite(
  'TransfersService.confirmTransfer — external settle ordering vs. internal (no-hold) post',
  () => {
    it('EXTERNAL settle: `updateHeldInTx` DECREMENTS held BEFORE the ledger post, and the backing hold is settled/mutated', async () => {
      const { service, mocks } = await setup();
      mocks.state.findByIdResult = externalPending();

      const res = await capture(service.confirmTransfer(confirmParams()));

      expect(res.ok).toBe(true);
      expect(statusOf(res.value)).toBe('POSTED');

      const heldIdx = firstIndex(mocks.callLog, (e) => e.method === 'updateHeldInTx');
      const postIdx = firstIndex(mocks.callLog, (e) => /post/i.test(e.method));
      // The ordering safety property: held is released FIRST, so the post's funds check does not
      // double-count the hold this settle is consuming.
      expect(heldIdx).toBeGreaterThanOrEqual(0);
      expect(postIdx).toBeGreaterThanOrEqual(0);
      expect(heldIdx).toBeLessThan(postIdx);
      // The backing hold was mutated during confirm (settled) — the reservation ledger is updated.
      expect(mocks.callLog.some((e) => e.target === 'hold')).toBe(true);
    });

    it('INTERNAL confirm posts WITHOUT touching any hold (no `updateHeldInTx`, no hold-repo call) — internal transfers place no hold', async () => {
      const { service, mocks } = await setup();
      mocks.state.findByIdResult = internalPending();

      const res = await capture(service.confirmTransfer(confirmParams()));

      expect(res.ok).toBe(true);
      expect(statusOf(res.value)).toBe('POSTED');
      // The post happened...
      expect(mocks.posting.postPendingInTx).toHaveBeenCalledTimes(1);
      // ...but NO hold machinery was engaged for an internal transfer.
      expect(mocks.callLog.some((e) => e.method === 'updateHeldInTx')).toBe(false);
      expect(mocks.callLog.some((e) => e.target === 'hold')).toBe(false);
    });
  },
);
