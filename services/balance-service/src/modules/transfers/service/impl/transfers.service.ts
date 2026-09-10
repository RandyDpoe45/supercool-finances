import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Redis } from 'ioredis';
import { DataSource, QueryRunner } from 'typeorm';
import { runInTransactionWithRetry } from '../../../../common/db/run-in-transaction';
import { addMinor, availableMinor } from '../../../../common/money/money';
import { OUTBOUND_RAIL } from '../../../../common/rails/outbound-rail';
import {
  AccountKind,
  AccountStatus,
  HoldStatus,
  TransactionStatus,
  TransactionType,
} from '../../../../database/entities/enums';
import { Transaction } from '../../../../database/entities/transaction.entity';
import {
  ACCOUNT_REPOSITORY,
  IAccountRepository,
} from '../../../../database/repositories/interfaces/account.repository.interface';
import {
  CUSTOMER_REPOSITORY,
  ICustomerRepository,
} from '../../../../database/repositories/interfaces/customer.repository.interface';
import {
  EXTERNAL_PAYEE_REPOSITORY,
  IExternalPayeeRepository,
} from '../../../../database/repositories/interfaces/external-payee.repository.interface';
import {
  HOLD_REPOSITORY,
  IHoldRepository,
} from '../../../../database/repositories/interfaces/hold.repository.interface';
import {
  ITransactionRepository,
  TRANSACTION_REPOSITORY,
} from '../../../../database/repositories/interfaces/transaction.repository.interface';
import { REDIS_CLIENT } from '../../../../redis/redis.tokens';
import {
  IDEMPOTENCY_SERVICE,
  IdempotencyOutcome,
  IIdempotencyService,
} from '../../../idempotency/service/interfaces/idempotency.service.interface';
import { IOtpService, OTP_SERVICE } from '../../../otp/service/interfaces/otp.service.interface';
import {
  AccountFrozenError,
  CurrencyMismatchError,
  InsufficientFundsError,
} from '../../../posting/service/errors';
import { PostTransactionCommand } from '../../../posting/service/interfaces/post-transaction.command';
import {
  IPostingService,
  POSTING_SERVICE,
} from '../../../posting/service/interfaces/posting.service.interface';
import {
  DestinationNotConfirmedError,
  InvalidOtpError,
  InvalidTransferError,
  OtpLockedOutError,
  PayeeInCoolingOffError,
  PayeeNotFoundError,
  PendingTransferConflictError,
  TransferExpiredError,
  TransferNotFoundError,
  TransferNotPendingError,
} from '../errors';
import { maskName } from './mask-name';
import {
  CancelTransferParams,
  ConfirmTransferParams,
  DestinationResolution,
  InitiateExternalTransferParams,
  InitiateTransferParams,
  ITransfersService,
  PendingAuthorization,
  ResolveDestinationParams,
} from '../interfaces/transfers.service.interface';

/** The partial unique index enforcing at most one PENDING transfer per initiator. A same-owner
 * concurrent initiate collides on it (SQLSTATE 23505); the service maps that to a 409. */
const PENDING_UNIQUE_CONSTRAINT = 'uq_one_pending_per_initiator';

/** True iff the error is (or wraps) a Postgres unique violation on {@link PENDING_UNIQUE_CONSTRAINT}
 * — the single-pending index. TypeORM surfaces the driver error as `QueryFailedError`; the
 * SQLSTATE + constraint live on the error or its `driverError`, so both are checked. */
function isPendingUniqueViolation(error: unknown): boolean {
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
  return code === '23505' && constraint === PENDING_UNIQUE_CONSTRAINT;
}

/** Canonical unsigned minor-unit string (a positive amount magnitude). Validated before any
 * `BigInt()` so a malformed value raises the domain error, not a raw `SyntaxError`. */
const UNSIGNED_MINOR_UNITS = /^\d+$/;

/** The `system_key` of the per-rail outbound clearing account an external outbound credits — the
 * counter-leg of the customer debit. Seeded by `SeedSystemAccounts` (`clearing:rail-outbound`). */
const OUTBOUND_CLEARING_KEY = `clearing:${OUTBOUND_RAIL}`;

/** How long a confirmation-of-payee token stays valid (5 minutes) — long enough for the payer
 * to review the masked name and initiate, short enough that a stale confirmation can't be
 * reused indefinitely. The token is single-purpose: bind a CALLER to a resolved destination. */
export const CONFIRM_TOKEN_TTL_SECONDS = 300;

/** What the confirmation token stores in Redis: the resolved destination account id (the bind
 * initiate re-checks) plus the account number, keyed by `xfer:confirm:<ownerId>:<token>`. */
interface ConfirmationRecord {
  destinationAccountId: string;
  accountNumber: string;
}

/**
 * The transfer lifecycle (spec 04 Transfers): two-phase and OTP-gated, spanning INTERNAL
 * (customer↔customer) and EXTERNAL OUTBOUND (customer → outbound-rail clearing) transfers.
 * Internal is fronted by a confirmation-of-payee step (`resolveDestination` → masked name +
 * caller-bound token → `initiateTransfer`); external is to an ENROLLED payee addressed by
 * `payeeId` (no resolve step; the cooling-off gate + display name come from enrollment) via
 * `initiateExternalTransfer`. Both create a PENDING transaction at initiate under the caller's
 * `Idempotency-Key` — internal moves NO money and holds nothing; external PLACES A HOLD
 * (`held += amount`, a PLACED reservation, still no balance movement). `confirmTransfer` is
 * SHARED: it consumes the caller's one-time code, then branches on the transaction TYPE —
 * internal POSTS through the reducer's confirm-time seam ({@link IPostingService.postPendingInTx});
 * external SETTLES (releases the hold, posts the customer → clearing double-entry, marks the hold
 * SETTLED). `cancelTransfer` and the single `getPendingAuthorization` feed are shared too.
 *
 * Money-once is guaranteed by two independent gates: the `Idempotency-Key` dedups duplicate
 * CREATION at initiate, and at confirm the OTP single-use (`GETDEL`) plus the guarded
 * PENDING→POSTED transition ensure the movement happens exactly once. The OTP is consumed
 * BEFORE the money transaction (post or settle) — the single-use `GETDEL` is the authorization
 * gate; if the post/settle then fails (insufficient funds / frozen under the lock, etc.) the code
 * is spent and the transfer stays PENDING, so a retry needs a fresh code (matching the spec's
 * confirm-time funds check).
 *
 * Hold invariants (external outbound): every `held`/balance/hold mutation for one operation
 * happens in ONE READ COMMITTED, deadlock-retried transaction under the source's `FOR UPDATE`
 * lock; `SUM(PLACED holds per account) == account.held` at every commit; at initiate NO balance
 * moves; at settle the balance moves once (customer → clearing) and `held` nets to zero for that
 * transfer; on release/expiry `held` decrements with NO ledger entry. The reducer stays the single
 * balance/ledger/outbox keystone — holds and `held` are handled AROUND it in this service.
 *
 * Pending authorization is SINGLE and TIME-BOXED: at most one live PENDING per user (a partial
 * unique index, not just a service check), each carrying a 2-minute `expires_at` set from the DB
 * clock. Overdue pendings transition to EXPIRED lazily on the next access (confirm / read / next
 * initiate) — no scheduler. Confirm CHECKS EXPIRY BEFORE consuming the OTP, so an expired
 * transfer never burns the caller's code. A new initiate auto-supersedes any active pending
 * (→ CANCELLED, retained); the caller may also cancel a pending explicitly. Terminal states are
 * retained, never deleted.
 *
 * The write methods return the plain {@link Transaction} entity; DTO serialization is a transport
 * concern applied at the controller. Only the pending READ returns a domain PROJECTION (the
 * destination human account number + masked holder name), because masking the raw name (PII) is a
 * service-owned rule that must never cross the service boundary.
 */
@Injectable()
export class TransfersService implements ITransfersService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: IAccountRepository,
    @Inject(CUSTOMER_REPOSITORY) private readonly customers: ICustomerRepository,
    @Inject(TRANSACTION_REPOSITORY) private readonly transactions: ITransactionRepository,
    @Inject(HOLD_REPOSITORY) private readonly holds: IHoldRepository,
    @Inject(EXTERNAL_PAYEE_REPOSITORY) private readonly externalPayees: IExternalPayeeRepository,
    @Inject(IDEMPOTENCY_SERVICE) private readonly idempotency: IIdempotencyService,
    @Inject(OTP_SERVICE) private readonly otp: IOtpService,
    @Inject(POSTING_SERVICE) private readonly posting: IPostingService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async resolveDestination(params: ResolveDestinationParams): Promise<DestinationResolution> {
    const { ownerId, accountNumber } = params;

    // 1. Resolve the number to a CUSTOMER account. A missing account and a system/clearing
    //    account collapse to the SAME 404 — never reveal which case, nor that system accounts
    //    exist (anti-IDOR / anti-enumeration).
    const destination = await this.accounts.findByAccountNumber(accountNumber);
    if (!destination || destination.kind !== AccountKind.Customer || !destination.ownerId) {
      throw new TransferNotFoundError();
    }

    // 2. The holder, masked. The FK guarantees a customer row for a non-null owner; the guard
    //    keeps a missing one non-revealing rather than surfacing an empty name.
    const holder = await this.customers.findById(destination.ownerId);
    if (!holder) {
      throw new TransferNotFoundError();
    }

    // 3. A single-use confirmation token, bound to the CALLER (ownerId in the key), so another
    //    user cannot use it. It stores the resolved destination id that initiate re-checks.
    const confirmationToken = randomBytes(24).toString('hex');
    const record: ConfirmationRecord = {
      destinationAccountId: destination.id,
      accountNumber: destination.accountNumber ?? accountNumber,
    };
    await this.redis.set(
      this.confirmKey(ownerId, confirmationToken),
      JSON.stringify(record),
      'EX',
      CONFIRM_TOKEN_TTL_SECONDS,
    );

    // 4. Pure query — NO transaction is created.
    return { maskedName: maskName(holder.name), currency: destination.currency, confirmationToken };
  }

  async initiateTransfer(params: InitiateTransferParams): Promise<Transaction> {
    const {
      ownerId,
      sourceAccountId,
      destinationAccountNumber,
      amount,
      currency,
      idempotencyKey,
      confirmationToken,
      confirmDuplicate,
    } = params;

    // a. Shape invariants (defense-in-depth; the wire schema also enforces these).
    if (!UNSIGNED_MINOR_UNITS.test(amount) || BigInt(amount) <= 0n) {
      throw new InvalidTransferError('amount must be a positive minor-unit integer');
    }
    if (!currency || currency.trim().length === 0) {
      throw new InvalidTransferError('currency is required');
    }

    // b. The SOURCE is the caller's own account (anti-IDOR: a non-owned/missing source is a
    //    404, never revealing non-ownership). `findByIdAndOwner` can only return a customer
    //    account (system accounts have a NULL owner).
    const source = await this.accounts.findByIdAndOwner(sourceAccountId, ownerId);
    if (!source) {
      throw new TransferNotFoundError();
    }

    // c. The DESTINATION is resolved by its human account number; it must be a customer account.
    const destination = await this.accounts.findByAccountNumber(destinationAccountNumber);
    if (!destination || destination.kind !== AccountKind.Customer) {
      throw new TransferNotFoundError();
    }
    if (destination.id === source.id) {
      throw new InvalidTransferError('source and destination accounts must differ');
    }
    if (source.currency !== currency) {
      throw new CurrencyMismatchError(source.id, source.currency, currency);
    }
    if (destination.currency !== currency) {
      throw new CurrencyMismatchError(destination.id, destination.currency, currency);
    }

    // d. Confirmation-of-payee gate: the caller must hold a valid token bound to THIS
    //    destination. Without it they were only querying — a transfer cannot be initiated.
    await this.assertDestinationConfirmed(ownerId, confirmationToken, destination.id);

    // e. Claim the Idempotency-Key and create the PENDING header under it (no money moves). The
    //    operation runs in ONE transaction: first EXPIRE any overdue pending for this initiator
    //    (DB clock), then AUTO-SUPERSEDE any remaining active pending (→ CANCELLED, retained), then
    //    INSERT the new PENDING with a DB-clock `expires_at`. A replayed key returns the original
    //    id WITHOUT re-running any of this; SUSPECTED_DUPLICATE / IDEMPOTENCY_KEY_REUSED propagate.
    let outcome: IdempotencyOutcome;
    try {
      outcome = await this.idempotency.execute(
        {
          ownerId,
          key: idempotencyKey,
          fingerprintInput: {
            type: 'internal',
            source: source.id,
            destination: destination.id,
            amount,
            currency,
          },
          confirmDuplicate,
        },
        async (queryRunner) => {
          await this.transactions.expireOverduePendingByInitiator(queryRunner, ownerId);
          await this.transactions.supersedeActivePendingByInitiator(queryRunner, ownerId);
          const created = await this.transactions.insertPendingInTx(queryRunner, {
            id: randomUUID(),
            type: TransactionType.Internal,
            status: TransactionStatus.Pending,
            amount,
            currency,
            debitAccountId: source.id,
            creditAccountId: destination.id,
            initiatedBy: ownerId,
            postedAt: null,
          });
          return { transactionId: created.id };
        },
      );
    } catch (error) {
      // Concurrency backstop: two same-initiator initiates (different keys) racing collide on
      // the single-pending index. The idempotent same-key replay never reaches the insert.
      if (isPendingUniqueViolation(error)) {
        throw new PendingTransferConflictError();
      }
      throw error;
    }

    const transfer = await this.transactions.findById(outcome.transactionId);
    if (!transfer) {
      // Unreachable: the wrapper just committed (or replayed) this id.
      throw new TransferNotFoundError();
    }
    return transfer;
  }

  async initiateExternalTransfer(params: InitiateExternalTransferParams): Promise<Transaction> {
    const {
      ownerId,
      sourceAccountId,
      payeeId,
      amount,
      currency,
      idempotencyKey,
      confirmDuplicate,
    } = params;

    // a. Shape invariants (defense-in-depth; the wire schema also enforces these).
    if (!UNSIGNED_MINOR_UNITS.test(amount) || BigInt(amount) <= 0n) {
      throw new InvalidTransferError('amount must be a positive minor-unit integer');
    }
    if (!currency || currency.trim().length === 0) {
      throw new InvalidTransferError('currency is required');
    }

    // b. The SOURCE is the caller's own account (anti-IDOR: a non-owned/missing source is a 404).
    const source = await this.accounts.findByIdAndOwner(sourceAccountId, ownerId);
    if (!source) {
      throw new TransferNotFoundError();
    }
    if (source.currency !== currency) {
      throw new CurrencyMismatchError(source.id, source.currency, currency);
    }

    // c. The DESTINATION is an ENROLLED payee. A missing OR non-owned payee collapses to the SAME
    //    404 (anti-IDOR / anti-enumeration — never reveal another user's payee). The cooling-off
    //    gate is judged on the DB CLOCK (never the app clock): `now() < cooling_off_until` → 409.
    const payee = await this.externalPayees.findById(payeeId);
    if (!payee || payee.ownerId !== ownerId) {
      throw new PayeeNotFoundError();
    }
    const dbNow = await this.readDbNow();
    if (dbNow.getTime() < payee.coolingOffUntil.getTime()) {
      throw new PayeeInCoolingOffError();
    }

    // d. The counter-leg is the seeded outbound-rail clearing account. Its absence is a system
    //    misconfiguration (a missing seed), not a client fault — a 500-class internal error.
    const clearing = await this.accounts.findBySystemKey(OUTBOUND_CLEARING_KEY);
    if (!clearing) {
      throw new Error(`Outbound clearing account ${OUTBOUND_CLEARING_KEY} is not provisioned`);
    }
    if (clearing.currency !== currency) {
      throw new CurrencyMismatchError(clearing.id, clearing.currency, currency);
    }

    // e. Claim the Idempotency-Key and, inside ONE transaction: release+supersede any prior
    //    pending (freeing an external prior's hold), then PLACE THE HOLD + create the PENDING
    //    external_outbound header (no balance moves). A replay returns the original id.
    let outcome: IdempotencyOutcome;
    try {
      outcome = await this.idempotency.execute(
        {
          ownerId,
          key: idempotencyKey,
          fingerprintInput: {
            type: 'external_outbound',
            source: source.id,
            destination: payeeId,
            amount,
            currency,
          },
          confirmDuplicate,
        },
        async (queryRunner) => {
          // e1. Single-active-pending rule spans types: release the prior external pending's hold
          //     BEFORE the flip, then flip the prior (overdue → EXPIRED, else CANCELLED).
          await this.releasePriorExternalPendingHold(queryRunner, ownerId);
          await this.transactions.expireOverduePendingByInitiator(queryRunner, ownerId);
          await this.transactions.supersedeActivePendingByInitiator(queryRunner, ownerId);

          // e2. Lock the source, funds-check against AVAILABLE (balance − held) under the lock,
          //     reject a frozen debit. No balance moves — only `held` and the reservation ledger.
          const locked = await this.accounts.lockByIdForUpdate(queryRunner, source.id);
          if (!locked) {
            // Unreachable: the owner-scoped read above found it; a vanished row mid-tx is a fault.
            throw new TransferNotFoundError();
          }
          if (locked.status === AccountStatus.Frozen) {
            throw new AccountFrozenError(locked.id);
          }
          if (availableMinor(locked.balance, locked.held) < BigInt(amount)) {
            throw new InsufficientFundsError(locked.id);
          }

          // e3. Insert the PENDING external_outbound header (DB-clock `expires_at`), reserve the
          //     funds (`held += amount`), and append the PLACED hold carrying the header's TTL.
          const created = await this.transactions.insertPendingInTx(queryRunner, {
            id: randomUUID(),
            type: TransactionType.ExternalOutbound,
            status: TransactionStatus.Pending,
            amount,
            currency,
            debitAccountId: source.id,
            creditAccountId: clearing.id,
            payeeId: payee.id,
            initiatedBy: ownerId,
            postedAt: null,
          });
          if (!created.expiresAt) {
            // insertPendingInTx always stamps a DB-clock `expires_at` for a PENDING transfer; its
            // absence is a broken invariant (the hold's TTL mirrors the transfer's deadline).
            throw new Error(`Pending external transfer ${created.id} is missing its expires_at`);
          }
          await this.accounts.updateHeldInTx(queryRunner, locked.id, addMinor(locked.held, amount));
          await this.holds.insertInTx(queryRunner, {
            id: randomUUID(),
            accountId: locked.id,
            transactionId: created.id,
            amount,
            status: HoldStatus.Placed,
            rail: OUTBOUND_RAIL,
            expiresAt: created.expiresAt,
          });
          return { transactionId: created.id };
        },
      );
    } catch (error) {
      // Concurrency backstop: a same-initiator initiate racing another (different keys) collides
      // on the single-pending index. The idempotent same-key replay never reaches the insert.
      if (isPendingUniqueViolation(error)) {
        throw new PendingTransferConflictError();
      }
      throw error;
    }

    const transfer = await this.transactions.findById(outcome.transactionId);
    if (!transfer) {
      // Unreachable: the wrapper just committed (or replayed) this id.
      throw new TransferNotFoundError();
    }
    return transfer;
  }

  async confirmTransfer(params: ConfirmTransferParams): Promise<Transaction> {
    const { ownerId, transferId, code } = params;

    // 1. Load the transfer (unscoped: ownership is verified on the debit account below).
    const transfer = await this.transactions.findById(transferId);
    if (!transfer) {
      throw new TransferNotFoundError();
    }

    // 2. Anti-IDOR on the NESTED resource — the account being debited, not just the id. A
    //    non-owned/missing debit account is a 404 (never revealing non-ownership).
    const debitAccountId = transfer.debitAccountId;
    if (!debitAccountId) {
      throw new TransferNotFoundError();
    }
    const debitAccount = await this.accounts.findByIdAndOwner(debitAccountId, ownerId);
    if (!debitAccount) {
      throw new TransferNotFoundError();
    }

    // 3. Idempotent confirm-after-success: an already-POSTED transfer is returned as-is (the
    //    money already moved). A terminal EXPIRED / CANCELLED (or any other non-PENDING) cannot
    //    be posted.
    if (transfer.status === TransactionStatus.Posted) {
      return transfer;
    }
    if (transfer.status !== TransactionStatus.Pending) {
      // EXPIRED / CANCELLED / FAILED / REVERSED — a stale confirm against a terminal transfer.
      throw new TransferNotPendingError();
    }

    // 4. EXPIRY BEFORE OTP (money-safety): let the guarded DB-clock predicate be the authority.
    //    If it flips the row, it WAS overdue → reject WITHOUT consuming the code, so an expired
    //    transfer never burns the caller's one-time code. For an EXTERNAL transfer the expiry also
    //    RELEASES the hold (`held -= amount`) in the SAME tx under the source lock; internal has no
    //    hold, so the plain single-statement expiry is used.
    const expired =
      transfer.type === TransactionType.ExternalOutbound
        ? await this.expireExternalPendingReleasingHold(transfer)
        : await this.transactions.expireIfOverdue(transferId);
    if (expired) {
      throw new TransferExpiredError();
    }
    // Not overdue by the DB clock — but a concurrent confirm/cancel/expiry may have moved it
    // since the load; re-check it is still PENDING before consuming the code.
    const current = await this.transactions.findById(transferId);
    if (!current) {
      throw new TransferNotFoundError();
    }
    if (current.status === TransactionStatus.Posted) {
      return current;
    }
    if (current.status === TransactionStatus.Expired) {
      // A concurrent access (initiate/read/confirm) expired it between the check and this re-read;
      // report EXPIRED (410) deterministically rather than a generic not-pending (409).
      throw new TransferExpiredError();
    }
    if (current.status !== TransactionStatus.Pending) {
      throw new TransferNotPendingError();
    }

    const creditAccountId = current.creditAccountId;
    if (!creditAccountId) {
      // A PENDING transfer always carries a destination (internal → the payee account; external →
      // the clearing account); a breach is malformed state.
      throw new InvalidTransferError('transfer is missing a destination account');
    }

    // 5. Consume the one-time code. Single-use is atomic (GETDEL): a correct code authorizes
    //    exactly one confirm. A wrong code is retryable until lockout. Consumed BEFORE the money
    //    tx (both branches), so a settle/post failure spends the code and leaves the transfer
    //    PENDING (retryable with a fresh code until expiry).
    const result = await this.otp.consume(ownerId, code);
    if (!result.ok) {
      throw result.lockedOut ? new OtpLockedOutError() : new InvalidOtpError();
    }

    // 6. Branch on the transaction TYPE. Both post the SAME signed double-entry through the
    //    reducer's confirm-time seam (debit source −amount, credit destination +amount), inside
    //    ONE deadlock-retried transaction with the funds check under the account lock.
    const command: PostTransactionCommand = {
      type: current.type,
      currency: current.currency,
      amount: current.amount,
      legs: [
        { accountId: debitAccountId, delta: `-${current.amount}` },
        { accountId: creditAccountId, delta: current.amount },
      ],
      initiatedBy: ownerId,
    };

    if (current.type === TransactionType.ExternalOutbound) {
      // EXTERNAL → SETTLE: the funds are already reserved as `held`, so release the held BEFORE
      // the reducer's debit (so its `available = balance − held` check passes), post the
      // customer → clearing movement, then mark the hold SETTLED — all in one locked tx.
      return this.settleExternalTransfer(transferId, debitAccountId, command);
    }

    // INTERNAL → POST: the existing guarded PENDING → POSTED path (no hold).
    const posted = await runInTransactionWithRetry(this.dataSource, (queryRunner) =>
      this.posting.postPendingInTx(queryRunner, transferId, command),
    );
    return posted;
  }

  /**
   * Settle a confirmed external-outbound transfer in ONE locked, deadlock-retried transaction:
   *
   * 1. Lock the source `FOR UPDATE` and read its current `held`.
   * 2. **Release the held FIRST** — `updateHeldInTx(source, held − amount)`. This is essential:
   *    the funds are already reserved, so decrementing `held` before the reducer's debit makes the
   *    reducer's `available = balance − held` funds check pass (the initiate-time reservation
   *    guarantees `balance ≥ held`, so `balance − (held − amount) ≥ amount`). Without it the debit
   *    would double-count the reservation and spuriously fail.
   * 3. `postPendingInTx` posts the customer → clearing double-entry, transitions PENDING → POSTED,
   *    and writes one outbox row (the SINGLE balance/ledger/outbox keystone). Its guarded
   *    transition throws (→ tx rollback, undoing the held decrement) if the transfer is no longer
   *    PENDING, so the held decrement can never persist without the post.
   * 4. Mark the hold `PLACED → SETTLED`. The reducer's balance debit is the SOLE source of the
   *    customer's outflow; `held` nets to zero for this transfer (it was the reservation).
   */
  private settleExternalTransfer(
    transferId: string,
    sourceId: string,
    command: PostTransactionCommand,
  ): Promise<Transaction> {
    return runInTransactionWithRetry(this.dataSource, async (queryRunner) => {
      const source = await this.accounts.lockByIdForUpdate(queryRunner, sourceId);
      if (!source) {
        // Unreachable: the source was owner-scoped above; a vanished row mid-tx is a fault.
        throw new TransferNotFoundError();
      }
      const hold = await this.holds.findByTransactionInTx(queryRunner, transferId);
      if (!hold) {
        // A PENDING external_outbound transfer always carries its PLACED hold (the reservation
        // that backs `held`). Its absence is a broken invariant — fail loud, not silently.
        throw new Error(`External transfer ${transferId} has no hold to settle`);
      }
      await this.accounts.updateHeldInTx(
        queryRunner,
        sourceId,
        addMinor(source.held, `-${command.amount}`),
      );
      const posted = await this.posting.postPendingInTx(queryRunner, transferId, command);
      await this.holds.settleInTx(queryRunner, hold.id);
      return posted;
    });
  }

  async cancelTransfer(params: CancelTransferParams): Promise<Transaction> {
    const { ownerId, transferId } = params;

    // 1. Load + anti-IDOR on the debit account, exactly like confirm (404 on missing/non-owned).
    const transfer = await this.transactions.findById(transferId);
    if (!transfer) {
      throw new TransferNotFoundError();
    }
    const debitAccountId = transfer.debitAccountId;
    if (!debitAccountId) {
      throw new TransferNotFoundError();
    }
    const debitAccount = await this.accounts.findByIdAndOwner(debitAccountId, ownerId);
    if (!debitAccount) {
      throw new TransferNotFoundError();
    }

    // 2. POSTED money cannot be cancelled; an already CANCELLED / EXPIRED transfer is returned
    //    as-is (idempotent). FAILED / REVERSED are not user-cancellable either.
    if (transfer.status === TransactionStatus.Posted) {
      throw new TransferNotPendingError();
    }
    if (
      transfer.status === TransactionStatus.Cancelled ||
      transfer.status === TransactionStatus.Expired
    ) {
      return transfer;
    }
    if (transfer.status !== TransactionStatus.Pending) {
      throw new TransferNotPendingError();
    }

    // 3. Guarded PENDING → CANCELLED (retained). A 0-row result means a concurrent transition
    //    beat us; either way, reload and return the current terminal state. For an EXTERNAL
    //    transfer the cancel also RELEASES the hold (`held -= amount`) in the SAME tx under the
    //    source lock; internal has no hold, so the plain single-statement cancel is used.
    if (transfer.type === TransactionType.ExternalOutbound) {
      await this.cancelExternalPendingReleasingHold(transfer);
    } else {
      await this.transactions.transitionToCancelled(transferId);
    }
    const cancelled = await this.transactions.findById(transferId);
    if (!cancelled) {
      // Unreachable: terminal rows are retained, never deleted.
      throw new TransferNotFoundError();
    }
    return cancelled;
  }

  async getPendingAuthorization(ownerId: string): Promise<PendingAuthorization | null> {
    const pending = await this.transactions.findPendingByInitiator(ownerId);
    if (!pending) {
      return null;
    }
    // Reading is a lazy-expiry access point: an overdue pending flips to EXPIRED (DB clock) and
    // is no longer an active authorization, so return none. For an EXTERNAL pending the expiry
    // also RELEASES the hold (`held -= amount`) in the SAME tx under the source lock.
    const expired =
      pending.type === TransactionType.ExternalOutbound
        ? await this.expireExternalPendingReleasingHold(pending)
        : await this.transactions.expireIfOverdue(pending.id);
    if (expired) {
      return null;
    }
    return this.buildPendingAuthorization(pending);
  }

  /** Redis key binding a confirmation token to the CALLER — another user's token cannot be
   * replayed because the owner id is part of the key. */
  private confirmKey(ownerId: string, token: string): string {
    return `xfer:confirm:${ownerId}:${token}`;
  }

  /** Verify the caller resolved+confirmed THIS destination: the token must exist (not expired)
   * AND bind to the resolved destination account id. A GET (not GETDEL) so an idempotent
   * initiate retry within the TTL still works; the TTL cleans the token up. */
  private async assertDestinationConfirmed(
    ownerId: string,
    confirmationToken: string,
    destinationAccountId: string,
  ): Promise<void> {
    const raw = await this.redis.get(this.confirmKey(ownerId, confirmationToken));
    if (raw === null) {
      throw new DestinationNotConfirmedError();
    }
    let record: ConfirmationRecord;
    try {
      record = JSON.parse(raw) as ConfirmationRecord;
    } catch {
      throw new DestinationNotConfirmedError();
    }
    if (record.destinationAccountId !== destinationAccountId) {
      throw new DestinationNotConfirmedError();
    }
  }

  /** Project a pending transfer for the OTP feed, branching on type so the app can show WHAT the
   * payment is to. INTERNAL: the destination's human account number + the holder's MASKED name
   * (masking applied HERE — PII never crosses the service boundary), `payeeDisplayName` null.
   * EXTERNAL_OUTBOUND: the enrolled payee's display name (the caller's own label, unmasked),
   * `destinationAccountNumber` / `destinationMaskedName` null. The source account id is left on
   * the `transaction` (`debitAccountId`, the caller's own) for the controller to whitelist. */
  private async buildPendingAuthorization(transaction: Transaction): Promise<PendingAuthorization> {
    if (transaction.type === TransactionType.ExternalOutbound) {
      let payeeDisplayName: string | null = null;
      if (transaction.payeeId) {
        const payee = await this.externalPayees.findById(transaction.payeeId);
        payeeDisplayName = payee?.displayName ?? null;
      }
      return {
        transaction,
        destinationAccountNumber: null,
        destinationMaskedName: null,
        payeeDisplayName,
      };
    }

    let destinationAccountNumber: string | null = null;
    let destinationMaskedName = '';
    if (transaction.creditAccountId) {
      const destination = await this.accounts.findById(transaction.creditAccountId);
      destinationAccountNumber = destination?.accountNumber ?? null;
      if (destination?.ownerId) {
        const holder = await this.customers.findById(destination.ownerId);
        destinationMaskedName = holder ? maskName(holder.name) : '';
      }
    }

    return { transaction, destinationAccountNumber, destinationMaskedName, payeeDisplayName: null };
  }

  /** The DB clock (`now()`), read as a JS `Date` — the authoritative instant for time-gated
   * decisions (never the app clock). Optionally scoped to a queryRunner's transaction so it
   * returns that tx's `transaction_timestamp()` (stable within the tx), matching the `now()` a
   * guarded UPDATE in the same tx evaluates. Used for the payee cooling-off gate and to decide
   * whether a prior pending is overdue (EXPIRED) vs merely superseded (CANCELLED). */
  private async readDbNow(queryRunner?: QueryRunner): Promise<Date> {
    const runner = queryRunner ?? this.dataSource;
    const rows: Array<{ now: Date }> = await runner.query('SELECT now() AS now');
    return new Date(rows[0].now);
  }

  /**
   * Release the hold of the initiator's PRIOR pending transfer when it is an external outbound,
   * BEFORE the expire/supersede flip at initiate. Under the prior source's `FOR UPDATE` lock it
   * releases the hold (`EXPIRED` if the prior is overdue by the DB clock, else `RELEASED` — the
   * status agrees with the flip the sweep will apply, since both use the SAME tx `now()`) and
   * decrements `held` by the hold amount — but ONLY when the guarded release actually flipped the
   * hold (so a concurrently-settled prior can never double-decrement `held`). Internal priors
   * carry no hold; if there is no prior pending, this is a no-op.
   */
  private async releasePriorExternalPendingHold(
    queryRunner: QueryRunner,
    ownerId: string,
  ): Promise<void> {
    const prior = await this.transactions.findPendingByInitiatorInTx(queryRunner, ownerId);
    if (!prior || prior.type !== TransactionType.ExternalOutbound || !prior.debitAccountId) {
      return;
    }
    const dbNow = await this.readDbNow(queryRunner);
    const overdue = prior.expiresAt !== null && dbNow.getTime() >= prior.expiresAt.getTime();
    const releaseStatus = overdue ? HoldStatus.Expired : HoldStatus.Released;
    await this.releaseHoldForTransactionInTx(
      queryRunner,
      prior.debitAccountId,
      prior.id,
      releaseStatus,
    );
  }

  /**
   * Lazy expiry of an OVERDUE external-outbound pending that also RELEASES its hold, in ONE
   * locked, deadlock-retried transaction (the read/confirm expiry access points). Locks the
   * source, runs the guarded DB-clock `expireIfOverdueInTx` (`PENDING & overdue → EXPIRED`); if it
   * flipped, releases the hold (`→ EXPIRED`) and decrements `held`. Returns `true` iff it expired
   * the transfer (so confirm rejects WITHOUT consuming the OTP). Not overdue / already terminal →
   * `false` (no hold or `held` change).
   */
  private expireExternalPendingReleasingHold(transfer: Transaction): Promise<boolean> {
    const sourceId = transfer.debitAccountId;
    if (!sourceId) {
      // An external pending always carries its source; a breach is malformed state.
      return Promise.resolve(false);
    }
    return runInTransactionWithRetry(this.dataSource, async (queryRunner) => {
      await this.accounts.lockByIdForUpdate(queryRunner, sourceId);
      const expired = await this.transactions.expireIfOverdueInTx(queryRunner, transfer.id);
      if (!expired) {
        return false;
      }
      await this.releaseHoldForTransactionInTx(
        queryRunner,
        sourceId,
        transfer.id,
        HoldStatus.Expired,
      );
      return true;
    });
  }

  /**
   * Explicit cancel of an external-outbound pending that also RELEASES its hold, in ONE locked,
   * deadlock-retried transaction. Locks the source, runs the guarded `transitionToCancelledInTx`
   * (`PENDING → CANCELLED`); if it flipped, releases the hold (`→ RELEASED`) and decrements `held`.
   * A 0-row flip (concurrently terminal) leaves the hold untouched.
   */
  private cancelExternalPendingReleasingHold(transfer: Transaction): Promise<void> {
    const sourceId = transfer.debitAccountId;
    if (!sourceId) {
      return Promise.resolve();
    }
    return runInTransactionWithRetry(this.dataSource, async (queryRunner) => {
      await this.accounts.lockByIdForUpdate(queryRunner, sourceId);
      const cancelled = await this.transactions.transitionToCancelledInTx(queryRunner, transfer.id);
      if (cancelled) {
        await this.releaseHoldForTransactionInTx(
          queryRunner,
          sourceId,
          transfer.id,
          HoldStatus.Released,
        );
      }
    });
  }

  /**
   * Release the PLACED hold backing a transaction and decrement its source's `held` accordingly,
   * inside the caller's already-open transaction. Acquires the source's `FOR UPDATE` lock FIRST —
   * so every hold-mutating path locks the SOURCE before the TRANSACTION row (the settle path does
   * too), a single consistent order that removes the opposite-order deadlock — then re-reads
   * `held` under that lock (so `held -= hold.amount` is exact), releases the hold (guarded), and
   * decrements. The decrement is applied ONLY when `releaseInTx` actually flipped the hold, so a
   * concurrently settled/released hold never double-decrements `held` (preserving
   * `SUM(PLACED) == held`). No ledger entry — releasing returns the reservation, it does not move
   * money. Re-locking a source the caller already locked is a harmless re-entrant no-op.
   */
  private async releaseHoldForTransactionInTx(
    queryRunner: QueryRunner,
    sourceId: string,
    transactionId: string,
    status: HoldStatus.Released | HoldStatus.Expired,
  ): Promise<void> {
    const source = await this.accounts.lockByIdForUpdate(queryRunner, sourceId);
    if (!source) {
      // Unreachable: the source id comes from the transfer's own debit account; a vanished row is
      // a fault, not a business error.
      throw new TransferNotFoundError();
    }
    const hold = await this.holds.findByTransactionInTx(queryRunner, transactionId);
    if (!hold) {
      return;
    }
    const released = await this.holds.releaseInTx(queryRunner, hold.id, status);
    if (!released) {
      return;
    }
    await this.accounts.updateHeldInTx(
      queryRunner,
      sourceId,
      addMinor(source.held, `-${hold.amount}`),
    );
  }
}
