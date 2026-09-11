/**
 * Date/time rendering for the admin SPA (app-local copy of the customer SPA's lib, ADR-16). The
 * server is UTC-only and sends ISO-8601 `Z` instants; the UI converts to Mexico City time AT THE
 * EDGE (spec 07 / cross-cutting rule 5) — the server never sees a localized time. The IANA zone is
 * applied via `Intl`, NEVER a hardcoded UTC offset, so DST history (and Mexico's 2022 DST
 * abolition) is left to the tz database rather than baked in here.
 */

export const DISPLAY_TIME_ZONE = 'America/Mexico_City';
const DISPLAY_LOCALE = 'es-MX';

// Built once: a fixed 24-hour `dd/mm/yyyy, HH:MM:SS` rendering in Mexico City time.
const INSTANT_FORMAT = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/**
 * Format a server ISO-8601 UTC instant for display in Mexico City time. Returns the input
 * unchanged if it is not a parseable instant — the server contract guarantees a valid `Z`
 * timestamp, so this only keeps the render path from throwing on unexpected data.
 */
export function formatInstant(iso: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) {
    return iso;
  }
  return INSTANT_FORMAT.format(instant);
}
