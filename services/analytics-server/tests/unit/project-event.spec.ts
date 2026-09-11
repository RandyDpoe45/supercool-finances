/**
 * Spec 05, step A2 — the PURE `projectEvent(eventId, eventType, payloadJson)`
 * projection. Written from the CONTRACT OF RECORD (specs/DATA-MODEL.md Part 2: the
 * wire event payload shape ~line 403 and the stored `transactions` document), NOT
 * from the implementor's code — each test must be able to FAIL on a real defect.
 *
 * The projection turns the on-the-wire event (STREAM fields `event_id` / `event_type`
 * + a camelCase JSON `payload`, money as int64 STRINGS) into the stored read-model
 * shape (money as `bigint`). It is pure (no Redis/Mongo), so it runs in the default
 * `npm test` gate — no ANALYTICS_INTEGRATION opt-in.
 *
 * Money-safety is the crux here: a value past 2^53 must survive VERBATIM as a
 * `bigint`, and a NON-string (numeric) money field must be REJECTED — a JSON number
 * past 2^53 is already rounded by JSON.parse, so silently coercing it would corrupt
 * money. These tests assert exact bigint equality and throw-on-non-string.
 */
import { getProjectEvent } from '../support/harness';

type ProjectEvent = (eventId: string, eventType: string, payloadJson: string) => any;

const OWNER_A = 'sub-alice';
const OWNER_B = 'sub-bob';
// 2^53 + 1 — the smallest positive integer NOT representable as a float64 double.
const HUGE = '9007199254740993';

/** A complete, valid POSTED event payload (camelCase, money as int64 strings). */
function postedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    occurredAt: '2026-09-08T12:00:00.000Z',
    transaction: {
      id: 'tx-posted',
      type: 'external_outbound',
      status: 'POSTED',
      amount: HUGE,
      currency: 'MXN',
      initiatedBy: OWNER_A,
      reversesTransactionId: null,
      payee: { id: 'payee-1', displayName: 'ACME', rail: 'rail-outbound' },
      createdAt: '2026-09-08T12:00:00.000Z',
      postedAt: '2026-09-08T12:00:01.000Z',
      failureReason: null,
    },
    legs: [
      {
        accountId: 'acct-customer',
        ownerId: OWNER_A,
        accountKind: 'customer',
        systemKey: null,
        delta: `-${HUGE}`,
        balanceAfter: '150000',
        currency: 'MXN',
      },
      {
        accountId: 'acct-clearing',
        ownerId: null,
        accountKind: 'system',
        systemKey: 'clearing:rail-outbound',
        delta: HUGE,
        balanceAfter: '900000',
        currency: 'MXN',
      },
    ],
    ...overrides,
  };
}

/** A complete, valid FAILED event payload — status FAILED, EMPTY legs, reason set. */
function failedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    occurredAt: '2026-09-08T12:00:03.000Z',
    transaction: {
      id: 'tx-failed',
      type: 'external_outbound',
      status: 'FAILED',
      amount: '50000',
      currency: 'MXN',
      initiatedBy: OWNER_B,
      reversesTransactionId: null,
      payee: { id: 'payee-2', displayName: 'ACME', rail: 'rail-outbound' },
      createdAt: '2026-09-08T12:00:00.000Z',
      postedAt: null,
      failureReason: 'INSUFFICIENT_FUNDS',
    },
    legs: [],
    ...overrides,
  };
}

describe('projectEvent (pure projection: wire event -> stored read model)', () => {
  let projectEvent: ProjectEvent;

  beforeAll(() => {
    projectEvent = getProjectEvent();
  });

  it('maps a POSTED event: money strings -> bigint EXACT (> 2^53), distinct owners, payee, occurredAt Date', () => {
    const rm = projectEvent('evt-posted-1', 'transaction.posted', JSON.stringify(postedPayload()));

    // Identity + header fields carried through from stream fields + payload.
    expect(rm._id).toBe('evt-posted-1'); // _id = event_id (stream field), the dedup key
    expect(rm.transactionId).toBe('tx-posted');
    expect(rm.eventType).toBe('transaction.posted');
    expect(rm.type).toBe('external_outbound');
    expect(rm.status).toBe('POSTED');
    expect(rm.currency).toBe('MXN');
    expect(rm.initiatedBy).toBe(OWNER_A);
    expect(rm.reversesTransactionId).toBeNull();
    expect(rm.failureReason).toBeNull(); // A2 read-model field: null on a posted event

    // MONEY: exact bigint, past 2^53 verbatim. A number path would round HUGE down by 1.
    expect(typeof rm.amount).toBe('bigint');
    expect(rm.amount).toBe(9007199254740993n);
    for (const leg of rm.legs) {
      expect(typeof leg.delta).toBe('bigint');
      expect(typeof leg.balanceAfter).toBe('bigint');
    }
    const deltas = rm.legs.map((l: any) => l.delta);
    expect(deltas).toContain(9007199254740993n);
    expect(deltas).toContain(-9007199254740993n);
    // Double-entry preserved on the read side: SUM(delta) === 0n (bigint seed also
    // proves every delta is a bigint — mixing bigint + number throws).
    expect(rm.legs.reduce((a: bigint, l: any) => a + l.delta, 0n)).toBe(0n);

    // owners = DISTINCT non-null customer ownerIds across legs (system leg's null excluded).
    expect(new Set(rm.owners)).toEqual(new Set([OWNER_A]));
    expect(rm.owners).not.toContain(null);

    // payee mapped on its three specced fields.
    expect(rm.payee).not.toBeNull();
    expect(rm.payee.id).toBe('payee-1');
    expect(rm.payee.displayName).toBe('ACME');
    expect(rm.payee.rail).toBe('rail-outbound');

    // occurredAt: ISO string -> Date (same instant).
    expect(rm.occurredAt instanceof Date).toBe(true);
    expect(rm.occurredAt.getTime()).toBe(new Date('2026-09-08T12:00:00.000Z').getTime());
  });

  it('preserves reversesTransactionId and null payee on a reversal-style posted event', () => {
    const rm = projectEvent(
      'evt-reversal-1',
      'transaction.posted',
      JSON.stringify(
        postedPayload({
          transaction: {
            id: 'tx-reversal',
            type: 'internal',
            status: 'POSTED',
            amount: '30000',
            currency: 'MXN',
            initiatedBy: OWNER_A,
            reversesTransactionId: 'tx-original',
            payee: null,
            createdAt: '2026-09-08T12:00:00.000Z',
            postedAt: '2026-09-08T12:00:01.000Z',
            failureReason: null,
          },
        }),
      ),
    );
    expect(rm.reversesTransactionId).toBe('tx-original'); // link-only reversal
    expect(rm.payee).toBeNull();
    expect(rm.status).toBe('POSTED');
  });

  it('de-duplicates owners and drops nulls (two customer legs same owner + one distinct + a system leg)', () => {
    const rm = projectEvent(
      'evt-owners-1',
      'transaction.posted',
      JSON.stringify(
        postedPayload({
          legs: [
            {
              accountId: 'a1',
              ownerId: OWNER_A,
              accountKind: 'customer',
              systemKey: null,
              delta: '-100',
              balanceAfter: '0',
              currency: 'MXN',
            },
            {
              accountId: 'a2',
              ownerId: OWNER_A,
              accountKind: 'customer',
              systemKey: null,
              delta: '40',
              balanceAfter: '40',
              currency: 'MXN',
            },
            {
              accountId: 'a3',
              ownerId: OWNER_B,
              accountKind: 'customer',
              systemKey: null,
              delta: '60',
              balanceAfter: '60',
              currency: 'MXN',
            },
            {
              accountId: 'a4',
              ownerId: null,
              accountKind: 'system',
              systemKey: 'clearing:internal',
              delta: '0',
              balanceAfter: '5',
              currency: 'MXN',
            },
          ],
        }),
      ),
    );
    // DISTINCT set = {A, B}; the duplicate A collapses and the system leg's null is excluded.
    expect(new Set(rm.owners)).toEqual(new Set([OWNER_A, OWNER_B]));
    expect(rm.owners).toHaveLength(2);
    expect(rm.owners).not.toContain(null);
  });

  it('maps a FAILED event: status FAILED, EMPTY legs, failureReason = code, owners empty', () => {
    const rm = projectEvent('evt-failed-1', 'transaction.failed', JSON.stringify(failedPayload()));

    expect(rm.status).toBe('FAILED');
    expect(rm.eventType).toBe('transaction.failed');
    expect(rm.failureReason).toBe('INSUFFICIENT_FUNDS'); // the domain error code, for analytics
    expect(Array.isArray(rm.legs)).toBe(true);
    expect(rm.legs).toHaveLength(0); // no money moved -> no legs
    expect(rm.owners).toHaveLength(0); // no legs -> no owners
    // amount magnitude is still carried on the failed envelope.
    expect(typeof rm.amount).toBe('bigint');
    expect(rm.amount).toBe(50000n);
    // payee present on this external_outbound failure and mapped.
    expect(rm.payee).not.toBeNull();
    expect(rm.payee.id).toBe('payee-2');
  });

  it('maps a FAILED internal event with a null payee', () => {
    const rm = projectEvent(
      'evt-failed-2',
      'transaction.failed',
      JSON.stringify(
        failedPayload({
          transaction: {
            id: 'tx-failed-internal',
            type: 'internal',
            status: 'FAILED',
            amount: '25000',
            currency: 'MXN',
            initiatedBy: OWNER_A,
            reversesTransactionId: null,
            payee: null,
            createdAt: '2026-09-08T12:00:00.000Z',
            postedAt: null,
            failureReason: 'ACCOUNT_FROZEN',
          },
        }),
      ),
    );
    expect(rm.status).toBe('FAILED');
    expect(rm.payee).toBeNull();
    expect(rm.failureReason).toBe('ACCOUNT_FROZEN');
    expect(rm.legs).toHaveLength(0);
  });

  it('THROWS on invalid JSON — never returns a partial/garbage document', () => {
    expect(() => projectEvent('evt-bad-1', 'transaction.posted', '{not valid json')).toThrow();
  });

  it('THROWS on a structurally-malformed payload (missing `transaction`)', () => {
    const bad = JSON.stringify({
      schemaVersion: 1,
      occurredAt: '2026-09-08T12:00:00.000Z',
      legs: [],
    });
    expect(() => projectEvent('evt-bad-2', 'transaction.posted', bad)).toThrow();
  });

  it('THROWS on NON-string money (amount as a JSON number) — must reject, never silently coerce', () => {
    // A bare JSON number past 2^53 is ALREADY rounded by JSON.parse (9007199254740993
    // -> 9007199254740992), so accepting it would corrupt money. The wire contract is
    // money-as-string; the projection must reject a numeric amount rather than coerce it.
    const bad =
      '{"schemaVersion":1,"occurredAt":"2026-09-08T12:00:00.000Z","transaction":' +
      '{"id":"tx","type":"internal","status":"POSTED","amount":9007199254740993,' +
      '"currency":"MXN","initiatedBy":"sub","reversesTransactionId":null,"payee":null,' +
      '"createdAt":"2026-09-08T12:00:00.000Z","postedAt":"2026-09-08T12:00:01.000Z",' +
      '"failureReason":null},"legs":[]}';
    expect(() => projectEvent('evt-bad-3', 'transaction.posted', bad)).toThrow();
  });

  it('THROWS on NON-string leg money (delta as a JSON number)', () => {
    const bad =
      '{"schemaVersion":1,"occurredAt":"2026-09-08T12:00:00.000Z","transaction":' +
      '{"id":"tx","type":"internal","status":"POSTED","amount":"100","currency":"MXN",' +
      '"initiatedBy":"sub","reversesTransactionId":null,"payee":null,' +
      '"createdAt":"2026-09-08T12:00:00.000Z","postedAt":"2026-09-08T12:00:01.000Z",' +
      '"failureReason":null},"legs":[{"accountId":"a1","ownerId":"sub",' +
      '"accountKind":"customer","systemKey":null,"delta":-100,"balanceAfter":"0",' +
      '"currency":"MXN"}]}';
    expect(() => projectEvent('evt-bad-4', 'transaction.posted', bad)).toThrow();
  });
});
