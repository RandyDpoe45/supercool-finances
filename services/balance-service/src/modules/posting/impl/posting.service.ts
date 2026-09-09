import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { runInTransactionWithRetry } from '../../../common/db/run-in-transaction';
import { addMinor, availableMinor, sumMinor } from '../../../common/money/money';
import { Account } from '../../../database/entities/account.entity';
import { AccountKind, AccountStatus, TransactionStatus } from '../../../database/entities/enums';
import { Transaction } from '../../../database/entities/transaction.entity';
import {
  ACCOUNT_REPOSITORY,
  IAccountRepository,
} from '../../../database/repositories/interfaces/account.repository.interface';
import {
  ILedgerEntryRepository,
  LEDGER_ENTRY_REPOSITORY,
} from '../../../database/repositories/interfaces/ledger-entry.repository.interface';
import {
  IOutboxEventRepository,
  OUTBOX_EVENT_REPOSITORY,
} from '../../../database/repositories/interfaces/outbox-event.repository.interface';
import {
  ITransactionRepository,
  TRANSACTION_REPOSITORY,
} from '../../../database/repositories/interfaces/transaction.repository.interface';
import { PostingLeg, PostTransactionCommand } from '../post-transaction.command';
import {
  AccountFrozenError,
  AccountNotFoundError,
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidPostingCommandError,
} from '../posting.errors';
import {
  TRANSACTION_POSTED_EVENT,
  TransactionEventLeg,
  TransactionPostedPayload,
} from '../transaction-event';
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
 * Scope (this step): the balancing multi-leg post. Deliberately NOT here (later steps):
 * spend-counter/limit updates, hold/`held` mutation, idempotency-key handling. The funds
 * check DOES subtract existing `held` when computing `available`.
 */
@Injectable()
export class PostingService implements IPostingService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: IAccountRepository,
    @Inject(LEDGER_ENTRY_REPOSITORY) private readonly ledger: ILedgerEntryRepository,
    @Inject(TRANSACTION_REPOSITORY) private readonly transactions: ITransactionRepository,
    @Inject(OUTBOX_EVENT_REPOSITORY) private readonly outbox: IOutboxEventRepository,
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
    // Distinct account ids in canonical ascending order — the lock order every posting uses,
    // so two concurrent posts touching the same pair can never deadlock by acquiring in
    // opposite orders. Ids are already distinct (validated); the Set is defensive.
    const lockOrder = [...new Set(command.legs.map((leg) => leg.accountId))].sort(compareAccountId);

    // ONE transaction at READ COMMITTED, deadlock-retried, via the shared helper. `txId` and
    // `lockOrder` are captured up front so they stay stable across retries.
    return runInTransactionWithRetry(this.dataSource, (queryRunner) =>
      this.applyPosting(queryRunner, command, txId, lockOrder),
    );
  }

  /** Steps c–g of ADR-13, inside one already-open transaction. */
  private async applyPosting(
    queryRunner: QueryRunner,
    command: PostTransactionCommand,
    txId: string,
    lockOrder: string[],
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

    // e. The transaction header, POSTED, with debit/credit derived from a clean 2-leg pair.
    //    Inserted BEFORE the ledger/outbox rows: both FK their `transaction_id` to this row,
    //    so the parent must exist first. The up-front `txId` lets us do this without a
    //    round-trip.
    const { debitAccountId, creditAccountId } = deriveDebitCredit(command.legs);
    const transaction = await this.transactions.insertInTx(queryRunner, {
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
      postedAt: new Date(),
    });

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

    // g. Exactly one outbox row, same tx (transactional outbox, ADR-5).
    await this.outbox.insertInTx(queryRunner, {
      transactionId: txId,
      eventType: TRANSACTION_POSTED_EVENT,
      payload: buildPostedPayload(txId, command, appliedLegs),
    });

    return transaction;
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
    if (account.kind === AccountKind.Customer && isDebit) {
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

/** Build the provisional transaction-event payload (balance-service copy; see transaction-event.ts). */
function buildPostedPayload(
  txId: string,
  command: PostTransactionCommand,
  appliedLegs: AppliedLeg[],
): TransactionPostedPayload {
  const legs: TransactionEventLeg[] = appliedLegs.map((leg) => ({
    accountId: leg.accountId,
    delta: leg.delta,
    balanceAfter: leg.balanceAfter,
  }));
  return {
    txId,
    type: command.type,
    currency: command.currency,
    amount: command.amount,
    legs,
    occurredAt: new Date().toISOString(),
  };
}
