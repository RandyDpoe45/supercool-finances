/**
 * Customer-facing view of an {@link Account} on `GET /api/accounts`. Money fields are
 * canonical `bigint` minor-unit strings (never floats). `available` is derived
 * (`balance − held`), never stored — see `common/money/money.ts`.
 */
export interface AccountDto {
  id: string;
  currency: string;
  status: string;
  kind: string;
  balance: string;
  held: string;
  available: string;
}
