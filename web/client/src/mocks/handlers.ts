import { http, HttpResponse } from 'msw';
import type { AccountsResponse } from '../services/api/contracts/accounts';
import type { ErrorResponse } from '../services/api/contracts/error';
import { fixtureAccounts } from './fixtures/accounts';

/**
 * MSW request handlers mirroring the REAL `/api` wire contract (specs/07 +
 * specs/balance-schema.yaml; balance-service accounts serializer). Only `/api` is
 * stubbed — OIDC traffic to Keycloak is left to hit the real authority.
 *
 * The stub also mirrors the gateway identity contract: like `GatewayIdentityGuard`
 * (which rejects a request that carries no gateway identity with 401), a request
 * without a bearer token is rejected 401 with the service-wide `ErrorResponse`.
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
  http.get('/api/accounts', ({ request }) => {
    if (!isBearerAuthenticated(request)) {
      return unauthorized();
    }
    const body: AccountsResponse = { accounts: fixtureAccounts };
    return HttpResponse.json(body);
  }),
];
