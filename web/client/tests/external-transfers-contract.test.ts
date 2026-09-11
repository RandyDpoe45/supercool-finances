import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountDto, AccountsResponse } from '../src/services/api/contracts/accounts';
import type {
  PendingAuthorizationResponse,
  TransferDto,
} from '../src/services/api/contracts/transfers';
import type { ErrorResponse } from '../src/services/api/contracts/error';
import { resetTransferStore } from '../src/mocks/state/transferStore';
import { resetPayeeStore } from '../src/mocks/state/payeeStore';
import { fixturePayees } from '../src/mocks/fixtures/payees';
import { fixtureAccounts } from '../src/mocks/fixtures/accounts';

/**
 * The external-outbound MSW stub must honor the REAL balance-service wire contract — external
 * transfers move money via a HOLD, so this is money-safety critical. Expectations come from the
 * CONTRACT OF RECORD — the transfers serializer/`TransferDto` whitelist, the `.strict()`
 * `initiateExternalTransferSchema`, the transfers domain errors + `domain-error-status.ts`, and
 * `balance-schema.yaml` — NOT from the app's helpers. It guards against:
 *
 *  - a leaked internal column (esp. `payeeId`) reaching the wire;
 *  - the WRONG status for a domain code — a missing/non-owned payee MUST be 404 (never 403), or a
 *    caller could enumerate which payee ids exist (ADR-3);
 *  - a replayed Idempotency-Key placing a SECOND hold (double-spend), or a same-key/different-request
 *    silently replaying a different money movement;
 *  - the hold projection being incoherent: initiate must drop `available` at once, cancel must
 *    restore it, confirm must decrement `balance` — all in exact bigint minor units (no float).
 */

const ORIGIN = window.location.origin;
const url = (path: string) => new URL(path, ORIGIN).toString();
const AUTH = { Authorization: 'Bearer test', 'Content-Type': 'application/json' };

const SOURCE = fixtureAccounts[0]; // balance 1500000, held 0, available 1500000, MXN
const SOURCE_ID = SOURCE.id;
const USABLE_PAYEE_ID = fixturePayees[0].id; // Landlord — usable
const COOLING_PAYEE_ID = fixturePayees[1].id; // New Supplier — still cooling off
const UNKNOWN_PAYEE_ID = '99999999-9999-4999-8999-999999999999';
const DEV_OTP_CODE = '123456';

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
const FORBIDDEN_FIELDS = [
  'initiatedBy',
  'payeeId', // the external destination column — must NEVER leak on the customer DTO
  'failureReason',
  'failedAt',
  'reversesTransactionId',
  'creditAccountId',
  'debitAccountId',
  'destinationAccountId',
  'destinationAccountNumber',
];

function validBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sourceAccountId: SOURCE_ID,
    payeeId: USABLE_PAYEE_ID,
    amount: '50000',
    currency: 'MXN',
    ...overrides,
  };
}

function initiateExternal(
  body: Record<string, unknown>,
  key: string | null = crypto.randomUUID(),
  headers: Record<string, string> = AUTH,
): Promise<Response> {
  return fetch(url('/balance/api/transfers/external'), {
    method: 'POST',
    headers: key === null ? headers : { ...headers, 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
}

async function readSourceAccount(): Promise<AccountDto> {
  const res = await fetch(url('/balance/api/accounts'), { headers: AUTH });
  const { accounts } = (await res.json()) as AccountsResponse;
  const source = accounts.find((a) => a.id === SOURCE_ID);
  if (!source) {
    throw new Error('source account missing from projection');
  }
  return source;
}

function expectNoForbiddenFields(record: object) {
  for (const field of FORBIDDEN_FIELDS) {
    expect(record).not.toHaveProperty(field);
  }
}

beforeEach(() => {
  resetTransferStore();
  resetPayeeStore();
});
afterEach(() => {
  resetTransferStore();
  resetPayeeStore();
});

describe('POST /balance/api/transfers/external — whitelist + external type', () => {
  it('creates a PENDING external_outbound exposing only the whitelisted TransferDto fields', async () => {
    const res = await initiateExternal(validBody());
    expect(res.status).toBe(201);
    const dto = (await res.json()) as TransferDto;
    expect(Object.keys(dto).sort()).toEqual(TRANSFER_FIELDS);
    expectNoForbiddenFields(dto);
    expect(dto.type).toBe('external_outbound');
    expect(dto.status).toBe('PENDING');
    expect(dto.amount).toBe('50000');
    expect(dto.currency).toBe('MXN');
    expect(dto.sourceAccountId).toBe(SOURCE_ID);
    expect(dto.postedAt).toBeNull();
    expect(dto.expiresAt).not.toBeNull();
  });

  it('projects the external pending onto the feed with the payee label + null destination-account fields', async () => {
    await initiateExternal(validBody());
    const res = await fetch(url('/balance/api/pending-authorization'), { headers: AUTH });
    const { authorization } = (await res.json()) as PendingAuthorizationResponse;
    expect(authorization).not.toBeNull();
    if (authorization) {
      expect(authorization.type).toBe('external_outbound');
      // Caller-supplied payee label is shown UNMASKED; the internal-transfer destination fields are
      // null for an external pending (there is no resolve step).
      expect(authorization.payeeDisplayName).toBe(fixturePayees[0].displayName);
      expect(authorization.destinationAccountNumber).toBeNull();
      expect(authorization.destinationMaskedName).toBeNull();
      expect(authorization).not.toHaveProperty('payeeId');
    }
  });
});

describe('POST /balance/api/transfers/external — payee + shape errors (correct statuses)', () => {
  it('collapses an unknown/non-owned payee to 404 PAYEE_NOT_FOUND (never 403 — anti-enumeration)', async () => {
    const res = await initiateExternal(validBody({ payeeId: UNKNOWN_PAYEE_ID }));
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
    expect(((await res.json()) as ErrorResponse).error.code).toBe('PAYEE_NOT_FOUND');
  });

  it('rejects a still-cooling payee with 409 PAYEE_IN_COOLING_OFF (the AUTHORITATIVE clock gate)', async () => {
    const res = await initiateExternal(validBody({ payeeId: COOLING_PAYEE_ID }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorResponse).error.code).toBe('PAYEE_IN_COOLING_OFF');
  });

  it('rejects a smuggled confirmationToken / destinationAccountNumber (400 — external has no resolve step)', async () => {
    // `.strict()` — external addresses a payee by id; a confirmation token or destination account
    // number is NOT a valid field and must be rejected, not silently ignored.
    const withToken = await initiateExternal(validBody({ confirmationToken: 'x' }));
    expect(withToken.status).toBe(400);
    const withDest = await initiateExternal(validBody({ destinationAccountNumber: '2000000001' }));
    expect(withDest.status).toBe(400);
  });

  it('rejects a non-positive / non-integer amount (400)', async () => {
    expect((await initiateExternal(validBody({ amount: '0' }))).status).toBe(400);
    expect((await initiateExternal(validBody({ amount: '12.5' }))).status).toBe(400);
  });

  it('requires the Idempotency-Key header (400) and a bearer (401)', async () => {
    const noKey = await initiateExternal(validBody(), null);
    expect(noKey.status).toBe(400);
    const noAuth = await initiateExternal(validBody(), crypto.randomUUID(), {
      'Content-Type': 'application/json',
    });
    expect(noAuth.status).toBe(401);
  });
});

describe('POST /balance/api/transfers/external — funds + currency (money-state errors, 422)', () => {
  it('rejects an amount over the source available with 422 INSUFFICIENT_FUNDS (no hold placed)', async () => {
    const res = await initiateExternal(validBody({ amount: '99999999' }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorResponse).error.code).toBe('INSUFFICIENT_FUNDS');
    // A rejected initiate must NOT have moved the money boundary.
    const source = await readSourceAccount();
    expect(source.available).toBe(SOURCE.available);
    expect(source.held).toBe(SOURCE.held);
  });

  it('rejects a currency that differs from the source account with 422 CURRENCY_MISMATCH', async () => {
    const res = await initiateExternal(validBody({ currency: 'USD' }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorResponse).error.code).toBe('CURRENCY_MISMATCH');
  });
});

describe('POST /balance/api/transfers/external — idempotency (a replayed key holds money once)', () => {
  it('replays the SAME transfer for a byte-identical retry (never a second hold)', async () => {
    const key = crypto.randomUUID();
    const body = validBody();
    const first = await initiateExternal(body, key);
    expect(first.status).toBe(201);
    const created = (await first.json()) as TransferDto;

    const replay = await initiateExternal(body, key);
    expect(replay.status).toBe(201);
    const replayed = (await replay.json()) as TransferDto;
    expect(replayed.id).toBe(created.id);
    expect(replayed.status).toBe('PENDING');

    // Only ONE hold was placed despite the retry: available dropped by the amount exactly once.
    const source = await readSourceAccount();
    expect(source.held).toBe('50000');
    expect(source.available).toBe('1450000');
  });

  it('rejects the SAME key with a different money tuple as 409 IDEMPOTENCY_KEY_REUSED, original untouched', async () => {
    // The external fingerprint keys off (source, payeeId, amount, currency) — so a different amount
    // (or a different payee) under the same key is reuse, never a silent replay of a different move.
    const key = crypto.randomUUID();
    const first = await initiateExternal(validBody({ amount: '50000' }), key);
    expect(first.status).toBe(201);
    const created = (await first.json()) as TransferDto;

    const reuse = await initiateExternal(validBody({ amount: '77777' }), key);
    expect(reuse.status).toBe(409);
    expect(((await reuse.json()) as ErrorResponse).error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // The original hold stands, at the ORIGINAL amount — no adoption of 77777, no second hold.
    const feed = await fetch(url('/balance/api/pending-authorization'), { headers: AUTH });
    const { authorization } = (await feed.json()) as PendingAuthorizationResponse;
    expect(authorization?.transferId).toBe(created.id);
    expect(authorization?.amount).toBe('50000');
    const source = await readSourceAccount();
    expect(source.held).toBe('50000');
  });
});

describe('POST /balance/api/transfers/external — soft-duplicate window (honors confirmDuplicate)', () => {
  it('soft-blocks an identical recent payment under a new key, then lets confirmDuplicate through', async () => {
    const first = await initiateExternal(validBody(), crypto.randomUUID());
    expect(first.status).toBe(201);

    const dup = await initiateExternal(validBody(), crypto.randomUUID());
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as ErrorResponse).error.code).toBe('SUSPECTED_DUPLICATE');

    const forced = await initiateExternal(
      validBody({ confirmDuplicate: true }),
      crypto.randomUUID(),
    );
    expect(forced.status).toBe(201);
  });
});

describe('POST /balance/api/transfers/external — the HOLD moves the money boundary (cache-coherence source of truth)', () => {
  it('initiate PLACES A HOLD (available drops now), cancel RELEASES it (available restored)', async () => {
    // Baseline.
    const before = await readSourceAccount();
    expect(before.balance).toBe('1500000');
    expect(before.held).toBe('0');
    expect(before.available).toBe('1500000');

    const initiated = (await (
      await initiateExternal(validBody({ amount: '50000' }))
    ).json()) as TransferDto;

    // Hold placed: held += amount, available drops, balance UNCHANGED (money not yet moved).
    const held = await readSourceAccount();
    expect(held.balance).toBe('1500000');
    expect(held.held).toBe('50000');
    expect(held.available).toBe('1450000');

    const cancel = await fetch(url(`/balance/api/transfers/${initiated.id}/cancel`), {
      method: 'POST',
      headers: AUTH,
    });
    expect(cancel.status).toBe(200);
    expect(((await cancel.json()) as TransferDto).status).toBe('CANCELLED');

    // Hold released: available fully restored to baseline, nothing consumed.
    const released = await readSourceAccount();
    expect(released.balance).toBe('1500000');
    expect(released.held).toBe('0');
    expect(released.available).toBe('1500000');
  });

  it('confirm SETTLES the hold — balance is decremented by the amount, held returns to zero', async () => {
    const initiated = (await (
      await initiateExternal(validBody({ amount: '50000' }))
    ).json()) as TransferDto;

    const confirm = await fetch(url(`/balance/api/transfers/${initiated.id}/confirm`), {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ code: DEV_OTP_CODE }),
    });
    expect(confirm.status).toBe(200);
    const posted = (await confirm.json()) as TransferDto;
    expect(posted.status).toBe('POSTED');
    expect(posted.type).toBe('external_outbound');

    // Settled: the reservation became a posted movement — balance -= amount, held back to 0.
    const settled = await readSourceAccount();
    expect(settled.balance).toBe('1450000');
    expect(settled.held).toBe('0');
    expect(settled.available).toBe('1450000');
  });
});
