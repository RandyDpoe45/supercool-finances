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
 * Derived available balance: `balance − held`. Available is never stored — it is
 * always computed from the two materialized caches (spec 04 Accounts). Result is the
 * canonical minor-unit string; it MAY be negative for system/clearing accounts.
 */
export function availableBalance(balance: string, held: string): string {
  return (BigInt(balance) - BigInt(held)).toString();
}
