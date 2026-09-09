/**
 * One PENDING transfer awaiting the caller's OTP confirm, on
 * `GET /api/pending-authorizations` (the OTP app's feed). A pared-down view: enough to show
 * what the user is about to authorize, with no internal columns. `amount` is a canonical
 * `bigint` minor-unit string; `createdAt` is an ISO-8601 UTC string.
 */
export interface PendingAuthorizationDto {
  transferId: string;
  type: string;
  amount: string;
  currency: string;
  sourceAccountId: string;
  destinationAccountId: string;
  createdAt: string;
}
