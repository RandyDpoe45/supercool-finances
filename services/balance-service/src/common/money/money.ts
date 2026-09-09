/**
 * Money helpers for `bigint` minor-unit amounts surfaced by TypeORM as JS `string`
 * (a JS `number` cannot hold the full int64 range without precision loss). All math
 * here is exact `BigInt` arithmetic — NEVER `Number`/float. Cross-cutting on purpose:
 * the posting operation (later step) reuses these.
 *
 * Invariant: callers pass canonical int64 minor-unit strings as stored in Postgres
 * (`account.balance`/`held`, `ledger_entry.delta`/`balance_after`). `BigInt()` throws
 * on a non-integer string, so malformed input fails loudly rather than silently.
 */

/**
 * Derived available balance as an exact `bigint`: `balance − held`. Available is never
 * stored — it is always computed from the two materialized caches (spec 04 Accounts). It
 * MAY be negative for system/clearing accounts. Returned as `bigint` so callers doing a
 * further comparison (e.g. the posting funds check) stay in exact integer math and never
 * re-parse; string-facing callers use {@link availableBalance}.
 */
export function availableMinor(balance: string, held: string): bigint {
  return BigInt(balance) - BigInt(held);
}

/**
 * Derived available balance as the canonical minor-unit string (`balance − held`), for
 * serialize-time / wire use. Delegates to {@link availableMinor}.
 */
export function availableBalance(balance: string, held: string): string {
  return availableMinor(balance, held).toString();
}

/**
 * Exact sum of signed minor-unit strings, as a `bigint`. Used by the posting reducer to
 * assert the double-entry balancing invariant (legs sum to zero). Empty input sums to `0n`.
 */
export function sumMinor(values: string[]): bigint {
  return values.reduce((total, value) => total + BigInt(value), 0n);
}

/**
 * Exact addition of two signed minor-unit strings, returned as the canonical string. Used
 * to fold a ledger delta into a balance (`balance_after = balance_before + delta`).
 */
export function addMinor(a: string, b: string): string {
  return (BigInt(a) + BigInt(b)).toString();
}
