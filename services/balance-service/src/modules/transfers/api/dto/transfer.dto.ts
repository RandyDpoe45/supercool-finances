/**
 * Customer-facing view of an internal transfer (a {@link Transaction}) on
 * `POST /api/transfers`, `POST /api/transfers/:id/confirm`, and `POST /api/transfers/:id/cancel`.
 * `amount` is a canonical `bigint` minor-unit string (never float). The SOURCE is the caller's
 * own account, so it stays the account **id** (`sourceAccountId` — the UUID, exactly as
 * `AccountDto.id` is exposed to its owner); the destination account number is NOT echoed here
 * (the client supplied it at initiate / holds the id). The credit account UUID is NOT exposed.
 * Internal `initiatedBy` / `failureReason` / `failedAt` / `payeeId` / `reversesTransactionId` and
 * the raw credit UUID are deliberately NOT exposed. Timestamps are ISO-8601 UTC strings;
 * `expiresAt` is the 2-minute pending deadline (`null` once posted directly / never pending) and
 * `postedAt` is `null` while the transfer is PENDING.
 */
export interface TransferDto {
  id: string;
  type: string;
  status: string;
  amount: string;
  currency: string;
  sourceAccountId: string | null;
  createdAt: string;
  expiresAt: string | null;
  postedAt: string | null;
}
