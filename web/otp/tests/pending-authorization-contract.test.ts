import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { fixtureNoPendingAuthorization } from '../src/mocks/fixtures/pending-authorization';
import { server } from '../src/mocks/node';

/**
 * Anti-drift: the MSW stub MUST honor the balance-service contract of record
 * (specs/07-frontends.md; `PendingAuthorizationDto` + `serializePendingAuthorization`;
 * `GatewayIdentityGuard`). If the stub drifts (leaks an internal field, mis-types the
 * amount, breaks the type-dependent nullability, or drops the error envelope) the whole
 * app is validated against a fiction — these tests fail on exactly that.
 */

const ENDPOINT = `${window.location.origin}/balance/api/pending-authorization`;

// The EXACT whitelist from serializePendingAuthorization — no more, no less.
const WHITELISTED_KEYS = [
  'transferId',
  'type',
  'amount',
  'currency',
  'sourceAccountId',
  'destinationAccountNumber',
  'destinationMaskedName',
  'payeeDisplayName',
  'createdAt',
  'expiresAt',
].sort();

function getWithBearer() {
  return fetch(ENDPOINT, { headers: { Authorization: 'Bearer test-token' } });
}

describe('GET /balance/api/pending-authorization stub — contract of record', () => {
  it('returns the { authorization } envelope with EXACTLY the whitelisted DTO keys (no internal field leaks)', async () => {
    const res = await getWithBearer();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Object.keys(body)).toEqual(['authorization']);

    const dto = body.authorization;
    expect(dto).not.toBeNull();
    expect(Object.keys(dto).sort()).toEqual(WHITELISTED_KEYS);
  });

  it('serializes amount as a canonical minor-unit integer string (not a number or decimal)', async () => {
    const { authorization } = await (await getWithBearer()).json();
    expect(typeof authorization.amount).toBe('string');
    expect(authorization.amount).toMatch(/^\d+$/);
  });

  it('applies internal-transfer nullability: destination account number + masked name set, payeeDisplayName null', async () => {
    const { authorization } = await (await getWithBearer()).json();
    expect(authorization.type).toBe('internal');
    expect(authorization.destinationAccountNumber).not.toBeNull();
    expect(authorization.destinationMaskedName).not.toBeNull();
    // The holder name is masked PII, never the full name.
    expect(authorization.destinationMaskedName).toContain('*');
    expect(authorization.payeeDisplayName).toBeNull();
  });

  it('rejects a request with no gateway identity as 401 in the { error: { code, message, requestId } } envelope', async () => {
    const res = await fetch(ENDPOINT);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(Object.keys(body)).toEqual(['error']);
    expect(typeof body.error.code).toBe('string');
    expect(body.error.code.length).toBeGreaterThan(0);
    expect(typeof body.error.message).toBe('string');
    expect(typeof body.error.requestId).toBe('string');
    expect(body.error.requestId.length).toBeGreaterThan(0);
  });

  it('wraps the no-pending case as { authorization: null }', async () => {
    server.use(
      http.get('/balance/api/pending-authorization', () =>
        HttpResponse.json({ authorization: fixtureNoPendingAuthorization }),
      ),
    );
    const res = await getWithBearer();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authorization: null });
  });
});
