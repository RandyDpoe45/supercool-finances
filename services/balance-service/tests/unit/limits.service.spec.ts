/**
 * Spec 04 — Balance Service, step 8a (single-actor /admin): `LimitsService.upsertLimits(actorId,
 * input)` — the PUT /limits upsert domain operation, driven as a PURE unit (no DB) so it runs in the
 * DEFAULT `npm test`. Written FROM the spec's "/admin Endpoints" bullet + the developer-locked
 * contract, NOT from the implementor's code:
 *
 *   - scope shape is validated FAIL-CLOSED, BEFORE any write: `global` ⇒ `ownerId` MUST be absent;
 *     `customer` ⇒ `ownerId` is REQUIRED (else a 400-class rejection). A malformed scope must NOT
 *     upsert a row and must NOT write an audit row.
 *   - a valid upsert flips the row AND writes one `limits.change` audit row in the SAME tx (positive
 *     control — proves the validation is a real gate, not an "always throws").
 *
 * The collaborators (user-limits repo, audit service, DataSource) are MOCKED, but the validation +
 * orchestration under test is the service's own. Injection is order-independent (Nest TestingModule
 * + `useMocker` by DI token, resolved through the single harness seam).
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getDataSourceToken } from '@nestjs/typeorm';

import {
  getLimitsService,
  getLimitsServiceToken,
  getAuditServiceToken,
  getAuditLogRepositoryToken,
  getUserLimitsRepositoryToken,
} from '../support/harness';

const LimitsService = getLimitsService();

const ACTION_LIMITS_CHANGE = 'limits.change';
const ACTOR = 'admin-7';
const OWNER = 'sub-owner-1';
const MXN = 'MXN';

interface Mocks {
  limitsRepo: any;
  audit: any;
  dataSource: any;
  qr: any;
  state: { before: any };
}

function makeMocks(): Mocks {
  const state = { before: null as any };
  const fakeManager = { query: jest.fn(async () => []), save: jest.fn(async (e: any) => e) };
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

  const limitsRepo = {
    // The BEFORE snapshot the audit's before/after reads; null ⇒ an insert (no prior row).
    findExactInTx: jest.fn(async () => state.before),
    // The spec-locked upsert (`ON CONFLICT (scope, owner_id)`), returning the resulting row.
    upsertInTx: jest.fn(async (_qr: any, data: any) => ({ id: 'lim-1', ...(data ?? {}) })),
  };
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
  return { limitsRepo, audit, dataSource, qr, state };
}

const LIMITS_TOKEN = getLimitsServiceToken();
const AUDIT_TOKEN = getAuditServiceToken();
const AUDIT_REPO_TOKEN = getAuditLogRepositoryToken();
const USER_LIMITS_TOKEN = getUserLimitsRepositoryToken();
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
    providers: [{ provide: LIMITS_TOKEN, useClass: LimitsService }],
  })
    .useMocker((token) => {
      if (token === USER_LIMITS_TOKEN) return mocks.limitsRepo;
      if (token === AUDIT_TOKEN) return mocks.audit;
      if (token === AUDIT_REPO_TOKEN) return mocks.audit;
      if (isDataSourceToken(token)) return mocks.dataSource;
      return autoMock();
    })
    .compile();
  const service = moduleRef.get(LIMITS_TOKEN, { strict: false });
  return { service, mocks };
}

async function capture(p: Promise<any>): Promise<{ ok: boolean; value?: any; error?: any }> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

describe('LimitsService.upsertLimits — scope validation is fail-closed before any write (spec 04 step 8a)', () => {
  it("rejects scope='customer' WITHOUT ownerId, and neither upserts nor audits", async () => {
    const { service, mocks } = await setup();

    const res = await capture(
      service.upsertLimits(ACTOR, {
        scope: 'customer',
        currency: MXN,
        perTransactionMax: '5000',
      }),
    );

    expect(res.ok).toBe(false);
    // The gate is a PRECONDITION — no row is written and no audit is recorded on a bad scope.
    expect(mocks.limitsRepo.upsertInTx).not.toHaveBeenCalled();
    expect(mocks.audit.recordInTx).not.toHaveBeenCalled();
    expect(mocks.audit.record).not.toHaveBeenCalled();
  });

  it("rejects scope='global' WITH an ownerId, and neither upserts nor audits", async () => {
    const { service, mocks } = await setup();

    const res = await capture(
      service.upsertLimits(ACTOR, {
        scope: 'global',
        ownerId: OWNER,
        currency: MXN,
        dailyMax: '1000000',
      }),
    );

    expect(res.ok).toBe(false);
    expect(mocks.limitsRepo.upsertInTx).not.toHaveBeenCalled();
    expect(mocks.audit.recordInTx).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: a valid customer override upserts the row AND writes one limits.change audit row, both in the SAME tx', async () => {
    const { service, mocks } = await setup();

    const res = await capture(
      service.upsertLimits(ACTOR, {
        scope: 'customer',
        ownerId: OWNER,
        currency: MXN,
        perTransactionMax: '5000',
        dailyMax: '20000',
      }),
    );

    expect(res.ok).toBe(true);
    expect(mocks.limitsRepo.upsertInTx).toHaveBeenCalledTimes(1);
    // The upsert carries the caps the admin set (scope/owner/currency reach the row).
    const upsertData = JSON.stringify(mocks.limitsRepo.upsertInTx.mock.calls[0]);
    expect(upsertData).toContain(OWNER);
    expect(upsertData).toContain('5000');

    // Exactly one audit row, action limits.change, carrying the actor.
    expect(mocks.audit.recordInTx).toHaveBeenCalledTimes(1);
    const entry = mocks.audit.recordInTx.mock.calls[0];
    const serialized = JSON.stringify(entry[entry.length - 1]);
    expect(serialized).toContain(ACTION_LIMITS_CHANGE);
    expect(serialized).toContain(ACTOR);

    // ONE tx: the upsert and the audit append share the SAME queryRunner object.
    expect(mocks.audit.recordInTx.mock.calls[0][0]).toBe(
      mocks.limitsRepo.upsertInTx.mock.calls[0][0],
    );
  });

  it("POSITIVE CONTROL: a valid GLOBAL baseline (no ownerId) upserts + audits (proves 'global without ownerId' is allowed)", async () => {
    const { service, mocks } = await setup();

    const res = await capture(
      service.upsertLimits(ACTOR, {
        scope: 'global',
        currency: MXN,
        perTransactionMax: '5000000',
      }),
    );

    expect(res.ok).toBe(true);
    expect(mocks.limitsRepo.upsertInTx).toHaveBeenCalledTimes(1);
    expect(mocks.audit.recordInTx).toHaveBeenCalledTimes(1);
  });
});
