import { formatCountdown } from '../../lib/countdown';
import { useCountdown } from '../../lib/useCountdown';

/**
 * Live `m:ss` countdown to `deadlineMs` (epoch ms). Renders `expiredLabel` once the
 * deadline passes (or when there is no deadline). Ticks via {@link useCountdown}, which
 * tears down its timer at zero.
 */
export function Countdown({
  deadlineMs,
  expiredLabel = 'expired',
}: {
  deadlineMs: number | null;
  expiredLabel?: string;
}) {
  const secondsLeft = useCountdown(deadlineMs);
  if (deadlineMs === null || secondsLeft <= 0) {
    return <span className="countdown countdown--expired">{expiredLabel}</span>;
  }
  return <span className="countdown">{formatCountdown(secondsLeft)}</span>;
}
