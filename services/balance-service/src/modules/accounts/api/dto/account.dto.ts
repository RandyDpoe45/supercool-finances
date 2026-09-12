/**
 * Customer-facing view of an {@link Account} on `GET /api/accounts`. Money fields are
 * canonical `bigint` minor-unit strings (never floats). `available` is derived
 * (`balance − held`), never stored — see `common/money/money.ts`. `accountNumber` is the
 * owner's human account number (the transfer destination identifier); `null` on system
 * accounts, though owner-scoped reads only ever return the caller's own customer accounts.
 * `label` is the customer-chosen display name set at self-service creation; `null` on
 * seeded/system accounts.
 */
export interface AccountDto {
  id: string;
  currency: string;
  status: string;
  kind: string;
  balance: string;
  held: string;
  available: string;
  accountNumber: string | null;
  label: string | null;
}
