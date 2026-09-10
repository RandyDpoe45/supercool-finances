/**
 * Spec 04 — Balance Service, step 8a (single-actor /admin): the admin `GET /transactions` LISTING
 * read on the transfers-side service (`listTransactions(filter)`), driven as a PURE unit (no DB) so
 * it runs in the DEFAULT `npm test`. Written FROM the spec's "/admin Endpoints" bullet (view ANY
 * transaction, with filters + pagination) + the developer-locked contract, NOT the implementor's code:
 *
 *   - pagination is CLAMPED before it reaches the repository: an over-large `limit` (> 200) is capped
 *     to 200, and a negative `offset` is floored to 0 — so an admin cannot ask the DB for an unbounded
 *     scan or a negative skip. A within-bounds page passes through unchanged (the clamp is a ceiling/
 *     floor, not a rewrite).
 *   - it is a READ: the underlying repo `query(filter)` is called; no audit/mutation collaborators fire.
 *
 * The repository is MOCKED (its `query(filter)` is inspected), but the clamping logic under test is
 * the service's own. Injection is order-independent (Nest TestingModule + `useMocker` by DI token).
 */
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getDataSourceToken } from '@nestjs/typeorm';

import {
  getTransfersService,
  getTransfersServiceToken,
  getRepositoryToken,
} from '../support/harness';

const TransfersService = getTransfersService();

const LIST_METHODS = [
  'listTransactions',
  'listAllTransactions',
  'queryTransactions',
  'findTransactions',
  'adminListTransactions',
];

const TRANSFERS_TOKEN = getTransfersServiceToken();
const TRANSACTION_REPO_TOKEN = getRepositoryToken('TRANSACTION_REPOSITORY', 'transaction');
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

async function setup(): Promise<{ service: any; txRepo: any; listMethod: string }> {
  const txRepo = {
    // The admin listing port the service delegates to; returns a bounded page of rows.
    query: jest.fn(async () => []),
  };
  const dataSource = { query: jest.fn(async () => []), createQueryRunner: jest.fn() };
  const moduleRef = await Test.createTestingModule({
    providers: [{ provide: TRANSFERS_TOKEN, useClass: TransfersService }],
  })
    .useMocker((token) => {
      if (token === TRANSACTION_REPO_TOKEN) return txRepo;
      if (isDataSourceToken(token)) return dataSource;
      return autoMock();
    })
    .compile();
  const service = moduleRef.get(TRANSFERS_TOKEN, { strict: false });
  const listMethod = LIST_METHODS.find((m) => typeof service?.[m] === 'function') as string;
  if (!listMethod) {
    throw new Error(
      `[test] the transfers-side service exposes no admin listing method (tried ${LIST_METHODS.join(
        '/',
      )}). If the implementor named it differently, add it to LIST_METHODS in this spec, or reconcile ` +
        `the "listTransactions(filter)" contract with the implementor.`,
    );
  }
  return { service, txRepo, listMethod };
}

/** The filter the service actually handed the repo (its `query(filter)` first arg). */
function filterPassedTo(txRepo: any): any {
  const call = txRepo.query.mock.calls[0];
  return call?.[0];
}

describe('admin GET /transactions listing — pagination is clamped before the DB (spec 04 step 8a)', () => {
  it('clamps an over-large limit (> 200) down to 200', async () => {
    const { service, txRepo, listMethod } = await setup();

    await service[listMethod]({ limit: 5000, offset: 0 });

    expect(txRepo.query).toHaveBeenCalledTimes(1);
    expect(filterPassedTo(txRepo).limit).toBe(200);
  });

  it('floors a negative offset to 0', async () => {
    const { service, txRepo, listMethod } = await setup();

    await service[listMethod]({ limit: 50, offset: -25 });

    expect(txRepo.query).toHaveBeenCalledTimes(1);
    expect(filterPassedTo(txRepo).offset).toBe(0);
  });

  it('passes a within-bounds page through unchanged (clamp is a ceiling/floor, not a rewrite)', async () => {
    const { service, txRepo, listMethod } = await setup();

    await service[listMethod]({ limit: 50, offset: 10 });

    const f = filterPassedTo(txRepo);
    expect(f.limit).toBe(50);
    expect(f.offset).toBe(10);
  });
});
