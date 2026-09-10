/**
 * Spec 04 — Balance Service DOMAIN layer, Step 1: the controller-boundary serializers.
 *
 * Convention under test (Step-1 layering refactor): services work in ENTITIES; the
 * controller serializes to DTOs via EXPLICIT WHITELIST functions. This suite pins the
 * two whitelists purely (NO DB, NO Nest) so it runs in the DEFAULT `npm test` and is
 * never skipped. The serializers are imported through the single seam
 * (tests/support/harness.ts:getAccountSerializers).
 *
 * The point of this test is anti-leak: a serializer that spreads the entity (or adds a
 * field) would expose internal state — owner_id, the per-period spend counters/markers,
 * system_key, timestamps — to the customer. Feeding a FULL entity-shaped object and
 * asserting the DTO carries EXACTLY the contract keys (and none of the sensitive ones)
 * fails on exactly that defect. It also re-proves the money invariants at the boundary:
 * available = balance − held via BigInt (no float loss past 2^53), and a Date rendered
 * as an ISO-8601 string.
 */
import { getAccountSerializers } from '../support/harness';

const { serializeAccount, serializeStatementEntry } = getAccountSerializers();

const ACCOUNT_DTO_KEYS = [
  'available',
  'balance',
  'currency',
  'held',
  'id',
  'kind',
  'status',
  // Confirmation-of-payee follow-up: the human account number is a deliberate, whitelisted field.
  'accountNumber',
];
const ENTRY_DTO_KEYS = ['balanceAfter', 'createdAt', 'currency', 'delta', 'id', 'transactionId'];

// Fields that live on the Account entity but MUST NOT reach a customer-facing DTO.
const ACCOUNT_SENSITIVE = [
  'ownerId',
  'systemKey',
  'spentToday',
  'spentTodayDate',
  'spentMonth',
  'spentMonthDate',
  'createdAt',
  'updatedAt',
];

/** A full Account-shaped fixture (entity property names, bigint money as strings). */
function fullAccount(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'acc-11111111-1111-1111-1111-111111111111',
    ownerId: 'sub-SECRET-owner-do-not-leak',
    kind: 'customer',
    systemKey: null,
    accountNumber: '1234567890',
    currency: 'MXN',
    status: 'active',
    balance: '5000',
    held: '2000',
    spentToday: '4242',
    spentTodayDate: '2026-09-09',
    spentMonth: '999999',
    spentMonthDate: '2026-09-01',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-02-02T03:04:05.000Z'),
    ...overrides,
  };
}

describe('serializeAccount — entity -> AccountDto whitelist (pure, no DB)', () => {
  it('emits EXACTLY the whitelisted keys and leaks no internal fields', () => {
    const dto = serializeAccount(fullAccount());

    expect(Object.keys(dto).sort()).toEqual([...ACCOUNT_DTO_KEYS].sort());
    // Explicitly name the sensitive fields the customer must never see: none may appear.
    const leaked = ACCOUNT_SENSITIVE.filter((k) => k in dto);
    expect(leaked).toEqual([]);
  });

  it('passes through the whitelisted values unchanged', () => {
    const dto = serializeAccount(
      fullAccount({ id: 'acc-abc', currency: 'MXN', status: 'frozen', kind: 'customer' }),
    );
    expect(dto.id).toBe('acc-abc');
    expect(dto.currency).toBe('MXN');
    expect(dto.status).toBe('frozen'); // status is passed through, not filtered
    expect(dto.kind).toBe('customer');
    expect(dto.balance).toBe('5000');
    expect(dto.held).toBe('2000');
    expect(dto.accountNumber).toBe('1234567890'); // the human number is passed through verbatim
    expect(typeof dto.balance).toBe('string');
    expect(typeof dto.available).toBe('string');
  });

  it('passes a null accountNumber through unchanged (system/unassigned accounts)', () => {
    const dto = serializeAccount(fullAccount({ accountNumber: null }));
    expect(dto.accountNumber).toBeNull();
    // The whitelist is exact even when the number is null — the key is present, not dropped.
    expect(Object.keys(dto).sort()).toEqual([...ACCOUNT_DTO_KEYS].sort());
  });

  it('derives available = balance − held with BigInt math (no float loss near 2^63)', () => {
    // 2^63 - 1: Number() would round it to 2^63 and the subtraction would be wrong.
    const dto = serializeAccount(fullAccount({ balance: '9223372036854775807', held: '1' }));
    expect(dto.available).toBe('9223372036854775806');
  });

  it('handles the held edges: held = 0 (available = balance) and held = balance (available = 0)', () => {
    expect(serializeAccount(fullAccount({ balance: '7500', held: '0' })).available).toBe('7500');
    expect(serializeAccount(fullAccount({ balance: '4000', held: '4000' })).available).toBe('0');
  });
});

describe('serializeStatementEntry — entity -> StatementEntryDto whitelist (pure, no DB)', () => {
  /** A full LedgerEntry-shaped fixture (entity property names). */
  function fullEntry(overrides: Record<string, unknown> = {}): any {
    return {
      id: 'led-22222222-2222-2222-2222-222222222222',
      transactionId: 'tx-33333333-3333-3333-3333-333333333333',
      accountId: 'acc-SECRET-account-do-not-leak',
      delta: '-200',
      balanceAfter: '9007199254740993', // > 2^53: must survive as an exact string
      currency: 'MXN',
      createdAt: new Date('2026-03-03T12:34:56.000Z'),
      ...overrides,
    };
  }

  it('emits EXACTLY the whitelisted keys and does not leak accountId', () => {
    const dto = serializeStatementEntry(fullEntry());
    expect(Object.keys(dto).sort()).toEqual([...ENTRY_DTO_KEYS].sort());
    expect('accountId' in dto).toBe(false);
  });

  it('passes delta and balance_after through as exact strings (no Number rounding)', () => {
    const dto = serializeStatementEntry(fullEntry());
    expect(dto.id).toBe('led-22222222-2222-2222-2222-222222222222');
    expect(dto.transactionId).toBe('tx-33333333-3333-3333-3333-333333333333');
    expect(dto.delta).toBe('-200');
    expect(dto.balanceAfter).toBe('9007199254740993');
    expect(dto.currency).toBe('MXN');
  });

  it('renders a Date createdAt as its ISO-8601 string', () => {
    const dto = serializeStatementEntry(fullEntry());
    expect(typeof dto.createdAt).toBe('string');
    expect(dto.createdAt).toBe('2026-03-03T12:34:56.000Z');
  });
});
