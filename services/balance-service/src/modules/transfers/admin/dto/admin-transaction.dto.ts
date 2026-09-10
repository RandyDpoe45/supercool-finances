/**
 * Admin-plane view of a {@link Transaction} on `GET /admin/transactions`. The admin is a trusted,
 * role-gated actor, so this view exposes MORE than the customer `TransferDto` — BOTH account legs
 * (`debitAccountId` / `creditAccountId`), the `initiatedBy` actor, `payeeId`,
 * `reversesTransactionId`, and `failureReason`. Every field is still listed EXPLICITLY (the
 * serializer never spreads the entity). `amount` is a canonical `bigint` minor-unit string;
 * timestamps are ISO-8601 UTC strings (or `null`).
 */
export interface AdminTransactionDto {
  id: string;
  type: string;
  status: string;
  amount: string;
  currency: string;
  debitAccountId: string | null;
  creditAccountId: string | null;
  payeeId: string | null;
  reversesTransactionId: string | null;
  initiatedBy: string;
  failureReason: string | null;
  createdAt: string;
  postedAt: string | null;
  failedAt: string | null;
  expiresAt: string | null;
}
