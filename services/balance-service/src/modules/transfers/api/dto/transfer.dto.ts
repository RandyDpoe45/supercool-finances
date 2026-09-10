/**
 * Customer-facing view of an internal transfer (a {@link Transaction}) on
 * `POST /api/transfers` and `POST /api/transfers/:id/confirm`. `amount` is a canonical
 * `bigint` minor-unit string (never float). The SOURCE is the caller's own account, so it
 * stays the account **id** (`sourceAccountId` — the UUID, exactly as `AccountDto.id` is
 * exposed to its owner); only the DESTINATION is shown as the HUMAN account **number**
 * (`destinationAccountNumber`, resolved by the service). The credit account UUID is NOT
 * exposed. Internal `initiatedBy` / `failureReason` and other columns are deliberately NOT
 * exposed. Timestamps are ISO-8601 UTC strings; `postedAt` is `null` while the transfer is
 * PENDING.
 */
export interface TransferDto {
  id: string;
  type: string;
  status: string;
  amount: string;
  currency: string;
  sourceAccountId: string | null;
  destinationAccountNumber: string | null;
  createdAt: string;
  postedAt: string | null;
}
