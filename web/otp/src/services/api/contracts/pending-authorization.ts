/**
 * App-local copy of the balance-service `GET /api/pending-authorization` wire contract
 * (the OTP app's feed).
 *
 * Per ADR-16 (self-contained components, no cross-folder imports) this SPA keeps its
 * own copy of the contract rather than importing from the service; it is kept in sync
 * via specs/07-frontends.md, which is the contract of record. Mirrors balance-service's
 * `PendingAuthorizationDto` + `serializePendingAuthorization` output.
 *
 * `amount` is a canonical bigint minor-unit string — NEVER parse it into a float.
 * `createdAt` / `expiresAt` are ISO-8601 UTC instants (Mexico City conversion is an
 * app-edge concern added with the code-reveal UI in O2). Destination shape depends on
 * `type`:
 * - `internal` — `destinationAccountNumber` + `destinationMaskedName`; `payeeDisplayName` null.
 * - `external_outbound` — `payeeDisplayName`; both destination fields null.
 */
export interface PendingAuthorizationDto {
  transferId: string;
  type: string;
  amount: string;
  currency: string;
  sourceAccountId: string | null;
  destinationAccountNumber: string | null;
  destinationMaskedName: string | null;
  payeeDisplayName: string | null;
  createdAt: string;
  expiresAt: string | null;
}

/** Envelope returned by `GET /api/pending-authorization` — `null` when the caller has
 * no active pending transfer awaiting confirm. */
export interface PendingAuthorizationResponse {
  authorization: PendingAuthorizationDto | null;
}
