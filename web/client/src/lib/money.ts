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

/**
 * Split a signed minor-unit integer string into a plain decimal string, e.g.
 * `('-1500000', 2)` -> `'-15000.00'`. Float-free: BigInt division/modulo, never
 * `Number`. Throws (via `BigInt`) on a non-integer input rather than silently yielding
 * `NaN`.
 */
export function toDecimalString(minorUnits: string, exponent: number): string {
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
  const value = BigInt(minorUnits);
  if (value > 0n) return 'in';
  if (value < 0n) return 'out';
  return 'zero';
}
