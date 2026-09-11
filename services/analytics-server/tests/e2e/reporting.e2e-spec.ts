/**
 * Spec 05, step A3 — the `/admin/reports` REPORTING API at the HTTP boundary.
 * Written from the spec-05 DoD ("An `/admin` analytics query returns correct
 * aggregates over seeded data" + "unreachable from the public plane" = role-gated)
 * and the A3 contract, NOT from the implementor's code. Every test can FAIL on a
 * real defect.
 *
 * DoD proofs anchored here (the parts that need NO live Mongo — they short-circuit at
 * the guard / validation pipe, or run through a FAKE reporting service):
 *   - Role-gating: no `X-User-Id` -> 401; a non-admin identity -> 403; an admin -> 200
 *     with the wrapped array. The analytics service has NO `/api`; `/admin` is the only
 *     surface and it demands the `admin` role — that is what makes it unreachable from
 *     the public plane.
 *   - Query validation: a malformed query (unknown key under `.strict()`, a non-uuid
 *     `accountId`, an out-of-enum `type`) -> 400 with a SAFE, field-name-only message
 *     (never the offending value reflected back).
 *   - Wire shape: the 200 body wraps the array (`{ accountSummaries }` /
 *     `{ dailyAggregates }`) and money crosses as a STRING (int64 exact past 2^53),
 *     never a JS number — proven end-to-end through the REAL controller + serializers.
 *
 * Follows the repo's no-Docker e2e pattern (identity-and-error-model.e2e-spec.ts): a
 * MINIMAL Nest app binds the implementor's REAL GatewayIdentityGuard globally
 * (APP_GUARD, exactly as AppModule does) + the REAL error filter + the REAL
 * `/admin/reports` controller and its declared validation pipe + serializers, with the
 * reporting SERVICE faked (so the auth/validation/serialization paths are exercised
 * without a database). Correctness OVER SEEDED DATA (the aggregation itself) lives in
 * reporting.integration.spec.ts, which needs a live Mongo.
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import {
  resolveGuardsAndFilter,
  getRequestId,
  getReportsController,
  getReportingServiceToken,
} from '../support/harness';

const { GatewayIdentityGuard, AllExceptionsFilter } = resolveGuardsAndFilter();
const { requestIdMiddleware } = getRequestId();

// 2^53 + 1 — a value a JS number cannot hold without rounding. It rides through the
// fake service as a DOMAIN bigint and must land on the wire as this exact STRING.
const HUGE = 9_007_199_254_740_993n;
const HUGE_STR = '9007199254740993';

// Fixed DOMAIN rows the fake reporting service returns (money as bigint, Date). The
// REAL controller serializes them; we assert the serialized WIRE shape.
const ACCOUNT_ROWS = [
  {
    accountId: 'acct-1',
    ownerId: 'sub-alice',
    accountKind: 'customer',
    systemKey: null,
    currency: 'MXN',
    lastBalanceAfter: HUGE,
    txnCount: 3,
    totalDebited: HUGE,
    totalCredited: 12_345n,
    lastActivityAt: new Date('2026-09-08T12:00:00.000Z'),
    // internal fields the whitelist serializer must drop even here:
    owners: ['sub-alice'],
    _id: 'leak-me-not',
  },
];

const DAILY_ROWS = [
  {
    date: '2026-09-08',
    currency: 'MXN',
    type: 'external_outbound',
    count: 5,
    totalAmount: HUGE,
    _id: { date: '2026-09-08', currency: 'MXN', type: 'external_outbound' },
  },
];

/**
 * A fake reporting service. It doesn't know the exact method name the controller calls
 * (the service interface is the implementor's to name), so it answers via a Proxy that
 * dispatches on the method-name substring — an account/summary method returns the
 * account rows, a daily/aggregate method returns the daily rows. This keeps the fake
 * robust to naming while still driving the REAL controller + serializers.
 */
function makeFakeReportingService(): unknown {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop === 'then') return undefined; // not a thenable
        const name = String(prop).toLowerCase();
        return async () => {
          if (name.includes('account') || name.includes('summar')) return ACCOUNT_ROWS;
          if (name.includes('dail') || name.includes('aggregate')) return DAILY_ROWS;
          return [];
        };
      },
    },
  );
}

const ADMIN = { 'X-User-Id': 'admin-alice', 'X-Roles': 'admin' } as const;

describe('/admin/reports reporting API (HTTP boundary, no Docker)', () => {
  let app: INestApplication;
  let ReportsController: any;
  let REPORTING_SERVICE: symbol;

  beforeAll(async () => {
    ReportsController = getReportsController();
    REPORTING_SERVICE = getReportingServiceToken();

    const moduleRef = await Test.createTestingModule({
      controllers: [ReportsController],
      providers: [
        // Bound globally exactly like AppModule — the gateway guard governs /admin.
        { provide: APP_GUARD, useClass: GatewayIdentityGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        { provide: REPORTING_SERVICE, useValue: makeFakeReportingService() },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(requestIdMiddleware);
    await app.init();
  }, 30_000);

  afterAll(async () => {
    if (app) await app.close();
  });

  const ENDPOINTS = ['/admin/reports/account-summaries', '/admin/reports/daily-aggregates'];

  describe('role-gating (unreachable from the public plane)', () => {
    it.each(ENDPOINTS)('rejects %s with 401 when X-User-Id is absent', async (path) => {
      const res = await request(app.getHttpServer()).get(path);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it.each(ENDPOINTS)(
      'rejects %s with 403 when the identity lacks the admin role',
      async (path) => {
        const res = await request(app.getHttpServer())
          .get(path)
          .set('X-User-Id', 'user-bob')
          .set('X-Roles', 'customer');
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
      },
    );

    it.each(ENDPOINTS)(
      'does NOT trust a role from the query/body (no header => still 401): %s',
      async (path) => {
        const res = await request(app.getHttpServer())
          .get(`${path}?roles=admin`)
          .send({ roles: ['admin'] });
        expect(res.status).toBe(401);
      },
    );
  });

  describe('account-summaries: admin 200 returns the wrapped, serialized array', () => {
    it('wraps as { accountSummaries } and emits money as EXACT strings (> 2^53), never a number', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/reports/account-summaries')
        .set(ADMIN);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.accountSummaries)).toBe(true);
      expect(res.body.accountSummaries).toHaveLength(1);

      const row = res.body.accountSummaries[0];
      // Money crossed the wire as a STRING, exact past 2^53 (JSON has no bigint; a
      // number path would already have rounded HUGE to ...992).
      expect(typeof row.lastBalanceAfter).toBe('string');
      expect(row.lastBalanceAfter).toBe(HUGE_STR);
      expect(typeof row.totalDebited).toBe('string');
      expect(row.totalDebited).toBe(HUGE_STR);
      expect(typeof row.totalCredited).toBe('string');
      expect(row.totalCredited).toBe('12345');
      // Counts stay numbers, dates are ISO strings.
      expect(typeof row.txnCount).toBe('number');
      expect(row.txnCount).toBe(3);
      expect(row.lastActivityAt).toBe('2026-09-08T12:00:00.000Z');
      // Whitelist holds end-to-end: internal fields never reach the wire.
      expect('owners' in row).toBe(false);
      expect('_id' in row).toBe(false);
      expect(JSON.stringify(res.body)).not.toContain('leak-me-not');
    });
  });

  describe('daily-aggregates: admin 200 returns the wrapped, serialized array', () => {
    it('wraps as { dailyAggregates } and emits totalAmount as an EXACT string (> 2^53)', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/reports/daily-aggregates')
        .set(ADMIN);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.dailyAggregates)).toBe(true);
      expect(res.body.dailyAggregates).toHaveLength(1);

      const row = res.body.dailyAggregates[0];
      expect(row.date).toBe('2026-09-08');
      expect(row.currency).toBe('MXN');
      expect(row.type).toBe('external_outbound');
      expect(typeof row.count).toBe('number');
      expect(row.count).toBe(5);
      expect(typeof row.totalAmount).toBe('string');
      expect(row.totalAmount).toBe(HUGE_STR);
      expect('_id' in row).toBe(false);
    });
  });

  describe('query validation (ZodValidationPipe, .strict()) — 400 with a safe message', () => {
    it('rejects an UNKNOWN query key on account-summaries (.strict()) with 400', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/reports/account-summaries?bogusKey=whatever')
        .set(ADMIN);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
    });

    it('rejects a non-uuid accountId on account-summaries with 400 and does NOT reflect the value', async () => {
      const badValue = 'not-a-uuid-value-1234';
      const res = await request(app.getHttpServer())
        .get(`/admin/reports/account-summaries?accountId=${badValue}`)
        .set(ADMIN);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      // Safe message: only field NAMES, never the offending value reflected back.
      expect(res.body.error.message).not.toContain(badValue);
    });

    it('rejects an out-of-enum type on daily-aggregates with 400', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/reports/daily-aggregates?type=not_a_real_type')
        .set(ADMIN);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).not.toContain('not_a_real_type');
    });

    it('accepts a well-formed narrowing query (200), proving validation is not over-broad', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/reports/daily-aggregates?currency=MXN&limit=10')
        .set(ADMIN);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.dailyAggregates)).toBe(true);
    });
  });

  describe('NoSQL operator-injection is rejected (query object cannot reach $match)', () => {
    // Express/qs parses bracket syntax (`?accountId[$ne]=x`) into an OBJECT, not a
    // string. A schema of `z.string()` / `z.string().uuid()` under `.strict()` must
    // reject that object (400) so a `$ne`/`$gt` operator can NEVER land in a Mongo
    // `$match` — the classic NoSQL-injection vector. These lock that defense.
    it('rejects an object-valued accountId (?accountId[$ne]=x) with 400 and does not reflect the operator', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/reports/account-summaries?accountId[$ne]=x')
        .set(ADMIN);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      // The operator/value must not be echoed back (no schema/operator probing).
      expect(res.body.error.message).not.toContain('$ne');
      expect(res.body.error.message).not.toContain('accountId[');
    });

    it('rejects an object-valued ownerId (?ownerId[$gt]=) with 400', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/reports/account-summaries?ownerId[$gt]=')
        .set(ADMIN);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).not.toContain('$gt');
    });

    it('rejects an object-valued currency on daily-aggregates (?currency[$ne]=MXN) with 400', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/reports/daily-aggregates?currency[$ne]=MXN')
        .set(ADMIN);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.message).not.toContain('$ne');
    });
  });
});
