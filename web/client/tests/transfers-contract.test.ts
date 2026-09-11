import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PendingAuthorizationResponse,
  ResolveDestinationDto,
  TransferDto,
} from '../src/services/api/contracts/transfers';
import type { ErrorResponse } from '../src/services/api/contracts/error';
import { resetTransferStore } from '../src/mocks/state/transferStore';

/**
 * The transfers MSW stub must honor the REAL balance-service wire contract so the SPA is developed
 * against the shape and status codes the backend actually emits. Expectations come from the CONTRACT
 * OF RECORD — the transfers serializers/DTO whitelists (`TransferDto`, `ResolveDestinationDto`,
 * `PendingAuthorizationDto`), the transfers domain errors, and `domain-error-status.ts` — NOT from
 * the app's own helpers. This is the guard against stub drift and, more importantly, against the
 * money defects the surface must prevent:
 *
 *  - a leaked internal column (`initiatedBy` / `payeeId` / `failureReason` / `failedAt` /
 *    `reversesTransactionId` / a raw credit account id) reaching the wire;
 *  - the wrong status for a domain code (e.g. a NOT_FOUND rendered 403, which would let a caller
 *    probe which ids exist — ADR-3 says 404, never 403);
 *  - a replayed Idempotency-Key creating a SECOND pending transfer (double-spend).
 */

const ORIGIN = window.location.origin;
const url = (path: string) => new URL(path, ORIGIN).toString();
const AUTH = { Authorization: 'Bearer test', 'Content-Type': 'application/json' };

const SOURCE_ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const SEEDED_DESTINATION = '2000000001';
const OTHER_DESTINATION = '2000000002';
const DEV_OTP_CODE = '123456';
const RANDOM_UUID = '99999999-9999-4999-8999-999999999999';

// The EXACT whitelists the serializers emit (transfers.serializer.ts + the DTO files). A leaked
// internal column would make Object.keys(...) diverge from these.
const TRANSFER_FIELDS = [
  'amount',
  'createdAt',
  'currency',
  'expiresAt',
  'id',
  'postedAt',
  'sourceAccountId',
  'status',
  'type',
].sort();
const RESOLVE_FIELDS = ['confirmationToken', 'currency', 'maskedName'].sort();
const PENDING_FIELDS = [
  'amount',
  'createdAt',
  'currency',
  'destinationAccountNumber',
  'destinationMaskedName',
  'expiresAt',
  'payeeDisplayName',
  'sourceAccountId',
  'transferId',
  'type',
].sort();
// Internal columns the service deliberately withholds — none may ever appear on the wire.
const FORBIDDEN_FIELDS = [
  'initiatedBy',
  'payeeId',
  'failureReason',
  'failedAt',
  'reversesTransactionId',
  'creditAccountId',
  'debitAccountId',
  'destinationAccountId',
];

async function resolve(accountNumber: string): Promise<ResolveDestinationDto> {
  const res = await fetch(url('/balance/api/transfers/resolve-destination'), {
    method: 'POST',
    headers: AUTH,
    body: JSON.stringify({ accountNumber }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as ResolveDestinationDto;
}

async function initiate(body: Record<string, unknown>, idempotencyKey: string): Promise<Response> {
  return fetch(url('/balance/api/transfers'), {
    method: 'POST',
    headers: { ...AUTH, 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  });
}

/** Resolve a destination and initiate a fresh PENDING transfer, returning its DTO. */
async function initiatePending(
  overrides: Partial<{ amount: string; key: string; destination: string }> = {},
): Promise<TransferDto> {
  const destination = overrides.destination ?? SEEDED_DESTINATION;
  const { confirmationToken } = await resolve(destination);
  const res = await initiate(
    {
      sourceAccountId: SOURCE_ACCOUNT_ID,
      destinationAccountNumber: destination,
      amount: overrides.amount ?? '10050',
      currency: 'MXN',
      confirmationToken,
    },
    overrides.key ?? crypto.randomUUID(),
  );
  expect(res.status).toBe(201);
  return (await res.json()) as TransferDto;
}

function expectNoForbiddenFields(record: object) {
  for (const field of FORBIDDEN_FIELDS) {
    expect(record).not.toHaveProperty(field);
  }
}

beforeEach(() => resetTransferStore());
afterEach(() => {
  vi.useRealTimers();
  resetTransferStore();
});

describe('POST /balance/api/transfers/resolve-destination — confirmation of payee', () => {
  it('returns only the whitelisted { maskedName, currency, confirmationToken }, no raw PII', async () => {
    const dto = await resolve(SEEDED_DESTINATION);
    expect(Object.keys(dto).sort()).toEqual(RESOLVE_FIELDS);
    expect(dto.maskedName).toMatch(/\*\*/); // masked, never a raw holder name
    expect(dto).not.toHaveProperty('name');
    expect(dto).not.toHaveProperty('accountId');
    expect(dto.currency).toBe('MXN');
    expect(typeof dto.confirmationToken).toBe('string');
    expect(dto.confirmationToken.length).toBeGreaterThan(0);
  });

  it('collapses an unknown destination to 404 TRANSFER_NOT_FOUND (never 403 — anti-enumeration)', async () => {
    const res = await fetch(url('/balance/api/transfers/resolve-destination'), {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ accountNumber: '9999999999' }),
    });
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error.code).toBe('TRANSFER_NOT_FOUND');
  });

  it('rejects a malformed account number as 400 and no bearer as 401', async () => {
    const malformed = await fetch(url('/balance/api/transfers/resolve-destination'), {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ accountNumber: 'not-digits' }),
    });
    expect(malformed.status).toBe(400);

    const noAuth = await fetch(url('/balance/api/transfers/resolve-destination'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountNumber: SEEDED_DESTINATION }),
    });
    expect(noAuth.status).toBe(401);
  });
});

describe('POST /balance/api/transfers — initiate whitelist + confirmation gate', () => {
  it('creates a PENDING transfer exposing only the whitelisted TransferDto fields', async () => {
    const dto = await initiatePending();
    expect(Object.keys(dto).sort()).toEqual(TRANSFER_FIELDS);
    expectNoForbiddenFields(dto);
    // The destination is NOT echoed on this DTO (the client holds it).
    expect(dto).not.toHaveProperty('destinationAccountNumber');

    expect(dto.type).toBe('internal');
    expect(dto.status).toBe('PENDING');
    expect(dto.amount).toBe('10050');
    expect(dto.currency).toBe('MXN');
    expect(dto.sourceAccountId).toBe(SOURCE_ACCOUNT_ID);
    expect(dto.postedAt).toBeNull(); // null while pending
    expect(dto.expiresAt).not.toBeNull(); // 2-minute deadline set
    expect(typeof dto.createdAt).toBe('string');
  });

  it('rejects a confirmation token that was never issued as 409 DESTINATION_NOT_CONFIRMED', async () => {
    const res = await initiate(
      {
        sourceAccountId: SOURCE_ACCOUNT_ID,
        destinationAccountNumber: SEEDED_DESTINATION,
        amount: '10050',
        currency: 'MXN',
        confirmationToken: 'never-resolved',
      },
      crypto.randomUUID(),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorResponse).error.code).toBe('DESTINATION_NOT_CONFIRMED');
  });

  it('rejects a token bound to a DIFFERENT destination (token/destination mismatch)', async () => {
    const { confirmationToken } = await resolve(SEEDED_DESTINATION);
    const res = await initiate(
      {
        sourceAccountId: SOURCE_ACCOUNT_ID,
        destinationAccountNumber: OTHER_DESTINATION, // token was for SEEDED_DESTINATION
        amount: '10050',
        currency: 'MXN',
        confirmationToken,
      },
      crypto.randomUUID(),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorResponse).error.code).toBe('DESTINATION_NOT_CONFIRMED');
  });

  it('requires the Idempotency-Key header (400) and a bearer (401)', async () => {
    const { confirmationToken } = await resolve(SEEDED_DESTINATION);
    const body = {
      sourceAccountId: SOURCE_ACCOUNT_ID,
      destinationAccountNumber: SEEDED_DESTINATION,
      amount: '10050',
      currency: 'MXN',
      confirmationToken,
    };
    const noKey = await fetch(url('/balance/api/transfers'), {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify(body),
    });
    expect(noKey.status).toBe(400);

    const noAuth = await fetch(url('/balance/api/transfers'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify(body),
    });
    expect(noAuth.status).toBe(401);
  });

  it('rejects a non-positive / non-integer amount as 400', async () => {
    const { confirmationToken } = await resolve(SEEDED_DESTINATION);
    const base = {
      sourceAccountId: SOURCE_ACCOUNT_ID,
      destinationAccountNumber: SEEDED_DESTINATION,
      currency: 'MXN',
      confirmationToken,
    };
    const zero = await initiate({ ...base, amount: '0' }, crypto.randomUUID());
    expect(zero.status).toBe(400);
    const fractional = await initiate({ ...base, amount: '12.5' }, crypto.randomUUID());
    expect(fractional.status).toBe(400);
  });
});

describe('POST /balance/api/transfers — idempotency (a replayed key moves money once)', () => {
  // The two halves of the service's `resolveExisting` (idempotency.service.ts): a matching
  // fingerprint REPLAYS the original; a mismatched one is `IdempotencyKeyReuseError` → 409.
  it('replays the SAME transfer for a byte-identical retry and never creates a second pending', async () => {
    const { confirmationToken } = await resolve(SEEDED_DESTINATION);
    const key = crypto.randomUUID();
    const body = {
      sourceAccountId: SOURCE_ACCOUNT_ID,
      destinationAccountNumber: SEEDED_DESTINATION,
      amount: '10050',
      currency: 'MXN',
      confirmationToken,
    };
    const created = await initiate(body, key);
    expect(created.status).toBe(201);
    const first = (await created.json()) as TransferDto;

    // A byte-identical retry under the SAME key must REPLAY the original transfer (same id, same
    // amount, still PENDING) — the money-safety replay property: a retried request moves money once.
    // POST /balance/api/transfers has no custom @HttpCode, so a replay returns 201 like the first create.
    const replay = await initiate(body, key);
    expect(replay.status).toBe(201);
    const replayed = (await replay.json()) as TransferDto;
    expect(replayed.id).toBe(first.id);
    expect(replayed.amount).toBe('10050');
    expect(replayed.status).toBe('PENDING');

    // No SECOND pending was created: the single active pending is STILL the original transfer. Had
    // the replay minted a new pending, the single-pending rule would have superseded `first`, so the
    // feed's transferId would diverge.
    const feed = await fetch(url('/balance/api/pending-authorization'), { headers: AUTH });
    const { authorization } = (await feed.json()) as PendingAuthorizationResponse;
    expect(authorization).not.toBeNull();
    expect(authorization?.transferId).toBe(first.id);
    expect(authorization?.amount).toBe('10050');
  });

  it('rejects the SAME key with different details as 409 IDEMPOTENCY_KEY_REUSED and leaves the original untouched', async () => {
    const { confirmationToken } = await resolve(SEEDED_DESTINATION);
    const key = crypto.randomUUID();
    const created = await initiate(
      {
        sourceAccountId: SOURCE_ACCOUNT_ID,
        destinationAccountNumber: SEEDED_DESTINATION,
        amount: '10050',
        currency: 'MXN',
        confirmationToken,
      },
      key,
    );
    expect(created.status).toBe(201);
    const first = (await created.json()) as TransferDto;

    // Same key, DIFFERENT money tuple (a new amount) → the service's fingerprint mismatch raises
    // `IdempotencyKeyReuseError`, mapped to 409 IDEMPOTENCY_KEY_REUSED (domain-error-status.ts). It
    // must NOT silently replay and must NOT adopt the new amount — that would be a money defect.
    const reuse = await initiate(
      {
        sourceAccountId: SOURCE_ACCOUNT_ID,
        destinationAccountNumber: SEEDED_DESTINATION,
        amount: '99999',
        currency: 'MXN',
        confirmationToken,
      },
      key,
    );
    expect(reuse.status).toBe(409);
    expect(((await reuse.json()) as ErrorResponse).error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // The original is untouched: still the single active pending, still the ORIGINAL amount (no
    // adoption of 99999), and no second pending was created.
    const feed = await fetch(url('/balance/api/pending-authorization'), { headers: AUTH });
    const { authorization } = (await feed.json()) as PendingAuthorizationResponse;
    expect(authorization).not.toBeNull();
    expect(authorization?.transferId).toBe(first.id);
    expect(authorization?.amount).toBe('10050');
  });

  it('creates DISTINCT transfers for different keys', async () => {
    const a = await initiatePending({ amount: '11111' });
    const b = await initiatePending({ amount: '22222' }); // different amount → no soft-duplicate block
    expect(a.id).not.toBe(b.id);
  });
});

describe('POST /balance/api/transfers — soft-duplicate window (honors confirmDuplicate)', () => {
  it('blocks an identical recent payment under a new key, then lets confirmDuplicate through', async () => {
    const { confirmationToken } = await resolve(SEEDED_DESTINATION);
    const body = {
      sourceAccountId: SOURCE_ACCOUNT_ID,
      destinationAccountNumber: SEEDED_DESTINATION,
      amount: '55555',
      currency: 'MXN',
      confirmationToken,
    };
    const first = await initiate(body, crypto.randomUUID());
    expect(first.status).toBe(201);

    // A DIFFERENT key, identical payment, within the window, no confirmDuplicate → soft-blocked.
    const dup = await initiate(body, crypto.randomUUID());
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as ErrorResponse).error.code).toBe('SUSPECTED_DUPLICATE');

    // With confirmDuplicate the same payment proceeds.
    const forced = await initiate({ ...body, confirmDuplicate: true }, crypto.randomUUID());
    expect(forced.status).toBe(201);
  });
});

describe('POST /balance/api/transfers/:id/confirm — OTP-gated posting', () => {
  it('posts a PENDING transfer on the dev code and echoes only the whitelisted fields', async () => {
    const pending = await initiatePending();
    const res = await fetch(url(`/balance/api/transfers/${pending.id}/confirm`), {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ code: DEV_OTP_CODE }),
    });
    expect(res.status).toBe(200);
    const dto = (await res.json()) as TransferDto;
    expect(Object.keys(dto).sort()).toEqual(TRANSFER_FIELDS);
    expectNoForbiddenFields(dto);
    expect(dto.status).toBe('POSTED');
    expect(dto.postedAt).not.toBeNull();
  });

  it('rejects a wrong code as 401 INVALID_OTP (leaving the transfer confirmable)', async () => {
    const pending = await initiatePending();
    const res = await fetch(url(`/balance/api/transfers/${pending.id}/confirm`), {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ code: '000000' }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrorResponse).error.code).toBe('INVALID_OTP');
  });

  it('collapses an unknown transfer id to 404 TRANSFER_NOT_FOUND (never 403)', async () => {
    const res = await fetch(url(`/balance/api/transfers/${RANDOM_UUID}/confirm`), {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ code: DEV_OTP_CODE }),
    });
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
    expect(((await res.json()) as ErrorResponse).error.code).toBe('TRANSFER_NOT_FOUND');
  });

  it('rejects a malformed id (400) and a non-numeric code (400)', async () => {
    const badId = await fetch(url('/balance/api/transfers/not-a-uuid/confirm'), {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ code: DEV_OTP_CODE }),
    });
    expect(badId.status).toBe(400);

    const pending = await initiatePending();
    const badCode = await fetch(url(`/balance/api/transfers/${pending.id}/confirm`), {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ code: 'abc' }),
    });
    expect(badCode.status).toBe(400);
  });

  it('returns 409 TRANSFER_NOT_PENDING when confirming a cancelled transfer', async () => {
    const pending = await initiatePending();
    await fetch(url(`/balance/api/transfers/${pending.id}/cancel`), {
      method: 'POST',
      headers: AUTH,
    });
    const res = await fetch(url(`/balance/api/transfers/${pending.id}/confirm`), {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ code: DEV_OTP_CODE }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorResponse).error.code).toBe('TRANSFER_NOT_PENDING');
  });

  it('returns 410 TRANSFER_EXPIRED once the 2-minute deadline lapses (code not consumed)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-10T00:00:00.000Z'));
    const pending = await initiatePending();
    // Past the 2-minute pending deadline.
    vi.setSystemTime(new Date('2026-09-10T00:03:00.000Z'));
    const res = await fetch(url(`/balance/api/transfers/${pending.id}/confirm`), {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ code: DEV_OTP_CODE }),
    });
    expect(res.status).toBe(410);
    expect(((await res.json()) as ErrorResponse).error.code).toBe('TRANSFER_EXPIRED');
  });
});

describe('POST /balance/api/transfers/:id/cancel', () => {
  it('cancels a PENDING transfer and is idempotent on an already-terminal one', async () => {
    const pending = await initiatePending();
    const first = await fetch(url(`/balance/api/transfers/${pending.id}/cancel`), {
      method: 'POST',
      headers: AUTH,
    });
    expect(first.status).toBe(200);
    const dto = (await first.json()) as TransferDto;
    expect(Object.keys(dto).sort()).toEqual(TRANSFER_FIELDS);
    expect(dto.status).toBe('CANCELLED');

    const again = await fetch(url(`/balance/api/transfers/${pending.id}/cancel`), {
      method: 'POST',
      headers: AUTH,
    });
    expect(again.status).toBe(200);
    expect(((await again.json()) as TransferDto).status).toBe('CANCELLED');
  });

  it('collapses an unknown id to 404 and refuses to cancel a POSTED transfer (409)', async () => {
    const unknown = await fetch(url(`/balance/api/transfers/${RANDOM_UUID}/cancel`), {
      method: 'POST',
      headers: AUTH,
    });
    expect(unknown.status).toBe(404);

    const pending = await initiatePending();
    await fetch(url(`/balance/api/transfers/${pending.id}/confirm`), {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ code: DEV_OTP_CODE }),
    });
    const posted = await fetch(url(`/balance/api/transfers/${pending.id}/cancel`), {
      method: 'POST',
      headers: AUTH,
    });
    expect(posted.status).toBe(409);
    expect(((await posted.json()) as ErrorResponse).error.code).toBe('TRANSFER_NOT_PENDING');
  });
});

describe('GET /balance/api/pending-authorization — the resume / OTP feed', () => {
  it('projects only the whitelisted PendingAuthorizationDto fields for the active pending', async () => {
    await initiatePending();
    const res = await fetch(url('/balance/api/pending-authorization'), { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PendingAuthorizationResponse;
    expect(body.authorization).not.toBeNull();
    if (body.authorization) {
      expect(Object.keys(body.authorization).sort()).toEqual(PENDING_FIELDS);
      expectNoForbiddenFields(body.authorization);
      expect(body.authorization.type).toBe('internal');
      expect(body.authorization.destinationAccountNumber).toBe(SEEDED_DESTINATION);
      expect(body.authorization.destinationMaskedName).toMatch(/\*\*/);
      expect(body.authorization.payeeDisplayName).toBeNull();
    }
  });

  it('reports no active pending once the transfer is confirmed', async () => {
    const pending = await initiatePending();
    await fetch(url(`/balance/api/transfers/${pending.id}/confirm`), {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ code: DEV_OTP_CODE }),
    });
    const res = await fetch(url('/balance/api/pending-authorization'), { headers: AUTH });
    const body = (await res.json()) as PendingAuthorizationResponse;
    expect(body.authorization).toBeNull();
  });

  it('requires a bearer (401)', async () => {
    const res = await fetch(url('/balance/api/pending-authorization'));
    expect(res.status).toBe(401);
  });
});

describe('error envelope shape', () => {
  it('every error uses { error: { code, message, requestId } } with non-empty strings', async () => {
    const res = await fetch(url('/balance/api/transfers/resolve-destination'), {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ accountNumber: '9999999999' }),
    });
    const body = (await res.json()) as ErrorResponse;
    expect(typeof body.error.code).toBe('string');
    expect(body.error.code.length).toBeGreaterThan(0);
    expect(typeof body.error.message).toBe('string');
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(typeof body.error.requestId).toBe('string');
    expect(body.error.requestId.length).toBeGreaterThan(0);
  });
});
