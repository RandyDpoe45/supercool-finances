import { describe, expect, it } from 'vitest';
import type { WhoamiDto } from '../src/services/api/contracts/identity';
import type { ErrorResponse } from '../src/services/api/contracts/error';

/**
 * The `/balance/admin/whoami` MSW stub must honor the REAL admin wire contract, so the SPA is
 * developed against the shape the gateway actually echoes. Expectations are derived from the
 * contract of record — `WhoamiDto` ({ userId, roles }) and the service-wide `{ error }` envelope
 * (specs/07-frontends.md) — NOT from the app's own view code. This is the guard against stub
 * drift: a leaked internal field, `roles` emitted as a non-array, or an auth failure that
 * dropped the fail-closed 401 / leaked the identity would fail here.
 */

const WHOAMI_URL = new URL('/balance/admin/whoami', window.location.origin).toString();

// The EXACT whitelist the admin whoami contract emits — nothing more (no leaked internal fields).
const CONTRACT_FIELDS = ['roles', 'userId'];

describe('GET /balance/admin/whoami stub — contract of record', () => {
  it('returns exactly { userId, roles } with correct types for an authenticated caller', async () => {
    const res = await fetch(WHOAMI_URL, { headers: { Authorization: 'Bearer test' } });
    expect(res.status).toBe(200);

    const body = (await res.json()) as WhoamiDto;

    // No extra keys (leak) and none missing.
    expect(Object.keys(body).sort()).toEqual(CONTRACT_FIELDS);
    expect(typeof body.userId).toBe('string');
    expect(body.userId.length).toBeGreaterThan(0);
    expect(Array.isArray(body.roles)).toBe(true);
    for (const role of body.roles) {
      expect(typeof role).toBe('string');
    }
  });

  it('rejects a request with no gateway identity as 401 in the service-wide error envelope', async () => {
    // Mirrors the admin gateway guard: no bearer (no gateway-injected identity) -> 401.
    const res = await fetch(WHOAMI_URL);
    expect(res.status).toBe(401);

    const body = (await res.json()) as ErrorResponse & { userId?: unknown; roles?: unknown };
    expect(body.error).toBeDefined();
    expect(typeof body.error.code).toBe('string');
    expect(body.error.code.length).toBeGreaterThan(0);
    expect(typeof body.error.message).toBe('string');
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(typeof body.error.requestId).toBe('string');
    expect(body.error.requestId.length).toBeGreaterThan(0);
    // An auth failure must not leak any identity.
    expect(body.userId).toBeUndefined();
    expect(body.roles).toBeUndefined();
  });
});
