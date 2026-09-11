/**
 * Spec 04 — Balance Service, `/admin` READ surface: the admin `GET /admin/limits` LISTING read on the
 * limits service (`listLimits(query)`), driven as a PURE unit (no DB) so it runs in the DEFAULT
 * `npm test`. Written FROM the spec's "/admin Endpoints" bullet (`PUT /limits` configures the baseline
 * + per-customer overrides; the read views ANY limits row with `scope` / `ownerId` filters) + the
 * developer-locked contract, NOT from the implementor's code:
 *
 *   - The service MAPS the wire `scope` string (`'global'` | `'customer'`) to the `UserLimitsScope`
 *     enum before delegating to the repo (proven against the resolved enum member, not a bare string),
 *     and forwards `ownerId` verbatim.
 *   - An ABSENT scope leaves the repo filter's scope `undefined` (all rows) — the read is not silently
 *     narrowed.
 *   - It is a READ: the repo `list(filter)` is called exactly once; the audit collaborator NEVER fires.
 *
 * The user-limits repo + audit service are MOCKED (inspected); the mapping/delegation logic under test
 * is the service's own. Injection is order-independent (Nest TestingModule + `useMocker` BY DI TOKEN).
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getDataSourceToken } from '@nestjs/typeorm';

import {
  getLimitsService,
  getLimitsServiceToken,
  getUserLimitsRepositoryToken,
  getUserLimitsScope,
  getAuditServiceToken,
  getAuditLogRepositoryToken,
} from '../support/harness';

const LimitsService = getLimitsService();
const UserLimitsScope = getUserLimitsScope();

const LIMITS_TOKEN = getLimitsServiceToken();
const USER_LIMITS_REPO_TOKEN = getUserLimitsRepositoryToken();
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
  limitsRepo: { list: jest.Mock };
  audit: { recordInTx: jest.Mock; record: jest.Mock };
}

async function setup(): Promise<{ service: any; mocks: Mocks }> {
  const limitsRepo = { list: jest.fn(async () => []) };
  const audit = {
    recordInTx: jest.fn(async () => undefined),
    record: jest.fn(async () => undefined),
  };
  const dataSource = { query: jest.fn(async () => []), createQueryRunner: jest.fn() };

  const moduleRef = await Test.createTestingModule({
    providers: [{ provide: LIMITS_TOKEN, useClass: LimitsService }],
  })
    .useMocker((token) => {
      if (token === USER_LIMITS_REPO_TOKEN) return limitsRepo;
      if (token === AUDIT_TOKEN) return audit;
      if (token === AUDIT_REPO_TOKEN) return audit;
      if (isDataSourceToken(token)) return dataSource;
      return autoMock();
    })
    .compile();

  const service = moduleRef.get(LIMITS_TOKEN, { strict: false });
  if (typeof service?.listLimits !== 'function') {
    throw new Error(
      '[test] the limits service exposes no listLimits(query) admin read. Reconcile the ' +
        '"listLimits({ scope?, ownerId? })" contract with the implementor.',
    );
  }
  return { service, mocks: { limitsRepo, audit } };
}

/** The filter the service actually handed the repo (its `list(filter)` first arg). */
function filterPassedTo(limitsRepo: Mocks['limitsRepo']): any {
  return limitsRepo.list.mock.calls[0]?.[0];
}

describe('admin GET /admin/limits — scope maps to the enum, ownerId forwarded, no audit (spec 04)', () => {
  it("maps scope: 'customer' to the UserLimitsScope enum and forwards ownerId", async () => {
    const { service, mocks } = await setup();

    await service.listLimits({ scope: 'customer', ownerId: 'sub-owner-1' });

    expect(mocks.limitsRepo.list).toHaveBeenCalledTimes(1);
    const f = filterPassedTo(mocks.limitsRepo);
    expect(f.scope).toBe(UserLimitsScope.Customer);
    expect(f.ownerId).toBe('sub-owner-1');
  });

  it("maps scope: 'global' to the UserLimitsScope enum", async () => {
    const { service, mocks } = await setup();

    await service.listLimits({ scope: 'global' });

    expect(filterPassedTo(mocks.limitsRepo).scope).toBe(UserLimitsScope.Global);
  });

  it('leaves the repo scope undefined when scope is absent (all rows, not silently narrowed)', async () => {
    const { service, mocks } = await setup();

    await service.listLimits({});

    expect(mocks.limitsRepo.list).toHaveBeenCalledTimes(1);
    expect(filterPassedTo(mocks.limitsRepo).scope).toBeUndefined();
  });

  it('is a READ: it delegates to list and writes NO audit row', async () => {
    const { service, mocks } = await setup();

    await service.listLimits({ scope: 'customer', ownerId: 'sub-owner-1' });

    expect(mocks.limitsRepo.list).toHaveBeenCalledTimes(1);
    expect(mocks.audit.recordInTx).not.toHaveBeenCalled();
    expect(mocks.audit.record).not.toHaveBeenCalled();
  });
});
