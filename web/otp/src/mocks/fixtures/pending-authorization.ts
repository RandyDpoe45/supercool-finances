import type { PendingAuthorizationDto } from '../../services/api/contracts/pending-authorization';

/**
 * Seed pending authorization for the MSW stub: one INTERNAL transfer awaiting OTP
 * confirm. Mirrors the server serializer — `amount` is a canonical minor-unit string,
 * timestamps are ISO-8601 UTC, and for an internal transfer the destination is the
 * human account number + masked holder name while `payeeDisplayName` is null.
 *
 * Swap this for `null` (see handlers) to exercise the no-pending case.
 */
export const fixturePendingAuthorization: PendingAuthorizationDto = {
  transferId: '33333333-3333-4333-8333-333333333333',
  type: 'internal',
  amount: '125000',
  currency: 'MXN',
  sourceAccountId: '11111111-1111-4111-8111-111111111111',
  destinationAccountNumber: '1000000002',
  destinationMaskedName: 'Jua** Per**',
  payeeDisplayName: null,
  createdAt: '2026-09-10T18:00:00.000Z',
  expiresAt: '2026-09-10T18:02:00.000Z',
};

/** The no-pending case: `GET /api/pending-authorization` returns `{ authorization: null }`. */
export const fixtureNoPendingAuthorization: PendingAuthorizationDto | null = null;
