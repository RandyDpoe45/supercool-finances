import { Account } from '../../../../database/entities/account.entity';
import { LedgerEntry } from '../../../../database/entities/ledger-entry.entity';

/** DI token for {@link IAccountsService}. Consumers (the `/api` surface controller) depend on
 * the interface via this token, never the concrete class. */
export const ACCOUNTS_SERVICE = Symbol('ACCOUNTS_SERVICE');

/** Owner-scoped customer account queries (spec 04 Accounts) plus the admin freeze/unfreeze op.
 * Returns ENTITIES — DTO serialization is a transport concern applied at the controller boundary.
 * The `/api` reads are owner-scoped; {@link setFrozen} is an `/admin` (role-gated) action. */
export interface IAccountsService {
  /** The caller's own accounts only (excludes system accounts). */
  listOwnedAccounts(ownerId: string): Promise<Account[]>;
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
