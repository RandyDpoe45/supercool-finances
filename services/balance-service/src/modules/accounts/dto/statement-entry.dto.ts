/**
 * One ledger leg in an account's statement on `GET /api/accounts/:id/transactions`.
 * `delta` (signed) and `balanceAfter` (the running fold) are canonical `bigint`
 * minor-unit strings; `createdAt` is an ISO-8601 UTC instant.
 */
export interface StatementEntryDto {
  id: string;
  transactionId: string;
  delta: string;
  balanceAfter: string;
  currency: string;
  createdAt: string;
}
