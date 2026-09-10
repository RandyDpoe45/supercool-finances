/**
 * App-local copy of the balance-service `GET /api/accounts` wire contract.
 *
 * Per ADR-16 (self-contained components, no cross-folder imports) this SPA keeps its
 * own copy of the contract rather than importing from the service; it is kept in sync
 * via specs/07-frontends.md and specs/balance-schema.yaml, which are the contract of
 * record. Mirrors balance-service's `AccountDto` serializer output.
 *
 * Money fields (`balance`, `held`, `available`) are canonical bigint minor-unit
 * strings — NEVER parse them into a float. `available` is derived server-side as
 * `balance - held` and is never stored.
 */
export type AccountStatus = 'active' | 'frozen';
export type AccountKind = 'customer' | 'system';

export interface AccountDto {
  id: string;
  currency: string;
  status: AccountStatus;
  kind: AccountKind;
  balance: string;
  held: string;
  available: string;
  /** Human destination identifier for a customer account; null on system accounts. */
  accountNumber: string | null;
}

/** Envelope returned by `GET /api/accounts`. */
export interface AccountsResponse {
  accounts: AccountDto[];
}
