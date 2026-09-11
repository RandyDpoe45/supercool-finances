import { afterEach, describe, expect, it } from 'vitest';
import { resetMockState } from '../src/mocks/state';

/**
 * Anti-drift for `POST /balance/api/otp`: the stub MUST honour the balance-service contract of record
 * (OtpDto { code, ttlSeconds } + serializeOtp; the OTP service's SINGLETON gate ->
 * OtpAlreadyActiveError => 409; GatewayIdentityGuard => 401 on a missing identity). If the
 * stub drifts (leaks a field, drops the 409 singleton, or accepts an unauthenticated mint) the
 * whole reveal flow is validated against a fiction — these tests fail on exactly that.
 *
 * The stub's active-code slot is module-level state (not reset by server.resetHandlers), so we
 * reset it after every case.
 */

const ENDPOINT = `${window.location.origin}/balance/api/otp`;

function mintWithBearer() {
  return fetch(ENDPOINT, { method: 'POST', headers: { Authorization: 'Bearer test-token' } });
}

afterEach(() => {
  resetMockState();
});

describe('POST /balance/api/otp stub — contract of record', () => {
  it('returns EXACTLY the { code, ttlSeconds } DTO — no extra field leaks onto the wire', async () => {
    const res = await mintWithBearer();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['code', 'ttlSeconds']);
    // code is the plaintext one-time code (the real service mints a 6-digit CSPRNG code);
    // ttlSeconds is a positive validity window.
    expect(typeof body.code).toBe('string');
    expect(body.code).toMatch(/^\d{6}$/);
    expect(typeof body.ttlSeconds).toBe('number');
    expect(body.ttlSeconds).toBeGreaterThan(0);
  });

  it('rejects a SECOND mint while a code is active with 409 OTP_ALREADY_ACTIVE in the error envelope', async () => {
    const first = await mintWithBearer();
    expect(first.status).toBe(200);

    const second = await mintWithBearer();
    expect(second.status).toBe(409);

    const body = await second.json();
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error.code).toBe('OTP_ALREADY_ACTIVE');
    expect(typeof body.error.message).toBe('string');
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(typeof body.error.requestId).toBe('string');
    expect(body.error.requestId.length).toBeGreaterThan(0);
    // The singleton message must stay PII-light: no code, no user id.
    expect(body.error.message).not.toContain('424242');
  });

  it('rejects a mint with no gateway identity as 401 in the { error } envelope (no code minted)', async () => {
    const res = await fetch(ENDPOINT, { method: 'POST' });
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(Object.keys(body)).toEqual(['error']);
    expect(typeof body.error.code).toBe('string');
    expect(body.error.code.length).toBeGreaterThan(0);
    expect(body.error).not.toHaveProperty('code', 'OTP_ALREADY_ACTIVE');
    expect(typeof body.error.requestId).toBe('string');
    // No plaintext code is ever present on the failure envelope.
    expect(body).not.toHaveProperty('code');
  });
});
