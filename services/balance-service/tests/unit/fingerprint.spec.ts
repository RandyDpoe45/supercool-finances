/**
 * Spec 04 — Balance Service DOMAIN layer, Step 3: the request fingerprint.
 *
 * `computeFingerprint({type, source, destination, amount, currency})` is the server-computed
 * hash that backs BOTH idempotency-key REUSE detection (same key, different fingerprint) and
 * the 60s SOFT-DUPLICATE window (different key, same fingerprint). Its correctness is a pure
 * property — no DB — so it is proven here directly: determinism, a stable hash string, every
 * field mattering, and no delimiter/field-boundary collisions (the property that keeps a
 * duplicate check from either missing a real duplicate or flagging a false one).
 *
 * No DB, never skipped. The helper is resolved through the single harness seam
 * (getComputeFingerprint); if it were not exported purely, this suite would be omitted and the
 * fingerprint behaviour proven via the integration soft-duplicate cases instead.
 */
import 'reflect-metadata';
import { getComputeFingerprint } from '../support/harness';

const computeFingerprint = getComputeFingerprint();

if (!computeFingerprint) {
  throw new Error(
    '[unit] could not resolve a pure computeFingerprint through the harness seam ' +
      '(getComputeFingerprint). If the implementor named/placed it differently, add it to ' +
      'tests/support/harness.ts:getComputeFingerprint — the single coordination point.',
  );
}

const HEX64 = /^[0-9a-f]{64}$/; // sha256 hex

interface FI {
  type: string;
  source: string | null;
  destination: string | null;
  amount: string;
  currency: string;
}

function fi(overrides: Partial<FI> = {}): FI {
  return {
    type: 'internal',
    source: 'acc-src',
    destination: 'acc-dst',
    amount: '1000',
    currency: 'MXN',
    ...overrides,
  };
}

describe('computeFingerprint — canonical hash over the business tuple', () => {
  it('is deterministic: the same tuple yields the same hash', () => {
    expect(computeFingerprint(fi())).toBe(computeFingerprint(fi()));
  });

  it('returns a stable 64-char lowercase hex string', () => {
    expect(computeFingerprint(fi())).toMatch(HEX64);
  });

  it.each<keyof FI>(['type', 'source', 'destination', 'amount', 'currency'])(
    'changes when the %s field changes (every field is part of the identity)',
    (field) => {
      const base = computeFingerprint(fi());
      const changed = computeFingerprint(
        fi({ [field]: `CHANGED-${String(field)}` } as Partial<FI>),
      );
      expect(changed).not.toBe(base);
    },
  );

  it('has no delimiter/field-boundary collision (positional canonical form)', () => {
    // Under a naive `${type}|${source}` join these two collide ('a|b|c'); a correct canonical
    // encoding keeps them distinct — otherwise two DIFFERENT transfers would share a fingerprint
    // and one could be wrongly suppressed as a duplicate of the other.
    const a = computeFingerprint(fi({ type: 'a', source: 'b|c' }));
    const b = computeFingerprint(fi({ type: 'a|b', source: 'c' }));
    expect(a).not.toBe(b);
  });

  it('does not treat source and destination as interchangeable', () => {
    // Direction matters: A→B is not the same movement as B→A.
    const ab = computeFingerprint(fi({ source: 'a', destination: 'b' }));
    const ba = computeFingerprint(fi({ source: 'b', destination: 'a' }));
    expect(ab).not.toBe(ba);
  });

  it('handles null source/destination: no throw, stable, and distinct from the non-null form', () => {
    const nulls = computeFingerprint(fi({ source: null, destination: null }));
    expect(nulls).toMatch(HEX64);
    expect(nulls).toBe(computeFingerprint(fi({ source: null, destination: null }))); // deterministic
    expect(nulls).not.toBe(computeFingerprint(fi({ source: 'acc-src', destination: 'acc-dst' })));
    // A null in the source slot is not the same as a null in the destination slot (positional).
    expect(computeFingerprint(fi({ source: null }))).not.toBe(
      computeFingerprint(fi({ destination: null })),
    );
  });
});
