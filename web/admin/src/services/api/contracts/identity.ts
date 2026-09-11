/**
 * App-local copy of the balance-service admin `whoami` wire contract. Per ADR-16 the
 * admin-app keeps its own copy rather than importing from the service; it is kept in sync
 * via specs/07-frontends.md, the contract of record.
 *
 * `userId` is the gateway-resolved admin subject; `roles` are the realm roles carried on
 * the access token (e.g. `['admin']`). This is the identity the admin-plane gateway echoes
 * back once a bearer round-trips — the Step 1 proof that auth reaches the service.
 */
export interface WhoamiDto {
  userId: string;
  roles: string[];
}
