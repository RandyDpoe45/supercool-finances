/**
 * Spec 05, step A3 — the two `/admin/reports` WHITELIST serializers
 * (`serializeAccountSummary` / `serializeDailyAggregate`). Written from the CONTRACT
 * OF RECORD (specs/DATA-MODEL.md Part 2 "query-time views" + the A3 DTO shapes), NOT
 * from the implementor's code — each test must be able to FAIL on a real defect.
 *
 * The money-safety crux (CLAUDE.md "Layering & serialization"): money is int64 minor
 * units and MUST cross the wire as a decimal STRING, exact past 2^53 — never a JS
 * `number` (which would round a value above 2^53) and never a raw `bigint` (not JSON
 * serializable, and a client that JSON.parses a bare number would already have lost
 * precision). Dates serialize to ISO strings; counts stay numbers. And the serializer
 * is a WHITELIST: an internal field on the domain object (owners, _id, a Mongo Long,
 * an injected secret) must NEVER appear on the wire — a leaked field is a security
 * defect, so the output key set is asserted EXACTLY.
 *
 * Pure functions (no Nest/Mongo), so this runs in the default `npm test` gate.
 */
import { getReportingSerializers } from '../support/harness';

// 2^53 + 1 — the smallest positive integer NOT representable as a float64 double, and
// int64 max — the top of the range. If money were ever floated (or Number()-ed) these
// change; asserting the exact decimal string proves the serializer kept them as int64.
const HUGE = 9_007_199_254_740_993n; // 2^53 + 1
const HUGE_STR = '9007199254740993';
const MAX_I64 = 9_223_372_036_854_775_807n;
const MAX_I64_STR = '9223372036854775807';

/** A complete DOMAIN account-summary (money as bigint, lastActivityAt as a Date) with
 *  EXTRA internal fields the whitelist must drop. */
function domainAccountSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accountId: 'acct-1',
    ownerId: 'sub-alice',
    accountKind: 'customer',
    systemKey: null,
    currency: 'MXN',
    lastBalanceAfter: HUGE, // > 2^53
    txnCount: 42,
    totalDebited: MAX_I64, // top of int64
    totalCredited: 1_350_000n,
    lastActivityAt: new Date('2026-09-08T12:00:00.000Z'),
    // --- fields that MUST NOT leak (not in the DTO whitelist) ---
    owners: ['sub-alice', 'sub-bob'],
    _id: 'internal-mongo-id',
    __v: 0,
    internalSecret: 'do-not-leak',
    ...overrides,
  };
}

/** A complete DOMAIN daily-aggregate (date already a `YYYY-MM-DD` string from the
 *  pipeline's $dateToString; totalAmount as bigint) with EXTRA fields to drop. */
function domainDailyAggregate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date: '2026-09-08',
    currency: 'MXN',
    type: 'external_outbound',
    count: 17,
    totalAmount: HUGE, // > 2^53
    // --- must not leak ---
    _id: { date: '2026-09-08', currency: 'MXN', type: 'external_outbound' },
    owners: ['sub-alice'],
    rawTotal: 830000,
    ...overrides,
  };
}

const ACCOUNT_SUMMARY_KEYS = [
  'accountId',
  'ownerId',
  'accountKind',
  'systemKey',
  'currency',
  'lastBalanceAfter',
  'txnCount',
  'totalDebited',
  'totalCredited',
  'lastActivityAt',
].sort();

const DAILY_AGGREGATE_KEYS = ['date', 'currency', 'type', 'count', 'totalAmount'].sort();

describe('serializeAccountSummary (whitelist DTO serializer)', () => {
  let serializeAccountSummary: (s: any) => any;

  beforeAll(() => {
    ({ serializeAccountSummary } = getReportingSerializers());
  });

  it('emits money as EXACT decimal STRINGS (bigint -> string, > 2^53 verbatim), never a JS number', () => {
    const out = serializeAccountSummary(domainAccountSummary());

    // The three money fields are STRINGS, exact, past 2^53.
    expect(typeof out.lastBalanceAfter).toBe('string');
    expect(out.lastBalanceAfter).toBe(HUGE_STR);
    expect(typeof out.totalDebited).toBe('string');
    expect(out.totalDebited).toBe(MAX_I64_STR);
    expect(typeof out.totalCredited).toBe('string');
    expect(out.totalCredited).toBe('1350000');

    // A bigint MUST NOT be coerced to a JS number: number(9007199254740993) === 9007199254740992.
    expect(typeof out.lastBalanceAfter).not.toBe('number');
    // Re-parsing the string as a bigint round-trips EXACTLY (a floated value would not).
    expect(BigInt(out.lastBalanceAfter)).toBe(HUGE);
    expect(BigInt(out.totalDebited)).toBe(MAX_I64);
  });

  it('serializes lastActivityAt to an ISO string, keeps txnCount a number, passes scalars through', () => {
    const out = serializeAccountSummary(domainAccountSummary());

    expect(typeof out.lastActivityAt).toBe('string');
    expect(out.lastActivityAt).toBe('2026-09-08T12:00:00.000Z');
    expect(new Date(out.lastActivityAt).getTime()).toBe(
      new Date('2026-09-08T12:00:00.000Z').getTime(),
    );

    expect(typeof out.txnCount).toBe('number');
    expect(out.txnCount).toBe(42);
    expect(out.accountId).toBe('acct-1');
    expect(out.ownerId).toBe('sub-alice');
    expect(out.accountKind).toBe('customer');
    expect(out.currency).toBe('MXN');
  });

  it('carries a null systemKey / null ownerId faithfully (system-account row)', () => {
    const out = serializeAccountSummary(
      domainAccountSummary({
        ownerId: null,
        accountKind: 'system',
        systemKey: 'clearing:rail-outbound',
      }),
    );
    expect(out.ownerId).toBeNull();
    expect(out.systemKey).toBe('clearing:rail-outbound');
    expect(out.accountKind).toBe('system');
  });

  it('WHITELIST: outputs EXACTLY the DTO fields — never leaks owners/_id/__v/secrets', () => {
    const out = serializeAccountSummary(domainAccountSummary());

    expect(Object.keys(out).sort()).toEqual(ACCOUNT_SUMMARY_KEYS);
    // Explicit negatives (belt-and-braces): none of the internal fields survive.
    expect('owners' in out).toBe(false);
    expect('_id' in out).toBe(false);
    expect('__v' in out).toBe(false);
    expect('internalSecret' in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain('do-not-leak');
  });
});

describe('serializeDailyAggregate (whitelist DTO serializer)', () => {
  let serializeDailyAggregate: (a: any) => any;

  beforeAll(() => {
    ({ serializeDailyAggregate } = getReportingSerializers());
  });

  it('emits totalAmount as an EXACT decimal STRING (> 2^53 verbatim), count a number', () => {
    const out = serializeDailyAggregate(domainDailyAggregate());

    expect(typeof out.totalAmount).toBe('string');
    expect(out.totalAmount).toBe(HUGE_STR);
    expect(typeof out.totalAmount).not.toBe('number');
    expect(BigInt(out.totalAmount)).toBe(HUGE); // exact round-trip

    expect(typeof out.count).toBe('number');
    expect(out.count).toBe(17);
  });

  it('passes date / currency / type through as-is (date stays YYYY-MM-DD)', () => {
    const out = serializeDailyAggregate(domainDailyAggregate());
    expect(out.date).toBe('2026-09-08');
    expect(out.currency).toBe('MXN');
    expect(out.type).toBe('external_outbound');
  });

  it('WHITELIST: outputs EXACTLY the DTO fields — never leaks _id/owners/raw internals', () => {
    const out = serializeDailyAggregate(domainDailyAggregate());

    expect(Object.keys(out).sort()).toEqual(DAILY_AGGREGATE_KEYS);
    expect('_id' in out).toBe(false);
    expect('owners' in out).toBe(false);
    expect('rawTotal' in out).toBe(false);
  });
});
