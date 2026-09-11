/**
 * Money formatting for the admin SPA (app-local copy of the customer SPA's lib, ADR-16). The wire
 * carries amounts as canonical minor-unit INTEGER strings (int64 precision); this module renders
 * them for humans WITHOUT ever touching a float. `Number`/`parseFloat` on an amount silently loses
 * precision above 2^53 and introduces rounding error — a money-safety defect — so the major/minor
 * split, thousands grouping, and range checks are done with BigInt and string math only.
 *
 * The admin limits screen edits money-valued CAPS (per-transaction / daily / monthly). Those are
 * entered and carried as unsigned minor-unit integer strings; {@link isUnsignedMinorUnits} is the
 * float-free validator the form and stub use, and {@link formatAmount} renders a live preview.
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

/** Sign of a signed minor-unit amount: money in / out / neither. */
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

/** The greatest value the server's `int64` minor-unit column can hold. A cap above this is rejected
 * client-side rather than overflowing server-side. */
const MAX_INT64_MINOR = 9223372036854775807n;

/**
 * True iff `value` is a canonical UNSIGNED minor-unit integer string within the int64 range — the
 * shape a limit cap carries on the wire (e.g. `'150000'`). Empty, signed, non-digit, and
 * overflowing inputs all fail. Float-free: the range check is BigInt, never `Number`. The limits
 * form uses this to gate a cap before submit (empty input means uncapped/`null`, checked by the
 * caller, not here).
 */
export function isUnsignedMinorUnits(value: string): boolean {
  if (!/^\d+$/.test(value)) {
    return false;
  }
  return BigInt(value) <= MAX_INT64_MINOR;
}
