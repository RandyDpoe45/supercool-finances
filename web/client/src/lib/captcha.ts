/**
 * A lightweight, CLIENT-ONLY demo captcha — a trivial arithmetic challenge with NO external
 * service and NO network. It exists to gate the sensitive initiate form in the prototype (spec 07:
 * "a library captcha on sensitive forms (demo stub)"); it is intentionally not a real bot defense.
 * The pure challenge/verify logic lives here so it is deterministic and testable; the `CaptchaStub`
 * molecule renders it.
 */

export interface CaptchaChallenge {
  a: number;
  b: number;
}

/** Build a fresh challenge: the sum of two single digits (1..9). `rand` is injectable so a test
 * can make it deterministic; it defaults to `Math.random` (no crypto strength needed — this is a
 * demo gate, never a security control). */
export function makeCaptchaChallenge(rand: () => number = Math.random): CaptchaChallenge {
  const a = Math.floor(rand() * 9) + 1;
  const b = Math.floor(rand() * 9) + 1;
  return { a, b };
}

/** True iff `input` is the exact numeric sum of the challenge. Non-numeric / empty input is not
 * solved (never coerced). `Number` is safe here — the operands are single digits, not money. */
export function isCaptchaSolved(challenge: CaptchaChallenge, input: string): boolean {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) {
    return false;
  }
  return Number(trimmed) === challenge.a + challenge.b;
}
