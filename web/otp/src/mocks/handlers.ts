import { http, HttpResponse } from 'msw';
import type { ErrorResponse } from '../services/api/contracts/error';
import type { PendingAuthorizationResponse } from '../services/api/contracts/pending-authorization';
import { fixturePendingAuthorization } from './fixtures/pending-authorization';

/**
 * MSW request handlers mirroring the REAL `/api` wire contract (specs/07-frontends.md;
 * balance-service transfers serializer `serializePendingAuthorization`). Only `/api` is
 * stubbed — OIDC traffic to Keycloak is left to hit the real authority.
 *
 * The stub also mirrors the gateway identity contract: like `GatewayIdentityGuard`
 * (which rejects a request that carries no gateway identity with 401), a request
 * without a bearer token is rejected 401 with the service-wide `ErrorResponse`.
 *
 * O1 seeds a single pending (internal) authorization. The `{ authorization: null }`
 * no-pending case is exercised by swapping the response (see the fixtures file); the
 * real feed + code reveal arrive in O2.
 */

function isBearerAuthenticated(request: Request): boolean {
  const authorization = request.headers.get('authorization');
  return authorization !== null && authorization.toLowerCase().startsWith('bearer ');
}

function unauthorized() {
  const body: ErrorResponse = {
    error: {
      code: 'UNAUTHORIZED',
      message: 'Missing gateway identity',
      requestId: crypto.randomUUID(),
    },
  };
  return HttpResponse.json(body, { status: 401 });
}

export const handlers = [
  http.get('/api/pending-authorization', ({ request }) => {
    if (!isBearerAuthenticated(request)) {
      return unauthorized();
    }
    const body: PendingAuthorizationResponse = { authorization: fixturePendingAuthorization };
    return HttpResponse.json(body);
  }),
];
