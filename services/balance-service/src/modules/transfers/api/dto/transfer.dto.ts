/**
 * Customer-facing view of an internal transfer (a {@link Transaction}) on
 * `POST /api/transfers` and `POST /api/transfers/:id/confirm`. `amount` is a canonical
 * `bigint` minor-unit string (never float). The header's `debit`/`credit` account ids are
 * exposed as `source`/`destination`; internal `initiatedBy` / `failureReason` and other
 * columns are deliberately NOT exposed. Timestamps are ISO-8601 UTC strings; `postedAt` is
 * `null` while the transfer is PENDING.
 */
export interface TransferDto {
  id: string;
  type: string;
  status: string;
  amount: string;
  currency: string;
  sourceAccountId: string;
  destinationAccountId: string;
  createdAt: string;
  postedAt: string | null;
}
