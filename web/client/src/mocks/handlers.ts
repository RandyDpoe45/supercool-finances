import { http, HttpResponse } from 'msw';
import type { AccountsResponse, StatementResponse } from '../services/api/contracts/accounts';
import type { ErrorResponse } from '../services/api/contracts/error';
import type {
  PendingAuthorizationResponse,
  TransferDto,
} from '../services/api/contracts/transfers';
import { fixtureAccounts } from './fixtures/accounts';
import { fixtureStatements } from './fixtures/statements';
import {
  cancelTransfer,
  confirmTransfer,
  getPendingAuthorization,
  initiateTransfer,
  resolveDestination,
} from './state/transferStore';

/**
 * MSW request handlers mirroring the REAL `/api` wire contract (specs/07 + specs/04 +
 * specs/balance-schema.yaml; balance-service serializers + controllers). Only `/api` is stubbed —
 * OIDC traffic to Keycloak is left to hit the real authority.
 *
 * The stub mirrors the gateway/controller error contract: like `GatewayIdentityGuard` a request
 * without a bearer is rejected 401; like the `ZodValidationPipe` a malformed body/param is 400; and
 * every error uses the service-wide `ErrorResponse` envelope `{ error: { code, message, requestId } }`.
 * For the transfer surface the DOMAIN code (e.g. `SUSPECTED_DUPLICATE`, `TRANSFER_EXPIRED`,
 * `INVALID_OTP`) is returned with its HTTP status, exactly as the service maps it, so the client's
 * code-keyed error handling exercises the real branches.
 *
 * The transfer lifecycle state (tokens, idempotency, pending, expiry) lives in `state/transferStore`.
 * The one-time code is a DETERMINISTIC dev code (`VITE_DEV_OTP_CODE`, default `123456`) — a mock,
 * not a secret; the real code comes from the otp-app against the real backend.
 */

// Matches the controller's ParseUUIDPipe (any RFC-4122 version); malformed -> 400.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_NUMBER_PATTERN = /^\d{10}$/;
const UNSIGNED_MINOR_UNITS = /^\d+$/;
const NUMERIC_CODE = /^\d+$/;

/** The dev one-time code the confirm stub accepts (documented in docs/README.md + .env.example). */
const DEV_OTP_CODE = import.meta.env.VITE_DEV_OTP_CODE ?? '123456';

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

function badRequest(message: string) {
  return errorResponse(400, 'BAD_REQUEST', message);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
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

  // Confirmation of payee (query only): resolve a 10-digit account number to a masked name +
  // currency + single-use token. Unknown number -> 404 (indistinguishable, anti-IDOR).
  http.post('/api/transfers/resolve-destination', async ({ request }) => {
    if (!isBearerAuthenticated(request)) {
      return unauthorized();
    }
    const body = await request.json().catch(() => null);
    const accountNumber = (body as { accountNumber?: unknown } | null)?.accountNumber;
    if (typeof accountNumber !== 'string' || !ACCOUNT_NUMBER_PATTERN.test(accountNumber)) {
      return badRequest('accountNumber must be a 10-digit numeric string');
    }
    const resolution = resolveDestination(accountNumber);
    if (!resolution) {
      return errorResponse(404, 'TRANSFER_NOT_FOUND', 'Transfer not found');
    }
    return HttpResponse.json(resolution);
  }),

  // Initiate an internal transfer (creates PENDING, no money moves). Requires the Idempotency-Key
  // header + a confirmation token bound to the destination.
  http.post('/api/transfers', async ({ request }) => {
    if (!isBearerAuthenticated(request)) {
      return unauthorized();
    }
    const idempotencyKey = request.headers.get('idempotency-key');
    if (!isNonEmptyString(idempotencyKey)) {
      return badRequest('Idempotency-Key header is required');
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return badRequest('Malformed request body');
    }
    const { sourceAccountId, destinationAccountNumber, amount, currency, confirmationToken } = body;
    if (typeof sourceAccountId !== 'string' || !UUID_PATTERN.test(sourceAccountId)) {
      return badRequest('sourceAccountId must be a uuid');
    }
    if (
      typeof destinationAccountNumber !== 'string' ||
      !ACCOUNT_NUMBER_PATTERN.test(destinationAccountNumber)
    ) {
      return badRequest('destinationAccountNumber must be a 10-digit numeric string');
    }
    if (typeof amount !== 'string' || !UNSIGNED_MINOR_UNITS.test(amount) || BigInt(amount) <= 0n) {
      return badRequest('amount must be an unsigned minor-unit integer greater than zero');
    }
    if (typeof currency !== 'string' || currency.length !== 3) {
      return badRequest('currency must be a 3-letter code');
    }
    if (!isNonEmptyString(confirmationToken)) {
      return badRequest('confirmationToken is required');
    }
    const confirmDuplicate = body.confirmDuplicate;
    if (confirmDuplicate !== undefined && typeof confirmDuplicate !== 'boolean') {
      return badRequest('confirmDuplicate must be a boolean');
    }

    const result = initiateTransfer({
      idempotencyKey,
      sourceAccountId,
      destinationAccountNumber,
      amount,
      currency,
      confirmationToken,
      confirmDuplicate: confirmDuplicate === true,
    });
    if (result.outcome === 'duplicate') {
      return errorResponse(
        409,
        'SUSPECTED_DUPLICATE',
        'A semantically identical transfer was seen within the last 60 seconds; confirm the duplicate to proceed',
      );
    }
    if (result.outcome === 'key-reused') {
      return errorResponse(
        409,
        'IDEMPOTENCY_KEY_REUSED',
        'The Idempotency-Key was already used for a request with different details',
      );
    }
    if (result.outcome === 'destination-not-confirmed') {
      return errorResponse(
        409,
        'DESTINATION_NOT_CONFIRMED',
        'The destination has not been confirmed; resolve it before initiating a transfer',
      );
    }
    return HttpResponse.json(result.transfer, { status: 201 });
  }),

  // Confirm a PENDING transfer with the one-time code -> POSTED (money moves).
  http.post('/api/transfers/:id/confirm', async ({ request, params }) => {
    if (!isBearerAuthenticated(request)) {
      return unauthorized();
    }
    const id = String(params.id);
    if (!UUID_PATTERN.test(id)) {
      return badRequest('Malformed transfer id');
    }
    const body = await request.json().catch(() => null);
    const code = (body as { code?: unknown } | null)?.code;
    if (typeof code !== 'string' || !NUMERIC_CODE.test(code)) {
      return badRequest('code must be a numeric string');
    }
    const result = confirmTransfer(id, code, DEV_OTP_CODE);
    switch (result.outcome) {
      case 'posted':
      case 'already-posted':
        return HttpResponse.json(result.transfer satisfies TransferDto);
      case 'not-found':
        return errorResponse(404, 'TRANSFER_NOT_FOUND', 'Transfer not found');
      case 'expired':
        return errorResponse(410, 'TRANSFER_EXPIRED', 'The transfer has expired');
      case 'not-pending':
        return errorResponse(409, 'TRANSFER_NOT_PENDING', 'Transfer is not pending');
      case 'invalid-otp':
        return errorResponse(401, 'INVALID_OTP', 'The one-time code is invalid');
    }
  }),

  // Cancel a PENDING transfer (guarded PENDING->CANCELLED; idempotent on already terminal).
  http.post('/api/transfers/:id/cancel', async ({ request, params }) => {
    if (!isBearerAuthenticated(request)) {
      return unauthorized();
    }
    const id = String(params.id);
    if (!UUID_PATTERN.test(id)) {
      return badRequest('Malformed transfer id');
    }
    const result = cancelTransfer(id);
    switch (result.outcome) {
      case 'cancelled':
      case 'already-terminal':
        return HttpResponse.json(result.transfer satisfies TransferDto);
      case 'not-found':
        return errorResponse(404, 'TRANSFER_NOT_FOUND', 'Transfer not found');
      case 'not-pending':
        return errorResponse(409, 'TRANSFER_NOT_PENDING', 'Transfer is not pending');
    }
  }),

  // The caller's single active pending transfer (or null) — the resume / OTP feed.
  http.get('/api/pending-authorization', ({ request }) => {
    if (!isBearerAuthenticated(request)) {
      return unauthorized();
    }
    const body: PendingAuthorizationResponse = { authorization: getPendingAuthorization() };
    return HttpResponse.json(body);
  }),
];
