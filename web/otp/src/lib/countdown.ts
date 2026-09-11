/**
 * Pure ttl/countdown math for the otp-app. No React, no `Date.now()` inside — callers pass
 * `now` so the functions stay deterministic (and trivially testable). Both the 2-minute
 * pending-authorization deadline and the revealed code's ttl are rendered through these.
 */

/** Whole seconds remaining until `deadlineMs` (epoch ms), floored at 0 once it lapses. */
export function remainingSeconds(deadlineMs: number, nowMs: number): number {
  const diffMs = deadlineMs - nowMs;
  return diffMs <= 0 ? 0 : Math.ceil(diffMs / 1000);
}

/** Format a non-negative whole-second count as `m:ss` (e.g. `119` → `"1:59"`). */
export function formatCountdown(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
