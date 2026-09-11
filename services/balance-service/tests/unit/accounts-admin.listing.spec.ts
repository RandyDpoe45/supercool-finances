/**
 * Spec 04 — Balance Service, `/admin` READ surface: the admin `GET /admin/accounts` LISTING read on
 * the accounts service (`listAccounts(query)`), driven as a PURE unit (no DB) so it runs in the
 * DEFAULT `npm test`. Written FROM the spec's "/admin Endpoints" bullet (view ANY account, NOT
 * owner-scoped, with an `ownerId` filter + paging) + the developer-locked contract, NOT from the
 * implementor's code:
 *
 *   - Paging is CLAMPED before it reaches the repository: an over-large `limit` (> 200) is capped to
 *     200; a below-range `limit` (< 1) is floored to 1; an absent `limit` defaults to 50; a negative
 *     `offset` is floored to 0. A within-bounds page passes through unchanged. So an admin can never
 *     ask the DB for an unbounded scan, a zero/negative page size, or a negative skip.
 *   - It is DELIBERATELY NON-owner-scoped: the caller's `ownerId` filter (when present) is forwarded
 *     verbatim to the repo; when absent, the repo is asked with an undefined filter (any owner).
 *   - It is a READ: the repo `queryAccounts(filter)` is called exactly once; the audit collaborator
 *     NEVER fires (a read writes no audit row).
 *
 * The account repo + audit service are MOCKED (inspected), but the clamp/delegation logic under test
 * is the service's own. Injection is order-independent (Nest TestingModule + `useMocker` BY DI TOKEN,
 * resolved through the single harness seam).
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

interface Mocks {
  accountRepo: { queryAccounts: jest.Mock };
  audit: { recordInTx: jest.Mock; record: jest.Mock };
}

async function setup(): Promise<{ service: any; mocks: Mocks }> {
  const accountRepo = { queryAccounts: jest.fn(async () => []) };
  const audit = {
    recordInTx: jest.fn(async () => undefined),
    record: jest.fn(async () => undefined),
  };
  const dataSource = { query: jest.fn(async () => []), createQueryRunner: jest.fn() };

  const moduleRef = await Test.createTestingModule({
    providers: [{ provide: ACCOUNTS_TOKEN, useClass: AccountsService }],
  })
    .useMocker((token) => {
      if (token === ACCOUNT_REPO_TOKEN) return accountRepo;
      if (token === AUDIT_TOKEN) return audit;
      if (token === AUDIT_REPO_TOKEN) return audit;
      if (token === LEDGER_REPO_TOKEN) return autoMock();
      if (isDataSourceToken(token)) return dataSource;
      return autoMock();
    })
    .compile();

  const service = moduleRef.get(ACCOUNTS_TOKEN, { strict: false });
  if (typeof service?.listAccounts !== 'function') {
    throw new Error(
      '[test] the accounts service exposes no listAccounts(query) admin read. Reconcile the ' +
        '"listAccounts({ ownerId?, limit?, offset? })" contract with the implementor.',
    );
  }
  return { service, mocks: { accountRepo, audit } };
}

/** The filter the service actually handed the repo (its `queryAccounts(filter)` first arg). */
function filterPassedTo(accountRepo: Mocks['accountRepo']): any {
  return accountRepo.queryAccounts.mock.calls[0]?.[0];
}

describe('admin GET /admin/accounts — paging is clamped before the DB, non-owner-scoped, no audit (spec 04)', () => {
  it('clamps an over-large limit (> 200) down to 200', async () => {
    const { service, mocks } = await setup();

    await service.listAccounts({ limit: 5000, offset: 0 });

    expect(mocks.accountRepo.queryAccounts).toHaveBeenCalledTimes(1);
    expect(filterPassedTo(mocks.accountRepo).limit).toBe(200);
  });

  it('floors a below-range limit (< 1) up to 1 (a zero/negative page size never reaches the DB)', async () => {
    const { service, mocks } = await setup();

    await service.listAccounts({ limit: 0, offset: 0 });

    expect(filterPassedTo(mocks.accountRepo).limit).toBe(1);
  });

  it('defaults limit to 50 when absent', async () => {
    const { service, mocks } = await setup();

    await service.listAccounts({});

    expect(mocks.accountRepo.queryAccounts).toHaveBeenCalledTimes(1);
    expect(filterPassedTo(mocks.accountRepo).limit).toBe(50);
  });

  it('floors a negative offset to 0', async () => {
    const { service, mocks } = await setup();

    await service.listAccounts({ limit: 50, offset: -25 });

    expect(filterPassedTo(mocks.accountRepo).offset).toBe(0);
  });

  it('passes a within-bounds page through unchanged (clamp is a ceiling/floor, not a rewrite)', async () => {
    const { service, mocks } = await setup();

    await service.listAccounts({ limit: 50, offset: 10 });

    const f = filterPassedTo(mocks.accountRepo);
    expect(f.limit).toBe(50);
    expect(f.offset).toBe(10);
  });

  it('forwards the ownerId filter VERBATIM (a non-owner-scoped query filtered to one owner)', async () => {
    const { service, mocks } = await setup();

    await service.listAccounts({ ownerId: 'sub-owner-xyz', limit: 50, offset: 0 });

    expect(filterPassedTo(mocks.accountRepo).ownerId).toBe('sub-owner-xyz');
  });

  it('is a READ: it delegates to queryAccounts and writes NO audit row', async () => {
    const { service, mocks } = await setup();

    await service.listAccounts({ limit: 10, offset: 0 });

    expect(mocks.accountRepo.queryAccounts).toHaveBeenCalledTimes(1);
    // The safety-critical read invariant: a list never appends to the append-only audit log.
    expect(mocks.audit.recordInTx).not.toHaveBeenCalled();
    expect(mocks.audit.record).not.toHaveBeenCalled();
  });
});
