import { http, HttpResponse } from 'msw';
import type { AdminAccountsResponse } from '../services/api/contracts/account';
import type { ErrorResponse } from '../services/api/contracts/error';
import type { WhoamiDto } from '../services/api/contracts/identity';
import type { LimitsResponse, LimitsScope } from '../services/api/contracts/limits';
import { fixtureWhoami } from './fixtures/identity';
import {
  freezeAccount,
  listAccounts,
  listLimits,
  unfreezeAccount,
  upsertLimits,
} from './state/adminState';

/**
 * MSW request handlers mirroring the REAL balance-service admin wire contract
 * (specs/07-frontends.md). Only `/balance/admin` is stubbed — the SPA's service-namespaced
 * outbound path per ADR-17 (the transport strips `/balance` so the service still serves its own
 * `/admin` surface). OIDC traffic to Keycloak hits the real authority.
 *
 * The stub mirrors the gateway/controller error contract: like the admin gateway guard, a request
 * without a bearer is rejected 401; like the `ZodValidationPipe` a malformed body/param is 400; the
 * limits scope⇒ownerId violation is 400 `INVALID_LIMITS`; and every error uses the service-wide
 * `{ error: { code, message, requestId } }` envelope.
 *
 * The mutable account/limits state lives in `state/adminState` (which survives
 * `server.resetHandlers()` — tests reset it via `resetAdminState`).
 *
 * Note: MSW intercepts the ORIGIN-ROOT path `/balance/admin/...` — the service-namespaced API path
 * (ADR-17), NOT a SPA URL prefix. The admin SPA is root-served on its dedicated `:8081` origin.
 */

// Matches the controller's ParseUUIDPipe (any RFC-4122 version); malformed -> 400.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_PATTERN = /^[A-Za-z]{3}$/;
const UNSIGNED_MINOR_UNITS = /^\d+$/;

const LIMITS_BODY_KEYS = [
  'scope',
  'ownerId',
  'currency',
  'perTransactionMax',
  'dailyMax',
  'monthlyMax',
] as const;
const CAP_KEYS = ['perTransactionMax', 'dailyMax', 'monthlyMax'] as const;

function isBearerAuthenticated(request: Request): boolean {
  const authorization = request.headers.get('authorization');
  return authorization !== null && authorization.toLowerCase().startsWith('bearer ');
}

function errorResponse(status: number, code: string, message: string) {
  const body: ErrorResponse = { error: { code, message, requestId: crypto.randomUUID() } };
  return HttpResponse.json(body, { status });
}

const unauthorized = () => errorResponse(401, 'UNAUTHORIZED', 'Missing gateway identity');
const badRequest = (message: string) => errorResponse(400, 'BAD_REQUEST', message);
const notFound = (message: string) => errorResponse(404, 'NOT_FOUND', message);
const invalidLimits = (message: string) => errorResponse(400, 'INVALID_LIMITS', message);

/** Mirror a Zod `.strict()` body: reject any key outside the allowlist (defense against param
 * smuggling — a client must not send `id` / `status` / `createdAt`, etc.). */
function hasOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(body).every((key) => allowed.includes(key));
}

/** A cap is optional: absent (`undefined`), explicitly `null` (uncapped), or an unsigned minor-unit
 * integer string. Anything else (a number, a signed/decimal string) is malformed. */
function isCapValue(value: unknown): value is string | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && UNSIGNED_MINOR_UNITS.test(value))
  );
}

/** Parse an optional non-negative integer query param; returns undefined when absent, NaN when
 * present-but-nonnumeric (the caller's clamp treats NaN as the default). */
function numericParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) {
    return undefined;
  }
  return Number(raw);
}

export const handlers = [
  http.get('/balance/admin/whoami', ({ request }) => {
    if (!isBearerAuthenticated(request)) {
      return unauthorized();
    }
    const body: WhoamiDto = fixtureWhoami;
    return HttpResponse.json(body);
  }),

  // The admin-visible accounts, optionally filtered to one owner + paged (limit clamped ≤200).
  http.get('/balance/admin/accounts', ({ request }) => {
    if (!isBearerAuthenticated(request)) {
      return unauthorized();
    }
    const url = new URL(request.url);
    const ownerId = url.searchParams.get('ownerId') ?? undefined;
    const accounts = listAccounts({
      ownerId,
      limit: numericParam(url, 'limit'),
      offset: numericParam(url, 'offset'),
    });
    const body: AdminAccountsResponse = { accounts };
    return HttpResponse.json(body);
  }),

  // Freeze an account (idempotent). No body; returns the updated account.
  http.post('/balance/admin/accounts/:id/freeze', ({ request, params }) => {
    if (!isBearerAuthenticated(request)) {
      return unauthorized();
    }
    const id = String(params.id);
    if (!UUID_PATTERN.test(id)) {
      return badRequest('Malformed account id');
    }
    const account = freezeAccount(id);
    if (!account) {
      return notFound('Account not found');
    }
    return HttpResponse.json(account);
  }),

  // Unfreeze an account (idempotent). No body; returns the updated account.
  http.post('/balance/admin/accounts/:id/unfreeze', ({ request, params }) => {
    if (!isBearerAuthenticated(request)) {
      return unauthorized();
    }
    const id = String(params.id);
    if (!UUID_PATTERN.test(id)) {
      return badRequest('Malformed account id');
    }
    const account = unfreezeAccount(id);
    if (!account) {
      return notFound('Account not found');
    }
    return HttpResponse.json(account);
  }),

  // Current limits (global baseline + customer overrides), optionally filtered by scope/ownerId.
  http.get('/balance/admin/limits', ({ request }) => {
    if (!isBearerAuthenticated(request)) {
      return unauthorized();
    }
    const url = new URL(request.url);
    const scope = url.searchParams.get('scope') ?? undefined;
    const ownerId = url.searchParams.get('ownerId') ?? undefined;
    const body: LimitsResponse = { limits: listLimits({ scope, ownerId }) };
    return HttpResponse.json(body);
  }),

  // Upsert a limits row. `.strict()` body; enforces the scope⇒ownerId rule (400 INVALID_LIMITS).
  http.put('/balance/admin/limits', async ({ request }) => {
    if (!isBearerAuthenticated(request)) {
      return unauthorized();
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      return badRequest('Malformed request body');
    }
    if (!hasOnlyKeys(body, LIMITS_BODY_KEYS)) {
      return badRequest('Unexpected field in limits body');
    }
    const { scope, ownerId, currency } = body;
    if (scope !== 'global' && scope !== 'customer') {
      return badRequest("scope must be 'global' or 'customer'");
    }
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      return badRequest('currency must be a 3-letter code');
    }
    if (ownerId !== undefined && ownerId !== null && typeof ownerId !== 'string') {
      return badRequest('ownerId must be a string or null');
    }
    for (const key of CAP_KEYS) {
      if (!isCapValue(body[key])) {
        return badRequest(`${key} must be an unsigned minor-unit integer string or null`);
      }
    }

    // The scope⇒ownerId rule — a money-adjacent invariant, mirrored from the real controller.
    const hasOwner = typeof ownerId === 'string' && ownerId.length > 0;
    if (scope === 'global' && hasOwner) {
      return invalidLimits('A global limit must not carry an ownerId');
    }
    if (scope === 'customer' && !hasOwner) {
      return invalidLimits('A customer limit requires an ownerId');
    }

    const row = upsertLimits({
      scope: scope as LimitsScope,
      ownerId: scope === 'customer' ? (ownerId as string) : null,
      currency: currency.toUpperCase(),
      perTransactionMax: body.perTransactionMax as string | null | undefined,
      dailyMax: body.dailyMax as string | null | undefined,
      monthlyMax: body.monthlyMax as string | null | undefined,
    });
    return HttpResponse.json(row);
  }),
];
