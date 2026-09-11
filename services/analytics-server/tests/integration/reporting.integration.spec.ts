/**
 * Spec 05, step A3 — the `/admin/reports` AGGREGATION correctness, over a live Mongo.
 * Written from the CONTRACT OF RECORD (specs/DATA-MODEL.md Part 2: the query-time
 * `accountSummaries` / `dailyAggregates` view shapes + the "query-time everywhere, no
 * materialized rollups" strategy) and the spec-05 DoD ("An `/admin` analytics query
 * returns correct aggregates over seeded data"), NOT from the implementor's code —
 * every test is built to FAIL on a real defect.
 *
 * The money-safety crux (proof 6): the aggregation runs over BSON `Long` (int64), so a
 * SUM that stays EXACT past 2^53 proves the pipeline never floats money. Every total
 * here is seeded to exceed 2^53 and asserted for exact-integer equality.
 *
 * Seeding: through the A1 repository `upsertByEventId` with money as `bigint` — so
 * exact int64 values enter Mongo as `Long` WITHOUT ever passing through a JS number
 * (a number path would already have rounded a value > 2^53, defeating the proof).
 *
 * Genuinely Mongo-dependent -> honest-SKIP (mirrors the other integration suites):
 * OPT-IN via ANALYTICS_INTEGRATION=1 (a default `npm test` reports it SKIPPED, never a
 * false pass); when opted in it TCP-probes Mongo and fails LOUDLY if unreachable.
 *
 * Isolation: every test uses fresh uuid accounts/owners and a fresh synthetic currency
 * (`Z` + 2 random letters, never a real code), and NARROWS its queries by those, so an
 * aggregation that scans the whole collection still sees only this test's data; all
 * seeded docs are tracked by `_id` and deleted in `afterEach` (never nuke the
 * collection), keeping the suite re-runnable against a shared Mongo.
 *
 * To run:
 *   1. bring up the compose datastores (mongo reachable to the runner);
 *   2. export the analytics MONGO_* env (or rely on the defaults below);
 *   3. ANALYTICS_INTEGRATION=1 npm test
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getConnectionToken } from '@nestjs/mongoose';

import {
  getConfigModule,
  getDatabaseModule,
  getPersistenceModule,
  getReportingModule,
  getReportingServiceToken,
  getTransactionsRepositoryToken,
  tcpProbe,
} from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';

const ENABLED = process.env.ANALYTICS_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[integration] SKIPPED reporting-aggregation suite: set ANALYTICS_INTEGRATION=1 ' +
      '(and point MONGO_HOST/MONGO_PORT/MONGO_USER/MONGO_PASSWORD/MONGO_DB/MONGO_AUTH_SOURCE ' +
      'at a reachable Mongo) to run it.',
  );
}

const MONGO_HOST = process.env.MONGO_HOST || '127.0.0.1';
const MONGO_PORT = Number(process.env.MONGO_PORT || '27017');
const COLLECTION = 'transactions';

const suite = ENABLED ? describe : describe.skip;

interface Leg {
  accountId: string;
  ownerId: string | null;
  accountKind: 'customer' | 'system';
  systemKey: string | null;
  delta: bigint;
  balanceAfter: bigint;
  currency: string;
}

interface TxDoc {
  _id: string;
  transactionId: string;
  eventType: string;
  type: string;
  status: string;
  amount: bigint;
  currency: string;
  initiatedBy: string;
  reversesTransactionId: string | null;
  failureReason: string | null;
  payee: { id: string; displayName: string; rail: string } | null;
  legs: Leg[];
  owners: string[];
  occurredAt: Date;
}

/** Synthetic, never-real currency code (`Z` + 2 random letters) so a test's data is
 *  invisible to any other data when we narrow queries by currency. */
function synthCurrency(): string {
  const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return 'Z' + L[Math.floor(Math.random() * 26)] + L[Math.floor(Math.random() * 26)];
}

function leg(o: Partial<Leg> & Pick<Leg, 'accountId' | 'delta' | 'balanceAfter'>): Leg {
  return {
    ownerId: null,
    accountKind: 'customer',
    systemKey: null,
    currency: 'MXN',
    ...o,
  };
}

/** Distinct non-null customer ownerIds across legs (matches the A2 projection). */
function ownersOf(legs: Leg[]): string[] {
  return [...new Set(legs.filter((l) => l.ownerId).map((l) => l.ownerId as string))];
}

/** Money at the domain OR wire boundary: a `bigint` or a decimal STRING — NEVER a JS
 *  `number` (a number > 2^53 is already rounded) and never a raw Long object. Returns
 *  the exact bigint. The `expect` here is the money-safety guard. */
function money(v: unknown): bigint {
  expect(typeof v === 'bigint' || typeof v === 'string').toBe(true);
  return typeof v === 'bigint' ? v : BigInt(v as string);
}

suite('reporting aggregation (integration, needs Mongo)', () => {
  let app: INestApplication;
  let service: any;
  let repo: any;
  let connection: any;
  const created: string[] = [];

  async function seed(doc: TxDoc): Promise<void> {
    created.push(doc._id);
    await repo.upsertByEventId(doc);
  }

  function mkDoc(o: Partial<TxDoc> & Pick<TxDoc, 'legs' | 'occurredAt'>): TxDoc {
    const owner = o.initiatedBy ?? `sub-${randomUUID()}`;
    return {
      _id: randomUUID(),
      transactionId: randomUUID(),
      eventType: o.status === 'FAILED' ? 'transaction.failed' : 'transaction.posted',
      type: 'internal',
      status: 'POSTED',
      amount: 50_000n,
      currency: 'MXN',
      initiatedBy: owner,
      reversesTransactionId: null,
      failureReason: null,
      payee: null,
      owners: ownersOf(o.legs),
      ...o,
    };
  }

  /** Try the candidate service method names (the interface is the implementor's to
   *  name); throw an actionable error if none exist. */
  async function callService(kind: 'account' | 'daily', query: unknown): Promise<any> {
    const names =
      kind === 'account'
        ? [
            'getAccountSummaries',
            'accountSummaries',
            'queryAccountSummaries',
            'findAccountSummaries',
            'listAccountSummaries',
          ]
        : [
            'getDailyAggregates',
            'dailyAggregates',
            'queryDailyAggregates',
            'findDailyAggregates',
            'listDailyAggregates',
          ];
    for (const n of names) {
      if (typeof service[n] === 'function') return service[n](query);
    }
    throw new Error(
      `[test] REPORTING_SERVICE exposes none of: ${names.join(', ')} — update tests/support/harness.ts`,
    );
  }

  function asRows(res: any, key: string): any[] {
    if (Array.isArray(res)) return res;
    if (res && Array.isArray(res[key])) return res[key];
    throw new Error(`[test] reporting result is neither an array nor { ${key}: [...] }`);
  }

  const summaries = async (q: unknown): Promise<any[]> =>
    asRows(await callService('account', q), 'accountSummaries');
  const aggregates = async (q: unknown): Promise<any[]> =>
    asRows(await callService('daily', q), 'dailyAggregates');

  const findDaily = (rows: any[], date: string, currency: string, type: string): any =>
    rows.find((r) => r.date === date && r.currency === currency && r.type === type);

  beforeAll(async () => {
    const reachable = await tcpProbe(MONGO_HOST, MONGO_PORT);
    if (!reachable) {
      throw new Error(
        `[integration] ANALYTICS_INTEGRATION=1 but Mongo is not reachable at ` +
          `${MONGO_HOST}:${MONGO_PORT}. Bring up the compose datastores (and publish/point ` +
          `MONGO_HOST/MONGO_PORT at them) or unset ANALYTICS_INTEGRATION.`,
      );
    }

    const env = completeRawEnv({
      MONGO_HOST,
      MONGO_PORT: String(MONGO_PORT),
      MONGO_DB: process.env.MONGO_DB || 'analytics',
      MONGO_USER: process.env.MONGO_USER || 'analytics_app',
      MONGO_PASSWORD: process.env.MONGO_PASSWORD || 'changeme-analytics-local',
      MONGO_AUTH_SOURCE: process.env.MONGO_AUTH_SOURCE || 'analytics',
    });
    for (const [k, v] of Object.entries(env)) process.env[k] = String(v);

    const moduleRef = await Test.createTestingModule({
      imports: [
        getConfigModule(),
        getDatabaseModule(),
        getPersistenceModule(),
        getReportingModule(),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    service = app.get(getReportingServiceToken(), { strict: false });
    repo = app.get(getTransactionsRepositoryToken(), { strict: false });
    connection = app.get(getConnectionToken(), { strict: false });

    for (const name of connection.modelNames()) {
      await connection.model(name).ensureIndexes();
    }
  }, 60_000);

  afterEach(async () => {
    if (connection?.db && created.length) {
      await connection.db.collection(COLLECTION).deleteMany({ _id: { $in: created.splice(0) } });
    }
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('accountSummaries: per-account rollup is exact — lastBalanceAfter by latest occurredAt, txnCount, totalDebited/Credited (> 2^53), lastActivityAt', async () => {
    const owner = `sub-${randomUUID()}`;
    const acctA = randomUUID();
    const sys = randomUUID();

    // Every asserted money value is an ODD integer above 2^53 — such values are NOT
    // representable as a float64 double (the double grid has spacing 2 there), so if the
    // aggregation ever floated money the result would round to an even neighbour and the
    // exact-equality assertions below would fail. That is the money-safety proof.
    const DEB1 = 5_000_000_000_000_000n;
    const DEB2 = 4_007_199_254_740_993n; // DEB1 + DEB2 = 9_007_199_254_740_993 (2^53 + 1, odd)
    const CRED = 9_007_199_254_740_997n; // 2^53 + 5 (odd)
    const TOTAL_DEBITED = DEB1 + DEB2;
    const LAST_BALANCE = 9_007_199_254_740_995n; // 2^53 + 3 (odd) — the LATEST event's balanceAfter

    const T1 = new Date('2026-09-01T12:00:00.000Z');
    const T2 = new Date('2026-09-02T12:00:00.000Z');
    const T3 = new Date('2026-09-03T12:00:00.000Z'); // latest by occurredAt

    // e1: acctA debit (delta < 0). e2: acctA credit (delta > 0). e3: acctA debit, and the
    // LATEST — its balanceAfter is what `lastBalanceAfter` must report.
    const e1 = mkDoc({
      initiatedBy: owner,
      occurredAt: T1,
      legs: [
        leg({ accountId: acctA, ownerId: owner, delta: -DEB1, balanceAfter: 1_000n }),
        leg({
          accountId: sys,
          accountKind: 'system',
          systemKey: 'clearing:internal',
          delta: DEB1,
          balanceAfter: DEB1,
        }),
      ],
    });
    const e2 = mkDoc({
      initiatedBy: owner,
      occurredAt: T2,
      legs: [
        leg({ accountId: acctA, ownerId: owner, delta: CRED, balanceAfter: 2_000n }),
        leg({
          accountId: sys,
          accountKind: 'system',
          systemKey: 'clearing:internal',
          delta: -CRED,
          balanceAfter: 0n,
        }),
      ],
    });
    const e3 = mkDoc({
      initiatedBy: owner,
      occurredAt: T3,
      legs: [
        leg({ accountId: acctA, ownerId: owner, delta: -DEB2, balanceAfter: LAST_BALANCE }),
        leg({
          accountId: sys,
          accountKind: 'system',
          systemKey: 'clearing:internal',
          delta: DEB2,
          balanceAfter: DEB2,
        }),
      ],
    });

    // Insert OUT of occurredAt order (latest first) so a pipeline that takes the
    // last-INSERTED balanceAfter instead of the last-by-occurredAt is caught.
    await seed(e3);
    await seed(e1);
    await seed(e2);

    const rows = await summaries({ ownerId: owner, limit: 200 });
    const row = rows.find((r) => r.accountId === acctA);
    expect(row).toBeDefined();

    // txnCount = number of legs touching acctA (one per event = 3).
    expect(row.txnCount).toBe(3);
    // lastBalanceAfter = the LATEST event's (T3) balanceAfter — proves occurredAt sort.
    expect(money(row.lastBalanceAfter)).toBe(LAST_BALANCE);
    // totalDebited = Σ|delta| over debit legs (> 2^53, EXACT). totalCredited = Σ credit.
    expect(money(row.totalDebited)).toBe(TOTAL_DEBITED);
    expect(money(row.totalCredited)).toBe(CRED);
    // lastActivityAt = the latest occurredAt.
    expect(new Date(row.lastActivityAt).getTime()).toBe(T3.getTime());
    // Descriptive fields.
    expect(row.ownerId).toBe(owner);
    expect(row.accountKind).toBe('customer');
    expect(row.currency).toBe('MXN');
  }, 60_000);

  it('accountSummaries: an empty money side is exactly "0" — debit-only -> totalCredited 0n, credit-only -> totalDebited 0n', async () => {
    // The empty-$sum edge: when a `$cond` never matches (an account with no credit legs,
    // or no debit legs), Mongo's `$sum` returns an int32 `0`. The repo's toBigInt must
    // convert that to `0n` / "0" — not throw, not float, not leave it undefined. Assert
    // the EXACT zero (a wrong path would surface as undefined/NaN or a non-"0" value).
    const owner = `sub-${randomUUID()}`;
    const debitOnly = randomUUID();
    const creditOnly = randomUUID();
    const at = new Date('2026-04-01T12:00:00.000Z');

    // debitOnly account: two negative-delta legs, zero credits.
    const dOnly = mkDoc({
      initiatedBy: owner,
      occurredAt: at,
      legs: [
        leg({ accountId: debitOnly, ownerId: owner, delta: -700n, balanceAfter: 300n }),
        leg({
          accountId: randomUUID(),
          accountKind: 'system',
          systemKey: 'clearing:internal',
          delta: 700n,
          balanceAfter: 700n,
        }),
      ],
    });
    const dOnly2 = mkDoc({
      initiatedBy: owner,
      occurredAt: new Date('2026-04-02T12:00:00.000Z'),
      legs: [
        leg({ accountId: debitOnly, ownerId: owner, delta: -200n, balanceAfter: 100n }),
        leg({
          accountId: randomUUID(),
          accountKind: 'system',
          systemKey: 'clearing:internal',
          delta: 200n,
          balanceAfter: 900n,
        }),
      ],
    });
    // creditOnly account: a single positive-delta leg, zero debits.
    const cOnly = mkDoc({
      initiatedBy: owner,
      occurredAt: at,
      legs: [
        leg({ accountId: creditOnly, ownerId: owner, delta: 500n, balanceAfter: 500n }),
        leg({
          accountId: randomUUID(),
          accountKind: 'system',
          systemKey: 'clearing:internal',
          delta: -500n,
          balanceAfter: -500n,
        }),
      ],
    });

    await seed(dOnly);
    await seed(dOnly2);
    await seed(cOnly);

    const rows = await summaries({ ownerId: owner, limit: 200 });

    const dRow = rows.find((r) => r.accountId === debitOnly);
    expect(dRow).toBeDefined();
    expect(money(dRow.totalDebited)).toBe(900n); // 700 + 200
    expect(money(dRow.totalCredited)).toBe(0n); // EXACT zero (empty credit side)

    const cRow = rows.find((r) => r.accountId === creditOnly);
    expect(cRow).toBeDefined();
    expect(money(cRow.totalCredited)).toBe(500n);
    expect(money(cRow.totalDebited)).toBe(0n); // EXACT zero (empty debit side)
  }, 60_000);

  it('dailyAggregates: per day × currency × type rollup is exact — count + totalAmount (> 2^53)', async () => {
    const cur1 = synthCurrency();
    let cur2 = synthCurrency();
    while (cur2 === cur1) cur2 = synthCurrency();

    const day1 = '2026-06-01';
    const day2 = '2026-06-02';
    const at = (day: string): Date => new Date(`${day}T12:00:00.000Z`);

    // (day1, cur1, internal): two events summing PAST 2^53.
    const A1a = 5_000_000_000_000_000n;
    const A1b = 4_007_199_254_740_993n; // A1a + A1b = 9_007_199_254_740_993 (2^53 + 1)
    const D1_INTERNAL_TOTAL = A1a + A1b;
    const A1c = 777_000n; // (day1, cur1, external_outbound)
    const A2 = 123_456n; // (day2, cur1, internal)
    const B1 = 999_000n; // (day1, cur2, internal)

    const posted = (currency: string, type: string, amount: bigint, day: string): TxDoc => {
      const owner = `sub-${randomUUID()}`;
      return mkDoc({
        type,
        currency,
        amount,
        initiatedBy: owner,
        occurredAt: at(day),
        legs: [
          leg({
            accountId: randomUUID(),
            ownerId: owner,
            delta: -amount,
            balanceAfter: 0n,
            currency,
          }),
          leg({
            accountId: randomUUID(),
            accountKind: 'system',
            systemKey: 'clearing:x',
            delta: amount,
            balanceAfter: amount,
            currency,
          }),
        ],
      });
    };

    await seed(posted(cur1, 'internal', A1a, day1));
    await seed(posted(cur1, 'internal', A1b, day1));
    await seed(posted(cur1, 'external_outbound', A1c, day1));
    await seed(posted(cur1, 'internal', A2, day2));
    await seed(posted(cur2, 'internal', B1, day1));

    const cur1Rows = await aggregates({ currency: cur1, limit: 200 });

    const g1 = findDaily(cur1Rows, day1, cur1, 'internal');
    expect(g1).toBeDefined();
    expect(g1.count).toBe(2);
    expect(money(g1.totalAmount)).toBe(D1_INTERNAL_TOTAL); // > 2^53, EXACT (the money proof)

    const g2 = findDaily(cur1Rows, day1, cur1, 'external_outbound');
    expect(g2).toBeDefined();
    expect(g2.count).toBe(1);
    expect(money(g2.totalAmount)).toBe(A1c);

    const g3 = findDaily(cur1Rows, day2, cur1, 'internal');
    expect(g3).toBeDefined();
    expect(g3.count).toBe(1);
    expect(money(g3.totalAmount)).toBe(A2);

    // The cur1 query must not include cur2's data (currency filter narrows).
    expect(cur1Rows.every((r) => r.currency === cur1)).toBe(true);

    // And the cur2 query returns ONLY cur2's single group (filter exclusion both ways).
    const cur2Rows = await aggregates({ currency: cur2 });
    const gb = findDaily(cur2Rows, day1, cur2, 'internal');
    expect(gb).toBeDefined();
    expect(gb.count).toBe(1);
    expect(money(gb.totalAmount)).toBe(B1);
    expect(cur2Rows.some((r) => r.currency === cur1)).toBe(false);
  }, 60_000);

  it('FAILED events are excluded: no accountSummary row (empty legs) and no POSTED-only inflation of dailyAggregates', async () => {
    // --- dailyAggregates: a FAILED event carries an amount but must NOT be counted ---
    const cur = synthCurrency();
    const day = '2026-07-01';
    const at = new Date(`${day}T12:00:00.000Z`);
    const POSTED_AMT = 200_000n;
    const FAILED_AMT = 9_999_999n; // would inflate the total if wrongly counted

    const ownerP = `sub-${randomUUID()}`;
    const acctP = randomUUID();
    const postedDoc = mkDoc({
      type: 'internal',
      currency: cur,
      amount: POSTED_AMT,
      initiatedBy: ownerP,
      occurredAt: at,
      legs: [
        leg({
          accountId: acctP,
          ownerId: ownerP,
          delta: -POSTED_AMT,
          balanceAfter: 0n,
          currency: cur,
        }),
        leg({
          accountId: randomUUID(),
          accountKind: 'system',
          systemKey: 'clearing:x',
          delta: POSTED_AMT,
          balanceAfter: POSTED_AMT,
          currency: cur,
        }),
      ],
    });
    const failedOwner = `sub-${randomUUID()}`;
    const failedDoc = mkDoc({
      status: 'FAILED',
      type: 'internal',
      currency: cur,
      amount: FAILED_AMT,
      failureReason: 'INSUFFICIENT_FUNDS',
      initiatedBy: failedOwner,
      occurredAt: at,
      legs: [], // FAILED => no money moved => empty legs (contract)
    });

    await seed(postedDoc);
    await seed(failedDoc);

    const rows = await aggregates({ currency: cur, limit: 200 });
    const g = findDaily(rows, day, cur, 'internal');
    expect(g).toBeDefined();
    expect(g.count).toBe(1); // ONLY the posted event — not 2
    expect(money(g.totalAmount)).toBe(POSTED_AMT); // NOT POSTED_AMT + FAILED_AMT

    // --- accountSummaries: the failed (empty-legs) event yields no account row ---
    const failedRows = await summaries({ ownerId: failedOwner });
    expect(failedRows).toHaveLength(0);

    // Sanity: the pipeline DOES produce a row for the posted customer account.
    const postedRows = await summaries({ ownerId: ownerP });
    const pRow = postedRows.find((r) => r.accountId === acctP);
    expect(pRow).toBeDefined();
    expect(pRow.txnCount).toBe(1);
    expect(money(pRow.totalDebited)).toBe(POSTED_AMT);
  }, 60_000);

  it('filters narrow results: accountSummaries by ownerId & accountId; dailyAggregates by from/to & type', async () => {
    // accountSummaries: two distinct owners / accounts under one synthetic currency.
    const cur = synthCurrency();
    const owner1 = `sub-${randomUUID()}`;
    const owner2 = `sub-${randomUUID()}`;
    const acct1 = randomUUID();
    const acct2 = randomUUID();
    const at = new Date('2026-05-01T12:00:00.000Z');

    const customerDoc = (owner: string, acct: string): TxDoc =>
      mkDoc({
        type: 'internal',
        currency: cur,
        amount: 10_000n,
        initiatedBy: owner,
        occurredAt: at,
        legs: [
          leg({
            accountId: acct,
            ownerId: owner,
            delta: -10_000n,
            balanceAfter: 0n,
            currency: cur,
          }),
          leg({
            accountId: randomUUID(),
            accountKind: 'system',
            systemKey: 'clearing:x',
            delta: 10_000n,
            balanceAfter: 10_000n,
            currency: cur,
          }),
        ],
      });

    await seed(customerDoc(owner1, acct1));
    await seed(customerDoc(owner2, acct2));

    // ownerId filter: owner1's account present, owner2's absent.
    const byOwner = await summaries({ ownerId: owner1, limit: 200 });
    expect(byOwner.some((r) => r.accountId === acct1)).toBe(true);
    expect(byOwner.some((r) => r.accountId === acct2)).toBe(false);

    // accountId filter: only acct1.
    const byAccount = await summaries({ accountId: acct1, limit: 200 });
    expect(byAccount.some((r) => r.accountId === acct1)).toBe(true);
    expect(byAccount.some((r) => r.accountId === acct2)).toBe(false);

    // dailyAggregates: from/to (date range) + type filters.
    const cur2 = synthCurrency();
    const early = '2026-08-01';
    const late = '2026-08-10';
    const atDay = (day: string): Date => new Date(`${day}T12:00:00.000Z`);
    const dailyDoc = (type: string, day: string, amount: bigint): TxDoc => {
      const owner = `sub-${randomUUID()}`;
      return mkDoc({
        type,
        currency: cur2,
        amount,
        initiatedBy: owner,
        occurredAt: atDay(day),
        legs: [
          leg({
            accountId: randomUUID(),
            ownerId: owner,
            delta: -amount,
            balanceAfter: 0n,
            currency: cur2,
          }),
          leg({
            accountId: randomUUID(),
            accountKind: 'system',
            systemKey: 'clearing:x',
            delta: amount,
            balanceAfter: amount,
            currency: cur2,
          }),
        ],
      });
    };
    await seed(dailyDoc('internal', early, 100_000n));
    await seed(dailyDoc('external_outbound', early, 55_000n));
    await seed(dailyDoc('internal', late, 200_000n));

    // from/to: the service contract is `from?: Date` / `to?: Date` — the controller's
    // `z.coerce.date()` turns the HTTP query STRINGS into `Date`s, so calling the service
    // directly we must pass the coerced form (a string here builds a BSON string bound
    // against a `Date` field and matches nothing). Window [08-01T00:00Z, 08-05T00:00Z]
    // includes `early` (08-01T12:00Z) and excludes `late` (08-10T12:00Z).
    const inRange = await aggregates({
      currency: cur2,
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-08-05T00:00:00.000Z'),
      limit: 200,
    });
    expect(inRange.some((r) => r.date === early)).toBe(true);
    expect(inRange.some((r) => r.date === late)).toBe(false);

    // type filter: only internal groups come back.
    const internalOnly = await aggregates({ currency: cur2, type: 'internal', limit: 200 });
    expect(internalOnly.length).toBeGreaterThan(0);
    expect(internalOnly.every((r) => r.type === 'internal')).toBe(true);
    expect(internalOnly.some((r) => r.type === 'external_outbound')).toBe(false);
  }, 60_000);

  it('paging clamps: limit above max clamps to 200, no limit defaults to 50, offset skips a distinct page', async () => {
    const owner = `sub-${randomUUID()}`;
    const cur = synthCurrency();
    const sysShared = randomUUID();
    const N = 201; // > 200 so the max clamp is observable

    const docs: TxDoc[] = [];
    for (let i = 0; i < N; i++) {
      docs.push(
        mkDoc({
          type: 'internal',
          currency: cur,
          amount: 100n,
          initiatedBy: owner,
          occurredAt: new Date(2026, 0, 1, 0, 0, i), // distinct occurredAt per doc
          legs: [
            leg({
              accountId: randomUUID(),
              ownerId: owner,
              delta: -100n,
              balanceAfter: 0n,
              currency: cur,
            }),
            leg({
              accountId: sysShared,
              accountKind: 'system',
              systemKey: 'clearing:x',
              delta: 100n,
              balanceAfter: 0n,
              currency: cur,
            }),
          ],
        }),
      );
    }
    for (const d of docs) created.push(d._id);
    await Promise.all(docs.map((d) => repo.upsertByEventId(d)));

    // Max clamp: ask for far more than the cap -> exactly 200 rows.
    const capped = await summaries({ ownerId: owner, limit: 9999 });
    expect(capped.length).toBe(200);

    // Default clamp: no limit -> 50 rows (plenty available).
    const defaulted = await summaries({ ownerId: owner });
    expect(defaulted.length).toBe(50);

    // Offset skips: two adjacent pages of 10 are DISJOINT (20 distinct accounts).
    const page1 = await summaries({ ownerId: owner, limit: 10, offset: 0 });
    const page2 = await summaries({ ownerId: owner, limit: 10, offset: 10 });
    expect(page1.length).toBe(10);
    expect(page2.length).toBe(10);
    const distinct = new Set([...page1, ...page2].map((r) => r.accountId));
    expect(distinct.size).toBe(20); // no overlap -> offset advanced the window
  }, 90_000);

  describe('daily-aggregates date range: the `to` bound is INCLUSIVE of the whole `to` UTC day', () => {
    // Ground-truth seed. Times are chosen to EXPOSE the old `occurredAt.$lte = to` bug:
    // `to` comes from `z.coerce.date()` on a `"YYYY-MM-DD"` wire string -> that day's UTC
    // MIDNIGHT, but the output buckets are whole UTC calendar days ($dateToString '%Y-%m-%d'
    // in UTC). So the 03-02 events below (15:00 / 23:59, AFTER 03-02T00:00Z) were WRONGLY
    // EXCLUDED by the old code whenever `to = 2026-03-02` (nothing on the 03-02 day is
    // <= 03-02T00:00Z). The fix makes [from, to] an inclusive UTC-calendar-day range
    // (occurredAt >= start-of-from-day AND occurredAt < start-of-(to-day + 1)), so the
    // ENTIRE 03-02 day is included. Every assertion below is derived from THIS seed's
    // ground truth — not from the pipeline.
    const T_0301 = new Date('2026-03-01T12:00:00.000Z'); // day 03-01
    const T_0302_MID = new Date('2026-03-02T15:00:00.000Z'); // day 03-02, mid-day (the critical case)
    const T_0302_LATE = new Date('2026-03-02T23:59:59.000Z'); // day 03-02, last second — strengthens the proof
    const T_0303 = new Date('2026-03-03T09:00:00.000Z'); // day 03-03

    const AMT_0301 = 100_000n;
    const AMT_0302_MID = 20_000n;
    const AMT_0302_LATE = 3_000n;
    const AMT_0303 = 500_000n;
    const TOTAL_0302 = AMT_0302_MID + AMT_0302_LATE; // 23_000 — the two 03-02 events bucket into ONE day

    // `new Date('YYYY-MM-DD')` parses to that day's UTC midnight — EXACTLY what the
    // controller's `z.coerce.date()` produces from the wire day string. Passing this
    // through the service exercises the real coerced input, not a hand-built boundary.
    const FROM_0302 = new Date('2026-03-02');
    const TO_0302 = new Date('2026-03-02');

    // All docs share ONE fresh synthetic currency + one type, so each distinct UTC day is
    // exactly one bucket AND the query is isolated from any other data in a shared Mongo.
    let cur: string;
    const day = (r: any[], date: string): any => findDaily(r, date, cur, 'internal');

    beforeEach(async () => {
      cur = synthCurrency();
      const posted = (amount: bigint, at: Date): TxDoc => {
        const owner = `sub-${randomUUID()}`;
        return mkDoc({
          type: 'internal',
          currency: cur,
          amount,
          initiatedBy: owner,
          occurredAt: at,
          legs: [
            leg({
              accountId: randomUUID(),
              ownerId: owner,
              delta: -amount,
              balanceAfter: 0n,
              currency: cur,
            }),
            leg({
              accountId: randomUUID(),
              accountKind: 'system',
              systemKey: 'clearing:x',
              delta: amount,
              balanceAfter: amount,
              currency: cur,
            }),
          ],
        });
      };
      await seed(posted(AMT_0301, T_0301));
      await seed(posted(AMT_0302_MID, T_0302_MID));
      await seed(posted(AMT_0302_LATE, T_0302_LATE));
      await seed(posted(AMT_0303, T_0303));
    });

    it('proof 1 — the `to` day is INCLUDED: {from:03-02,to:03-02} yields the 03-02 bucket with BOTH that-day events (old $lte:midnight code returned ZERO buckets)', async () => {
      const rows = await aggregates({ currency: cur, from: FROM_0302, to: TO_0302, limit: 200 });

      // Narrowed by the synthetic currency, the ONLY in-range day carrying data is 03-02, so
      // there is exactly one bucket. The old code (occurredAt <= 03-02T00:00Z) dropped both
      // 03-02 events and returned an EMPTY result here.
      expect(rows).toHaveLength(1);
      const g = day(rows, '2026-03-02');
      expect(g).toBeDefined();
      // Both 03-02 events (15:00 and 23:59, AFTER midnight) are counted — the bug's blind spot.
      expect(g.count).toBe(2);
      expect(money(g.totalAmount)).toBe(TOTAL_0302);
    }, 60_000);

    it('proof 2 — upper bound inclusive, lower open: {to:03-02} (no from) returns 03-01 AND 03-02, and NOT 03-03 (old code returned only 03-01)', async () => {
      const rows = await aggregates({ currency: cur, to: TO_0302, limit: 200 });

      const d1 = day(rows, '2026-03-01');
      const d2 = day(rows, '2026-03-02');
      expect(d1).toBeDefined();
      expect(d1.count).toBe(1);
      expect(money(d1.totalAmount)).toBe(AMT_0301);
      // The whole 03-02 day is present — the old code omitted this bucket entirely.
      expect(d2).toBeDefined();
      expect(d2.count).toBe(2);
      expect(money(d2.totalAmount)).toBe(TOTAL_0302);

      // 03-03 is strictly after the `to` day -> excluded by the exclusive next-day upper bound.
      expect(day(rows, '2026-03-03')).toBeUndefined();
      expect(rows).toHaveLength(2);
    }, 60_000);

    it('proof 3 — the window excludes days outside [from,to]: {from:03-02,to:03-02} includes neither 03-01 (from lower bound) nor 03-03 (exclusive next-day upper bound) — no over-inclusion', async () => {
      const rows = await aggregates({ currency: cur, from: FROM_0302, to: TO_0302, limit: 200 });

      expect(day(rows, '2026-03-01')).toBeUndefined();
      expect(day(rows, '2026-03-03')).toBeUndefined();
      // 03-02 is the SOLE surviving bucket — the fix widened the upper bound to cover the
      // whole `to` day WITHOUT bleeding into the next day.
      expect(rows.map((r) => r.date)).toEqual(['2026-03-02']);
    }, 60_000);
  });
});
