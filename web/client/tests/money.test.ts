import { describe, expect, it } from 'vitest';
import {
  amountDirection,
  formatAmount,
  formatMoney,
  minorUnitDigits,
  toDecimalString,
} from '../src/lib/money';

/**
 * Money formatting is the money-safety crux of F2: the wire carries amounts as canonical
 * minor-unit INTEGER strings (int64 precision) and the UI must render them WITHOUT ever
 * touching a float. Every expected value here is HAND-COMPUTED (never taken from the
 * helper's own output — that would be tautological), so a `Number`/`parseFloat`-based
 * implementation, a grouping bug, or a silent `NaN` on bad input all fail here.
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

  it('formats sub-unit, zero and signed amounts', () => {
    expect(formatAmount('5', 'MXN')).toBe('0.05');
    expect(formatAmount('0', 'MXN')).toBe('0.00');
    expect(formatAmount('-1500000', 'MXN')).toBe('-15,000.00');
    expect(formatAmount('-600000', 'MXN')).toBe('-6,000.00');
  });

  it('throws rather than rendering NaN for malformed input', () => {
    expect(() => formatAmount('12.5', 'MXN')).toThrow();
    expect(() => formatAmount('abc', 'MXN')).toThrow();
  });
});

describe('formatMoney (amount + ISO code)', () => {
  it('appends the ISO currency code to the grouped amount', () => {
    expect(formatMoney('-1500000', 'MXN')).toBe('-15,000.00 MXN');
    expect(formatMoney('245075', 'MXN')).toBe('2,450.75 MXN');
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
