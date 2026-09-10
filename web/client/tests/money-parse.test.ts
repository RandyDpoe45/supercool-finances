import { describe, expect, it } from 'vitest';
import {
  AmountParseError,
  amountDirection,
  parseAmountToMinor,
  safeParseAmountToMinor,
  toDecimalString,
} from '../src/lib/money';

/**
 * `parseAmountToMinor` is the money-safety crux of the transfer form: a human types a MAJOR-unit
 * amount and we must produce the EXACT canonical minor-unit integer string the wire carries, with
 * BigInt/string math only. Every expected value here is HAND-COMPUTED (never taken from the helper's
 * own output — that would be tautological). The defects these catch: a `Number`/`parseFloat`/`toFixed`
 * path that loses precision above 2^53 or rounds; a silent truncation of over-precise input
 * (`'1.005'` → `100`/`101`); a coercion of malformed input instead of a LOUD typed rejection; and an
 * int64 overflow slipping through to the server. It NEVER rounds or coerces.
 */

describe('parseAmountToMinor — exact major→minor conversion (float-free)', () => {
  it.each([
    ['1', '100'],
    ['150', '15000'],
    ['150.5', '15050'],
    ['150.50', '15050'],
    ['0.05', '5'],
    ['0.5', '50'],
    ['0.01', '1'],
    ['1000000', '100000000'],
    // Whitespace around a valid number is trimmed, not rejected.
    ['  100  ', '10000'],
  ])('converts %j → %j (MXN, exponent 2)', (input, expected) => {
    expect(parseAmountToMinor(input, 'MXN')).toBe(expected);
  });

  it('keeps every digit for a value an order of magnitude past 2^53 (the precision proof)', () => {
    // 900,719,925,474,099.10 → 90071992547409910 minor units, ~10× above Number.MAX_SAFE_INTEGER.
    // A Number-based parse would corrupt the low digits; BigInt/string math keeps them exact.
    expect(parseAmountToMinor('900719925474099.10', 'MXN')).toBe('90071992547409910');
  });

  it('accepts EXACTLY the int64-max minor value and rejects one centavo above it', () => {
    // int64 max = 9_223_372_036_854_775_807 minor units = 92,233,720,368,547,758.07 major.
    expect(parseAmountToMinor('92233720368547758.07', 'MXN')).toBe('9223372036854775807');
    // One centavo more overflows int64 → LOUD rejection, never a wrap or coerce.
    expect(() => parseAmountToMinor('92233720368547758.08', 'MXN')).toThrow(AmountParseError);
    expect(safeParseAmountToMinor('92233720368547758.08', 'MXN')).toMatchObject({
      ok: false,
      error: { kind: 'too-large' },
    });
  });
});

describe('parseAmountToMinor — rejects over-precision WITHOUT rounding (money defect)', () => {
  it('rejects a 3-decimal MXN amount instead of truncating to 100 or rounding to 101', () => {
    expect(() => parseAmountToMinor('1.005', 'MXN')).toThrow(AmountParseError);
    const result = safeParseAmountToMinor('1.005', 'MXN');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('too-many-fraction-digits');
    }
    // The exact money-safety failure mode: the parser must NOT silently produce 100 or 101.
    expect(result).not.toMatchObject({ ok: true });
  });
});

describe('parseAmountToMinor — LOUD typed rejections (never a silent coerce)', () => {
  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['-5', 'negative'],
    ['0', 'zero'],
    ['0.0', 'zero'],
    ['0.00', 'zero'],
    ['abc', 'not-a-number'],
    ['1,000', 'not-a-number'],
    ['.5', 'not-a-number'],
    ['1e5', 'not-a-number'],
    ['1.2.3', 'not-a-number'],
    ['+5', 'not-a-number'],
    ['0x10', 'not-a-number'],
    ['99999999999999999999', 'too-large'],
    ['1234567890123456789012345678901', 'too-large'],
  ] as const)('rejects %j as %s', (input, kind) => {
    expect(() => parseAmountToMinor(input, 'MXN')).toThrow(AmountParseError);
    let thrownKind: string | undefined;
    try {
      parseAmountToMinor(input, 'MXN');
    } catch (error) {
      thrownKind = error instanceof AmountParseError ? error.kind : 'WRONG-TYPE';
    }
    expect(thrownKind).toBe(kind);
  });

  it('carries a human message on every rejection', () => {
    const result = safeParseAmountToMinor('-1', 'MXN');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(AmountParseError);
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });
});

describe('safeParseAmountToMinor — non-throwing wrapper for the live form', () => {
  it('returns the exact minor string on success without throwing', () => {
    expect(safeParseAmountToMinor('150.50', 'MXN')).toEqual({ ok: true, minor: '15050' });
  });

  it('returns the typed error (never throws) on a bad amount', () => {
    const result = safeParseAmountToMinor('nope', 'MXN');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('not-a-number');
    }
  });
});

/**
 * The BigInt-coercion hardening on the DISPLAY helpers: `BigInt('')`/`BigInt(' ')` → 0n,
 * `BigInt('0x10')` → 16n, `BigInt('+5')` → 5n. Without the explicit canonical-integer guard those
 * would render a WRONG amount silently (a money defect). The guard must make them throw LOUDLY
 * instead — and, critically, never return the coerced value.
 */
describe('toDecimalString / amountDirection — reject BigInt-coercible junk LOUDLY', () => {
  const junk = ['', ' ', '0x10', '+5'];

  it.each(junk)('toDecimalString throws on %j and never returns a coerced amount', (input) => {
    expect(() => toDecimalString(input, 2)).toThrow();
    let out: string | undefined;
    try {
      out = toDecimalString(input, 2);
    } catch {
      out = undefined;
    }
    // These are the exact silent values the guard prevents: 0.00 (from ''/' '), 0.16 (0x10), 0.05 (+5).
    expect(out).toBeUndefined();
  });

  it.each(junk)('amountDirection throws on %j and never returns a coerced direction', (input) => {
    expect(() => amountDirection(input)).toThrow();
    let out: string | undefined;
    try {
      out = amountDirection(input);
    } catch {
      out = undefined;
    }
    expect(out).toBeUndefined();
  });
});
