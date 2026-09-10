import { http, HttpResponse } from 'msw';
import type { AccountsResponse, StatementResponse } from '../services/api/contracts/accounts';
import type { ErrorResponse } from '../services/api/contracts/error';
import { fixtureAccounts } from './fixtures/accounts';
import { fixtureStatements } from './fixtures/statements';

/**
 * MSW request handlers mirroring the REAL `/api` wire contract (specs/07 +
 * specs/balance-schema.yaml; balance-service accounts serializer + controller). Only `/api`
 * is stubbed — OIDC traffic to Keycloak is left to hit the real authority.
 *
 * The stub mirrors the gateway/controller error contract: like `GatewayIdentityGuard` a
 * request without a bearer is rejected 401; like the controller's `ParseUUIDPipe` a
 * malformed account id is rejected 400; and like the service (a missing / non-owned /
 * system account is indistinguishable — anti-IDOR, ADR-3) an unknown account id is 404.
 * Every error uses the service-wide `ErrorResponse` envelope.
 */

// Matches the controller's ParseUUIDPipe (any RFC-4122 version); malformed -> 400.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isBearerAuthenticated(request: Request): boolean {
  const authorization = request.headers.get('authorization');
  return authorization !== null && authorization.toLowerCase().startsWith('bearer ');
}

function errorResponse(status: number, code: string, message: string) {
  const body: ErrorResponse = {
    error: { code, message, requestId: crypto.randomUUID() },
  };
  return HttpResponse.json(body, { status });
}

function unauthorized() {
  return errorResponse(401, 'UNAUTHORIZED', 'Missing gateway identity');
}

export const handlers = [
  http.get('/api/accounts', ({ request }) => {
    if (!isBearerAuthenticated(request)) {
      return unauthorized();
    }
    const body: AccountsResponse = { accounts: fixtureAccounts };
    return HttpResponse.json(body);
  }),

  http.get('/api/accounts/:id/transactions', ({ request, params }) => {
    if (!isBearerAuthenticated(request)) {
      return unauthorized();
    }
    const id = String(params.id);
    if (!UUID_PATTERN.test(id)) {
      return errorResponse(400, 'BAD_REQUEST', 'Malformed account id');
    }
    const entries = fixtureStatements[id];
    if (!entries) {
      // Missing / non-owned / system are indistinguishable to the caller (never 403).
      return errorResponse(404, 'NOT_FOUND', 'Account not found');
    }
    const body: StatementResponse = { accountId: id, entries };
    return HttpResponse.json(body);
  }),
];
