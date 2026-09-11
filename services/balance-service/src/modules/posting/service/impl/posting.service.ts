import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { runInTransactionWithRetry } from '../../../../common/db/run-in-transaction';
import { addMinor, availableMinor, sumMinor } from '../../../../common/money/money';
import { Account } from '../../../../database/entities/account.entity';
import { AccountKind, AccountStatus, TransactionStatus } from '../../../../database/entities/enums';
import { Transaction } from '../../../../database/entities/transaction.entity';
import {
  ACCOUNT_REPOSITORY,
  IAccountRepository,
} from '../../../../database/repositories/interfaces/account.repository.interface';
import {
  ILedgerEntryRepository,
  LEDGER_ENTRY_REPOSITORY,
} from '../../../../database/repositories/interfaces/ledger-entry.repository.interface';
import {
  IOutboxEventRepository,
  OUTBOX_EVENT_REPOSITORY,
} from '../../../../database/repositories/interfaces/outbox-event.repository.interface';
import {
  ITransactionRepository,
  TRANSACTION_REPOSITORY,
} from '../../../../database/repositories/interfaces/transaction.repository.interface';
import {
  IUserLimitsRepository,
  USER_LIMITS_REPOSITORY,
} from '../../../../database/repositories/interfaces/user-limits.repository.interface';
import { PostingLeg, PostTransactionCommand } from '../interfaces/post-transaction.command';
import {
  AccountFrozenError,
  AccountNotFoundError,
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidPostingCommandError,
  LimitExceededError,
  TransactionNotPendingError,
} from '../errors';
import {
  buildFailedPayload,
  TRANSACTION_FAILED_EVENT,
  TRANSACTION_POSTED_EVENT,
  TransactionEventLeg,
  TransactionEventPayee,
  TransactionPostedPayload,
} from '../interfaces/transaction-event';
import { IPostingService } from '../interfaces/posting.service.interface';

/** Canonical minor-unit string shapes. A signed integer for a leg delta, an unsigned integer
 * for the amount magnitude. Validated BEFORE any `BigInt()` so a malformed string raises the
 * domain error, not a raw `SyntaxError`. */
const SIGNED_MINOR_UNITS = /^-?\d+$/;
const UNSIGNED_MINOR_UNITS = /^\d+$/;

/** A leg after validation, carrying its computed post-fold `balance_after`. */
interface AppliedLeg {
  accountId: string;
  delta: string;
  balanceAfter: string;
}

/** The post-reset, post-add fixed-window spend counters to persist for the debited account when
 * a movement is limit-enforced (`command.limitAccountId` set). Computed under the account lock
 * BEFORE any balance mutation, written AFTER the balance/ledger fold in the same tx. */
interface SpendCounterUpdate {
  accountId: string;
  spentToday: string;
  spentTodayDate: string;
  spentMonth: string;
  spentMonthDate: string;
}

/**
 * The single balance-mutating operation — the money-safety keystone. ALL balance changes
 * (internal transfers, external settlement, reversals, inbound) funnel through
 * {@link postTransaction}, so the ledger and the materialized `balance` can never diverge
 * (ADR-13).
 *
 * Mechanics (ADR-13): ONE DB transaction at READ COMMITTED; every affected account row is
 * locked `FOR UPDATE` in canonical ascending id order (deadlock avoidance). The transaction
 * header is inserted first (it is the FK parent of both the ledger and the outbox rows),
 * then under the lock the order is balance-then-ledger per leg (update `balance`, then append
 * the `LedgerEntry` carrying the resulting `balance_after`), then exactly one outbox row —
 * all in the same tx (transactional outbox, ADR-5). Only a deadlock (`40P01`) is retried.
 *
 * Three entry points share the same shared steps (lock → per-leg check/fold → balance-then-
 * ledger → one outbox row) and differ ONLY in whether they open a transaction and in the
 * header step ({@link applyPosting}'s `applyHeader` callback):
 * - {@link postTransaction} opens its OWN transaction and INSERTS a new POSTED header (a fresh
 *   movement, e.g. reversal / external settlement).
 * - {@link postFreshInTx} runs INSIDE the caller's transaction and INSERTS a new POSTED header
 *   (a fresh movement posted within an already-open, source-locked tx — the rail reversal /
 *   inbound credit).
 * - {@link postPendingInTx} runs INSIDE the caller's transaction and TRANSITIONS an existing
 *   PENDING header to POSTED (the confirm-time half of an internal transfer).
 *
 * Scope: the balancing multi-leg post PLUS spend-counter/limit enforcement — but ONLY when the
 * caller opts in via `command.limitAccountId` (the customer debit leg). When set, the resolved
 * caps are checked and the account's fixed-window `spent_today`/`spent_month` incremented under
 * the SAME `FOR UPDATE` lock as the funds check, so the counters can never exceed the cap under a
 * concurrent race (spec 04 Limits). Unset movements (inbound credits, reversals) never touch a
 * counter. Deliberately still NOT here: hold/`held` mutation (the transfers layer owns it).
 * Idempotency-key handling is the wrapper's job (the transfers layer runs the initiate under it).
 * The funds check DOES subtract existing `held` when computing `available`.
 */
@Injectable()
export class PostingService implements IPostingService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: IAccountRepository,
    @Inject(LEDGER_ENTRY_REPOSITORY) private readonly ledger: ILedgerEntryRepository,
    @Inject(TRANSACTION_REPOSITORY) private readonly transactions: ITransactionRepository,
    @Inject(OUTBOX_EVENT_REPOSITORY) private readonly outbox: IOutboxEventRepository,
    @Inject(USER_LIMITS_REPOSITORY) private readonly userLimits: IUserLimitsRepository,
  ) {}

  /**
   * Apply a balancing money movement atomically and return the posted transaction header.
   * The transaction id is generated up front so legs and the outbox row reference it without
   * a DB round-trip. Throws a {@link DomainError} on a broken invariant (validation, missing
   * account, currency mismatch, frozen account, insufficient funds); the caller maps those to
   * transport codes.
   */
  async postTransaction(command: PostTransactionCommand): Promise<Transaction> {
    this.validateCommand(command);

    const txId = randomUUID();
    const lockOrder = lockOrderFor(command);

    // ONE transaction at READ COMMITTED, deadlock-retried, via the shared helper. `txId` and
    // `lockOrder` are captured up front so they stay stable across retries. The header step
    // INSERTS a fresh POSTED row.
    return runInTransactionWithRetry(this.dataSource, (queryRunner) =>
      this.applyPosting(queryRunner, command, txId, lockOrder, () =>
        this.insertPostedHeader(queryRunner, command, txId),
      ),
    );
  }

  async postFreshInTx(
    queryRunner: QueryRunner,
    command: PostTransactionCommand,
  ): Promise<Transaction> {
    this.validateCommand(command);

    const txId = randomUUID();
    const lockOrder = lockOrderFor(command);

    // Runs INSIDE the caller's already-open transaction (no new tx): the SAME shared steps as
    // postTransaction, but the header step INSERTS a fresh POSTED row rather than opening a new
    // transaction. The caller has already acquired any lock it needs to precede the reducer's
    // canonical order (e.g. the customer source, before the clearing account this reaches).
    return this.applyPosting(queryRunner, command, txId, lockOrder, () =>
      this.insertPostedHeader(queryRunner, command, txId),
    );
  }

  async postPendingInTx(
    queryRunner: QueryRunner,
    transactionId: string,
    command: PostTransactionCommand,
  ): Promise<Transaction> {
    this.validateCommand(command);
    const lockOrder = lockOrderFor(command);

    // Runs INSIDE the caller's already-open transaction (no new tx): the header ALREADY exists
    // (created PENDING at initiate), so the header step is a guarded PENDING→POSTED transition,
    // not an insert. `transactionId` is the existing header's id and doubles as the ledger/
    // outbox FK. Re-run-safe: on a deadlock the caller's wrapper rolls the whole tx back
    // (status returns to PENDING) and retries, so the transition succeeds again.
    return this.applyPosting(queryRunner, command, transactionId, lockOrder, () =>
      this.transitionExistingHeader(queryRunner, transactionId),
    );
  }

  async recordFailedInTx(
    queryRunner: QueryRunner,
    transactionId: string,
    reason: string,
    payee?: TransactionEventPayee | null,
  ): Promise<boolean> {
    // The single balance-service emitter of transaction events also owns the FAILED case: a guarded
    // PENDING→FAILED header write PLUS the single `transaction.failed` outbox row, atomically in the
    // caller's tx, moving NO money. A 0-row transition (already expired/cancelled) is a guarded no-op:
    // return false and emit nothing, so the caller releases no hold.
    const failed = await this.transactions.transitionToFailedInTx(
      queryRunner,
      transactionId,
      reason,
    );
    if (!failed) {
      return false;
    }
    // Re-read the now-FAILED header WITHIN this tx so the event carries the persisted state.
    const header = await this.transactions.findByIdInTx(queryRunner, transactionId);
    if (!header) {
      // Unreachable: the row was just transitioned under this same transaction.
      throw new Error(`Transaction ${transactionId} vanished after its FAILED transition`);
    }
    await this.emitTransactionFailed(queryRunner, header, reason, payee ?? null);
    return true;
  }

  /**
   * Emit the SINGLE `transaction.failed` outbox row for a FAILED header, in the caller's tx (the
   * FK parent already exists). Factored out so a fresh-FAILED-header case (a later step) can reuse
   * the SAME emit — keeping the reducer the sole emitter of transaction events. Empty legs: a FAILED
   * transaction moves no money, so the double-entry sum-zero invariant holds trivially.
   */
  private async emitTransactionFailed(
    queryRunner: QueryRunner,
    transaction: Transaction,
    reason: string,
    payee: TransactionEventPayee | null,
  ): Promise<void> {
    await this.outbox.insertInTx(queryRunner, {
      transactionId: transaction.id,
      eventType: TRANSACTION_FAILED_EVENT,
      payload: buildFailedPayload(transaction, {
        reason,
        payee,
        occurredAt: new Date().toISOString(),
      }),
    });
  }

  /**
   * Steps c–g of ADR-13, inside one already-open transaction. The header step (e) is supplied
   * by `applyHeader` — an INSERT for a fresh post, a guarded transition for a confirm — and is
   * the ONLY difference between the two entry points. It runs BEFORE the ledger/outbox rows
   * because both FK their `transaction_id` to the header row.
   */
  private async applyPosting(
    queryRunner: QueryRunner,
    command: PostTransactionCommand,
    txId: string,
    lockOrder: string[],
    applyHeader: () => Promise<Transaction>,
  ): Promise<Transaction> {
    // c. Lock every affected account row FOR UPDATE, in canonical ascending id order.
    const locked = new Map<string, Account>();
    for (const id of lockOrder) {
      const account = await this.accounts.lockByIdForUpdate(queryRunner, id);
      if (!account) {
        throw new AccountNotFoundError(id);
      }
      locked.set(id, account);
    }

    // d. Validate each leg against its (now locked) account, and compute its balance_after.
    const appliedLegs = command.legs.map((leg) => this.checkAndFold(leg, command, locked));

    // d′. Limits (only when the movement counts against a customer's spend — `limitAccountId`
    //     set): resolve the caps, lazily reset the fixed window off the DB clock, and reject a
    //     breach — all under the SAME lock as the funds check and BEFORE any balance mutation.
    //     The computed counters are persisted after the balance/ledger fold (step f′).
    const spendUpdate = command.limitAccountId
      ? await this.enforceLimits(queryRunner, command, locked)
      : null;

    // e. The transaction header (insert POSTED, or guarded PENDING→POSTED transition). Runs
    //    BEFORE the ledger/outbox rows, which FK their `transaction_id` to it.
    const transaction = await applyHeader();

    // f. balance-then-ledger: update the materialized balance FIRST, then append the entry
    //    (ADR-13). Runs after the header so the ledger FK parent exists.
    for (const leg of appliedLegs) {
      await this.accounts.updateBalanceInTx(queryRunner, leg.accountId, leg.balanceAfter);
      await this.ledger.insertInTx(queryRunner, {
        transactionId: txId,
        accountId: leg.accountId,
        delta: leg.delta,
        balanceAfter: leg.balanceAfter,
        currency: command.currency,
      });
    }

    // f′. Persist the incremented fixed-window spend counters for the debited account (same lock,
    //     same tx) when this movement was limit-enforced — so the check (step d′) and the write
    //     straddle one critical section and a counter can never overshoot its cap.
    if (spendUpdate) {
      await this.accounts.updateSpendCountersInTx(
        queryRunner,
        spendUpdate.accountId,
        spendUpdate.spentToday,
        spendUpdate.spentTodayDate,
        spendUpdate.spentMonth,
        spendUpdate.spentMonthDate,
      );
    }

    // g. Exactly one outbox row, same tx (transactional outbox, ADR-5). The payload is the
    //    enriched, self-contained read-model event: the header entity supplies id / type /
    //    status / amount / currency / initiatedBy / reverses / timestamps; the LOCKED accounts
    //    supply each leg's owner / kind / systemKey / currency; the command supplies the payee
    //    snapshot (external_outbound only). No extra reads — every source is already in hand.
    await this.outbox.insertInTx(queryRunner, {
      transactionId: txId,
      eventType: TRANSACTION_POSTED_EVENT,
      payload: buildPostedPayload(transaction, command, appliedLegs, locked),
    });

    return transaction;
  }

  /**
   * Header step for {@link postTransaction}: INSERT a fresh POSTED header, with debit/credit
   * derived from a clean 2-leg pair (null for both otherwise — the ledger legs remain
   * authoritative). The up-front `txId` lets the FK children reference it without a round-trip.
   */
  private insertPostedHeader(
    queryRunner: QueryRunner,
    command: PostTransactionCommand,
    txId: string,
  ): Promise<Transaction> {
    const { debitAccountId, creditAccountId } = deriveDebitCredit(command.legs);
    // A freshly-posted movement is created AND posted in one act: stamp both timestamps from
    // the SAME app-clock instant. `postedAt` was already app-clock; setting `createdAt`
    // explicitly (rather than leaning on the DB `now()` default) guarantees the returned entity
    // carries it, so the emitted transaction event can report `createdAt` without an extra read.
    const now = new Date();
    return this.transactions.insertInTx(queryRunner, {
      id: txId,
      type: command.type,
      status: TransactionStatus.Posted,
      amount: command.amount,
      currency: command.currency,
      debitAccountId,
      creditAccountId,
      initiatedBy: command.initiatedBy,
      payeeId: command.payeeId ?? null,
      reversesTransactionId: command.reversesTransactionId ?? null,
      createdAt: now,
      postedAt: now,
    });
  }

  /**
   * Header step for {@link postPendingInTx}: a guarded `PENDING → POSTED` transition on the
   * EXISTING header. A 0-row result means the transfer was already posted / is not pending, so
   * it throws {@link TransactionNotPendingError} BEFORE any balance is touched — the "money
   * moves once" gate. On success the just-transitioned row is re-read WITHIN this tx so the
   * returned header reflects the POSTED status + `posted_at`.
   */
  private async transitionExistingHeader(
    queryRunner: QueryRunner,
    transactionId: string,
  ): Promise<Transaction> {
    const transitioned = await this.transactions.transitionToPostedInTx(queryRunner, transactionId);
    if (!transitioned) {
      throw new TransactionNotPendingError(transactionId);
    }
    const posted = await this.transactions.findByIdInTx(queryRunner, transactionId);
    if (!posted) {
      // Unreachable: the row was just transitioned under this same transaction. A genuine
      // breach here is an internal fault (500), not a business error.
      throw new Error(`Transaction ${transactionId} vanished after its POSTED transition`);
    }
    return posted;
  }

  /**
   * Enforce the per-account invariants for one leg and fold its delta into a new balance.
   * Currency must match for every account. For a CUSTOMER debit (`delta < 0`): the account
   * must not be frozen and `available (= balance − held)` must cover the debit. SYSTEM
   * accounts (clearing) are exempt from the frozen and funds checks — they may go negative.
   */
  private checkAndFold(
    leg: PostingLeg,
    command: PostTransactionCommand,
    locked: Map<string, Account>,
  ): AppliedLeg {
    const account = locked.get(leg.accountId);
    if (!account) {
      // Unreachable: lockOrder is built from these same ids, so all were locked above.
      throw new AccountNotFoundError(leg.accountId);
    }
    if (account.currency !== command.currency) {
      throw new CurrencyMismatchError(account.id, account.currency, command.currency);
    }

    const delta = BigInt(leg.delta);
    const isDebit = delta < 0n;
    // A FORCED admin correction (maker-checker reversal, `command.forced`) SKIPS the frozen +
    // insufficient-funds checks on a customer DEBIT leg, so the compensating movement always
    // applies and the counterparty balance may go negative — there is no `balance >= 0` DB check on
    // customer accounts, by design, so the fold still balances (no money created or lost). `forced`
    // is set ONLY by admin reversal; it never affects a credit leg or a system account (neither
    // enters this branch), and when falsy/absent the checks run unchanged.
    if (account.kind === AccountKind.Customer && isDebit && !command.forced) {
      if (account.status === AccountStatus.Frozen) {
        throw new AccountFrozenError(account.id);
      }
      if (availableMinor(account.balance, account.held) < -delta) {
        throw new InsufficientFundsError(account.id);
      }
    }

    return {
      accountId: account.id,
      delta: leg.delta,
      balanceAfter: addMinor(account.balance, leg.delta),
    };
  }

  /**
   * Enforce the owner's spend caps for a customer-initiated outbound movement and compute the
   * counters to persist. Runs under the SAME `FOR UPDATE` lock the funds check already took: the
   * `limitAccountId` MUST be one of the locked legs, be a DEBIT (`delta < 0`), and name a
   * CUSTOMER account — otherwise the directive is malformed ({@link InvalidPostingCommandError};
   * defensive — the transfers layer only ever points it at the customer sender).
   *
   * Resolution is row-level, customer-wins (the repo picks the customer row over global; a NULL
   * cap field = uncapped). The fixed window is reset lazily off the DB clock (UTC calendar): a
   * `spent_*_date` lexically before the current boundary means the window rolled over, so its
   * effective spend is 0 before the add (ISO `YYYY-MM-DD` strings sort chronologically). Breach
   * order is per-transaction → daily → monthly (first breach wins), each throwing
   * {@link LimitExceededError} BEFORE any balance mutation. Returns the post-add counters + the
   * current window dates for the reducer to write after the balance/ledger fold.
   */
  private async enforceLimits(
    queryRunner: QueryRunner,
    command: PostTransactionCommand,
    locked: Map<string, Account>,
  ): Promise<SpendCounterUpdate> {
    const accountId = command.limitAccountId as string;
    const leg = command.legs.find((entry) => entry.accountId === accountId);
    if (!leg) {
      throw new InvalidPostingCommandError('limitAccountId must reference one of the legs');
    }
    if (BigInt(leg.delta) >= 0n) {
      throw new InvalidPostingCommandError('limitAccountId must reference a debit leg');
    }
    const account = locked.get(accountId);
    if (!account || account.kind !== AccountKind.Customer) {
      throw new InvalidPostingCommandError('limitAccountId must reference a customer account');
    }
    if (account.ownerId === null) {
      // Unreachable for a customer account (owner is an FK); defensive against malformed state.
      throw new InvalidPostingCommandError('limit account is missing an owner');
    }

    const caps = await this.userLimits.resolveInTx(queryRunner, account.ownerId, command.currency);
    const { today, monthStart } = await this.accounts.currentSpendWindowInTx(queryRunner);

    // Charge the window against THIS account's own debit magnitude, not `command.amount`. For
    // every current caller they are identical (a clean 2-leg customer→dest post, where
    // `validateCommand` pins `amount == moved magnitude`), but keying off the resolved debit leg
    // keeps the counter correct if a future multi-leg command ever debits this customer for only
    // part of `amount`. `leg.delta` is a validated negative (a debit), so negate for the magnitude.
    const amount = -BigInt(leg.delta);
    // Lazy reset: a stale window date (behind the boundary) contributes 0 to the new counter.
    const effToday = account.spentTodayDate < today ? 0n : BigInt(account.spentToday);
    const effMonth = account.spentMonthDate < monthStart ? 0n : BigInt(account.spentMonth);
    const newToday = effToday + amount;
    const newMonth = effMonth + amount;

    if (caps) {
      if (caps.perTransactionMax != null && amount > BigInt(caps.perTransactionMax)) {
        throw new LimitExceededError('per_transaction', accountId);
      }
      if (caps.dailyMax != null && newToday > BigInt(caps.dailyMax)) {
        throw new LimitExceededError('daily', accountId);
      }
      if (caps.monthlyMax != null && newMonth > BigInt(caps.monthlyMax)) {
        throw new LimitExceededError('monthly', accountId);
      }
    }

    return {
      accountId,
      spentToday: newToday.toString(),
      spentTodayDate: today,
      spentMonth: newMonth.toString(),
      spentMonthDate: monthStart,
    };
  }

  /** Step a: shape/balancing invariants, before any DB work. */
  private validateCommand(command: PostTransactionCommand): void {
    if (!command.currency || command.currency.trim().length === 0) {
      throw new InvalidPostingCommandError('currency is required');
    }
    if (command.legs.length < 2) {
      throw new InvalidPostingCommandError('a transaction requires at least two legs');
    }

    // Validate minor-unit string SHAPE up front, before any BigInt() below — a malformed
    // string (e.g. '1.5', 'abc') would otherwise throw a raw SyntaxError (later a generic
    // 500) instead of this domain error.
    if (!UNSIGNED_MINOR_UNITS.test(command.amount)) {
      throw new InvalidPostingCommandError(
        `amount is not a valid unsigned minor-unit integer: "${command.amount}"`,
      );
    }
    for (const leg of command.legs) {
      if (!SIGNED_MINOR_UNITS.test(leg.delta)) {
        throw new InvalidPostingCommandError(
          `leg delta for account ${leg.accountId} is not a valid signed minor-unit ` +
            `integer: "${leg.delta}"`,
        );
      }
    }

    if (BigInt(command.amount) <= 0n) {
      throw new InvalidPostingCommandError('amount must be a positive minor-unit value');
    }
    const ids = command.legs.map((leg) => leg.accountId);
    if (new Set(ids).size !== ids.length) {
      throw new InvalidPostingCommandError('leg account ids must be distinct');
    }
    for (const leg of command.legs) {
      if (BigInt(leg.delta) === 0n) {
        throw new InvalidPostingCommandError('a leg delta must be non-zero');
      }
    }
    if (sumMinor(command.legs.map((leg) => leg.delta)) !== 0n) {
      throw new InvalidPostingCommandError('leg deltas must sum to zero (double-entry)');
    }

    // Cross-check the declared amount against the actual movement: the total moved magnitude
    // is the sum of the positive-delta legs (== |sum of the negative legs|, since the deltas
    // sum to zero). Balances/ledger fold from the legs, so a wrong amount is not a
    // money-safety breach — but the header and the outbox payload must not carry a magnitude
    // that lies. General: holds for the 2-leg case and any balanced multi-leg.
    const movedMagnitude = sumMinor(
      command.legs.map((leg) => leg.delta).filter((delta) => BigInt(delta) > 0n),
    );
    if (BigInt(command.amount) !== movedMagnitude) {
      throw new InvalidPostingCommandError(
        `amount (${command.amount}) must equal the moved magnitude (${movedMagnitude.toString()})`,
      );
    }
  }
}

/**
 * Distinct affected account ids in canonical ascending order — the lock order EVERY posting
 * uses, so two concurrent posts touching the same pair can never deadlock by acquiring the
 * rows in opposite orders. Ids are already distinct (validated); the `Set` is defensive.
 * Shared by both entry points so they lock identically.
 */
function lockOrderFor(command: PostTransactionCommand): string[] {
  return [...new Set(command.legs.map((leg) => leg.accountId))].sort(compareAccountId);
}

/** Canonical ascending order over account ids (UUID strings), used for lock acquisition. */
function compareAccountId(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * The denormalized debit/credit header fields are set only for a clean 2-leg pair (exactly
 * one negative and one positive leg); otherwise both are null and the ledger legs remain the
 * authoritative record of who was debited/credited.
 */
function deriveDebitCredit(legs: PostingLeg[]): {
  debitAccountId: string | null;
  creditAccountId: string | null;
} {
  if (legs.length !== 2) {
    return { debitAccountId: null, creditAccountId: null };
  }
  const debit = legs.find((leg) => BigInt(leg.delta) < 0n);
  const credit = legs.find((leg) => BigInt(leg.delta) > 0n);
  if (!debit || !credit) {
    return { debitAccountId: null, creditAccountId: null };
  }
  return { debitAccountId: debit.accountId, creditAccountId: credit.accountId };
}

/**
 * Build the enriched, self-contained transaction-event payload (balance-service copy; see
 * transaction-event.ts). Everything is already in hand — no extra DB read:
 * - the `transaction` HEADER entity gives id / type / status (POSTED) / amount / currency /
 *   initiatedBy / reversesTransactionId / createdAt / postedAt (authoritative, as persisted);
 * - each leg's `owner` / `kind` / `systemKey` / `currency` come from the LOCKED `Account`
 *   already read under the `FOR UPDATE` lock for the fold;
 * - the external-payee snapshot is copied verbatim from `command.payee` (external_outbound
 *   only; null otherwise) — the reducer never reaches into a payee repository (layering).
 *
 * Money stays int64-as-string end to end (`amount`, `delta`, `balanceAfter`); the legs still
 * sum to zero (they are the same appliedLegs the ledger folds).
 */
function buildPostedPayload(
  transaction: Transaction,
  command: PostTransactionCommand,
  appliedLegs: AppliedLeg[],
  locked: Map<string, Account>,
): TransactionPostedPayload {
  const legs: TransactionEventLeg[] = appliedLegs.map((leg) => {
    const account = locked.get(leg.accountId);
    if (!account) {
      // Unreachable: every applied leg's account was locked into `locked` in applyPosting.
      throw new AccountNotFoundError(leg.accountId);
    }
    return {
      accountId: leg.accountId,
      ownerId: account.ownerId,
      accountKind: account.kind,
      systemKey: account.systemKey,
      delta: leg.delta,
      balanceAfter: leg.balanceAfter,
      currency: account.currency,
    };
  });
  return {
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    transaction: {
      id: transaction.id,
      type: transaction.type,
      status: transaction.status,
      amount: transaction.amount,
      currency: transaction.currency,
      initiatedBy: transaction.initiatedBy,
      reversesTransactionId: transaction.reversesTransactionId,
      payee: command.payee ?? null,
      createdAt: transaction.createdAt.toISOString(),
      postedAt: transaction.postedAt ? transaction.postedAt.toISOString() : null,
      // Always null on a POSTED event — carried for shape uniformity with `transaction.failed`.
      failureReason: transaction.failureReason ?? null,
    },
    legs,
  };
}
