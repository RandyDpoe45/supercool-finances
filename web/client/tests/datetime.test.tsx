import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Timestamp } from '../src/components/atoms/Timestamp';
import { DISPLAY_TIME_ZONE, formatInstant } from '../src/lib/datetime';

/**
 * The server is UTC-only; the SPA converts ISO-8601 `Z` instants to Mexico City wall-clock
 * AT THE EDGE (spec 07 / cross-cutting rule 5) using the IANA zone via `Intl` — never a
 * hardcoded offset. These tests assert the conversion actually happened (local hour, not the
 * UTC hour) and that DST HISTORY is honored, which a fixed-offset implementation cannot do.
 */

describe('formatInstant (UTC -> America/Mexico_City at the edge)', () => {
  it('uses the IANA zone, not a hardcoded offset', () => {
    expect(DISPLAY_TIME_ZONE).toBe('America/Mexico_City');
  });

  it('renders a UTC instant in Mexico City local time (present day: CST, UTC-6)', () => {
    // 22:10:03 UTC on 2026-09-08. Mexico City is permanent CST (UTC-6) since the 2022 DST
    // abolition -> 16:10:03 local, same calendar day.
    const out = formatInstant('2026-09-08T22:10:03.000Z');
    expect(out).toContain('16:10:03'); // the converted local hour
    expect(out).toContain('08/09/2026'); // day/month/year, es-MX
    // The raw UTC hour must NOT survive — proves a conversion, not a passthrough.
    expect(out).not.toContain('22:10:03');
  });

  it('applies DST history via the tz database, not a fixed -6 offset', () => {
    // Two instants at the SAME UTC hour (18:00:00Z). In 2021 Mexico City still observed DST:
    // July was CDT (UTC-5) -> 13:00 local; January was CST (UTC-6) -> 12:00 local. The
    // one-hour split between identical UTC hours can only come from IANA DST rules; a
    // hardcoded -6 offset would render BOTH as 12:00 and fail the summer assertion.
    const summer = formatInstant('2021-07-01T18:00:00.000Z');
    const winter = formatInstant('2021-01-01T18:00:00.000Z');

    expect(summer).toContain('13:00:00');
    expect(summer).not.toContain('12:00:00');
    expect(summer).toContain('01/07/2021');

    expect(winter).toContain('12:00:00');
    expect(winter).toContain('01/01/2021');
  });

  it('returns the input verbatim (never "Invalid Date") when the instant is unparseable', () => {
    // The server contract guarantees a valid `Z` instant; this only keeps the render path
    // from emitting a broken "Invalid Date" string on unexpected data.
    expect(formatInstant('not-a-timestamp')).toBe('not-a-timestamp');
  });
});

describe('Timestamp atom', () => {
  it('shows the localized text while preserving the canonical UTC instant in <time dateTime>', () => {
    const iso = '2026-09-08T22:10:03.000Z';
    const { container } = render(<Timestamp iso={iso} />);
    const time = container.querySelector('time');

    expect(time).not.toBeNull();
    // The machine-readable wire value is preserved exactly (not lost to formatting).
    expect(time?.getAttribute('dateTime')).toBe(iso);
    // The visible text is the Mexico City rendering, not the raw UTC string.
    expect(time?.textContent).toContain('16:10:03');
    expect(time?.textContent).not.toBe(iso);
  });
});
