import { randomInt } from 'node:crypto';

/** The fixed width of a customer account number: 10 digits, zero-padded. */
export const ACCOUNT_NUMBER_LENGTH = 10;

/**
 * Mint a candidate customer account number — a 10-digit zero-padded numeric string from a
 * CSPRNG (`crypto.randomInt`), never `Math.random`. Pure: it does NOT check the DB. Uniqueness
 * is enforced by the `uq_account_account_number` unique index, so any caller that assigns numbers
 * (self-service `POST /api/accounts`, the spec-08 seed, tests) MUST retry on a unique-violation.
 * `AccountsService.createAccount` wraps this in a bounded regenerate-and-retry on a `23505`
 * collision scoped to that index.
 */
export function generateAccountNumber(): string {
  const n = randomInt(0, 10 ** ACCOUNT_NUMBER_LENGTH);
  return String(n).padStart(ACCOUNT_NUMBER_LENGTH, '0');
}
