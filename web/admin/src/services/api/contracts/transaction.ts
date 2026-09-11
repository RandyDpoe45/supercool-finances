/**
 * App-local copy of the balance-service admin `GET /admin/transactions` wire contract. Per ADR-16
 * (self-contained components, no cross-folder imports) the admin-app keeps its own copy rather than
 * importing from the service or the sibling SPAs; it is kept in sync via specs/07-frontends.md, the
 * contract of record. Mirrors balance-service's admin `AdminTransactionDto` serializer output.
 *
 * The admin view is broader than the customer `TransferDto`: it exposes BOTH account legs
 * (`debitAccountId` / `creditAccountId`), the `initiatedBy` actor, `payeeId`,
 * `reversesTransactionId`, and `failureReason` — enough to drive the maker-checker reversals screen.
 *
 * `amount` is a canonical bigint minor-unit STRING (int64 precision) — NEVER parse it into a float;
 * render it via the float-free `Money` atom. `type` is one of `internal` / `external_outbound` /
 * `external_inbound`; `status` is one of `PENDING` / `POSTED` / `FAILED` / `REVERSED` / `EXPIRED` /
 * `CANCELLED` (left as open strings because the admin surface may see values beyond a bespoke set).
 * `createdAt` is an ISO-8601 UTC instant; `postedAt` / `failedAt` / `expiresAt` are the same or
 * `null` when the lifecycle stage has not occurred. `reversesTransactionId` is set only on a
 * compensating (reversal) transaction and points at the transaction it reverses.
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

/** Envelope returned by `GET /admin/transactions`. */
export interface AdminTransactionsResponse {
  transactions: AdminTransactionDto[];
}
