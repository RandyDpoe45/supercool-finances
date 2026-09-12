import {
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { runInTransactionWithRetry } from '../../../../common/db/run-in-transaction';
import { Account } from '../../../../database/entities/account.entity';
import { AccountKind, AccountStatus } from '../../../../database/entities/enums';
import { LedgerEntry } from '../../../../database/entities/ledger-entry.entity';
import {
  ACCOUNT_REPOSITORY,
  IAccountRepository,
} from '../../../../database/repositories/interfaces/account.repository.interface';
import {
  CUSTOMER_REPOSITORY,
  ICustomerRepository,
} from '../../../../database/repositories/interfaces/customer.repository.interface';
import {
  ILedgerEntryRepository,
  LEDGER_ENTRY_REPOSITORY,
} from '../../../../database/repositories/interfaces/ledger-entry.repository.interface';
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICE,
  IAuditService,
} from '../../../audit/service/interfaces/audit.service.interface';
import {
  AccountLimitReachedError,
  AccountNotFoundError,
  AccountNotFreezableError,
  CustomerNotFoundError,
} from '../errors';
import { IAccountsService, ListAccountsQuery } from '../interfaces/accounts.service.interface';
import { generateAccountNumber } from './account-number';

/** Upper bound on ledger legs returned by one statement read. The underlying query
 * MUST stay bounded — an account's history is unbounded, so it is never scanned whole. */
export const STATEMENT_PAGE_LIMIT = 100;

/** The per-customer cap on self-service (`kind = customer`) accounts. An over-cap create is
 * rejected with {@link AccountLimitReachedError} (→ 422). The cap is checked under the per-owner
 * advisory lock, so a concurrent double-create cannot exceed it. */
export const MAX_CUSTOMER_ACCOUNTS = 5;

/** The single seeded currency (prototype seeds MXN only — see the CreateBalanceCore migration).
 * A self-created account is always MXN; the currency is never taken from the request. */
const SEEDED_CURRENCY = 'MXN';

/** The `uq_account_account_number` unique index — a generated 10-digit account number that
 * collides with an existing one raises SQLSTATE 23505 on it; the create then regenerates and
 * retries (bounded). A collision is astronomically rare over the 10^10 space. */
const ACCOUNT_NUMBER_UNIQUE_CONSTRAINT = 'uq_account_account_number';

/** Total attempts to mint a unique account number before giving up (each attempt regenerates the
 * number and re-runs the create transaction). Bounded so a pathological run can never livelock. */
const ACCOUNT_NUMBER_MAX_ATTEMPTS = 5;

/**
 * True iff the error is (or wraps) a Postgres unique violation on
 * {@link ACCOUNT_NUMBER_UNIQUE_CONSTRAINT} — the account-number index. TypeORM surfaces the driver
 * error as `QueryFailedError`; the SQLSTATE + constraint live on the error or its `driverError`, so
 * both are checked (mirrors the transfers single-pending / payees enrollment helpers). Scoped to
 * this ONE constraint so a create retries only on an account-number collision — never on the
 * per-owner cap, a missing customer, or a validation error, which must propagate.
 */
function isAccountNumberUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as {
    code?: unknown;
    constraint?: unknown;
    driverError?: { code?: unknown; constraint?: unknown };
  };
  const code = candidate.code ?? candidate.driverError?.code;
  const constraint = candidate.constraint ?? candidate.driverError?.constraint;
  return code === '23505' && constraint === ACCOUNT_NUMBER_UNIQUE_CONSTRAINT;
}

/** Paging bounds for the admin account list ({@link AccountsService.listAccounts}), mirroring the
 * transfers admin list: a missing `limit` defaults to {@link ADMIN_LIST_DEFAULT_LIMIT}; a larger
 * request is clamped to {@link ADMIN_LIST_MAX_LIMIT}, so the account table is never scanned
 * unbounded. */
const ADMIN_LIST_DEFAULT_LIMIT = 50;
const ADMIN_LIST_MAX_LIMIT = 200;

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
  // NOTE: the repo params stay FIRST (in their step-1 order) — DI binds each param by its decorator
  // regardless of position, so `dataSource`/`audit` are appended without disturbing existing
  // positional instantiation of this service.
  constructor(
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: IAccountRepository,
    @Inject(LEDGER_ENTRY_REPOSITORY) private readonly ledger: ILedgerEntryRepository,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(AUDIT_SERVICE) private readonly audit: IAuditService,
    @Inject(CUSTOMER_REPOSITORY) private readonly customers: ICustomerRepository,
  ) {}

  /** The caller's own accounts only — `findByOwner` excludes system accounts (NULL owner). */
  async listOwnedAccounts(ownerId: string): Promise<Account[]> {
    assertOwnerScope(ownerId);
    return this.accounts.findByOwner(ownerId);
  }

  /**
   * Customer self-service account creation (spec 04 `POST /api/accounts`). MONEY-SAFETY: the new
   * account is minted at `balance = '0'` / `held = '0'` with every spend counter `'0'` — a
   * self-service create can never seed funds and moves no money, so it writes NO ledger / outbox /
   * OTP / audit row.
   *
   * Each attempt runs ONE {@link runInTransactionWithRetry} tx (which itself retries on a deadlock).
   * Inside the tx, in order: (a) take the per-owner advisory lock so a concurrent double-create
   * serializes; (b) reject an owner with no `customer` row (the `owner_id` FK precondition →
   * CUSTOMER_NOT_FOUND); (c) count the owner's customer accounts and reject an over-cap create
   * (→ ACCOUNT_LIMIT_REACHED) — the count-then-insert is atomic under the lock, so the cap holds
   * under a race; (d) read the current spend window (for the NOT-NULL counter dates); (e) insert.
   *
   * The `account_number` UNIQUE index makes a collision on the generated number astronomically
   * rare; on that ONE constraint (23505) the whole attempt is retried with a freshly generated
   * number (bounded). The cap / missing-customer / validation errors are NOT retryable — they
   * propagate immediately.
   */
  async createAccount(ownerId: string, input: { label: string }): Promise<Account> {
    assertOwnerScope(ownerId);
    const { label } = input;

    let lastCollision: unknown;
    for (let attempt = 0; attempt < ACCOUNT_NUMBER_MAX_ATTEMPTS; attempt += 1) {
      const accountNumber = generateAccountNumber();
      try {
        return await runInTransactionWithRetry(this.dataSource, async (queryRunner) => {
          await this.accounts.lockOwnerForAccountCreation(queryRunner, ownerId);

          const customerExists = await this.customers.existsByIdInTx(queryRunner, ownerId);
          if (!customerExists) {
            throw new CustomerNotFoundError(ownerId);
          }

          const existingCount = await this.accounts.countCustomerAccountsByOwner(
            queryRunner,
            ownerId,
          );
          if (existingCount >= MAX_CUSTOMER_ACCOUNTS) {
            throw new AccountLimitReachedError(MAX_CUSTOMER_ACCOUNTS);
          }

          const { today, monthStart } = await this.accounts.currentSpendWindowInTx(queryRunner);
          return this.accounts.createInTx(queryRunner, {
            ownerId,
            kind: AccountKind.Customer,
            currency: SEEDED_CURRENCY,
            status: AccountStatus.Active,
            balance: '0',
            held: '0',
            spentToday: '0',
            spentMonth: '0',
            spentTodayDate: today,
            spentMonthDate: monthStart,
            accountNumber,
            label,
          });
        });
      } catch (error) {
        // Retry ONLY on an account-number collision, and only while attempts remain; every other
        // error (the cap, a missing customer, a validation fault, a non-account-number DB error)
        // propagates unchanged.
        if (isAccountNumberUniqueViolation(error) && attempt < ACCOUNT_NUMBER_MAX_ATTEMPTS - 1) {
          lastCollision = error;
          continue;
        }
        throw error;
      }
    }

    // Exhausted every attempt on repeated account-number collisions — astronomically improbable
    // over the 10^10 space; surfaced as the last collision so it never masquerades as success.
    throw lastCollision ?? new Error('Failed to generate a unique account number');
  }

  /**
   * Admin `GET /admin/accounts` — view ANY account (spec 04 "Admin ops"). DELIBERATELY NOT
   * owner-scoped: every OTHER account read binds `owner_id`, but the role-gated admin surface may
   * see any owner's accounts (and system/clearing accounts), so this method omits the owner
   * predicate ON PURPOSE and applies NO `assertOwnerScope`. A pure READ (no audit). It CLAMPS the
   * requested paging — an over-large `limit` is capped to {@link ADMIN_LIST_MAX_LIMIT} and a
   * negative/absent `offset`/`limit` floored/defaulted — so an admin can never ask the DB for an
   * unbounded scan, then delegates to the parameterized repo query.
   */
  listAccounts(query: ListAccountsQuery): Promise<Account[]> {
    const limit = Math.min(
      Math.max(query.limit ?? ADMIN_LIST_DEFAULT_LIMIT, 1),
      ADMIN_LIST_MAX_LIMIT,
    );
    const offset = Math.max(query.offset ?? 0, 0);
    return this.accounts.queryAccounts({ ownerId: query.ownerId, limit, offset });
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

  /**
   * Admin single-actor freeze / unfreeze (spec 04 "Admin ops"). ONE transaction: lock the account
   * `FOR UPDATE` (so a concurrent flip serializes and the audited `previousStatus` is truthful),
   * reject a missing account (→ 404) or a system/clearing account (→ 409), flip `status`, and write
   * the audit row via {@link IAuditService.recordInTx} in the SAME tx — the change and its audit
   * commit or roll back together. The updated row is re-read AFTER commit so the returned entity
   * carries the DB-stamped `updated_at`.
   */
  async setFrozen(actorId: string, accountId: string, frozen: boolean): Promise<Account> {
    const newStatus = frozen ? AccountStatus.Frozen : AccountStatus.Active;
    await runInTransactionWithRetry(this.dataSource, async (queryRunner) => {
      const account = await this.accounts.lockByIdForUpdate(queryRunner, accountId);
      if (!account) {
        throw new AccountNotFoundError(accountId);
      }
      if (account.kind !== AccountKind.Customer) {
        throw new AccountNotFreezableError(accountId);
      }
      const previousStatus = account.status;
      await this.accounts.updateStatusInTx(queryRunner, accountId, newStatus);
      await this.audit.recordInTx(queryRunner, {
        actorId,
        action: frozen ? AUDIT_ACTIONS.ACCOUNT_FREEZE : AUDIT_ACTIONS.ACCOUNT_UNFREEZE,
        targetType: 'account',
        targetId: accountId,
        metadata: { previousStatus, newStatus },
      });
    });

    const updated = await this.accounts.findById(accountId);
    if (!updated) {
      // Unreachable: the row was locked and updated in the just-committed transaction.
      throw new AccountNotFoundError(accountId);
    }
    return updated;
  }
}
