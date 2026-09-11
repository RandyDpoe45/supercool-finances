import { describe, expect, it } from 'vitest';
import { currencyMinorUnitScale, formatMinorUnits } from '../src/lib/money';

/**
 * Money formatting is a CORRECTNESS surface, not a cosmetic one: amounts arrive as canonical
 * bigint minor-unit strings (MXN centavos) and must be rendered WITHOUT ever going through a
 * float, or a large balance loses precision silently. Every expected string below is
 * hand-computed from the input + the es-MX/MXN locale rule (never taken from the helper's own
 * output), so a regression that flips to a float path, mis-groups, or drops a fraction digit
 * fails here.
 */
describe('formatMinorUnits — float-free localized currency (es-MX / MXN, scale 2)', () => {
  it('formats a whole peso amount with grouping and two fraction digits', () => {
    // 125000 centavos = 1250.00 pesos.
    expect(formatMinorUnits('125000', 'MXN')).toBe('$1,250.00');
  });

  it('renders zero as $0.00 (no minor units, no stray sign)', () => {
    expect(formatMinorUnits('0', 'MXN')).toBe('$0.00');
  });

  it('formats a sub-unit amount into the fraction, zero-padded (no leading major digit lost)', () => {
    // 5 centavos = $0.05 — the whole-part is 0 and the fraction is padded to the scale.
    expect(formatMinorUnits('5', 'MXN')).toBe('$0.05');
    expect(formatMinorUnits('50', 'MXN')).toBe('$0.50');
  });

  it('groups thousands / millions correctly across the whole part', () => {
    // 123456789 centavos = 1,234,567.89 pesos.
    expect(formatMinorUnits('123456789', 'MXN')).toBe('$1,234,567.89');
  });

  it('places the negative sign per the locale template', () => {
    expect(formatMinorUnits('-125000', 'MXN')).toBe('-$1,250.00');
  });

  it('renders negative zero as a positive $0.00 (no misleading minus on a zero amount)', () => {
    expect(formatMinorUnits('-0', 'MXN')).toBe('$0.00');
  });

  it('preserves EXACT precision for a value beyond 2^53 (the float-loss defect gate)', () => {
    // 9007199254740993 = 2^53 + 1 — NOT representable as a JS number:
    //   Number('9007199254740993') === 9007199254740992 (rounds down, losing the +1).
    // With scale 2: 9007199254740993 / 100 => whole 90071992547409, fraction 93.
    // A float path would render `.92` (from ...992). BigInt math must render `.93`.
    expect(formatMinorUnits('9007199254740993', 'MXN')).toBe('$90,071,992,547,409.93');
  });

  it('handles an arbitrarily large integer (BigInt has no width ceiling)', () => {
    // 123456789012345678901234 centavos: whole 1234567890123456789012, fraction 34.
    expect(formatMinorUnits('123456789012345678901234', 'MXN')).toBe(
      '$1,234,567,890,123,456,789,012.34',
    );
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(formatMinorUnits('  125000  ', 'MXN')).toBe('$1,250.00');
  });

  it('throws on non-integer / malformed input rather than rendering garbage', () => {
    // A decimal point is NOT a minor-unit integer string.
    expect(() => formatMinorUnits('12.50', 'MXN')).toThrow();
    expect(() => formatMinorUnits('abc', 'MXN')).toThrow();
    expect(() => formatMinorUnits('12a', 'MXN')).toThrow();
    expect(() => formatMinorUnits('', 'MXN')).toThrow();
    // A lone sign with no digits is not an integer either.
    expect(() => formatMinorUnits('-', 'MXN')).toThrow();
  });
});

describe('currencyMinorUnitScale', () => {
  it('reports 2 for the seeded MXN currency', () => {
    expect(currencyMinorUnitScale('MXN')).toBe(2);
  });

  it('defaults an unseeded code to 2 rather than throwing (a wrong render beats a crashed feed)', () => {
    expect(currencyMinorUnitScale('USD')).toBe(2);
    expect(currencyMinorUnitScale('ZZZ')).toBe(2);
  });
});
