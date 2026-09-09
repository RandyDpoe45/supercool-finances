import {
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Account } from '../../../database/entities/account.entity';
import { LedgerEntry } from '../../../database/entities/ledger-entry.entity';
import {
  ACCOUNT_REPOSITORY,
  IAccountRepository,
} from '../../../database/repositories/interfaces/account.repository.interface';
import {
  ILedgerEntryRepository,
  LEDGER_ENTRY_REPOSITORY,
} from '../../../database/repositories/interfaces/ledger-entry.repository.interface';
import { IAccountsService } from '../interfaces/accounts.service.interface';

/** Upper bound on ledger legs returned by one statement read. The underlying query
 * MUST stay bounded — an account's history is unbounded, so it is never scanned whole. */
export const STATEMENT_PAGE_LIMIT = 100;

/**
 * Fail-closed guard on the owner scope. An empty `ownerId` would let TypeORM drop the
 * `owner_id` predicate — returning others' rows (an IDOR). The GatewayIdentityGuard makes
 * this unreachable today; this keeps the anti-IDOR predicate structurally impossible to
 * lose under a future refactor. Purely a "predicate can't be empty" assertion — not
 * identity-semantics validation; a broken invariant is an internal fault (500), not a 4xx.
 */
function assertOwnerScope(ownerId: string): void {
  if (!ownerId || ownerId.trim().length === 0) {
    throw new InternalServerErrorException('Missing owner scope');
  }
}

/**
 * Read-only customer account queries (spec 04 Accounts, first domain slice — no money
 * movement). Every read is owner-scoped: the caller's `userId` comes from the trusted
 * gateway identity, never from the request body/query. The service works in ENTITIES —
 * DTO serialization is a transport concern applied at the controller boundary.
 */
@Injectable()
export class AccountsService implements IAccountsService {
  constructor(
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: IAccountRepository,
    @Inject(LEDGER_ENTRY_REPOSITORY) private readonly ledger: ILedgerEntryRepository,
  ) {}

  /** The caller's own accounts only — `findByOwner` excludes system accounts (NULL owner). */
  async listOwnedAccounts(ownerId: string): Promise<Account[]> {
    assertOwnerScope(ownerId);
    return this.accounts.findByOwner(ownerId);
  }

  /**
   * One account's statement (its ledger legs), owner-scoped. Ownership is verified on
   * the nested resource — the account itself, not just the id echoed back — INSIDE the
   * repo query; a missing, non-owned, or system account is indistinguishable → 404
   * (never 403), so existence can't be probed by enumeration (anti-IDOR, ADR-3).
   */
  async getAccountStatement(
    accountId: string,
    ownerId: string,
  ): Promise<{ account: Account; entries: LedgerEntry[] }> {
    assertOwnerScope(ownerId);
    const account = await this.accounts.findByIdAndOwner(accountId, ownerId);
    if (!account) {
      throw new NotFoundException('Account not found');
    }
    const entries = await this.ledger.findByAccount(account.id, STATEMENT_PAGE_LIMIT);
    return { account, entries };
  }
}
