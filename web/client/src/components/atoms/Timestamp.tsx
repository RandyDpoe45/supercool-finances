import { formatInstant } from '../../lib/datetime';

/**
 * Renders a server ISO-8601 UTC instant in Mexico City time (the edge conversion). The
 * canonical UTC instant is preserved verbatim in the `<time dateTime>` attribute (machine
 * readable), while the visible text is the localized rendering.
 */
export function Timestamp({ iso }: { iso: string }) {
  return <time dateTime={iso}>{formatInstant(iso)}</time>;
}
