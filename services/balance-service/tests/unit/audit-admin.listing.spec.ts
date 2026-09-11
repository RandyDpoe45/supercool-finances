/**
 * Spec 04 — Balance Service, `/admin` AUDIT read: the admin `GET /admin/audit` browse of the
 * `audit_log` (`AuditService.listAudit(query)` + the `listAuditQuerySchema` wire guard + the
 * `serializeAuditLog` whitelist), driven as PURE units (no DB) so they run in the DEFAULT
 * `npm run test:unit`. Written FROM the developer-locked contract (a role-gated, NON-owner-scoped,
 * NO-audit, NO-transaction read; `{ entries: AuditLogDto[] }`, newest-first) — NOT from the
 * implementor's code:
 *
 *   - CLAMP (the sharp, security-relevant proof — an unbounded scan is a real defect): the service
 *     CLAMPS `limit` to `[1,200]` (default 50 when absent; 500 → 200; 0/negative → 1) and floors a
 *     negative `offset` to 0 BEFORE the value reaches the repository, and forwards each present filter
 *     (`actorId`/`action`/`targetType`/`targetId`) VERBATIM. Asserted by inspecting the exact filter
 *     object the mocked `AUDIT_LOG_REPOSITORY.queryAuditLog` received.
 *   - It is a READ: `queryAuditLog` is called once; the append-only write paths (`insertInTx` / `create`)
 *     NEVER fire — browsing the audit log must not append to it.
 *   - `.strict()` + coercion: the query schema rejects an unknown key (param smuggling), accepts the
 *     known optional filters, coerces string→int for `limit`/`offset`, and rejects a negative / non-integer.
 *   - Whitelist serializer: `serializeAuditLog` emits EXACTLY the 7 whitelist keys and no more (a leaked
 *     extra entity field fails the key-set assertion); `createdAt` is the ISO string of the entity Date;
 *     `metadata` (incl. null) passes through unchanged; null `targetType`/`targetId` surface as null.
 *
 * The repo is MOCKED (inspected), but the clamp/delegation logic under test is the service's own.
 * Injection is order-independent (Nest TestingModule + `useMocker` BY DI token).
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getDataSourceToken } from '@nestjs/typeorm';

import {
  getAuditService,
  getAuditServiceToken,
  getAuditLogRepositoryToken,
  getListAuditQuerySchema,
  getAuditLogSerializer,
} from '../support/harness';

const AuditService = getAuditService();
const listAuditQuerySchema = getListAuditQuerySchema();
const serializeAuditLog = getAuditLogSerializer();

const AUDIT_TOKEN = getAuditServiceToken();
const AUDIT_REPO_TOKEN = getAuditLogRepositoryToken();
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

interface Mocks {
  auditRepo: { queryAuditLog: jest.Mock; insertInTx: jest.Mock; create: jest.Mock };
}

async function setup(): Promise<{ service: any; mocks: Mocks }> {
  const auditRepo = {
    queryAuditLog: jest.fn(async () => []),
    insertInTx: jest.fn(async () => undefined),
    create: jest.fn(async () => undefined),
  };
  const dataSource = { query: jest.fn(async () => []), createQueryRunner: jest.fn() };

  const moduleRef = await Test.createTestingModule({
    providers: [{ provide: AUDIT_TOKEN, useClass: AuditService }],
  })
    .useMocker((token) => {
      if (token === AUDIT_REPO_TOKEN) return auditRepo;
      if (isDataSourceToken(token)) return dataSource;
      return autoMock();
    })
    .compile();

  const service = moduleRef.get(AUDIT_TOKEN, { strict: false });
  if (typeof service?.listAudit !== 'function') {
    throw new Error(
      '[test] the audit service exposes no listAudit(query) admin read. Reconcile the ' +
        '"listAudit({ actorId?, action?, targetType?, targetId?, limit?, offset? })" contract ' +
        'with the implementor.',
    );
  }
  return { service, mocks: { auditRepo } };
}

/** The filter the service actually handed the repo (its `queryAuditLog(filter)` first arg). */
function filterPassedTo(auditRepo: Mocks['auditRepo']): any {
  return auditRepo.queryAuditLog.mock.calls[0]?.[0];
}

// =============================================================================================
// AuditService.listAudit — paging is clamped before the DB; filters forwarded; no audit written
// =============================================================================================
describe('admin GET /admin/audit — service clamps paging before the DB, non-owner-scoped, no audit write (spec 04)', () => {
  it('defaults limit to 50 when absent', async () => {
    const { service, mocks } = await setup();

    await service.listAudit({});

    expect(mocks.auditRepo.queryAuditLog).toHaveBeenCalledTimes(1);
    expect(filterPassedTo(mocks.auditRepo).limit).toBe(50);
  });

  it('clamps an over-large limit (500) down to 200 (no unbounded scan)', async () => {
    const { service, mocks } = await setup();

    await service.listAudit({ limit: 500, offset: 0 });

    expect(filterPassedTo(mocks.auditRepo).limit).toBe(200);
  });

  it('floors a zero limit up to 1 (a zero page size never reaches the DB)', async () => {
    const { service, mocks } = await setup();

    await service.listAudit({ limit: 0, offset: 0 });

    expect(filterPassedTo(mocks.auditRepo).limit).toBe(1);
  });

  it('floors a negative limit up to 1', async () => {
    const { service, mocks } = await setup();

    await service.listAudit({ limit: -10, offset: 0 });

    expect(filterPassedTo(mocks.auditRepo).limit).toBe(1);
  });

  it('floors a negative offset to 0', async () => {
    const { service, mocks } = await setup();

    await service.listAudit({ limit: 50, offset: -25 });

    expect(filterPassedTo(mocks.auditRepo).offset).toBe(0);
  });

  it('passes a within-bounds page through unchanged (clamp is a ceiling/floor, not a rewrite)', async () => {
    const { service, mocks } = await setup();

    await service.listAudit({ limit: 25, offset: 10 });

    const f = filterPassedTo(mocks.auditRepo);
    expect(f.limit).toBe(25);
    expect(f.offset).toBe(10);
  });

  it('forwards every present exact-match filter VERBATIM alongside the clamped paging', async () => {
    const { service, mocks } = await setup();

    await service.listAudit({
      actorId: 'admin-sub-xyz',
      action: 'account.freeze',
      targetType: 'account',
      targetId: 'acc-123',
      limit: 5000,
      offset: 40,
    });

    const f = filterPassedTo(mocks.auditRepo);
    expect(f.actorId).toBe('admin-sub-xyz');
    expect(f.action).toBe('account.freeze');
    expect(f.targetType).toBe('account');
    expect(f.targetId).toBe('acc-123');
    // paging still clamped even with filters present
    expect(f.limit).toBe(200);
    expect(f.offset).toBe(40);
  });

  it('is a READ: it delegates to queryAuditLog exactly once and writes NO audit row', async () => {
    const { service, mocks } = await setup();

    const returned = await service.listAudit({});

    expect(mocks.auditRepo.queryAuditLog).toHaveBeenCalledTimes(1);
    // Browsing the audit log must never append to the append-only log.
    expect(mocks.auditRepo.insertInTx).not.toHaveBeenCalled();
    expect(mocks.auditRepo.create).not.toHaveBeenCalled();
    // The service returns the repo's rows verbatim (the controller serializes them).
    expect(Array.isArray(returned)).toBe(true);
  });
});

// =============================================================================================
// listAuditQuerySchema — .strict() rejects param smuggling; string→int coercion; bounds
// =============================================================================================
describe('listAuditQuerySchema — .strict() + coercion (GET /admin/audit query guard, spec 04)', () => {
  it('rejects an UNKNOWN query key (.strict() — param-smuggling defense)', () => {
    const res = listAuditQuerySchema.safeParse({ foo: 'x' });
    expect(res.success).toBe(false);
  });

  it('accepts the known optional exact-match filters (all absent is valid too)', () => {
    expect(listAuditQuerySchema.safeParse({}).success).toBe(true);
    const res = listAuditQuerySchema.safeParse({
      actorId: 'admin-1',
      action: 'limits.change',
      targetType: 'user_limits',
      targetId: 'lim-9',
    });
    expect(res.success).toBe(true);
  });

  it('coerces string limit/offset (query params arrive as strings) to integers', () => {
    const res = listAuditQuerySchema.safeParse({ limit: '25', offset: '50' });
    expect(res.success).toBe(true);
    expect(res.data.limit).toBe(25);
    expect(res.data.offset).toBe(50);
    expect(typeof res.data.limit).toBe('number');
    expect(typeof res.data.offset).toBe('number');
  });

  it('rejects a negative limit and a non-integer limit (bounds enforced at the wire)', () => {
    expect(listAuditQuerySchema.safeParse({ limit: '-1' }).success).toBe(false);
    expect(listAuditQuerySchema.safeParse({ limit: '1.5' }).success).toBe(false);
    expect(listAuditQuerySchema.safeParse({ offset: '-5' }).success).toBe(false);
  });

  it('rejects an empty-string filter (an exact-match predicate must be non-empty)', () => {
    expect(listAuditQuerySchema.safeParse({ actorId: '' }).success).toBe(false);
  });
});

// =============================================================================================
// serializeAuditLog — explicit whitelist; ISO createdAt; metadata (incl. null) + null targets
// =============================================================================================
describe('serializeAuditLog — explicit 7-field whitelist, ISO createdAt, metadata surfaced (spec 04)', () => {
  const EXPECTED_KEYS = [
    'id',
    'actorId',
    'action',
    'targetType',
    'targetId',
    'metadata',
    'createdAt',
  ].sort();

  function fakeEntity(overrides: Record<string, unknown> = {}): any {
    return {
      id: '42',
      actorId: 'admin-sub-1',
      action: 'account.freeze',
      targetType: 'account',
      targetId: 'acc-7',
      metadata: { before: { status: 'active' }, after: { status: 'frozen' } },
      createdAt: new Date('2026-09-11T12:34:56.000Z'),
      // Internal fields the whitelist must NOT surface (a spread would leak these):
      version: 3,
      internalRowHash: 'do-not-leak',
      ...overrides,
    };
  }

  it('emits EXACTLY the 7 whitelist keys — no more (a leaked internal field fails here)', () => {
    const dto = serializeAuditLog(fakeEntity());
    expect(Object.keys(dto).sort()).toEqual(EXPECTED_KEYS);
    expect(dto).not.toHaveProperty('version');
    expect(dto).not.toHaveProperty('internalRowHash');
    expect(JSON.stringify(dto)).not.toContain('do-not-leak');
  });

  it('renders createdAt as the ISO-8601 UTC string of the entity Date; id stays the bigint STRING', () => {
    const dto = serializeAuditLog(fakeEntity());
    expect(dto.createdAt).toBe('2026-09-11T12:34:56.000Z');
    expect(dto.id).toBe('42');
    expect(typeof dto.id).toBe('string');
  });

  it('passes the metadata blob through UNCHANGED (the audit content the auditor needs)', () => {
    const metadata = { before: { dailyMax: '20000' }, after: { dailyMax: '5000' }, note: 'x' };
    const dto = serializeAuditLog(fakeEntity({ metadata }));
    expect(dto.metadata).toEqual(metadata);
  });

  it('surfaces a null metadata as null (not dropped, not defaulted to {})', () => {
    const dto = serializeAuditLog(fakeEntity({ metadata: null }));
    expect(dto.metadata).toBeNull();
    // key still present in the whitelist even when null
    expect(Object.keys(dto).sort()).toEqual(EXPECTED_KEYS);
  });

  it('surfaces null targetType/targetId as null (the polymorphic pointer may be absent)', () => {
    const dto = serializeAuditLog(fakeEntity({ targetType: null, targetId: null }));
    expect(dto.targetType).toBeNull();
    expect(dto.targetId).toBeNull();
  });
});
