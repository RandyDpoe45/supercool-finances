import {
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { availableBalance } from '../../common/money/money';
import { Account } from '../../database/entities/account.entity';
import { LedgerEntry } from '../../database/entities/ledger-entry.entity';
import {
  ACCOUNT_REPOSITORY,
  IAccountRepository,
} from '../../database/repositories/account.repository.interface';
import {
  ILedgerEntryRepository,
  LEDGER_ENTRY_REPOSITORY,
} from '../../database/repositories/ledger-entry.repository.interface';
import { AccountDto } from './dto/account.dto';
import { StatementEntryDto } from './dto/statement-entry.dto';

/** Upper bound on ledger legs returned by one statement read. The underlying query
 * MUST stay bounded — an account's history is unbounded, so it is never scanned whole. */
export const STATEMENT_PAGE_LIMIT = 100;

/** Pure entity→DTO map; `available` is derived, never read from storage. */
export function toAccountDto(account: Account): AccountDto {
  return {
    id: account.id,
    currency: account.currency,
    status: account.status,
    kind: account.kind,
    balance: account.balance,
    held: account.held,
    available: availableBalance(account.balance, account.held),
  };
}

/** Pure entity→DTO map; `createdAt` is rendered as an ISO-8601 UTC instant. */
export function toStatementEntryDto(entry: LedgerEntry): StatementEntryDto {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    delta: entry.delta,
    balanceAfter: entry.balanceAfter,
    currency: entry.currency,
    createdAt: entry.createdAt.toISOString(),
  };
}

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
 * gateway identity, never from the request body/query.
 */
@Injectable()
export class AccountsService {
  constructor(
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: IAccountRepository,
    @Inject(LEDGER_ENTRY_REPOSITORY) private readonly ledger: ILedgerEntryRepository,
  ) {}

  /** The caller's own accounts only — `findByOwner` excludes system accounts (NULL owner). */
  async listOwnedAccounts(ownerId: string): Promise<{ accounts: AccountDto[] }> {
    assertOwnerScope(ownerId);
    const rows = await this.accounts.findByOwner(ownerId);
    return { accounts: rows.map(toAccountDto) };
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
  ): Promise<{ accountId: string; entries: StatementEntryDto[] }> {
    assertOwnerScope(ownerId);
    const account = await this.accounts.findByIdAndOwner(accountId, ownerId);
    if (!account) {
      throw new NotFoundException('Account not found');
    }
    const entries = await this.ledger.findByAccount(account.id, STATEMENT_PAGE_LIMIT);
    return { accountId: account.id, entries: entries.map(toStatementEntryDto) };
  }
}
