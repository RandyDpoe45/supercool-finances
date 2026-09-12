import { Account } from '../../../../database/entities/account.entity';
import { LedgerEntry } from '../../../../database/entities/ledger-entry.entity';

/** DI token for {@link IAccountsService}. Consumers (the `/api` surface controller) depend on
 * the interface via this token, never the concrete class. */
export const ACCOUNTS_SERVICE = Symbol('ACCOUNTS_SERVICE');

/** The admin account-list query ({@link IAccountsService.listAccounts}, `GET /admin/accounts`).
 * `ownerId` optional (absent → any owner); `limit` / `offset` are the caller's requested paging and
 * are CLAMPED by the service (default 50, max 200, offset ≥ 0). */
export interface ListAccountsQuery {
  ownerId?: string;
  limit?: number;
  offset?: number;
}

/** Owner-scoped customer account queries (spec 04 Accounts) plus the admin freeze/unfreeze op.
 * Returns ENTITIES — DTO serialization is a transport concern applied at the controller boundary.
 * The `/api` reads are owner-scoped; {@link setFrozen} is an `/admin` (role-gated) action. */
export interface IAccountsService {
  /** The caller's own accounts only (excludes system accounts). */
  listOwnedAccounts(ownerId: string): Promise<Account[]>;
  /**
   * Customer self-service account creation (spec 04 `POST /api/accounts`). Mints a NEW customer
   * account owned by `ownerId` (the trusted gateway identity, never the body), minted at
   * `balance = 0` / `held = 0` with all spend counters zeroed — a self-service create can NEVER
   * seed funds and moves no money (no ledger / outbox / OTP / audit row). Under a per-owner
   * advisory lock: rejects an owner with no `customer` row (→ 404 CUSTOMER_NOT_FOUND) and an
   * over-cap create (→ 422 ACCOUNT_LIMIT_REACHED); the cap holds even under a concurrent
   * double-create. Generates a unique 10-digit `account_number` (bounded retry on the rare unique
   * collision). Returns the created ENTITY; the controller serializes it.
   */
  createAccount(ownerId: string, input: { label: string }): Promise<Account>;
  /**
   * Admin `GET /admin/accounts` — view ANY account (spec 04 "Admin ops"). DELIBERATELY NOT
   * owner-scoped: unlike the owner-scoped `/api` account reads, this returns accounts for any owner
   * (and system/clearing accounts) for the role-gated admin surface only. Clamps the requested
   * paging (default 50, max 200, offset ≥ 0 — never an unbounded scan) and delegates to the
   * repository's parameterized query. A pure READ — it writes NO audit row. Returns entities; the
   * controller serializes them.
   */
  listAccounts(query: ListAccountsQuery): Promise<Account[]>;
  /** One account's statement (its ledger legs), owner-scoped; a missing/non-owned/system
   * account is indistinguishable to the caller (the service throws → 404). */
  getAccountStatement(
    accountId: string,
    ownerId: string,
  ): Promise<{ account: Account; entries: LedgerEntry[] }>;
  /**
   * Admin single-actor freeze / unfreeze of a CUSTOMER account (spec 04 "Admin ops"). In ONE
   * transaction, under the account's `FOR UPDATE` lock: read the account (missing → 404), reject a
   * system/clearing account (409), flip `status` to `frozen`/`active`, and write ONE audit row in
   * the SAME transaction (`actorId` = the admin's gateway identity; before/after status in the
   * metadata). A frozen account can still be CREDITED — only customer debits are blocked. Returns
   * the updated account entity.
   */
  setFrozen(actorId: string, accountId: string, frozen: boolean): Promise<Account>;
}
