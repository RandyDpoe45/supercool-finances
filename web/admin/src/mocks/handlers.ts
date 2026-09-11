import { http, HttpResponse } from 'msw';
import type { ErrorResponse } from '../services/api/contracts/error';
import type { WhoamiDto } from '../services/api/contracts/identity';
import { fixtureWhoami } from './fixtures/identity';

/**
 * MSW request handlers mirroring the REAL balance-service admin wire contract
 * (specs/07-frontends.md). Only `/balance/admin` is stubbed — the SPA's service-namespaced
 * outbound path per ADR-17 (the transport strips `/balance` so the service still serves its
 * own `/admin` surface). OIDC traffic to Keycloak hits the real authority.
 *
 * The stub mirrors the gateway identity contract: like the admin gateway guard, a request
 * without a bearer token is rejected 401 with the service-wide `ErrorResponse` envelope.
 *
 * Note: MSW intercepts the ORIGIN-ROOT path `/balance/admin/whoami` — that is the
 * service-namespaced API path (ADR-17), NOT a SPA URL prefix. The admin SPA is root-served on
 * its dedicated `:8081` origin (no Vite `base` / router `basename`).
 */

function isBearerAuthenticated(request: Request): boolean {
  const authorization = request.headers.get('authorization');
  return authorization !== null && authorization.toLowerCase().startsWith('bearer ');
}

function errorResponse(status: number, code: string, message: string) {
  const body: ErrorResponse = { error: { code, message, requestId: crypto.randomUUID() } };
  return HttpResponse.json(body, { status });
}

const unauthorized = () => errorResponse(401, 'UNAUTHORIZED', 'Missing gateway identity');

export const handlers = [
  http.get('/balance/admin/whoami', ({ request }) => {
    if (!isBearerAuthenticated(request)) {
      return unauthorized();
    }
    const body: WhoamiDto = fixtureWhoami;
    return HttpResponse.json(body);
  }),
];
