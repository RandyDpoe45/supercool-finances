/**
 * Spec 04 — Balance Service, confirmation-of-payee follow-up: the payee-name PRIVACY MASK.
 *
 * Written FROM the developer-locked contract, NOT the implementation: the masked name shown at
 * resolve-time protects the destination holder's PII — a payer sanity-checks WHO they are paying
 * without the service disclosing the full name of an account they merely know the number of.
 *
 * The rule (contract): split the name on whitespace (runs collapse), each token → its first 3
 * characters + EXACTLY two asterisks (fixed, uniform — the mask does NOT reveal the token's
 * length), joined by single spaces; an empty/whitespace-only name → `""`.
 *
 * The point of this suite is to pin the EXACT fixed-two-asterisks rule. A plausible-but-wrong
 * "one asterisk per hidden character" implementation would agree on a 5-char token ("Maria" →
 * "Mar**" either way) but DISAGREE on `"Juanita"` (fixed → "Jua**"; per-char → "Jua****") and on
 * `"Al"` (fixed → "Al**"; per-char → "Al"). Those two cases are the discriminators, so a mask
 * that leaks length fails here. Pure — NO DB, NO Nest — so it runs in the DEFAULT `npm test`.
 */
import { getMaskName } from '../support/harness';

const maskName = getMaskName();

const suite = maskName ? describe : describe.skip;
if (!maskName) {
  console.info(
    '[unit] SKIPPED mask-name suite: the pure `maskName` helper is not resolvable via ' +
      'tests/support/harness.ts:getMaskName. Add its path/export there to activate this suite.',
  );
}

suite('maskName — the fixed-two-asterisks payee-name privacy mask (pure)', () => {
  const mask = maskName as (name: string) => string;

  it('masks a multi-token name to first-3 + ** per token, single-space joined', () => {
    // The contract's canonical example.
    expect(mask('Juan Perez')).toBe('Jua** Per**');
  });

  it('keeps only the FIRST 3 chars of a long token, with EXACTLY two asterisks (length not leaked)', () => {
    // A per-character mask would emit "Jua****" (4 asterisks) and leak that 4 chars were hidden.
    expect(mask('Juanita')).toBe('Jua**');
    expect(mask('Maria')).toBe('Mar**');
  });

  it('handles a 3-char token — keeps all three plus the two asterisks', () => {
    expect(mask('Ana')).toBe('Ana**');
  });

  it('handles a short (<3) token — keeps what it has plus EXACTLY two asterisks', () => {
    // A per-character mask would emit "Al" (no asterisks, so nothing hidden) — this pins the
    // fixed-two rule at the short end.
    expect(mask('Al')).toBe('Al**');
    expect(mask('J')).toBe('J**');
  });

  it('collapses repeated internal whitespace to a single space (no empty tokens)', () => {
    expect(mask('Juan   Perez')).toBe('Jua** Per**');
    expect(mask('Juan\tPerez')).toBe('Jua** Per**');
  });

  it('trims leading/trailing whitespace before masking', () => {
    expect(mask('  Juan Perez  ')).toBe('Jua** Per**');
  });

  it('masks each token of a 3+ token name independently', () => {
    expect(mask('Ana Maria Lopez')).toBe('Ana** Mar** Lop**');
  });

  it('returns "" for an empty or whitespace-only name (nothing to mask, nothing leaked)', () => {
    expect(mask('')).toBe('');
    expect(mask('   ')).toBe('');
    expect(mask('\t \n')).toBe('');
  });
});
