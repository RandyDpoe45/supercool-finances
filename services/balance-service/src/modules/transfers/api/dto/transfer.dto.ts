/**
 * Customer-facing view of an internal transfer (a {@link Transaction}) on
 * `POST /api/transfers` and `POST /api/transfers/:id/confirm`. `amount` is a canonical
 * `bigint` minor-unit string (never float). The raw debit/credit account UUIDs are NOT
 * exposed — the wire shows the HUMAN account numbers (`sourceAccountNumber` /
 * `destinationAccountNumber`), resolved by the service. Internal `initiatedBy` /
 * `failureReason` and other columns are deliberately NOT exposed. Timestamps are ISO-8601
 * UTC strings; `postedAt` is `null` while the transfer is PENDING.
 */
export interface TransferDto {
  id: string;
  type: string;
  status: string;
  amount: string;
  currency: string;
  sourceAccountNumber: string | null;
  destinationAccountNumber: string | null;
  createdAt: string;
  postedAt: string | null;
}
