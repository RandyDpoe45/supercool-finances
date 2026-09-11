import { http, HttpResponse } from 'msw';
import type { AdminAccountsResponse } from '../services/api/contracts/account';
import type {
  AccountSummariesResponse,
  DailyAggregatesResponse,
} from '../services/api/contracts/analytics';
import type { ApprovalsResponse } from '../services/api/contracts/approval';
import type { AuditLogResponse } from '../services/api/contracts/audit';
import type { ErrorResponse } from '../services/api/contracts/error';
import type { WhoamiDto } from '../services/api/contracts/identity';
import type { LimitsResponse, LimitsScope } from '../services/api/contracts/limits';
import type { AdminTransactionsResponse } from '../services/api/contracts/transaction';
import { fixtureWhoami } from './fixtures/identity';
import type { ReversalDomainCode } from './state/adminState';
import {
  approveReversal,
  freezeAccount,
  listAccounts,
  listApprovals,
  listAudit,
  listLimits,
  listTransactions,
  proposeReversal,
  rejectReversal,
  unfreezeAccount,
  upsertLimits,
} from './state/adminState';
import { listAccountSummaries, listDailyAggregates } from './state/analyticsState';

/**
 * MSW request handlers mirroring the REAL admin wire contracts (specs/07-frontends.md) across the
 * admin app's TWO gateway namespaces (ADR-17): `/balance/admin` (the balance-service admin surface)
 * and `/analytics/admin` (the analytics server's reporting surface). Both are service-namespaced
 * outbound paths — the internal transport strips the leading `/balance` or `/analytics` so each
 * service still serves its own `/admin` surface. OIDC traffic to Keycloak hits the real authority.
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
// Reversal domain errors carry their OWN stable code (not the generic 404/409/403 code) — the code
// IS the domain code, exactly as the real service returns it.
const conflict = (code: string, message: string) => errorResponse(409, code, message);
const forbidden = (code: string, message: string) => errorResponse(403, code, message);

/** PII-light messages mirroring the balance-service domain errors verbatim (safe to surface). */
const REVERSAL_MESSAGE: Readonly<Record<ReversalDomainCode, string>> = {
  TRANSFER_NOT_FOUND: 'Transfer not found',
  TRANSACTION_NOT_REVERSIBLE: 'The transaction is not reversible in its current state',
  REVERSAL_ALREADY_REQUESTED: 'A reversal has already been requested for this transaction',
  APPROVAL_NOT_FOUND: 'Approval request not found',
  APPROVAL_NOT_PENDING: 'The approval request is not pending',
  SELF_APPROVAL_FORBIDDEN: 'The maker of a reversal cannot decide their own request',
};

/** Map a reversal domain code to its HTTP status + envelope (the single mapping point, mirroring the
 * service's `domain-error-status.ts`): 404 for the not-found codes, 409 for the state conflicts, 403
 * for the four-eyes violation. */
function mapReversalError(code: ReversalDomainCode) {
  const message = REVERSAL_MESSAGE[code];
  switch (code) {
    case 'TRANSFER_NOT_FOUND':
    case 'APPROVAL_NOT_FOUND':
      return errorResponse(404, code, message);
    case 'TRANSACTION_NOT_REVERSIBLE':
    case 'REVERSAL_ALREADY_REQUESTED':
    case 'APPROVAL_NOT_PENDING':
      return conflict(code, message);
    case 'SELF_APPROVAL_FORBIDDEN':
      return forbidden(code, message);
  }
}

/** Validate the OPTIONAL `POST /transfers/:id/reverse` body, mirroring the service's
 * `z.object({ reason: z.string().min(1).max(500).optional() }).strict()` over a preprocessed
 * `?? {}`: an absent body is valid (no reason); a present `reason` must be a 1..500 char string; any
 * other key (or a non-string / empty / oversized reason) is a 400 BAD_REQUEST. */
function parseReverseBody(
  raw: unknown,
): { ok: true; reason?: string } | { ok: false; message: string } {
  if (raw === undefined || raw === null) {
    return { ok: true };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'Malformed request body' };
  }
  const body = raw as Record<string, unknown>;
  if (!hasOnlyKeys(body, ['reason'])) {
    return { ok: false, message: 'Unexpected field in reverse body' };
  }
  if (body.reason === undefined) {
    return { ok: true };
  }
  const reason = body.reason;
  if (typeof reason !== 'string' || reason.length < 1 || reason.length > 500) {
    return { ok: false, message: 'reason must be a 1..500 character string' };
  }
  return { ok: true, reason };
}

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

  // The admin-visible transactions, filtered (ownerId/accountId/status/type) + paged (limit ≤200).
  http.get('/balance/admin/transactions', ({ request }) => {
    if (!isBearerAuthenticated(request)) {
      return unauthorized();
    }
    const url = new URL(request.url);
    const transactions = listTransactions({
      ownerId: url.searchParams.get('ownerId') ?? undefined,
      accountId: url.searchParams.get('accountId') ?? undefined,
      status: url.searchParams.get('status') ?? undefined,
      type: url.searchParams.get('type') ?? undefined,
      limit: numericParam(url, 'limit'),
      offset: numericParam(url, 'offset'),
    });
    const body: AdminTransactionsResponse = { transactions };
    return HttpResponse.json(body);
  }),

  // The maker-checker approval requests; an absent `status` lets the state default to PENDING.
  http.get('/balance/admin/approvals', ({ request }) => {
    if (!isBearerAuthenticated(request)) {
      return unauthorized();
    }
    const url = new URL(request.url);
    const status = url.searchParams.get('status') ?? undefined;
    const body: ApprovalsResponse = { approvals: listApprovals({ status }) };
    return HttpResponse.json(body);
  }),

  // The admin audit log (read-only), newest-first. Optional exact-match filters
  // (actorId/action/targetType/targetId) + `limit`/`offset` paging (limit clamped [1,200], default 50).
  http.get('/balance/admin/audit', ({ request }) => {
    if (!isBearerAuthenticated(request)) {
      return unauthorized();
    }
    const url = new URL(request.url);
    const entries = listAudit({
      actorId: url.searchParams.get('actorId') ?? undefined,
      action: url.searchParams.get('action') ?? undefined,
      targetType: url.searchParams.get('targetType') ?? undefined,
      targetId: url.searchParams.get('targetId') ?? undefined,
      limit: numericParam(url, 'limit'),
      offset: numericParam(url, 'offset'),
    });
    const body: AuditLogResponse = { entries };
    return HttpResponse.json(body);
  }),

  // Propose a reversal (the MAKER action). `:id` is the target TRANSACTION uuid; optional `reason`
  // body. The maker id is the caller's identity (server-side), NEVER the body. 201, the PENDING
  // approval; a domain violation maps to 404/409.
  http.post('/balance/admin/transfers/:id/reverse', async ({ request, params }) => {
    if (!isBearerAuthenticated(request)) {
      return unauthorized();
    }
    const id = String(params.id);
    if (!UUID_PATTERN.test(id)) {
      return badRequest('Malformed transaction id');
    }
    const raw = await request.json().catch(() => undefined);
    const parsed = parseReverseBody(raw);
    if (!parsed.ok) {
      return badRequest(parsed.message);
    }
    const result = proposeReversal(fixtureWhoami.userId, id, parsed.reason);
    if (!result.ok) {
      return mapReversalError(result.code);
    }
    return HttpResponse.json(result.value, { status: 201 });
  }),

  // Approve a PENDING reversal (the CHECKER action) — executes it. `:id` is the APPROVAL uuid. The
  // checker id is the caller's identity; a self-approval is 403. 200, the EXECUTED approval.
  http.post('/balance/admin/approvals/:id/approve', ({ request, params }) => {
    if (!isBearerAuthenticated(request)) {
      return unauthorized();
    }
    const id = String(params.id);
    if (!UUID_PATTERN.test(id)) {
      return badRequest('Malformed approval id');
    }
    const result = approveReversal(fixtureWhoami.userId, id);
    if (!result.ok) {
      return mapReversalError(result.code);
    }
    return HttpResponse.json(result.value, { status: 200 });
  }),

  // Reject a PENDING reversal (the CHECKER action) — moves no money. `:id` is the APPROVAL uuid.
  // 200, the REJECTED approval; a domain violation maps to 404/409/403.
  http.post('/balance/admin/approvals/:id/reject', ({ request, params }) => {
    if (!isBearerAuthenticated(request)) {
      return unauthorized();
    }
    const id = String(params.id);
    if (!UUID_PATTERN.test(id)) {
      return badRequest('Malformed approval id');
    }
    const result = rejectReversal(fixtureWhoami.userId, id);
    if (!result.ok) {
      return mapReversalError(result.code);
    }
    return HttpResponse.json(result.value, { status: 200 });
  }),

  // --- Analytics reporting surface (`/analytics/admin`, ADR-17) ----------------------------------
  // The analytics server's read-model reports over the SECOND gateway namespace. Same bearer gate
  // as `/balance/admin` (both behind the internal gateway's admin-role gate). Pure reads.

  // Per-account activity + latest-known balance. Optional exact-match `ownerId` / `accountId` /
  // `currency` filters + `limit`/`offset` paging (limit clamped [1,200], default 50; offset ≥0).
  http.get('/analytics/admin/reports/account-summaries', ({ request }) => {
    if (!isBearerAuthenticated(request)) {
      return unauthorized();
    }
    const url = new URL(request.url);
    const accountSummaries = listAccountSummaries({
      ownerId: url.searchParams.get('ownerId') ?? undefined,
      accountId: url.searchParams.get('accountId') ?? undefined,
      currency: url.searchParams.get('currency') ?? undefined,
      limit: numericParam(url, 'limit'),
      offset: numericParam(url, 'offset'),
    });
    const body: AccountSummariesResponse = { accountSummaries };
    return HttpResponse.json(body);
  }),

  // Per-day × currency × type volume/count. Optional exact-match `currency` / `type` + inclusive
  // `from`/`to` (`YYYY-MM-DD` day bounds) filters + `limit`/`offset` paging (same clamp as above).
  http.get('/analytics/admin/reports/daily-aggregates', ({ request }) => {
    if (!isBearerAuthenticated(request)) {
      return unauthorized();
    }
    const url = new URL(request.url);
    const dailyAggregates = listDailyAggregates({
      currency: url.searchParams.get('currency') ?? undefined,
      type: url.searchParams.get('type') ?? undefined,
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
      limit: numericParam(url, 'limit'),
      offset: numericParam(url, 'offset'),
    });
    const body: DailyAggregatesResponse = { dailyAggregates };
    return HttpResponse.json(body);
  }),
];
