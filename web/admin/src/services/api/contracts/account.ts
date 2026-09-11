/**
 * App-local copy of the balance-service admin `GET /admin/accounts` (+ freeze/unfreeze) wire
 * contract. Per ADR-16 (self-contained components, no cross-folder imports) the admin-app keeps
 * its own copy rather than importing from the service or the sibling SPAs; it is kept in sync via
 * specs/07-frontends.md, the contract of record. Mirrors balance-service's admin `AccountDto`
 * serializer output.
 *
 * The admin view is broader than the customer view: it exposes `ownerId` (the account's owning
 * customer, null on system/clearing accounts) so an operator can see and filter by owner.
 *
 * Money fields (`balance`, `held`, `available`) are canonical bigint minor-unit STRINGS — NEVER
 * parse them into a float. `available` is derived server-side as `balance - held` and is never
 * stored. `createdAt`/`updatedAt` are ISO-8601 UTC instants (rendered in Mexico City time at the
 * edge, per spec 07). `status`/`kind` are left as open strings because the admin surface may see
 * lifecycle/kinds beyond the customer-visible `active`/`frozen` set.
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

/** Envelope returned by `GET /admin/accounts`. */
export interface AdminAccountsResponse {
  accounts: AdminAccountDto[];
}
