import { createHash } from 'node:crypto';

/**
 * The business tuple a fingerprint is computed over: the semantic identity of a money
 * movement (spec 04 Transfers). `source`/`destination` are nullable (e.g. an external rail
 * side has no internal account). All money values are minor-unit strings.
 */
export interface FingerprintInput {
  type: string;
  source: string | null;
  destination: string | null;
  amount: string;
  currency: string;
}

/**
 * Pure, deterministic `sha256` (hex) over a CANONICAL serialization of the business tuple —
 * the server-computed `request_fingerprint`. It backs BOTH idempotency-key reuse detection
 * (same key, different fingerprint = misuse) and the 60s soft duplicate-suppression window
 * (different keys, same fingerprint = suspected double-submit).
 *
 * Canonical form: a fixed-order JSON array (positional, not keyed, so field order is
 * guaranteed regardless of engine key-ordering), with `null` normalized for the optional
 * fields. JSON escaping makes the encoding unambiguous (no delimiter-collision).
 */
export function computeFingerprint(input: FingerprintInput): string {
  const canonical = JSON.stringify([
    input.type,
    input.source ?? null,
    input.destination ?? null,
    input.amount,
    input.currency,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
