/**
 * Spec 04 — Balance Service, `/admin` READ surface: the admin `GET /admin/approvals` LISTING read on
 * the approval service (`listApprovals(query)`), driven as a PURE unit (no DB) so it runs in the
 * DEFAULT `npm test`. Written FROM the spec's "/admin Maker-checker" bullet (the checker discovers
 * PENDING reversals here) + the developer-locked contract, NOT from the implementor's code:
 *
 *   - The LOAD-BEARING default: when NO status is supplied, the service DEFAULTS to `PENDING` (the
 *     checker's queue) and delegates `listByStatus(PENDING)`. A regression that dropped the default
 *     (delegating `listByStatus(undefined)`) would hand the checker an empty / wrong queue and is
 *     caught here.
 *   - An EXPLICIT status passes through UNCHANGED (e.g. EXECUTED → `listByStatus(EXECUTED)`).
 *   - It is a READ: the repo `listByStatus(status)` is called exactly once; the audit collaborator
 *     NEVER fires.
 *
 * The approval-request repo + audit service are MOCKED (inspected); the default/pass-through logic
 * under test is the service's own. Injection is order-independent (Nest TestingModule + `useMocker` BY
 * DI TOKEN). The concrete `ApprovalService` class is resolved best-effort through the harness seam; if
 * the maker-checker module is absent the suite honest-SKIPs (loudly) rather than crashing the default
 * `npm test`.
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getDataSourceToken } from '@nestjs/typeorm';

import {
  getApprovalService,
  getApprovalServiceToken,
  getApprovalRequestRepositoryToken,
  getApprovalStatus,
  getAuditServiceToken,
  getAuditLogRepositoryToken,
} from '../support/harness';

const ApprovalService = getApprovalService();
const ApprovalStatus = getApprovalStatus();

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
  approvalsRepo: { listByStatus: jest.Mock };
  audit: { recordInTx: jest.Mock; record: jest.Mock };
}

async function setup(): Promise<{ service: any; mocks: Mocks }> {
  const APPROVALS_TOKEN = getApprovalServiceToken();
  const APPROVAL_REPO_TOKEN = getApprovalRequestRepositoryToken();
  const approvalsRepo = { listByStatus: jest.fn(async () => []) };
  const audit = {
    recordInTx: jest.fn(async () => undefined),
    record: jest.fn(async () => undefined),
  };
  const dataSource = { query: jest.fn(async () => []), createQueryRunner: jest.fn() };

  const moduleRef = await Test.createTestingModule({
    providers: [{ provide: APPROVALS_TOKEN, useClass: ApprovalService }],
  })
    .useMocker((token) => {
      if (token === APPROVAL_REPO_TOKEN) return approvalsRepo;
      if (token === AUDIT_TOKEN) return audit;
      if (token === AUDIT_REPO_TOKEN) return audit;
      if (isDataSourceToken(token)) return dataSource;
      return autoMock();
    })
    .compile();

  const service = moduleRef.get(APPROVALS_TOKEN, { strict: false });
  if (typeof service?.listApprovals !== 'function') {
    throw new Error(
      '[test] the approval service exposes no listApprovals(query) admin read. Reconcile the ' +
        '"listApprovals({ status? })" contract with the implementor.',
    );
  }
  return { service, mocks: { approvalsRepo, audit } };
}

/** The status the service actually handed the repo (its `listByStatus(status)` first arg). */
function statusPassedTo(approvalsRepo: Mocks['approvalsRepo']): any {
  return approvalsRepo.listByStatus.mock.calls[0]?.[0];
}

const suite = ApprovalService ? describe : describe.skip;

if (!ApprovalService) {
  console.info(
    '[unit] SKIPPED approvals-admin listing suite: the maker-checker ApprovalService class did not ' +
      'resolve through tests/support/harness.ts:getApprovalService — nothing to drive.',
  );
}

suite('admin GET /admin/approvals — PENDING default + pass-through, no audit (spec 04)', () => {
  it('DEFAULTS to PENDING when no status is supplied (the checker queue is the default view)', async () => {
    const { service, mocks } = await setup();

    await service.listApprovals({});

    expect(mocks.approvalsRepo.listByStatus).toHaveBeenCalledTimes(1);
    expect(statusPassedTo(mocks.approvalsRepo)).toBe(ApprovalStatus.Pending);
  });

  it('passes an EXPLICIT status through UNCHANGED (EXECUTED → listByStatus(EXECUTED))', async () => {
    const { service, mocks } = await setup();

    await service.listApprovals({ status: ApprovalStatus.Executed });

    expect(mocks.approvalsRepo.listByStatus).toHaveBeenCalledTimes(1);
    expect(statusPassedTo(mocks.approvalsRepo)).toBe(ApprovalStatus.Executed);
  });

  it('is a READ: it delegates to listByStatus and writes NO audit row', async () => {
    const { service, mocks } = await setup();

    await service.listApprovals({});

    expect(mocks.approvalsRepo.listByStatus).toHaveBeenCalledTimes(1);
    expect(mocks.audit.recordInTx).not.toHaveBeenCalled();
    expect(mocks.audit.record).not.toHaveBeenCalled();
  });
});
