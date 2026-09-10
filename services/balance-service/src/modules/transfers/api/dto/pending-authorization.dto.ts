/**
 * The caller's SINGLE active PENDING transfer awaiting OTP confirm, on
 * `GET /api/pending-authorization` (the OTP app's feed). A pared-down view: enough to show what
 * the user is about to authorize, with no internal columns. The SOURCE is the caller's own
 * account, so it stays the account **id** (`sourceAccountId` — the UUID). The DESTINATION depends
 * on `type`:
 * - **internal** — the HUMAN account **number** (`destinationAccountNumber`) plus the destination
 *   holder's MASKED name (`destinationMaskedName`, e.g. `"Jua** Per**"`) so the app renders who
 *   the payment is to without disclosing the full name; `payeeDisplayName` is null.
 * - **external_outbound** — the enrolled payee's `payeeDisplayName` (the caller's own label);
 *   `destinationAccountNumber` and `destinationMaskedName` are null.
 *
 * `amount` is a canonical `bigint` minor-unit string; `createdAt` / `expiresAt` (the 2-minute
 * deadline) are ISO-8601 UTC strings.
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
