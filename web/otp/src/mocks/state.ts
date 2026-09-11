import type { PendingAuthorizationDto } from '../services/api/contracts/pending-authorization';
import { fixturePendingAuthorization } from './fixtures/pending-authorization';

/**
 * Mutable dev/test state for the MSW stub, isolated here so tests can reset it between cases:
 * `server.resetHandlers()` resets registered HANDLERS but not module-level state like this.
 *
 * Holds two things:
 * - `pending` — the caller's single pending authorization (or `null`), so a test/dev can
 *   swap between the internal and external fixtures (and the no-pending case).
 * - `otpActiveUntilMs` — the singleton gate for `POST /api/otp`: while a minted code is
 *   still within its ttl, a second mint is rejected 409; once the ttl elapses, minting is
 *   allowed again. This mirrors the server's active-code slot (freed on consume or expiry).
 */
interface MockState {
  pending: PendingAuthorizationDto | null;
  otpActiveUntilMs: number | null;
}

const state: MockState = {
  pending: fixturePendingAuthorization,
  otpActiveUntilMs: null,
};

/** The pending authorization the GET feed should return. */
export function getMockPending(): PendingAuthorizationDto | null {
  return state.pending;
}

/** Swap the seeded pending (internal ↔ external ↔ null) for a dev scenario or a test. */
export function setMockPending(pending: PendingAuthorizationDto | null): void {
  state.pending = pending;
}

/** True while a minted code is still within its ttl (the singleton slot is claimed). */
export function isOtpActive(nowMs: number): boolean {
  return state.otpActiveUntilMs !== null && nowMs < state.otpActiveUntilMs;
}

/** Claim the singleton slot until `untilMs` (set on a successful mint). */
export function markOtpActive(untilMs: number): void {
  state.otpActiveUntilMs = untilMs;
}

/** Restore the default seed (internal pending, no active code) so tests start clean. */
export function resetMockState(): void {
  state.pending = fixturePendingAuthorization;
  state.otpActiveUntilMs = null;
}
