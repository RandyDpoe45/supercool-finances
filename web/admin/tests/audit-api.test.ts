import { configureStore } from '@reduxjs/toolkit';
import { User } from 'oidc-client-ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Make the same-origin `/balance/admin` base absolute before baseApi captures the env at import
// (identical to the other suites); MSW still matches its relative handlers against the same origin.
vi.hoisted(() => {
  vi.stubEnv('VITE_API_BASE_URL', `${window.location.origin}/balance/admin`);
});

import { baseApi } from '../src/services/api/baseApi';
import { auditApi, type AuditFilter } from '../src/services/api/auditApi';
import type { AuditLogDto } from '../src/services/api/contracts/audit';
import { userManager } from '../src/auth/userManager';

/**
 * Direct stub/contract tests for the `GET /admin/audit` read endpoint. Dispatching
 * `auditApi.endpoints.getAudit.initiate(...)` on the REAL store hits the live MSW stub (no
 * `server.use` override), proving the stub mirrors the balance-service `/admin/audit` wire contract
 * that the audit VIEW relies on but the happy UI path cannot pin down precisely: newest-first
 * ordering (createdAt DESC, then a NUMERIC id-DESC tiebreak — never lexicographic), exact-match
 * filter mapping (actorId / action / targetType, and an unknown value → empty), and offset/limit
 * paging (disjoint pages that concatenate to a prefix of the full order; the server clamp).
 *
 * The expected ORDER is derived here from the SPEC (the {@link byNewestFirst} comparator), not copied
 * from the stub's implementation, so a stub that sorted lexicographically (placing `'9'` before
 * `'10'`) would fail these.
 */

const NOW_SECONDS = () => Math.floor(Date.now() / 1000);

/** Spec ordering: `createdAt` DESC (ISO strings compare chronologically), then `id` DESC as a
 * bigint-aware tiebreak so `'10'` sorts before `'9'` — a numeric compare, never lexicographic. */
function byNewestFirst(a: AuditLogDto, b: AuditLogDto): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1;
  }
  return a.id === b.id ? 0 : BigInt(a.id) < BigInt(b.id) ? 1 : -1;
}

function makeStore() {
  return configureStore({
    reducer: { [baseApi.reducerPath]: baseApi.reducer },
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(baseApi.middleware),
  });
}

/** Dispatch the audit read against the live stub on a throwaway store (no cache subscription), so
 * each call reflects the pristine seed straight off the MSW handler — the fixtures' ground truth. */
async function getAudit(arg?: AuditFilter): Promise<AuditLogDto[]> {
  const store = makeStore();
  const result = await store.dispatch(
    auditApi.endpoints.getAudit.initiate(arg, { subscribe: false, forceRefetch: true }),
  );
  if ('error' in result && result.error) {
    throw new Error(`getAudit failed: ${JSON.stringify(result.error)}`);
  }
  return result.data ?? [];
}

beforeEach(async () => {
  await userManager.storeUser(
    new User({
      access_token: 'audit-api-access-token',
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

describe('audit stub — newest-first ordering', () => {
  it('returns entries sorted by createdAt DESC, then a NUMERIC id-DESC tiebreak', async () => {
    const entries = await getAudit(undefined);
    expect(entries.length).toBeGreaterThanOrEqual(10);

    // The returned order must already equal the spec ordering — a stub that returned insertion order
    // or an ascending sort would differ once re-sorted.
    const expectedOrder = [...entries].sort(byNewestFirst).map((e) => e.id);
    expect(entries.map((e) => e.id)).toEqual(expectedOrder);

    // Sharp tiebreak proof: `'9'` and `'10'` share a createdAt in the seed, so a lexicographic id
    // sort would place `'9'` first. Newest-first (numeric) requires `'10'` before `'9'`.
    const ids = entries.map((e) => e.id);
    expect(ids).toContain('9');
    expect(ids).toContain('10');
    expect(ids.indexOf('10')).toBeLessThan(ids.indexOf('9'));
  });
});

describe('audit stub — filter mapping (exact match, server-side)', () => {
  it('narrows by action, by actorId, and returns [] for a value no entry uses', async () => {
    const all = await getAudit({ limit: 200, offset: 0 });
    expect(all.length).toBeGreaterThan(1);

    // action: every returned row carries the requested action, and the count matches ground truth.
    const action = all[0].action;
    const byAction = await getAudit({ action });
    expect(byAction.length).toBeGreaterThan(0);
    expect(byAction.every((e) => e.action === action)).toBe(true);
    expect(byAction.length).toBe(all.filter((e) => e.action === action).length);
    expect(byAction.length).toBeLessThan(all.length); // the seed has other actions too

    // actorId: same — and the seed uses ≥2 actors, so this is a true narrowing.
    const actor = all[0].actorId;
    const byActor = await getAudit({ actorId: actor });
    expect(byActor.length).toBeGreaterThan(0);
    expect(byActor.every((e) => e.actorId === actor)).toBe(true);
    expect(byActor.length).toBe(all.filter((e) => e.actorId === actor).length);
    expect(byActor.length).toBeLessThan(all.length);

    // targetType (a filter the contract lists): pick a non-null one from the seed.
    const targeted = all.find((e) => e.targetType !== null);
    expect(targeted, 'seed has an entry with a non-null targetType').toBeDefined();
    const byTargetType = await getAudit({ targetType: targeted!.targetType! });
    expect(byTargetType.length).toBeGreaterThan(0);
    expect(byTargetType.every((e) => e.targetType === targeted!.targetType)).toBe(true);

    // A filter value no entry uses returns an empty array (not "ignored → all rows").
    expect(await getAudit({ action: 'no.such.action' })).toEqual([]);
    expect(await getAudit({ actorId: 'nobody-not-seeded' })).toEqual([]);
  });
});

describe('audit stub — offset/limit paging', () => {
  it('honors limit + offset: disjoint pages that concatenate to a prefix of the full DESC order', async () => {
    const all = await getAudit({ limit: 200, offset: 0 });
    expect(all.length).toBeGreaterThanOrEqual(3);

    const page0 = await getAudit({ limit: 2, offset: 0 });
    const page1 = await getAudit({ limit: 2, offset: 2 });
    expect(page0.length).toBe(2);
    expect(page1.length).toBeGreaterThan(0);
    expect(page1.length).toBeLessThanOrEqual(2);

    // The two windows do not overlap (offset was actually applied, not ignored).
    const idsOnPage0 = new Set(page0.map((e) => e.id));
    expect(page1.every((e) => !idsOnPage0.has(e.id))).toBe(true);

    // Together they are the first `page0+page1` rows of the full newest-first order.
    expect([...page0, ...page1].map((e) => e.id)).toEqual(
      all.slice(0, page0.length + page1.length).map((e) => e.id),
    );

    // limit 1 returns exactly the single newest row (limit honored at the low bound).
    const first = await getAudit({ limit: 1, offset: 0 });
    expect(first.length).toBe(1);
    expect(first[0].id).toBe(all[0].id);
  });

  it('clamps an over-large limit to ≤200 without error (returns all seeded rows here)', async () => {
    const all = await getAudit({ limit: 200, offset: 0 });
    const clamped = await getAudit({ limit: 500 });
    expect(clamped.length).toBeLessThanOrEqual(200);
    expect(clamped.length).toBe(all.length);
  });
});
