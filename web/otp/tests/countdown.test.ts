import { describe, expect, it } from 'vitest';
import { formatCountdown, remainingSeconds } from '../src/lib/countdown';

/**
 * The ttl / deadline math is pure (now is passed in). Both the pending's 2-minute deadline and
 * the revealed code's ttl flow through these, so the boundaries matter: a code must never look
 * valid past its deadline, and a fraction of a second left must still read as "at least 1s"
 * (never round down to 0 and hide a still-live code). All expected values are hand-computed.
 */
describe('remainingSeconds — whole seconds until a deadline, floored at 0', () => {
  it('computes whole seconds for a comfortably-future deadline', () => {
    expect(remainingSeconds(120_000, 0)).toBe(120);
    expect(remainingSeconds(10_000, 0)).toBe(10);
  });

  it('rounds a sub-second remainder UP so a still-live code never reads as 0', () => {
    expect(remainingSeconds(500, 0)).toBe(1); // 0.5s left -> 1
    expect(remainingSeconds(1, 0)).toBe(1); // 1ms left -> 1
    expect(remainingSeconds(119_001, 0)).toBe(120); // ceil(119.001) -> 120
  });

  it('returns 0 exactly at the deadline', () => {
    expect(remainingSeconds(1_000, 1_000)).toBe(0);
  });

  it('clamps to 0 once the deadline has passed (never negative)', () => {
    expect(remainingSeconds(1_000, 5_000)).toBe(0);
  });
});

describe('formatCountdown — m:ss', () => {
  it('formats minutes and zero-padded seconds', () => {
    expect(formatCountdown(119)).toBe('1:59');
    expect(formatCountdown(60)).toBe('1:00');
    expect(formatCountdown(125)).toBe('2:05');
    expect(formatCountdown(5)).toBe('0:05');
    expect(formatCountdown(0)).toBe('0:00');
  });

  it('does not roll minutes over into hours (a 60-minute deadline reads 60:00)', () => {
    expect(formatCountdown(3600)).toBe('60:00');
  });

  it('floors a fractional second and clamps a negative to 0:00', () => {
    expect(formatCountdown(59.9)).toBe('0:59');
    expect(formatCountdown(-5)).toBe('0:00');
  });
});
