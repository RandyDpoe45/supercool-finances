import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PayeeDto, PayeesResponse } from '../src/services/api/contracts/payees';
import type { ErrorResponse } from '../src/services/api/contracts/error';
import { resetPayeeStore } from '../src/mocks/state/payeeStore';
import { fixturePayees } from '../src/mocks/fixtures/payees';

/**
 * The payees MSW stub must honor the REAL balance-service payees wire contract so the SPA is
 * developed against the shape + status codes the backend emits. Expectations come from the CONTRACT
 * OF RECORD — the `PayeeDto` whitelist (`payee.dto.ts` / `payees.serializer.ts`), the `.strict()`
 * enrollment schema (`payees.schema.ts`, `destinationRef` a 6–20 digit string), and the payees
 * domain errors + `domain-error-status.ts` — NOT from the app's helpers. This guards against:
 *
 *  - a LEAKED internal column (`ownerId` / `rail` / `status` / `activatedAt`) reaching the wire — the
 *    serializer whitelists by hand and must NEVER spread the entity;
 *  - the `usable` hint drifting from `now >= coolingOffUntil`;
 *  - a smuggled server-owned field being accepted (`.strict()` must reject unknown keys — otherwise a
 *    client could pre-set `coolingOffUntil` / `rail` and defeat the anti-fraud cooling-off gate);
 *  - a duplicate enrollment silently succeeding instead of colliding (409 `PAYEE_ALREADY_ENROLLED`).
 */

const ORIGIN = window.location.origin;
const url = (path: string) => new URL(path, ORIGIN).toString();
const AUTH = { Authorization: 'Bearer test', 'Content-Type': 'application/json' };

// The EXACT whitelist the serializer emits (payee.dto.ts). A leaked column diverges from this.
const PAYEE_FIELDS = [
  'coolingOffUntil',
  'createdAt',
  'destinationRef',
  'displayName',
  'id',
  'usable',
].sort();
// Internal columns the service deliberately withholds — none may appear on the wire.
const FORBIDDEN_FIELDS = ['ownerId', 'rail', 'status', 'activatedAt'];

const USABLE_PAYEE = fixturePayees[0]; // Landlord — cooling-off lapsed a day ago
const COOLING_PAYEE = fixturePayees[1]; // New Supplier — still cooling off

async function getPayees(headers: Record<string, string> = AUTH): Promise<Response> {
  return fetch(url('/balance/api/payees'), { headers });
}

async function enroll(
  body: Record<string, unknown>,
  headers: Record<string, string> = AUTH,
): Promise<Response> {
  return fetch(url('/balance/api/payees'), { method: 'POST', headers, body: JSON.stringify(body) });
}

function expectNoForbiddenFields(record: object) {
  for (const field of FORBIDDEN_FIELDS) {
    expect(record).not.toHaveProperty(field);
  }
}

beforeEach(() => resetPayeeStore());
afterEach(() => resetPayeeStore());

describe('GET /balance/api/payees — whitelist + usable derivation (hint = now >= coolingOffUntil)', () => {
  it('returns each payee with EXACTLY the whitelisted keys and no internal columns', async () => {
    const res = await getPayees();
    expect(res.status).toBe(200);
    const { payees } = (await res.json()) as PayeesResponse;
    expect(payees.length).toBeGreaterThan(0);
    for (const payee of payees) {
      expect(Object.keys(payee).sort()).toEqual(PAYEE_FIELDS);
      expectNoForbiddenFields(payee);
    }
  });

  it('derives usable from the clock: a lapsed cooling-off is usable, a future one is not', async () => {
    const { payees } = (await (await getPayees()).json()) as PayeesResponse;
    const usable = payees.find((p) => p.id === USABLE_PAYEE.id);
    const cooling = payees.find((p) => p.id === COOLING_PAYEE.id);
    expect(usable).toBeDefined();
    expect(cooling).toBeDefined();

    // Usable payee: usable === true AND its coolingOffUntil is in the PAST.
    expect(usable?.usable).toBe(true);
    expect(Date.parse(usable!.coolingOffUntil)).toBeLessThanOrEqual(Date.now());

    // Cooling-off payee: usable === false AND its coolingOffUntil is in the FUTURE. The `usable`
    // flag must track the timestamp, never contradict it.
    expect(cooling?.usable).toBe(false);
    expect(Date.parse(cooling!.coolingOffUntil)).toBeGreaterThan(Date.now());
  });

  it('requires a bearer (401)', async () => {
    const res = await getPayees({ 'Content-Type': 'application/json' });
    expect(res.status).toBe(401);
  });
});

describe('POST /balance/api/payees — enrollment: valid body + cooling-off gate', () => {
  it('enrolls with the two whitelisted fields → 201 PayeeDto, NOT-yet-usable, future cooling-off', async () => {
    const res = await enroll({ displayName: 'Butcher', destinationRef: '9000000123' });
    expect(res.status).toBe(201);
    const payee = (await res.json()) as PayeeDto;
    expect(Object.keys(payee).sort()).toEqual(PAYEE_FIELDS);
    expectNoForbiddenFields(payee);
    expect(payee.displayName).toBe('Butcher');
    expect(payee.destinationRef).toBe('9000000123');
    // A freshly enrolled payee CANNOT receive money yet — the cooling-off delay is the anti-fraud
    // control, so usable must be false and coolingOffUntil must be in the future.
    expect(payee.usable).toBe(false);
    expect(Date.parse(payee.coolingOffUntil)).toBeGreaterThan(Date.now());
  });

  it('appears in the list (still cooling off) after enrollment', async () => {
    await enroll({ displayName: 'Butcher', destinationRef: '9000000123' });
    const { payees } = (await (await getPayees()).json()) as PayeesResponse;
    const created = payees.find((p) => p.destinationRef === '9000000123');
    expect(created).toBeDefined();
    expect(created?.usable).toBe(false);
  });
});

describe('POST /balance/api/payees — .strict() rejects smuggled server-owned fields (400)', () => {
  it.each([
    ['rail', { displayName: 'X', destinationRef: '9000000123', rail: 'SPEI' }],
    ['status', { displayName: 'X', destinationRef: '9000000123', status: 'active' }],
    [
      'coolingOffUntil',
      {
        displayName: 'X',
        destinationRef: '9000000123',
        coolingOffUntil: '1970-01-01T00:00:00.000Z',
      },
    ],
    ['ownerId', { displayName: 'X', destinationRef: '9000000123', ownerId: 'someone-else' }],
  ])(
    'rejects an unknown key (%s) so it cannot defeat the cooling-off / rail invariants',
    async (_label, body) => {
      const res = await enroll(body);
      expect(res.status).toBe(400);
    },
  );
});

describe('POST /balance/api/payees — shape validation (400)', () => {
  it.each([
    ['too short', '123'],
    ['non-numeric', 'abcdef'],
    ['too long (21 digits)', '123456789012345678901'],
  ])('rejects a bad destinationRef (%s)', async (_label, destinationRef) => {
    const res = await enroll({ displayName: 'X', destinationRef });
    expect(res.status).toBe(400);
  });

  it('rejects an empty / whitespace-only displayName (trimmed to nothing)', async () => {
    expect((await enroll({ displayName: '', destinationRef: '9000000123' })).status).toBe(400);
    expect((await enroll({ displayName: '   ', destinationRef: '9000000123' })).status).toBe(400);
  });

  it('rejects a displayName longer than 120 characters', async () => {
    const res = await enroll({ displayName: 'a'.repeat(121), destinationRef: '9000000123' });
    expect(res.status).toBe(400);
  });

  it('requires a bearer (401)', async () => {
    const res = await enroll(
      { displayName: 'X', destinationRef: '9000000123' },
      { 'Content-Type': 'application/json' },
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /balance/api/payees — duplicate enrollment collides (409 PAYEE_ALREADY_ENROLLED)', () => {
  it('rejects a second enrollment of the SAME destinationRef (mirrors uq_payee)', async () => {
    const first = await enroll({ displayName: 'Butcher', destinationRef: '9000000123' });
    expect(first.status).toBe(201);
    const dup = await enroll({ displayName: 'Butcher again', destinationRef: '9000000123' });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as ErrorResponse).error.code).toBe('PAYEE_ALREADY_ENROLLED');
  });

  it('rejects re-enrolling a SEEDED destinationRef', async () => {
    const res = await enroll({
      displayName: 'Impostor',
      destinationRef: USABLE_PAYEE.destinationRef,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorResponse).error.code).toBe('PAYEE_ALREADY_ENROLLED');
  });
});
