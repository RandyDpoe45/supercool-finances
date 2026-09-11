/**
 * App-local date/time formatting for the otp-app (ADR-16: an INDEPENDENT copy — never
 * imported from `web/client` or outside `web/otp/`).
 *
 * The server is UTC-only and sends ISO-8601 `Z` instants. The app converts to Mexico City
 * time at the edge via the **IANA zone `America/Mexico_City`** passed to `Intl` — never a
 * hardcoded UTC offset. Using the IANA zone lets the platform apply the correct offset
 * (and any DST history) for the instant, so the display is right regardless of offset
 * changes; a hardcoded `-06:00` would silently drift the moment a rule changes.
 */

const DISPLAY_TIME_ZONE = 'America/Mexico_City';
const DEFAULT_LOCALE = 'es-MX';

/**
 * Format an ISO-8601 UTC instant for display in Mexico City time, e.g.
 * `"10 sept 2026, 12:00:00 GMT-6"`. The zone abbreviation is included so the reader knows
 * the wall-clock is local, not UTC. Throws on an unparseable input.
 */
export function formatInstant(isoUtc: string, locale: string = DEFAULT_LOCALE): string {
  const date = new Date(isoUtc);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`formatInstant: not a valid ISO-8601 instant: ${isoUtc}`);
  }
  return new Intl.DateTimeFormat(locale, {
    timeZone: DISPLAY_TIME_ZONE,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

/**
 * Epoch milliseconds for an ISO-8601 instant, or `null` when absent/unparseable. Used to
 * drive a countdown against `Date.now()` — the countdown math is offset-agnostic (both sides
 * are absolute instants), so the timezone only matters for the human-readable label above.
 */
export function instantToEpochMs(isoUtc: string | null): number | null {
  if (isoUtc === null) {
    return null;
  }
  const ms = Date.parse(isoUtc);
  return Number.isNaN(ms) ? null : ms;
}
