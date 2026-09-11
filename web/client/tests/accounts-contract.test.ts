import { describe, expect, it } from 'vitest';
import type { AccountsResponse } from '../src/services/api/contracts/accounts';
import type { ErrorResponse } from '../src/services/api/contracts/error';

/**
 * The `/balance/api/accounts` MSW stub must honor the REAL balance-service wire contract, so
 * the SPA is developed against the shape the backend actually emits. Expectations are
 * derived from the contract of record — the accounts serializer
 * (`AccountDto`: id, currency, status, kind, balance, held, available, accountNumber)
 * and `specs/balance-schema.yaml` — NOT from the app's own fixture values. This is the
 * guard against stub drift: a leaked internal column, a money field emitted as a
 * float/number, or an `available` that ignores `held` would fail here.
 */

// The EXACT whitelist the serializer emits (services/.../accounts.serializer.ts).
// Internal columns (ownerId, systemKey, spentToday/spentMonth + dates, createdAt,
// updatedAt) must never reach the wire.
const CONTRACT_FIELDS = [
  'id',
  'currency',
  'status',
  'kind',
  'balance',
  'held',
  'available',
  'accountNumber',
].sort();

const ACCOUNTS_URL = new URL('/balance/api/accounts', window.location.origin).toString();
const INTEGER_STRING = /^-?\d+$/;

describe('GET /balance/api/accounts stub — contract of record', () => {
  it('returns the { accounts } envelope with only the whitelisted DTO fields', async () => {
    const res = await fetch(ACCOUNTS_URL, { headers: { Authorization: 'Bearer test' } });
    expect(res.status).toBe(200);

    const body = (await res.json()) as AccountsResponse;
    expect(Array.isArray(body.accounts)).toBe(true);
    expect(body.accounts.length).toBeGreaterThan(0);

    for (const account of body.accounts) {
      // No extra keys (leak) and none missing.
      expect(Object.keys(account).sort()).toEqual(CONTRACT_FIELDS);
      // Enum domains per specs/balance-schema.yaml.
      expect(['active', 'frozen']).toContain(account.status);
      expect(['customer', 'system']).toContain(account.kind);
      expect(account.currency).toBe('MXN');
    }
  });

  it('emits money as canonical minor-unit integer strings with available = balance − held', async () => {
    const res = await fetch(ACCOUNTS_URL, { headers: { Authorization: 'Bearer test' } });
    const body = (await res.json()) as AccountsResponse;

    for (const account of body.accounts) {
      for (const field of ['balance', 'held', 'available'] as const) {
        expect(typeof account[field]).toBe('string');
        expect(account[field]).toMatch(INTEGER_STRING);
      }
      // Exact bigint arithmetic: available is derived, never independent.
      expect(account.available).toBe((BigInt(account.balance) - BigInt(account.held)).toString());
    }

    // The subtraction must actually be exercised: require a fixture with held > 0 so
    // a stub that returned available === balance (ignoring holds) cannot pass.
    const withHold = body.accounts.find((account) => BigInt(account.held) > 0n);
    expect(
      withHold,
      'contract check needs an account with held > 0 so available = balance − held can fail',
    ).toBeDefined();
    if (withHold) {
      expect(withHold.available).not.toBe(withHold.balance);
      expect(BigInt(withHold.available)).toBe(BigInt(withHold.balance) - BigInt(withHold.held));
    }
  });

  it('rejects a request with no gateway identity as 401 in the service-wide error envelope', async () => {
    // Mirrors GatewayIdentityGuard: no bearer (no gateway-injected identity) → 401.
    const res = await fetch(ACCOUNTS_URL);
    expect(res.status).toBe(401);

    const body = (await res.json()) as ErrorResponse & { accounts?: unknown };
    expect(body.error).toBeDefined();
    expect(typeof body.error.code).toBe('string');
    expect(body.error.code.length).toBeGreaterThan(0);
    expect(typeof body.error.message).toBe('string');
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(typeof body.error.requestId).toBe('string');
    expect(body.error.requestId.length).toBeGreaterThan(0);
    // An auth failure must not leak account data.
    expect(body.accounts).toBeUndefined();
  });
});
