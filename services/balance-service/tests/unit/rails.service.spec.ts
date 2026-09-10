/**
 * Spec 04 — Balance Service, step 5c: the RailsService (outbound settlement callback + inbound
 * credit) driven as a PURE unit (no DB, no real Redis) so it runs in the DEFAULT `npm test`. Written
 * FROM the spec ("Mocked external rails") + the developer-locked step-5c brief, NOT the impl.
 *
 * The LOGIC UNDER TEST is the service's own branch machinery — which is NOT mocked away:
 *   - settlement SUCCESS is RECONCILE-ONLY → the injected POSTING service is NEVER called (no ledger
 *     movement) and the rail `externalRef` is recorded on the settled hold;
 *   - settlement FAILURE is a COMPENSATING REVERSAL → the POSTING service IS called (the refund
 *     movement clearing→customer);
 *   - a repeated SUCCESS (ref already recorded) or repeated FAILURE (already REVERSED) is a NO-OP
 *     (posting still never re-invoked);
 *   - success-after-failure / failure-after-success → INVALID_SETTLEMENT_STATE;
 *   - an unknown transaction id → SETTLEMENT_TARGET_NOT_FOUND;
 *   - inbound resolves the destination BY ACCOUNT NUMBER and credits via the posting reducer; an
 *     unresolvable account → INBOUND_DESTINATION_NOT_FOUND and NO credit.
 *
 * Collaborators are MOCKED (matched by DI token via a Nest TestingModule + `useMocker`, so injection
 * is order-independent), and every mutating collaborator records into a shared call log. A logging
 * Proxy captures method names the implementor may choose (only the injected POSTING service is
 * asserted by its fixed methods) — the money-safety observables (money moved once / not at all,
 * refund-once, idempotent-by-ref, reconciliation) are proven AUTHORITATIVELY against a real DB in
 * tests/integration/rails-webhooks.integration.spec.ts; this unit suite pins the branch logic a pure
 * test can catch fast (the reconcile-writes-no-ledger tripwire above all).
 *
 * Seams are resolved defensively (the implementor authors the harness accessors + the new domain
 * errors + the RailsService in parallel): if the RailsService class / its settlement+inbound handlers
 * are not yet resolvable, the suite honest-SKIPs with a loud message rather than crashing (or
 * silently passing) the default run.
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

// Settlement `status` literal — DEVELOPER-LOCKED to lowercase `'success'` / `'failure'` (the wire
// schema is `z.enum(['success','failure'])`); the earlier ambiguity is resolved.
const STATUS_SUCCESS = 'success';
const STATUS_FAILURE = 'failure';

// The locked interface method is `settleOutbound` (kept first); the rest are fallbacks.
const SETTLE_METHODS = [
  'settleOutbound',
  'handleSettlementCallback',
  'settlementCallback',
  'processSettlementCallback',
  'processSettlement',
  'onSettlementCallback',
  'handleSettlement',
  'settle',
];
const INBOUND_METHODS = [
  'handleInbound',
  'processInbound',
  'creditInbound',
  'inboundCredit',
  'onInbound',
  'handleInboundCredit',
  'inbound',
];

const RailsService = tryResolve(() => (harness as any).getRailsService?.());
const RAILS_TOKEN = tryResolve(() => (harness as any).getRailsServiceToken?.());
const POSTING_TOKEN = tryResolve(() => harness.getPostingServiceToken());
const IDEMPOTENCY_TOKEN = tryResolve(() => harness.getIdempotencyServiceToken());
const ACCOUNT_REPO_TOKEN = tryResolve(() =>
  harness.getRepositoryToken('ACCOUNT_REPOSITORY', 'account'),
);
const TRANSACTION_REPO_TOKEN = tryResolve(() =>
  harness.getRepositoryToken('TRANSACTION_REPOSITORY', 'transaction'),
);
const HOLD_REPO_TOKEN = tryResolve(() => harness.getHoldRepositoryToken());
const CUSTOMER_REPO_TOKEN = tryResolve(() => harness.getCustomerRepositoryToken());
const REDIS_TOKEN = tryResolve(() => harness.getRedisClientToken());
const APP_CONFIG_TOKEN = tryResolve(() => harness.getAppConfigToken());
const de: any = harness.getDomainErrors();
const DS_TOKEN = tryResolve(() => getDataSourceToken());

function pickMethodName(cls: any, names: string[]): string | undefined {
  const proto = cls?.prototype;
  if (!proto) return undefined;
  for (const n of names) if (typeof proto[n] === 'function') return n;
  return undefined;
}

const settleMethod = RailsService ? pickMethodName(RailsService, SETTLE_METHODS) : undefined;
const inboundMethod = RailsService ? pickMethodName(RailsService, INBOUND_METHODS) : undefined;

const canRun = Boolean(
  RailsService && RAILS_TOKEN && POSTING_TOKEN && HOLD_REPO_TOKEN && settleMethod && inboundMethod,
);

if (!canRun) {
  console.info(
    '[unit] SKIPPED rails.service suite: could not resolve the RailsService class / its token / a ' +
      'settlement+inbound handler via tests/support/harness.ts (getRailsService / getRailsServiceToken). ' +
      'Add the path/export there (the single coordination point) and/or the actual method name to the ' +
      'candidate lists in this spec — the suite activates once the step-5c service exists.',
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
  transaction: any; // the settle target (null ⇒ unknown transaction id)
  hold: any; // the SETTLED hold backing the transfer (externalRef null ⇒ not yet reconciled)
  inboundAccount: any; // the account resolved by account number for inbound (null ⇒ unknown)
}

interface Mocks {
  posting: any;
  idempotency: any;
  accountRepo: any;
  transactionRepo: any;
  holdRepo: any;
  customerRepo: any;
  redis: any;
  dataSource: any;
  appConfig: any;
  callLog: CallEntry[];
  state: State;
}

const CLEARING_OUT = {
  id: 'clearing-out-1',
  kind: 'system',
  currency: 'MXN',
  status: 'active',
  systemKey: 'clearing:rail-outbound',
};
const CLEARING_IN = {
  id: 'clearing-in-1',
  kind: 'system',
  currency: 'MXN',
  status: 'active',
  systemKey: 'clearing:rail-inbound',
};

function customerAccount(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'src-1',
    ownerId: OWNER,
    kind: 'customer',
    currency: 'MXN',
    status: 'active',
    balance: '6000',
    held: '0',
    accountNumber: '1234567890',
    ...overrides,
  };
}

function externalOutboundPosted(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'tx-1',
    type: 'external_outbound',
    status: 'POSTED',
    amount: '4000',
    currency: 'MXN',
    debitAccountId: 'src-1',
    creditAccountId: 'clearing-out-1',
    initiatedBy: OWNER,
    reversesTransactionId: null,
    ...overrides,
  };
}

function settledHold(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'hold-1',
    accountId: 'src-1',
    transactionId: 'tx-1',
    amount: '4000',
    status: 'SETTLED',
    externalRef: null,
    rail: 'rail-outbound',
    ...overrides,
  };
}

function makeMocks(): Mocks {
  const callLog: CallEntry[] = [];
  const log = (target: string, method: string, args: any[]) =>
    callLog.push({ target, method, args });

  const state: State = {
    transaction: externalOutboundPosted(),
    hold: settledHold(),
    inboundAccount: customerAccount(),
  };

  const nowAwareQuery = async (sql?: unknown) =>
    /now\(\)/i.test(String(sql)) ? [{ now: new Date() }] : [];

  const fakeManager = {
    query: jest.fn(nowAwareQuery),
    save: jest.fn(async (e: any) => e),
    insert: jest.fn(async () => ({ identifiers: [{ id: 'tx-comp' }], raw: [{ id: 'tx-comp' }] })),
    create: jest.fn((_c: any, d: any) => ({ id: 'tx-comp', ...(d ?? {}) })),
    getRepository: jest.fn(() => ({
      save: jest.fn(async (e: any) => e),
      insert: jest.fn(async () => ({ identifiers: [{ id: 'tx-comp' }] })),
      create: jest.fn((d: any) => ({ id: 'tx-comp', ...(d ?? {}) })),
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

  // The RailsService funnels EVERY money movement through the injected POSTING service's
  // `postFreshInTx(queryRunner, command)` (the locked interface method). success reconcile must
  // never call it; failure reversal + inbound credit must.
  const posting = {
    postTransaction: jest.fn(async (cmd: any) => {
      log('posting', 'postTransaction', [cmd]);
      return { id: 'tx-comp', status: 'POSTED' };
    }),
    postPendingInTx: jest.fn(async (_qr: any, id: string, cmd: any) => {
      log('posting', 'postPendingInTx', [id, cmd]);
      return { id, status: 'POSTED' };
    }),
    postFreshInTx: jest.fn(async (_qr: any, cmd: any) => {
      log('posting', 'postFreshInTx', [cmd]);
      return { id: 'tx-comp', status: 'POSTED' };
    }),
  };

  const idempotency = {
    execute: jest.fn(async (params: any, op?: any) => {
      log('idempotency', 'execute', [params]);
      if (typeof op === 'function') {
        const r = await op(fakeQueryRunner);
        return { transactionId: r?.transactionId ?? r?.id ?? 'tx-inb', replayed: false };
      }
      return { transactionId: 'tx-inb', replayed: false };
    }),
  };

  function loggingRepo(
    name: string,
    known: Record<string, (...a: any[]) => any>,
    finderDefault: (...a: any[]) => any,
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
          return isFinder ? finderDefault(...args) : undefined;
        });
        target[prop] = fn;
        return fn;
      },
    });
  }

  // The account repo serves BOTH "resolve by account number" (inbound) and "lock clearing / source"
  // (reversal + credit). finderDefault disambiguates by the shape of the first arg (a 10-digit string
  // ⇒ account-number resolution; a `clearing:` key ⇒ the matching system account; else the source).
  const accountFinder = (...args: any[]) => {
    const a0 = args[0];
    if (typeof a0 === 'string' && /^\d{10}$/.test(a0)) return state.inboundAccount;
    if (typeof a0 === 'string' && a0.includes('clearing:'))
      return a0.includes('inbound') ? CLEARING_IN : CLEARING_OUT;
    return customerAccount();
  };
  const accountRepo = loggingRepo(
    'account',
    {
      findByAccountNumber: (n: string) =>
        /^\d{10}$/.test(String(n)) ? state.inboundAccount : null,
      findByNumber: (n: string) => (/^\d{10}$/.test(String(n)) ? state.inboundAccount : null),
      resolveByAccountNumber: (n: string) =>
        /^\d{10}$/.test(String(n)) ? state.inboundAccount : null,
      lockByIdForUpdate: () => customerAccount(),
      findById: () => customerAccount(),
      findBySystemKey: (k: string) => (String(k).includes('inbound') ? CLEARING_IN : CLEARING_OUT),
    },
    accountFinder,
  );

  const transactionRepo = loggingRepo(
    'transaction',
    {
      findById: () => state.transaction,
      findByIdInTx: () => state.transaction,
      lockByIdForUpdate: () => state.transaction,
      findByIdForUpdate: () => state.transaction,
      // Guarded POSTED → REVERSED: succeeds (true) only from POSTED, so a repeated failure on an
      // already-REVERSED transfer returns false (idempotent no-op — no second compensating post).
      transitionToReversedInTx: () => state.transaction?.status === 'POSTED',
    },
    () => state.transaction,
  );

  const holdRepo = loggingRepo(
    'hold',
    {
      findByTransactionId: () => state.hold,
      lockByTransactionIdForUpdate: () => state.hold,
      findByTransactionInTx: () => state.hold,
      findById: () => state.hold,
      recordExternalRefInTx: () => undefined, // (queryRunner, holdId, externalRef) → logged with the ref
    },
    () => state.hold,
  );

  const customerRepo = {
    findById: jest.fn(async () => ({ id: OWNER, name: 'Alice' })),
  };

  const redisStore = new Map<string, string>();
  const redis = {
    get: jest.fn(async (k: string) => (redisStore.has(k) ? redisStore.get(k)! : null)),
    set: jest.fn(async (k: string, v: string) => {
      redisStore.set(k, v);
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
    rails: { webhookApiKey: 'test-rails-webhook-api-key' },
    payees: { coolingOffSeconds: 3600 },
  };

  return {
    posting,
    idempotency,
    accountRepo,
    transactionRepo,
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
    providers: [{ provide: RAILS_TOKEN as symbol, useClass: RailsService }],
  })
    .useMocker((token) => {
      if (POSTING_TOKEN && token === POSTING_TOKEN) return mocks.posting;
      if (IDEMPOTENCY_TOKEN && token === IDEMPOTENCY_TOKEN) return mocks.idempotency;
      if (ACCOUNT_REPO_TOKEN && token === ACCOUNT_REPO_TOKEN) return mocks.accountRepo;
      if (TRANSACTION_REPO_TOKEN && token === TRANSACTION_REPO_TOKEN) return mocks.transactionRepo;
      if (token === HOLD_REPO_TOKEN) return mocks.holdRepo;
      if (CUSTOMER_REPO_TOKEN && token === CUSTOMER_REPO_TOKEN) return mocks.customerRepo;
      if (REDIS_TOKEN && token === REDIS_TOKEN) return mocks.redis;
      if (APP_CONFIG_TOKEN && token === APP_CONFIG_TOKEN) return mocks.appConfig;
      if (isDataSourceToken(token)) return mocks.dataSource;
      return autoMock();
    })
    .compile();
  const service = moduleRef.get(RAILS_TOKEN as symbol, { strict: false });
  return { service, mocks };
}

async function capture(p: Promise<any>): Promise<{ ok: boolean; value?: any; error?: any }> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

function settleCodeOf(err: any): string {
  if (de.SettlementTargetNotFoundError && err instanceof de.SettlementTargetNotFoundError)
    return 'SETTLEMENT_TARGET_NOT_FOUND';
  if (de.InvalidSettlementStateError && err instanceof de.InvalidSettlementStateError)
    return 'INVALID_SETTLEMENT_STATE';
  if (de.InboundDestinationNotFoundError && err instanceof de.InboundDestinationNotFoundError)
    return 'INBOUND_DESTINATION_NOT_FOUND';
  return (err?.code ?? '') as string;
}

const postingCalled = (m: Mocks): boolean =>
  m.posting.postTransaction.mock.calls.length > 0 ||
  m.posting.postPendingInTx.mock.calls.length > 0 ||
  m.posting.postFreshInTx.mock.calls.length > 0;

const REF = 'rail-ref-xyz';

// ---------------------------------------------------------------------------------------------
// SETTLEMENT — success reconciles (NO post), failure reverses (post), idempotency + mutual exclusion
// ---------------------------------------------------------------------------------------------

suite(
  'RailsService settlement callback — reconcile vs reverse (the no-double-move tripwire)',
  () => {
    it('SUCCESS reconciles: the POSTING service is NEVER called, and the rail externalRef is recorded on the settled hold', async () => {
      const { service, mocks } = await setup();
      mocks.state.transaction = externalOutboundPosted();
      mocks.state.hold = settledHold({ externalRef: null });

      const res = await capture(
        service[settleMethod!]({ transactionId: 'tx-1', status: STATUS_SUCCESS, externalRef: REF }),
      );
      expect(res.ok).toBe(true);

      // The keystone: success posts NOTHING to the ledger (the money already moved at 5b confirm).
      expect(postingCalled(mocks)).toBe(false);
      // The rail ref is recorded on the hold — a hold-repo call carried the externalRef value.
      const holdTouchedWithRef = mocks.callLog.some(
        (e) => e.target === 'hold' && e.args.some((a) => a === REF),
      );
      expect(holdTouchedWithRef).toBe(true);
    });

    it('FAILURE reverses: the POSTING service IS called (the compensating refund movement)', async () => {
      const { service, mocks } = await setup();
      mocks.state.transaction = externalOutboundPosted();
      mocks.state.hold = settledHold({ externalRef: null });

      const res = await capture(
        service[settleMethod!]({ transactionId: 'tx-1', status: STATUS_FAILURE, externalRef: REF }),
      );
      expect(res.ok).toBe(true);

      // A compensating movement is posted (contrast with SUCCESS, which posts nothing).
      expect(postingCalled(mocks)).toBe(true);
    });

    it('repeated SUCCESS (hold ref already recorded) is a NO-OP — the POSTING service is still never called', async () => {
      const { service, mocks } = await setup();
      mocks.state.transaction = externalOutboundPosted({ status: 'POSTED' });
      mocks.state.hold = settledHold({ externalRef: REF }); // already reconciled

      const res = await capture(
        service[settleMethod!]({ transactionId: 'tx-1', status: STATUS_SUCCESS, externalRef: REF }),
      );
      expect(res.ok).toBe(true);
      expect(postingCalled(mocks)).toBe(false); // no double anything
    });

    it('repeated FAILURE (already REVERSED) is a NO-OP — the POSTING service is NOT called again (no double-refund)', async () => {
      const { service, mocks } = await setup();
      mocks.state.transaction = externalOutboundPosted({ status: 'REVERSED' });
      mocks.state.hold = settledHold({ externalRef: null });

      const res = await capture(
        service[settleMethod!]({ transactionId: 'tx-1', status: STATUS_FAILURE, externalRef: REF }),
      );
      expect(res.ok).toBe(true);
      expect(postingCalled(mocks)).toBe(false); // the reversal already happened; do not post again
    });

    it('success-after-failure → INVALID_SETTLEMENT_STATE (tx already REVERSED); posting NOT called', async () => {
      const { service, mocks } = await setup();
      mocks.state.transaction = externalOutboundPosted({ status: 'REVERSED' });
      mocks.state.hold = settledHold({ externalRef: null });

      const res = await capture(
        service[settleMethod!]({ transactionId: 'tx-1', status: STATUS_SUCCESS, externalRef: REF }),
      );
      expect(res.ok).toBe(false);
      expect(settleCodeOf(res.error)).toBe('INVALID_SETTLEMENT_STATE');
      expect(postingCalled(mocks)).toBe(false);
    });

    it('failure-after-success → INVALID_SETTLEMENT_STATE (hold already reconciled); posting NOT called (no refund)', async () => {
      const { service, mocks } = await setup();
      mocks.state.transaction = externalOutboundPosted({ status: 'POSTED' });
      mocks.state.hold = settledHold({ externalRef: REF }); // success already applied

      const res = await capture(
        service[settleMethod!]({
          transactionId: 'tx-1',
          status: STATUS_FAILURE,
          externalRef: 'other',
        }),
      );
      expect(res.ok).toBe(false);
      expect(settleCodeOf(res.error)).toBe('INVALID_SETTLEMENT_STATE');
      expect(postingCalled(mocks)).toBe(false);
    });

    it('unknown transaction id → SETTLEMENT_TARGET_NOT_FOUND; posting NOT called', async () => {
      const { service, mocks } = await setup();
      mocks.state.transaction = null; // correlation misses

      const res = await capture(
        service[settleMethod!]({ transactionId: 'nope', status: STATUS_SUCCESS, externalRef: REF }),
      );
      expect(res.ok).toBe(false);
      expect(settleCodeOf(res.error)).toBe('SETTLEMENT_TARGET_NOT_FOUND');
      expect(postingCalled(mocks)).toBe(false);
    });
  },
);

// ---------------------------------------------------------------------------------------------
// INBOUND — resolve by account number, credit via posting; unknown account rejects (no credit)
// ---------------------------------------------------------------------------------------------

suite('RailsService inbound credit — resolve-by-number + credit', () => {
  it('resolves the destination BY ACCOUNT NUMBER and credits via the POSTING reducer', async () => {
    const { service, mocks } = await setup();
    mocks.state.inboundAccount = customerAccount({ id: 'dst-1', balance: '0' });

    const res = await capture(
      service[inboundMethod!]({
        accountNumber: '1234567890',
        amount: '2500',
        currency: 'MXN',
        externalRef: REF,
      }),
    );
    expect(res.ok).toBe(true);

    // The account was looked up BY the account number (the number appears in an account-repo call).
    const resolvedByNumber = mocks.callLog.some(
      (e) => e.target === 'account' && e.args.some((a) => a === '1234567890'),
    );
    expect(resolvedByNumber).toBe(true);
    // Money is credited via the posting reducer (a real ledger movement, not a mock-only call).
    expect(postingCalled(mocks)).toBe(true);
  });

  it('an unresolvable account number → rejects and does NOT credit (posting never called)', async () => {
    const { service, mocks } = await setup();
    mocks.state.inboundAccount = null; // account-number resolution misses

    const res = await capture(
      service[inboundMethod!]({
        accountNumber: '9999999999',
        amount: '1000',
        currency: 'MXN',
        externalRef: REF,
      }),
    );
    expect(res.ok).toBe(false);
    // The destination gate is a precondition: no credit is posted for an unknown account.
    expect(postingCalled(mocks)).toBe(false);
    // Classify exactly when the domain class resolves; otherwise the no-credit observable stands.
    if (de.InboundDestinationNotFoundError) {
      expect(res.error).toBeInstanceOf(de.InboundDestinationNotFoundError);
    }
  });

  it('inbound routes through the idempotency wrapper AND keys it on the rail externalRef (the dedup linkage cannot silently degrade to a no-op)', async () => {
    const { service, mocks } = await setup();
    mocks.state.inboundAccount = customerAccount({ id: 'dst-1', balance: '0' });

    await capture(
      service[inboundMethod!]({
        accountNumber: '1234567890',
        amount: '2500',
        currency: 'MXN',
        externalRef: REF,
      }),
    );

    // UNCONDITIONAL: inbound MUST go through the idempotency wrapper — if it ever stopped, dedup by
    // externalRef would be gone, so this assertion must fail (not pass vacuously).
    const execCalls = mocks.idempotency.execute.mock.calls;
    expect(execCalls.length).toBeGreaterThan(0);
    // AND the wrapper MUST be keyed on the rail externalRef (a wrapper keyed on something else would
    // not dedup a replayed webhook). The authoritative no-double-credit proof is the DB integration.
    const anyCarriesRef = execCalls.some((call: any[]) => JSON.stringify(call[0]).includes(REF));
    expect(anyCarriesRef).toBe(true);
  });
});
