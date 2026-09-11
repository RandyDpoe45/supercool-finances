/**
 * App-local money formatting for the otp-app (ADR-16: this is an INDEPENDENT copy — it
 * mirrors the client-app's intent but is NEVER imported from `web/client` or anywhere
 * outside `web/otp/`).
 *
 * Amounts arrive from `/api` as canonical **bigint minor-unit strings** (e.g. MXN centavos:
 * `"125000"` = $1,250.00). Formatting therefore uses **BigInt + string math only — never a
 * float**: parsing a minor-unit integer through `Number`/`parseFloat` risks silent precision
 * loss on large balances, which for a money surface is a correctness defect, not a cosmetic
 * one. `Intl.NumberFormat` is used only for locale artifacts (grouping, decimal separator,
 * currency symbol + placement); the integer is fed to it as a `bigint`, so no value is ever
 * coerced to a float.
 */

const DEFAULT_LOCALE = 'es-MX';

/**
 * Minor-unit scale per ISO-4217 code (decimal places). The prototype seeds MXN only
 * (`minor_unit_scale = 2`, centavos); adding a currency is a data change, mirrored here. An
 * unknown code falls back to 2 rather than throwing, since 2 is the overwhelmingly common
 * scale and a wrong render is preferable to a crashed feed.
 */
const CURRENCY_MINOR_UNIT_SCALE: Readonly<Record<string, number>> = { MXN: 2 };
const DEFAULT_MINOR_UNIT_SCALE = 2;

/** Decimal places for `currency` (defaults to 2 for an unseeded code). */
export function currencyMinorUnitScale(currency: string): number {
  return CURRENCY_MINOR_UNIT_SCALE[currency] ?? DEFAULT_MINOR_UNIT_SCALE;
}

/**
 * Format a canonical minor-unit integer string as a localized currency string
 * (e.g. `formatMinorUnits('125000', 'MXN')` → `"$1,250.00"`). Float-free: the value is split
 * into major/minor parts with BigInt, and only the locale scaffolding (symbol, grouping,
 * separators, sign placement) comes from `Intl`. Throws on a non-integer input rather than
 * silently rendering garbage.
 */
export function formatMinorUnits(
  minorUnits: string,
  currency: string,
  locale: string = DEFAULT_LOCALE,
): string {
  const scale = currencyMinorUnitScale(currency);
  const trimmed = minorUnits.trim();
  const negative = trimmed.startsWith('-');
  const digits = trimmed.replace(/^[+-]/, '');
  if (!/^\d+$/.test(digits)) {
    throw new Error(`formatMinorUnits: expected an integer minor-unit string, got: ${minorUnits}`);
  }

  const abs = BigInt(digits);
  const divisor = 10n ** BigInt(scale);
  const majorInt = abs / divisor;
  const minorInt = abs % divisor;
  const fraction = scale > 0 ? minorInt.toString().padStart(scale, '0') : '';

  // Locale template: derives symbol placement, grouping, decimal separator, and sign
  // placement from Intl WITHOUT ever coercing our value through a float. `-0` renders as
  // positive so a zero amount never shows a stray minus.
  const template = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    currencyDisplay: 'symbol',
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
  }).formatToParts(negative && abs !== 0n ? -1 : 1);

  // The grouped integer is formatted straight from the BigInt (float-free grouping).
  const groupedInteger = new Intl.NumberFormat(locale, { useGrouping: true }).format(majorInt);

  let out = '';
  let integerWritten = false;
  for (const part of template) {
    switch (part.type) {
      case 'integer':
      case 'group':
        // The template splits the placeholder integer into several integer/group parts;
        // emit our own grouped integer once, at the first, and skip the rest.
        if (!integerWritten) {
          out += groupedInteger;
          integerWritten = true;
        }
        break;
      case 'fraction':
        out += fraction;
        break;
      default:
        // currency, literal, decimal, minusSign, plusSign — emit the locale value verbatim.
        out += part.value;
    }
  }
  return out;
}
