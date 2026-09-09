import { Account } from '../../../database/entities/account.entity';
import { LedgerEntry } from '../../../database/entities/ledger-entry.entity';

/** DI token for {@link IAccountsService}. Consumers (the `/api` surface controller) depend on
 * the interface via this token, never the concrete class. */
export const ACCOUNTS_SERVICE = Symbol('ACCOUNTS_SERVICE');

/** Owner-scoped, read-only customer account queries (spec 04 Accounts). Returns ENTITIES —
 * DTO serialization is a transport concern applied at the controller boundary. */
export interface IAccountsService {
  /** The caller's own accounts only (excludes system accounts). */
  listOwnedAccounts(ownerId: string): Promise<Account[]>;
  /** One account's statement (its ledger legs), owner-scoped; a missing/non-owned/system
   * account is indistinguishable to the caller (the service throws → 404). */
  getAccountStatement(
    accountId: string,
    ownerId: string,
  ): Promise<{ account: Account; entries: LedgerEntry[] }>;
}
