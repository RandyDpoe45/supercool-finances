import { describe, expect, it } from 'vitest';
import type { StatementResponse } from '../src/services/api/contracts/accounts';
import type { ErrorResponse } from '../src/services/api/contracts/error';

/**
 * The `GET /balance/api/accounts/:id/transactions` MSW stub must honor the REAL balance-service wire
 * contract, so the SPA is developed against the shape the backend actually emits. Expectations
 * come from the contract of record — `serializeStatementEntry` / `StatementEntryDto`
 * (id, transactionId, delta, balanceAfter, currency, createdAt) and specs/balance-schema.yaml
 * (delta/balanceAfter minor-unit integer strings; createdAt ISO-8601 UTC; newest-first) — NOT
 * from the app's fixture literals. Guards against stub drift: a leaked internal column, a
 * money field emitted as a float, out-of-order entries, or a mis-mapped error status.
 */

// EXACT whitelist the serializer emits. A leaked internal column (accountId on the row,
// createdBy, internal counters, …) would break this.
const ENTRY_FIELDS = [
  'id',
  'transactionId',
  'delta',
  'balanceAfter',
  'currency',
  'createdAt',
].sort();

const INTEGER_STRING = /^-?\d+$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// A known-good fixture account id (mirrors a resolved, owned customer account).
const OWNED_ID = '11111111-1111-4111-8111-111111111111';

function url(id: string): string {
  return new URL(`/balance/api/accounts/${id}/transactions`, window.location.origin).toString();
}

async function getStatement(id: string): Promise<{ status: number; body: StatementResponse }> {
  const res = await fetch(url(id), { headers: { Authorization: 'Bearer test' } });
  return { status: res.status, body: (await res.json()) as StatementResponse };
}

describe('GET /balance/api/accounts/:id/transactions stub — contract of record', () => {
  it('returns the { accountId, entries } envelope, echoing the resolved account id', async () => {
    const { status, body } = await getStatement(OWNED_ID);
    expect(status).toBe(200);
    expect(body.accountId).toBe(OWNED_ID);
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThan(0);
  });

  it('emits each entry with EXACTLY the whitelisted DTO keys (no leaked internal column)', async () => {
    const { body } = await getStatement(OWNED_ID);
    for (const entry of body.entries) {
      expect(Object.keys(entry).sort()).toEqual(ENTRY_FIELDS);
    }
  });

  it('emits delta/balanceAfter as canonical minor-unit integer strings and createdAt as ISO-8601 UTC', async () => {
    const { body } = await getStatement(OWNED_ID);
    for (const entry of body.entries) {
      expect(typeof entry.delta).toBe('string');
      expect(entry.delta).toMatch(INTEGER_STRING);
      expect(typeof entry.balanceAfter).toBe('string');
      expect(entry.balanceAfter).toMatch(INTEGER_STRING);
      expect(entry.currency).toBe('MXN');
      // ISO-8601 UTC (`Z`), and it must round-trip through Date without becoming NaN.
      expect(entry.createdAt).toMatch(ISO_UTC);
      expect(Number.isNaN(new Date(entry.createdAt).getTime())).toBe(false);
    }
  });

  it('carries a signed debit with a non-trivial balanceAfter (exercises the sign path)', async () => {
    const { body } = await getStatement(OWNED_ID);
    const debit = body.entries.find((e) => BigInt(e.delta) < 0n);
    expect(
      debit,
      'contract needs a negative delta so Debit/sign logic can be exercised',
    ).toBeDefined();
    if (debit) {
      // Non-trivial: balanceAfter is a running fold, not just the delta itself.
      expect(BigInt(debit.balanceAfter)).not.toBe(BigInt(debit.delta));
      expect(BigInt(debit.balanceAfter)).not.toBe(0n);
    }
    // And a credit (delta > 0) is present too, so both directions render.
    expect(body.entries.some((e) => BigInt(e.delta) > 0n)).toBe(true);
  });

  it('orders entries newest-first with a running-fold-consistent balanceAfter', async () => {
    const { body } = await getStatement(OWNED_ID);
    const entries = body.entries;

    // Newest-first: createdAt strictly non-increasing.
    for (let i = 0; i + 1 < entries.length; i += 1) {
      const older = new Date(entries[i + 1].createdAt).getTime();
      const newer = new Date(entries[i].createdAt).getTime();
      expect(newer).toBeGreaterThanOrEqual(older);
    }

    // Running fold consistency (money-safety): balance_before of entry i equals the
    // balanceAfter of the chronologically preceding entry i+1. Exact BigInt math.
    for (let i = 0; i + 1 < entries.length; i += 1) {
      const balanceBefore = BigInt(entries[i].balanceAfter) - BigInt(entries[i].delta);
      expect(balanceBefore).toBe(BigInt(entries[i + 1].balanceAfter));
    }
  });
});

describe('GET /balance/api/accounts/:id/transactions stub — identity/error contract', () => {
  it('rejects a request with no bearer as 401 in the error envelope', async () => {
    const res = await fetch(url(OWNED_ID)); // no Authorization header
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorResponse & { entries?: unknown };
    expect(body.error?.code?.length ?? 0).toBeGreaterThan(0);
    expect(body.error?.message?.length ?? 0).toBeGreaterThan(0);
    expect(body.error?.requestId?.length ?? 0).toBeGreaterThan(0);
    // An auth failure must not leak statement data.
    expect(body.entries).toBeUndefined();
  });

  it('rejects a malformed account id as 400 (ParseUUIDPipe)', async () => {
    const res = await fetch(url('not-a-uuid'), { headers: { Authorization: 'Bearer test' } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error?.code?.length ?? 0).toBeGreaterThan(0);
  });

  it('returns 404 (NOT 403) for an unknown / non-owned account id (anti-IDOR, ADR-3)', async () => {
    // A well-formed but non-existent/non-owned uuid must be indistinguishable from a real
    // one the caller does not own: 404, never 403 (which would confirm existence).
    const unknown = '99999999-9999-4999-8999-999999999999';
    const res = await fetch(url(unknown), { headers: { Authorization: 'Bearer test' } });
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error?.code?.length ?? 0).toBeGreaterThan(0);
  });
});
