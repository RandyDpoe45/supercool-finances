import { describe, expect, it } from 'vitest';
import { formatInstant, instantToEpochMs } from '../src/lib/datetime';

/**
 * The server is UTC-only; the app must convert to Mexico City wall-clock at the edge via the
 * IANA zone `America/Mexico_City` — NEVER render the raw UTC instant. Mexico has not observed
 * DST since 2022, so the zone offset is a constant -06:00 today; a purely behavioural test
 * therefore cannot distinguish the correct IANA lookup from a hardcoded `-06:00`. What it CAN
 * (and must) catch is a passthrough — a display that leaves the instant in UTC — and that the
 * shift is actually applied. The expected wall-clock values below are hand-derived: subtract
 * 6 hours from the UTC instant.
 */
describe('formatInstant — UTC instant -> Mexico City wall clock', () => {
  it('shifts a UTC instant back 6 hours into Mexico City time (not a UTC passthrough)', () => {
    // 18:00:00Z - 6h = 12:00:00 (noon) in America/Mexico_City on the same day.
    const out = formatInstant('2026-09-10T18:00:00Z');
    expect(out).toBe('10 sep 2026, 12:00:00 p.m. GMT-6');
    // Sharp passthrough guards: a UTC render would show 06:00:00 p.m. (18:00 in 12h) and
    // would NOT carry the -6 offset label.
    expect(out).toContain('12:00:00');
    expect(out).toContain('GMT-6');
    expect(out).not.toContain('06:00:00');
  });

  it('rolls the calendar date back when the UTC instant is early-morning UTC', () => {
    // 2026-09-11T02:00:00Z - 6h = 2026-09-10 20:00:00 (8:00 p.m.) in Mexico City: the DATE
    // rolls from the 11th (UTC) to the 10th (local). A naive same-date offset would keep 11.
    const out = formatInstant('2026-09-11T02:00:00Z');
    expect(out).toBe('10 sep 2026, 08:00:00 p.m. GMT-6');
    expect(out).toContain('10 sep');
    expect(out).not.toContain('11 sep');
    expect(out).not.toContain('02:00:00');
  });

  it('throws on an unparseable instant rather than rendering "Invalid Date"', () => {
    expect(() => formatInstant('not-a-date')).toThrow();
    expect(() => formatInstant('')).toThrow();
  });
});

describe('instantToEpochMs — absolute epoch for the countdown', () => {
  it('returns the absolute epoch ms of a UTC instant (timezone-agnostic)', () => {
    // Date.UTC is a pure platform primitive (independent of the helper's Date.parse path);
    // the decomposed fields are supplied by hand. Month is 0-based (8 = September).
    const expected = Date.UTC(2026, 8, 10, 18, 0, 0);
    expect(instantToEpochMs('2026-09-10T18:00:00Z')).toBe(expected);
  });

  it('resolves the SAME moment whether written with Z or an explicit offset', () => {
    // These are the same instant; parsing must yield one epoch, proving it reads the absolute
    // moment rather than doing naive string arithmetic.
    const zulu = instantToEpochMs('2026-09-10T18:00:00Z');
    const offset = instantToEpochMs('2026-09-10T12:00:00-06:00');
    expect(zulu).toBe(Date.UTC(2026, 8, 10, 18, 0, 0));
    expect(offset).toBe(zulu);
  });

  it('returns null for an absent instant (no deadline)', () => {
    expect(instantToEpochMs(null)).toBeNull();
  });

  it('returns null (never NaN) for an unparseable instant', () => {
    expect(instantToEpochMs('garbage')).toBeNull();
  });
});
