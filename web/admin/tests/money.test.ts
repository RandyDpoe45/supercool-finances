import { describe, expect, it } from 'vitest';
import {
  amountDirection,
  formatAmount,
  formatMoney,
  isUnsignedMinorUnits,
  minorUnitDigits,
  toDecimalString,
} from '../src/lib/money';

/**
 * Money handling is the money-safety crux of the admin account-management screens: the wire carries
 * balances / holds / caps as canonical minor-unit INTEGER strings (int64 precision) and the UI must
 * render — and the limits form must validate — them WITHOUT ever touching a float. Every expected
 * value here is HAND-COMPUTED (never taken from the helper's own output — that would be
 * tautological), so a `Number`/`parseFloat`-based implementation, a grouping bug, a silent `NaN`, or
 * a validator that accepts a corrupting input all fail here.
 */

describe('toDecimalString (float-free major/minor split)', () => {
  it('formats a value far beyond 2^53 EXACTLY (the float-precision proof)', () => {
    // 90071992547409910 is ~10x above Number.MAX_SAFE_INTEGER (9007199254740991), so a
    // Number-based split would corrupt the low digits. BigInt math keeps every digit.
    expect(toDecimalString('90071992547409910', 2)).toBe('900719925474099.10');
  });

  it('pads a sub-unit value into the fractional part (no leading major digit lost)', () => {
    expect(toDecimalString('5', 2)).toBe('0.05');
    expect(toDecimalString('50', 2)).toBe('0.50');
  });

  it('renders zero at the currency exponent', () => {
    expect(toDecimalString('0', 2)).toBe('0.00');
  });

  it('carries the sign for a negative amount', () => {
    expect(toDecimalString('-1500000', 2)).toBe('-15000.00');
    expect(toDecimalString('-5', 2)).toBe('-0.05');
  });

  it('emits no decimal point for a zero-exponent (0-decimal) currency', () => {
    expect(toDecimalString('1234', 0)).toBe('1234');
    expect(toDecimalString('-1234', 0)).toBe('-1234');
  });

  it('throws on non-integer / malformed input instead of yielding NaN', () => {
    expect(() => toDecimalString('12.5', 2)).toThrow();
    expect(() => toDecimalString('1e5', 2)).toThrow();
    expect(() => toDecimalString('abc', 2)).toThrow();
    // Guard against the failure mode we actually fear: a silent NaN string reaching the UI.
    let out: string | undefined;
    try {
      out = toDecimalString('12.5', 2);
    } catch {
      out = undefined;
    }
    expect(out).toBeUndefined();
  });
});

describe('formatAmount (grouped human amount, no currency code)', () => {
  it('groups thousands and keeps a huge balance exact past the float ceiling', () => {
    expect(formatAmount('90071992547409910', 'MXN')).toBe('900,719,925,474,099.10');
  });

  it('groups exactly at the thousands boundaries', () => {
    expect(formatAmount('99999', 'MXN')).toBe('999.99'); // 999.99 — no grouping comma yet
    expect(formatAmount('100000', 'MXN')).toBe('1,000.00'); // first comma appears
    expect(formatAmount('100000000', 'MXN')).toBe('1,000,000.00'); // two groups
  });

  it('formats the seeded account/cap balances used by the tables (hand-computed)', () => {
    // These are the exact fixture values the accounts + limits tables must render.
    expect(formatAmount('1500000', 'MXN')).toBe('15,000.00'); // account balance
    expect(formatAmount('250075', 'MXN')).toBe('2,500.75'); // balance with sub-unit
    expect(formatAmount('5000', 'MXN')).toBe('50.00'); // held
    expect(formatAmount('245075', 'MXN')).toBe('2,450.75'); // available
    expect(formatAmount('5000000', 'MXN')).toBe('50,000.00'); // global per-tx cap
    expect(formatAmount('0', 'MXN')).toBe('0.00');
  });

  it('throws rather than rendering NaN for malformed input', () => {
    expect(() => formatAmount('12.5', 'MXN')).toThrow();
    expect(() => formatAmount('abc', 'MXN')).toThrow();
  });
});

describe('formatMoney (amount + ISO code)', () => {
  it('appends the ISO currency code to the grouped amount', () => {
    expect(formatMoney('245075', 'MXN')).toBe('2,450.75 MXN');
    expect(formatMoney('5000000', 'MXN')).toBe('50,000.00 MXN');
  });
});

describe('minorUnitDigits', () => {
  it('reports MXN as 2 and defaults unknown currencies to 2', () => {
    expect(minorUnitDigits('MXN')).toBe(2);
    expect(minorUnitDigits('XYZ')).toBe(2);
  });
});

describe('amountDirection (sign of a signed delta)', () => {
  it('classifies in / out / zero, including values past the float ceiling', () => {
    expect(amountDirection('150000')).toBe('in');
    expect(amountDirection('-50000')).toBe('out');
    expect(amountDirection('0')).toBe('zero');
    expect(amountDirection('90071992547409910')).toBe('in');
    expect(amountDirection('-90071992547409910')).toBe('out');
  });
});

/**
 * The limits form gates every cap through `isUnsignedMinorUnits` before it can be submitted. This is
 * a money-VALUED authorization input (the cap that later bounds a transfer), so a validator that let
 * a negative, fractional, or overflowing value through, or that used `Number` and lost precision at
 * int64 scale, would be a money-safety defect. Boundaries are asserted exactly.
 */
describe('isUnsignedMinorUnits (float-free cap validator)', () => {
  it('ACCEPTS canonical unsigned integer digit strings, including past the float ceiling', () => {
    expect(isUnsignedMinorUnits('0')).toBe(true);
    expect(isUnsignedMinorUnits('5')).toBe(true);
    expect(isUnsignedMinorUnits('150000')).toBe(true);
    // ~10x above Number.MAX_SAFE_INTEGER — a Number-based check would corrupt this.
    expect(isUnsignedMinorUnits('90071992547409910')).toBe(true);
  });

  it('ACCEPTS exactly the int64 max and REJECTS one above it (the overflow boundary)', () => {
    expect(isUnsignedMinorUnits('9223372036854775807')).toBe(true); // int64 max
    expect(isUnsignedMinorUnits('9223372036854775808')).toBe(false); // max + 1 → overflow
  });

  it('REJECTS negative amounts (a cap is unsigned)', () => {
    expect(isUnsignedMinorUnits('-1')).toBe(false);
    expect(isUnsignedMinorUnits('-150000')).toBe(false);
  });

  it('REJECTS decimals / floats (caps are whole minor units, never a major-unit decimal)', () => {
    expect(isUnsignedMinorUnits('12.5')).toBe(false);
    expect(isUnsignedMinorUnits('1500.00')).toBe(false);
    expect(isUnsignedMinorUnits('1e5')).toBe(false);
  });

  it('REJECTS empty, whitespace, grouped, signed, and non-digit strings (no lenient BigInt coercion)', () => {
    expect(isUnsignedMinorUnits('')).toBe(false);
    expect(isUnsignedMinorUnits(' ')).toBe(false);
    expect(isUnsignedMinorUnits(' 5')).toBe(false);
    expect(isUnsignedMinorUnits('5 ')).toBe(false);
    expect(isUnsignedMinorUnits('1,000')).toBe(false); // grouping is a display concern only
    expect(isUnsignedMinorUnits('+5')).toBe(false);
    expect(isUnsignedMinorUnits('0x10')).toBe(false);
    expect(isUnsignedMinorUnits('abc')).toBe(false);
  });
});
