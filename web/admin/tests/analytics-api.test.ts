import { configureStore } from '@reduxjs/toolkit';
import { User } from 'oidc-client-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom's node fetch cannot resolve the app's relative service-namespaced bases; make BOTH bases
// absolute against the test origin BEFORE the api slices capture the env at import (identical to the
// other suites). The analytics dashboard talks to a SECOND slice (`analyticsApi`) on the distinct
// `/analytics/admin` namespace, so we stub that base too. MSW resolves its relative handlers against
// the same origin, so requests still match.
vi.hoisted(() => {
  vi.stubEnv('VITE_ANALYTICS_API_BASE_URL', `${window.location.origin}/analytics/admin`);
  vi.stubEnv('VITE_API_BASE_URL', `${window.location.origin}/balance/admin`);
});

import { baseApi } from '../src/services/api/baseApi';
import {
  analyticsApi,
  type AccountSummariesFilter,
  type DailyAggregatesFilter,
} from '../src/services/api/analyticsApi';
import type { AccountSummaryDto, DailyAggregateDto } from '../src/services/api/contracts/analytics';
import { userManager } from '../src/auth/userManager';

/**
 * Direct stub/contract tests for the analytics reporting reads (`GET /admin/reports/account-summaries`
 * and `GET /admin/reports/daily-aggregates`). Dispatching `analyticsApi.endpoints.*.initiate(...)` on
 * the REAL store hits the live MSW stub (no `server.use` override), proving the stub mirrors the
 * analytics-server reporting wire contract (specs/07 + DATA-MODEL Part 2) that the dashboard relies
 * on but the happy UI path cannot pin down precisely:
 *
 *  - the `{ accountSummaries }` / `{ dailyAggregates }` envelope is unwrapped to the row array, and
 *    each row carries EXACTLY the whitelisted DTO fields — money as an integer STRING (never a float
 *    or a number), `txnCount` / `count` as the only numerics;
 *  - the exact-match filters (`type` / `currency` / `ownerId`) and the INCLUSIVE `from`/`to` day
 *    window narrow the rows correctly, and a value no row uses returns `[]` (not "ignored → all");
 *  - offset/limit paging yields disjoint pages that concatenate to a prefix of the list, and an
 *    over-large limit clamps to ≤200 without error.
 *
 * All expectations are derived from the ground truth FETCHED THROUGH THE ENDPOINT and re-filtered here
 * per the SPEC, never copied from the stub's implementation.
 */

const NOW_SECONDS = () => Math.floor(Date.now() / 1000);

const ACCOUNT_SUMMARY_KEYS = [
  'accountId',
  'ownerId',
  'accountKind',
  'systemKey',
  'currency',
  'lastBalanceAfter',
  'txnCount',
  'totalDebited',
  'totalCredited',
  'lastActivityAt',
].sort();

const DAILY_AGGREGATE_KEYS = ['date', 'currency', 'type', 'count', 'totalAmount'].sort();

const INTEGER_STRING = /^-?\d+$/;
const DAY_LABEL = /^\d{4}-\d{2}-\d{2}$/;

function makeStore() {
  return configureStore({
    reducer: {
      [baseApi.reducerPath]: baseApi.reducer,
      [analyticsApi.reducerPath]: analyticsApi.reducer,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().concat(baseApi.middleware).concat(analyticsApi.middleware),
  });
}

/** Dispatch a read against the live stub on a throwaway store (no cache subscription), so each call
 * reflects the pristine seed straight off the MSW handler — the fixtures' ground truth. */
async function getAccountSummaries(arg?: AccountSummariesFilter): Promise<AccountSummaryDto[]> {
  const store = makeStore();
  const result = await store.dispatch(
    analyticsApi.endpoints.getAccountSummaries.initiate(arg, {
      subscribe: false,
      forceRefetch: true,
    }),
  );
  if ('error' in result && result.error) {
    throw new Error(`getAccountSummaries failed: ${JSON.stringify(result.error)}`);
  }
  return result.data ?? [];
}

async function getDailyAggregates(arg?: DailyAggregatesFilter): Promise<DailyAggregateDto[]> {
  const store = makeStore();
  const result = await store.dispatch(
    analyticsApi.endpoints.getDailyAggregates.initiate(arg, {
      subscribe: false,
      forceRefetch: true,
    }),
  );
  if ('error' in result && result.error) {
    throw new Error(`getDailyAggregates failed: ${JSON.stringify(result.error)}`);
  }
  return result.data ?? [];
}

beforeEach(async () => {
  await userManager.storeUser(
    new User({
      access_token: 'analytics-api-access-token',
      token_type: 'Bearer',
      session_state: null,
      scope: 'openid profile',
      expires_at: NOW_SECONDS() + 3600,
      profile: {
        sub: 'admin-subject-123',
        iss: 'http://keycloak.localtest.me:8082/realms/supercool',
        aud: 'supercool-api',
        exp: NOW_SECONDS() + 3600,
        iat: NOW_SECONDS(),
      },
    }),
  );
});

afterEach(async () => {
  await userManager.removeUser();
  window.sessionStorage.clear();
});

describe('analytics stub — envelope unwrap + DTO shape', () => {
  it('account-summaries: unwraps { accountSummaries } to rows carrying exactly the whitelisted fields', async () => {
    const rows = await getAccountSummaries(undefined);
    expect(rows.length).toBeGreaterThanOrEqual(3);

    for (const row of rows) {
      // Exactly the contract keys — a leaked internal field (or a dropped one) fails here.
      expect(Object.keys(row).sort()).toEqual(ACCOUNT_SUMMARY_KEYS);
      // Money is a canonical integer STRING (minor units) — never a number, never a decimal/float.
      for (const money of [row.lastBalanceAfter, row.totalDebited, row.totalCredited]) {
        expect(typeof money).toBe('string');
        expect(money).toMatch(INTEGER_STRING);
      }
      // The only numeric is a safe-integer count.
      expect(typeof row.txnCount).toBe('number');
      expect(Number.isInteger(row.txnCount)).toBe(true);
      // Nullable identity fields hold a string or an explicit null (never undefined).
      expect(row.ownerId === null || typeof row.ownerId === 'string').toBe(true);
      expect(row.systemKey === null || typeof row.systemKey === 'string').toBe(true);
      expect(typeof row.accountKind).toBe('string');
      expect(typeof row.currency).toBe('string');
      // lastActivityAt is a parseable instant (converted at the render edge, not here).
      expect(Number.isNaN(new Date(row.lastActivityAt).getTime())).toBe(false);
    }
  });

  it('daily-aggregates: unwraps { dailyAggregates } to rows carrying exactly the whitelisted fields', async () => {
    const rows = await getDailyAggregates(undefined);
    expect(rows.length).toBeGreaterThanOrEqual(3);

    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(DAILY_AGGREGATE_KEYS);
      // `totalAmount` is a canonical integer STRING; `count` the only numeric.
      expect(typeof row.totalAmount).toBe('string');
      expect(row.totalAmount).toMatch(INTEGER_STRING);
      expect(typeof row.count).toBe('number');
      expect(Number.isInteger(row.count)).toBe(true);
      // `date` is a bare UTC day LABEL (YYYY-MM-DD), NOT a full ISO instant.
      expect(row.date).toMatch(DAY_LABEL);
      expect(typeof row.currency).toBe('string');
      expect(typeof row.type).toBe('string');
    }
  });
});

describe('analytics stub — exact-match filter mapping', () => {
  it('daily-aggregates narrow by type and by currency; an unused value returns []', async () => {
    const all = await getDailyAggregates({ limit: 200, offset: 0 });
    expect(all.length).toBeGreaterThan(1);

    // type: every returned row carries the requested type, and the count matches ground truth.
    const type = 'external_outbound';
    const expectedByType = all.filter((r) => r.type === type);
    expect(expectedByType.length, 'seed exercises external_outbound').toBeGreaterThan(0);
    expect(expectedByType.length, 'seed also has other types (true narrowing)').toBeLessThan(
      all.length,
    );
    const byType = await getDailyAggregates({ type });
    expect(byType.every((r) => r.type === type)).toBe(true);
    expect(byType.length).toBe(expectedByType.length);

    // currency: same. The seed mixes currencies, so this is a true narrowing.
    const currency = all.find((r) => r.currency !== all[0].currency)?.currency ?? all[0].currency;
    const expectedByCurrency = all.filter((r) => r.currency === currency);
    const byCurrency = await getDailyAggregates({ currency });
    expect(byCurrency.every((r) => r.currency === currency)).toBe(true);
    expect(byCurrency.length).toBe(expectedByCurrency.length);

    // A type / currency no row uses returns [] (the filter is applied, not ignored).
    expect(await getDailyAggregates({ type: 'no_such_type' })).toEqual([]);
    expect(await getDailyAggregates({ currency: 'ZZZ' })).toEqual([]);
  });

  it('account-summaries narrow by ownerId; an unused owner returns []', async () => {
    const all = await getAccountSummaries({ limit: 200, offset: 0 });
    expect(all.length).toBeGreaterThan(1);

    const owner = all.find((r) => r.ownerId !== null)?.ownerId;
    expect(owner, 'seed has an owned (non-system) summary').toBeDefined();
    const expectedByOwner = all.filter((r) => r.ownerId === owner);
    expect(expectedByOwner.length).toBeGreaterThan(0);
    expect(
      expectedByOwner.length,
      'seed has other owners / system rows (true narrowing)',
    ).toBeLessThan(all.length);

    const byOwner = await getAccountSummaries({ ownerId: owner! });
    expect(byOwner.every((r) => r.ownerId === owner)).toBe(true);
    expect(byOwner.length).toBe(expectedByOwner.length);

    // A null-owner (system) row must NOT be returned when filtering to a concrete owner.
    expect(byOwner.some((r) => r.ownerId === null)).toBe(false);

    expect(await getAccountSummaries({ ownerId: 'nobody-not-seeded' })).toEqual([]);
  });
});

describe('analytics stub — inclusive from/to day-window filter', () => {
  it('returns exactly the buckets with from <= date <= to (both bounds inclusive)', async () => {
    const all = await getDailyAggregates({ limit: 200, offset: 0 });
    const dates = [...new Set(all.map((r) => r.date))].sort();
    expect(dates.length, 'seed spans several distinct day buckets').toBeGreaterThanOrEqual(4);

    // A window that drops the earliest AND the latest bucket, so the filter is a real narrowing on
    // BOTH ends and the inclusivity of each bound is observable.
    const from = dates[1];
    const to = dates[dates.length - 2];
    const expected = all.filter((r) => r.date >= from && r.date <= to);
    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(all.length);

    const windowed = await getDailyAggregates({ from, to });

    // Exactly the SPEC-filtered rows (same set), and nothing out of range.
    expect(windowed.every((r) => r.date >= from && r.date <= to)).toBe(true);
    expect(windowed.length).toBe(expected.length);
    // The boundary days themselves are included (inclusive, not exclusive).
    expect(windowed.some((r) => r.date === from)).toBe(true);
    expect(windowed.some((r) => r.date === to)).toBe(true);
    // The dropped earliest/latest buckets are gone.
    expect(windowed.some((r) => r.date === dates[0])).toBe(false);
    expect(windowed.some((r) => r.date === dates[dates.length - 1])).toBe(false);
  });
});

describe('analytics stub — offset/limit paging', () => {
  it('account-summaries: disjoint pages concatenate to a prefix; over-large limit clamps to ≤200', async () => {
    const all = await getAccountSummaries({ limit: 200, offset: 0 });
    expect(all.length).toBeGreaterThanOrEqual(4);

    const page0 = await getAccountSummaries({ limit: 2, offset: 0 });
    const page1 = await getAccountSummaries({ limit: 2, offset: 2 });
    expect(page0.length).toBe(2);
    expect(page1.length).toBeGreaterThan(0);
    expect(page1.length).toBeLessThanOrEqual(2);

    // Disjoint windows (offset was applied, not ignored)...
    const idsPage0 = new Set(page0.map((r) => r.accountId));
    expect(page1.every((r) => !idsPage0.has(r.accountId))).toBe(true);
    // ...that together are the first `page0+page1` rows of the list.
    expect([...page0, ...page1].map((r) => r.accountId)).toEqual(
      all.slice(0, page0.length + page1.length).map((r) => r.accountId),
    );

    // An over-large limit clamps to ≤200 (here: all rows) rather than erroring.
    const clamped = await getAccountSummaries({ limit: 500 });
    expect(clamped.length).toBeLessThanOrEqual(200);
    expect(clamped.length).toBe(all.length);
  });

  it('daily-aggregates: paging is disjoint and the limit clamps', async () => {
    const all = await getDailyAggregates({ limit: 200, offset: 0 });
    expect(all.length).toBeGreaterThanOrEqual(4);

    const page0 = await getDailyAggregates({ limit: 3, offset: 0 });
    const page1 = await getDailyAggregates({ limit: 3, offset: 3 });
    expect(page0.length).toBe(3);
    expect(page1.length).toBeGreaterThan(0);

    const key = (r: DailyAggregateDto) => `${r.date}|${r.currency}|${r.type}`;
    const keysPage0 = new Set(page0.map(key));
    expect(page1.every((r) => !keysPage0.has(key(r)))).toBe(true);
    expect([...page0, ...page1].map(key)).toEqual(
      all.slice(0, page0.length + page1.length).map(key),
    );

    const clamped = await getDailyAggregates({ limit: 1000 });
    expect(clamped.length).toBeLessThanOrEqual(200);
    expect(clamped.length).toBe(all.length);
  });
});
