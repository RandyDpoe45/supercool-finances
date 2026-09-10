import { randomInt } from 'node:crypto';

/** The fixed width of a customer account number: 10 digits, zero-padded. */
export const ACCOUNT_NUMBER_LENGTH = 10;

/**
 * Mint a candidate customer account number — a 10-digit zero-padded numeric string from a
 * CSPRNG (`crypto.randomInt`), never `Math.random`. Pure: it does NOT check the DB. Uniqueness
 * is enforced by the `uq_account_account_number` unique index, so a caller that assigns numbers
 * (the spec-08 seed, tests) must retry on a unique-violation. There is no create-account
 * endpoint in this step, so nothing generates at runtime yet — this exposes the rule for those
 * callers alongside the schema.
 */
export function generateAccountNumber(): string {
  const n = randomInt(0, 10 ** ACCOUNT_NUMBER_LENGTH);
  return String(n).padStart(ACCOUNT_NUMBER_LENGTH, '0');
}
