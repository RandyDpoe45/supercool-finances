import type { PendingAuthorizationDto } from '../../services/api/contracts/pending-authorization';

/**
 * Seed pending authorizations for the MSW stub. Mirrors the server serializer: `amount` is a
 * canonical minor-unit string, timestamps are ISO-8601 UTC, and the destination fields are
 * type-dependent (internal → account number + masked name; external_outbound → payee name).
 *
 * Timestamps are computed RELATIVE TO NOW at module load so the dev demo shows a live
 * 2-minute countdown that actually lapses (matching the real deadline) rather than a fixed
 * instant that is perpetually in the past. The contract tests assert on shape/type, not on
 * the timestamp values, so this stays deterministic for them.
 */
const PENDING_WINDOW_MS = 2 * 60 * 1000;
const seededNowMs = Date.now();
const seededCreatedAt = new Date(seededNowMs).toISOString();
const seededExpiresAt = new Date(seededNowMs + PENDING_WINDOW_MS).toISOString();

/** One INTERNAL transfer awaiting OTP confirm (the default seed). */
export const fixturePendingAuthorization: PendingAuthorizationDto = {
  transferId: '33333333-3333-4333-8333-333333333333',
  type: 'internal',
  amount: '125000',
  currency: 'MXN',
  sourceAccountId: '11111111-1111-4111-8111-111111111111',
  destinationAccountNumber: '1000000002',
  destinationMaskedName: 'Jua** Per**',
  payeeDisplayName: null,
  createdAt: seededCreatedAt,
  expiresAt: seededExpiresAt,
};

/** One EXTERNAL_OUTBOUND transfer awaiting OTP confirm — exercises the payee-name branch of
 * the type-dependent rendering. Switch to it via `setMockPending` (see `../state`). */
export const fixtureExternalPendingAuthorization: PendingAuthorizationDto = {
  transferId: '44444444-4444-4444-8444-444444444444',
  type: 'external_outbound',
  amount: '5000000',
  currency: 'MXN',
  sourceAccountId: '11111111-1111-4111-8111-111111111111',
  destinationAccountNumber: null,
  destinationMaskedName: null,
  payeeDisplayName: 'Acme Utilities',
  createdAt: seededCreatedAt,
  expiresAt: seededExpiresAt,
};

/** The no-pending case: `GET /api/pending-authorization` returns `{ authorization: null }`. */
export const fixtureNoPendingAuthorization: PendingAuthorizationDto | null = null;
