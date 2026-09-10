/**
 * One PENDING transfer awaiting the caller's OTP confirm, on
 * `GET /api/pending-authorizations` (the OTP app's feed). A pared-down view: enough to show
 * what the user is about to authorize, with no internal columns. The wire shows the HUMAN
 * account numbers plus the destination holder's MASKED name (`destinationMaskedName`, e.g.
 * `"Jua** Per**"`) so the app can render who the payment is to without disclosing the full
 * name. `amount` is a canonical `bigint` minor-unit string; `createdAt` is an ISO-8601 UTC
 * string.
 */
export interface PendingAuthorizationDto {
  transferId: string;
  type: string;
  amount: string;
  currency: string;
  sourceAccountNumber: string | null;
  destinationAccountNumber: string | null;
  destinationMaskedName: string;
  createdAt: string;
}
