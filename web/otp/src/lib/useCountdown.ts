import { useEffect, useState } from 'react';
import { remainingSeconds } from './countdown';

/**
 * Live whole-seconds countdown to `deadlineMs` (epoch ms), re-rendering ~once/second and
 * settling at 0 once the deadline passes. `deadlineMs === null` means "no active deadline"
 * → 0 with no timer. The interval is torn down on unmount and when the deadline changes, and
 * it stops itself at 0 — so a revealed one-time code never keeps a timer (or itself) alive
 * past its ttl.
 */
export function useCountdown(deadlineMs: number | null): number {
  const [secondsLeft, setSecondsLeft] = useState(() =>
    deadlineMs === null ? 0 : remainingSeconds(deadlineMs, Date.now()),
  );

  useEffect(() => {
    if (deadlineMs === null) {
      setSecondsLeft(0);
      return;
    }
    // Recompute immediately (the deadline may have just changed), then each second.
    setSecondsLeft(remainingSeconds(deadlineMs, Date.now()));
    const id = setInterval(() => {
      const left = remainingSeconds(deadlineMs, Date.now());
      setSecondsLeft(left);
      if (left <= 0) {
        clearInterval(id);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [deadlineMs]);

  return secondsLeft;
}
