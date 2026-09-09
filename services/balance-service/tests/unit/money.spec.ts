/**
 * Spec 04 — Balance Service DOMAIN layer, Step 1: the pure available-balance helper.
 *
 * Contract (spec 04 "Available balance is derived: available = balance − held" + the
 * Step-1 coordination contract): `availableBalance(balance, held)` returns
 * `(BigInt(balance) - BigInt(held)).toString()`. Money is bigint MINOR UNITS carried
 * as decimal STRINGS, so the derivation MUST use BigInt math — a Number-based
 * implementation silently loses precision beyond 2^53 and would move money wrong.
 *
 * This suite is a pure unit test (NO Postgres, NO Nest) and therefore runs in the
 * DEFAULT `npm test` run — it is never skipped. The helper is imported through the
 * single seam (tests/support/harness.ts); every assertion below fails on a real defect
 * (wrong arithmetic, Number-based rounding, or a non-string return).
 */
import { getAvailableBalance } from '../support/harness';

const availableBalance = getAvailableBalance();

describe('availableBalance(balance, held) — derived available (pure, no DB)', () => {
  it('held = 0 => available equals balance exactly', () => {
    expect(availableBalance('7500', '0')).toBe('7500');
  });

  it('held > 0 => available = balance - held', () => {
    expect(availableBalance('5000', '2000')).toBe('3000');
  });

  it('held = balance => available = "0"', () => {
    expect(availableBalance('4000', '4000')).toBe('0');
  });

  it('uses BigInt (not Number) math: exact subtraction near the max bigint (> 2^53)', () => {
    // 2^63 - 1 is the largest Postgres bigint. Number('9223372036854775807') rounds to
    // 9223372036854775808 (2^63), so a Number-based helper would return
    // '9223372036854775808' (or a further-rounded value) — never the exact answer.
    expect(availableBalance('9223372036854775807', '1')).toBe('9223372036854775806');
  });

  it('does not lose the balance itself when it exceeds 2^53 and held = 0', () => {
    // Number('9007199254740993') === 9007199254740992 (silent 1-unit rounding); only
    // BigInt preserves the odd value. A wrong parse here means money reads short by 1.
    expect(availableBalance('9007199254740993', '0')).toBe('9007199254740993');
  });

  it('exact difference of two values both beyond 2^53', () => {
    // Both operands round to the SAME double, so a Number-based helper yields '0';
    // the true difference is 9.
    expect(availableBalance('90071992547409910', '90071992547409901')).toBe('9');
  });
});
