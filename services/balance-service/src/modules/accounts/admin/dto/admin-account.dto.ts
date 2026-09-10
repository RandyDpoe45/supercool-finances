/**
 * Admin-plane view of an {@link Account} on the `/admin/accounts` freeze/unfreeze routes. The
 * admin is a trusted, role-gated actor, so this view deliberately exposes MORE than the customer
 * `AccountDto` — notably `ownerId` (the account holder) and the account timestamps. Every field is
 * still listed EXPLICITLY (the serializer never spreads the entity): the internal spend counters
 * (`spentToday`/`spentMonth` + their window dates) and `systemKey` are NOT exposed even here.
 *
 * Money fields are canonical `bigint` minor-unit strings (never floats); `available` is derived
 * (`balance − held`). Timestamps are ISO-8601 UTC strings.
 */
export interface AdminAccountDto {
  id: string;
  ownerId: string | null;
  kind: string;
  currency: string;
  status: string;
  balance: string;
  held: string;
  available: string;
  accountNumber: string | null;
  createdAt: string;
  updatedAt: string;
}
