import { http, HttpResponse } from 'msw';
import type { ErrorResponse } from '../services/api/contracts/error';
import type { OtpDto } from '../services/api/contracts/otp';
import type { PendingAuthorizationResponse } from '../services/api/contracts/pending-authorization';
import { DEV_OTP_CODE, OTP_MOCK_TTL_SECONDS } from './fixtures/otp';
import { getMockPending, isOtpActive, markOtpActive } from './state';

/**
 * MSW request handlers mirroring the REAL balance-service wire contract (specs/07-frontends.md;
 * balance-service `serializePendingAuthorization`, `serializeOtp`, and the OTP service's
 * singleton/ttl semantics). Only `/balance/api` is stubbed — the SPA's service-namespaced outbound
 * path per ADR-17 (the transport strips `/balance` so the service still serves its own `/api`
 * surface). OIDC traffic to Keycloak hits the real authority.
 *
 * The stub mirrors the gateway identity contract: like `GatewayIdentityGuard`, a request
 * without a bearer token is rejected 401 with the service-wide `ErrorResponse` envelope.
 *
 * `POST /balance/api/otp` models the SINGLETON: while a minted code is within its ttl a second mint
 * is rejected `409 OTP_ALREADY_ACTIVE`; once the ttl elapses the slot frees and minting is
 * allowed again (see `./state`). The mocked code is the deterministic `DEV_OTP_CODE`.
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
  http.get('/balance/api/pending-authorization', ({ request }) => {
    if (!isBearerAuthenticated(request)) {
      return unauthorized();
    }
    const body: PendingAuthorizationResponse = { authorization: getMockPending() };
    return HttpResponse.json(body);
  }),

  http.post('/balance/api/otp', ({ request }) => {
    if (!isBearerAuthenticated(request)) {
      return unauthorized();
    }
    const now = Date.now();
    if (isOtpActive(now)) {
      return errorResponse(
        409,
        'OTP_ALREADY_ACTIVE',
        'An active one-time code already exists for this user',
      );
    }
    markOtpActive(now + OTP_MOCK_TTL_SECONDS * 1000);
    const body: OtpDto = { code: DEV_OTP_CODE, ttlSeconds: OTP_MOCK_TTL_SECONDS };
    return HttpResponse.json(body);
  }),
];
