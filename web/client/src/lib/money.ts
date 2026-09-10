/**
 * Money formatting for the customer SPA. The wire carries amounts as canonical
 * minor-unit INTEGER strings (int64 precision); this module renders them for humans
 * WITHOUT ever touching a float. `Number`/`parseFloat` on an amount silently loses
 * precision above 2^53 and introduces rounding error — a money-safety defect — so the
 * major/minor split and thousands grouping are done with BigInt and string math only.
 */

const DEFAULT_MINOR_UNIT_DIGITS = 2;

// Minor-unit exponent (digits after the decimal point) per ISO-4217 currency. MXN = 2
// (centavos). The system is MXN-only today; the map keeps the exponent a per-currency
// fact rather than a hidden constant, so a zero-decimal currency would format correctly.
const MINOR_UNIT_DIGITS: Readonly<Record<string, number>> = { MXN: 2 };

/** Minor-unit exponent for a currency (digits after the decimal point). */
export function minorUnitDigits(currency: string): number {
  return MINOR_UNIT_DIGITS[currency] ?? DEFAULT_MINOR_UNIT_DIGITS;
}

/** A canonical signed integer string: an optional leading `-` then one-or-more digits, nothing
 * else. `BigInt()` is dangerously lenient (`BigInt('')` / `BigInt(' ')` -> `0n`, `BigInt('0x10')`
 * -> `16n`, `BigInt('+5')` -> `5n`), so any string that reaches `BigInt` MUST first pass this. */
const CANONICAL_INTEGER = /^-?\d+$/;

/**
 * Split a signed minor-unit integer string into a plain decimal string, e.g.
 * `('-1500000', 2)` -> `'-15000.00'`. Float-free: BigInt division/modulo, never
 * `Number`. Throws on a non-canonical / non-integer input rather than letting `BigInt`
 * silently coerce it (`''`/`' '`/`'0x10'`/`'+5'`) or yielding `NaN`.
 */
export function toDecimalString(minorUnits: string, exponent: number): string {
  if (!CANONICAL_INTEGER.test(minorUnits)) {
    throw new Error(
      `toDecimalString: not a canonical integer string: ${JSON.stringify(minorUnits)}`,
    );
  }
  const value = BigInt(minorUnits);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const divisor = 10n ** BigInt(exponent);
  const major = (abs / divisor).toString();
  const fraction = exponent > 0 ? `.${(abs % divisor).toString().padStart(exponent, '0')}` : '';
  return `${negative ? '-' : ''}${major}${fraction}`;
}

// Group an integer-part digit string into thousands with ','. String-only, so it is
// exact for arbitrarily large balances (no Number ceiling). ',' grouping + '.' decimal
// matches es-MX peso conventions.
function groupThousands(integerDigits: string): string {
  return integerDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Human amount WITHOUT a currency code, e.g. `'-15,000.00'`. Grouped thousands, fixed to
 * the currency's minor-unit exponent. Use where the currency is shown alongside.
 */
export function formatAmount(minorUnits: string, currency: string): string {
  const decimal = toDecimalString(minorUnits, minorUnitDigits(currency));
  const negative = decimal.startsWith('-');
  const unsigned = negative ? decimal.slice(1) : decimal;
  const [integerPart, fractionPart] = unsigned.split('.');
  const grouped = groupThousands(integerPart) + (fractionPart ? `.${fractionPart}` : '');
  return negative ? `-${grouped}` : grouped;
}

/** Human money WITH the ISO currency code, e.g. `'-15,000.00 MXN'`. */
export function formatMoney(minorUnits: string, currency: string): string {
  return `${formatAmount(minorUnits, currency)} ${currency}`;
}

export type AmountDirection = 'in' | 'out' | 'zero';

/** Sign of a signed minor-unit amount (a statement `delta`): money in / out / neither. */
export function amountDirection(minorUnits: string): AmountDirection {
  if (!CANONICAL_INTEGER.test(minorUnits)) {
    throw new Error(
      `amountDirection: not a canonical integer string: ${JSON.stringify(minorUnits)}`,
    );
  }
  const value = BigInt(minorUnits);
  if (value > 0n) return 'in';
  if (value < 0n) return 'out';
  return 'zero';
}

// ---------------------------------------------------------------------------
// User input → minor units (the money-moving direction). This is the safety
// crux of a transfer form: a human types a MAJOR-unit amount ("15,000.50") and
// we must produce the exact minor-unit integer STRING the wire carries, WITHOUT
// ever touching a float. `Number`/`parseFloat`/`toFixed` would silently lose
// precision or round — a money defect — so the whole conversion is string/BigInt
// math and every rejection is LOUD (a typed error the form surfaces), never a
// silent coerce or round.
// ---------------------------------------------------------------------------

/** The greatest value the server's `int64` minor-unit column can hold. A parsed amount above
 * this is rejected client-side rather than overflowing server-side. */
const MAX_INT64_MINOR = 9223372036854775807n;

/** Hard cap on the raw input length: a cheap guard against pathological input before any BigInt
 * is built. Generous versus a real MXN amount (int64 in centavos is ~17 major digits). */
const MAX_INPUT_LENGTH = 30;

/** Well-formed non-negative decimal: one-or-more integer digits, optional fractional part with
 * one-or-more digits. Deliberately strict — no sign, no exponent, no separators, no bare `.5`. */
const DECIMAL_INPUT = /^\d+(\.\d+)?$/;

/** Why a user-entered amount was rejected — a stable discriminant the form maps to a message. */
export type AmountParseErrorKind =
  'empty' | 'not-a-number' | 'negative' | 'zero' | 'too-many-fraction-digits' | 'too-large';

/** A LOUD, typed rejection from {@link parseAmountToMinor}. Carries the `kind` (for programmatic
 * handling) and a human `message` (for the form) — the parser never silently rounds or coerces. */
export class AmountParseError extends Error {
  readonly kind: AmountParseErrorKind;

  constructor(kind: AmountParseErrorKind, message: string) {
    super(message);
    this.name = 'AmountParseError';
    this.kind = kind;
  }
}

/**
 * Convert a human MAJOR-unit amount string to a canonical unsigned minor-unit integer string for
 * the wire, using BigInt/string math ONLY. Fails LOUDLY (throws {@link AmountParseError}) on empty,
 * non-numeric, negative, zero, more fractional digits than the currency's exponent, or an
 * absurd/overflowing magnitude — it NEVER rounds or coerces. Thousands separators and a bare `.5`
 * are rejected as non-numeric. E.g. `('150.5', 'MXN')` -> `'15050'`; `('0.05', 'MXN')` -> `'5'`.
 */
export function parseAmountToMinor(input: string, currency: string): string {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new AmountParseError('empty', 'Enter an amount.');
  }
  if (trimmed.length > MAX_INPUT_LENGTH) {
    throw new AmountParseError('too-large', 'That amount is too large.');
  }
  if (trimmed.startsWith('-')) {
    throw new AmountParseError('negative', 'Amount must be positive.');
  }
  const exponent = minorUnitDigits(currency);
  if (!DECIMAL_INPUT.test(trimmed)) {
    throw new AmountParseError(
      'not-a-number',
      exponent > 0
        ? `Enter a valid amount using digits and up to ${exponent} decimal place${exponent === 1 ? '' : 's'}.`
        : 'Enter a valid whole amount using digits only.',
    );
  }
  const [integerPart, fractionPart = ''] = trimmed.split('.');
  if (fractionPart.length > exponent) {
    throw new AmountParseError(
      'too-many-fraction-digits',
      exponent > 0
        ? `${currency} allows at most ${exponent} decimal place${exponent === 1 ? '' : 's'}.`
        : `${currency} does not allow decimal places.`,
    );
  }
  // Concatenate the integer part with the fraction padded to the exponent — this IS the minor-unit
  // magnitude (e.g. "150" + "50" = "15050"). BigInt canonicalizes leading zeros; the regex above
  // already guaranteed a canonical-integer string, so BigInt cannot coerce anything unexpected.
  const minor = BigInt(`${integerPart}${fractionPart.padEnd(exponent, '0')}`);
  if (minor === 0n) {
    throw new AmountParseError('zero', 'Amount must be greater than zero.');
  }
  if (minor > MAX_INT64_MINOR) {
    throw new AmountParseError('too-large', 'That amount is too large.');
  }
  return minor.toString();
}

/** The successful/failed outcome of parsing an amount, for form use where a thrown error per
 * keystroke is awkward. Wraps {@link parseAmountToMinor} without swallowing the reason. */
export type AmountParseResult =
  { ok: true; minor: string } | { ok: false; error: AmountParseError };

/** Non-throwing wrapper over {@link parseAmountToMinor} for live form validation. */
export function safeParseAmountToMinor(input: string, currency: string): AmountParseResult {
  try {
    return { ok: true, minor: parseAmountToMinor(input, currency) };
  } catch (error) {
    if (error instanceof AmountParseError) {
      return { ok: false, error };
    }
    throw error;
  }
}
