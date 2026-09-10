import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { runInTransactionWithRetry } from '../../../../common/db/run-in-transaction';
import {
  AccountKind,
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
import { CurrencyMismatchError } from '../../../posting/service/errors';
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
 * The internal-transfer lifecycle (spec 04 Transfers): two-phase and OTP-gated, fronted by a
 * confirmation-of-payee step. `resolveDestination` turns a human account number into a masked
 * holder name + a caller-bound confirmation token (a pure query, no transaction); `initiate`
 * REQUIRES that token, creating a PENDING transaction (no money moves) under the caller's
 * `Idempotency-Key`; `confirm` consumes the caller's one-time code and posts the transfer
 * through the shared posting reducer's confirm-time seam ({@link IPostingService.postPendingInTx}).
 *
 * Money-once is guaranteed by two independent gates: the `Idempotency-Key` dedups duplicate
 * CREATION at initiate, and at confirm the OTP single-use (`GETDEL`) plus the guarded
 * PENDING→POSTED transition ensure the movement happens exactly once. The OTP is consumed
 * BEFORE the post transaction — the single-use `GETDEL` is the authorization gate; if the post
 * then fails (insufficient funds under the lock, etc.) the code is spent and the transfer
 * stays PENDING, so a retry needs a fresh code (matching the spec's confirm-time funds check).
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
    //    If `expireIfOverdue` flips the row, it WAS overdue → reject WITHOUT consuming the code,
    //    so an expired transfer never burns the caller's one-time code.
    const expired = await this.transactions.expireIfOverdue(transferId);
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
      // A PENDING internal transfer always carries a destination; a breach is malformed state.
      throw new InvalidTransferError('transfer is missing a destination account');
    }

    // 5. Consume the one-time code. Single-use is atomic (GETDEL): a correct code authorizes
    //    exactly one confirm. A wrong code is retryable until lockout.
    const result = await this.otp.consume(ownerId, code);
    if (!result.ok) {
      throw result.lockedOut ? new OtpLockedOutError() : new InvalidOtpError();
    }

    // 6. Post the pending transfer: the guarded transition + funds check under the account
    //    lock, inside one deadlock-retried transaction. The legs are the signed double-entry:
    //    debit source (−amount), credit destination (+amount).
    const command: PostTransactionCommand = {
      type: TransactionType.Internal,
      currency: current.currency,
      amount: current.amount,
      legs: [
        { accountId: debitAccountId, delta: `-${current.amount}` },
        { accountId: creditAccountId, delta: current.amount },
      ],
      initiatedBy: ownerId,
    };
    const posted = await runInTransactionWithRetry(this.dataSource, (queryRunner) =>
      this.posting.postPendingInTx(queryRunner, transferId, command),
    );
    return posted;
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
    //    beat us; either way, reload and return the current terminal state.
    await this.transactions.transitionToCancelled(transferId);
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
    // is no longer an active authorization, so return none.
    const expired = await this.transactions.expireIfOverdue(pending.id);
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

  /** Project a pending transfer for the OTP feed: the destination's human account number and the
   * holder's MASKED name (so the app shows who the payment is to). Masking is applied HERE (PII
   * never crosses the service boundary); the source account id is left on the `transaction`
   * (`debitAccountId`, the caller's own) for the controller to whitelist. Only the DESTINATION
   * needs a per-row account/customer lookup (prototype). */
  private async buildPendingAuthorization(transaction: Transaction): Promise<PendingAuthorization> {
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

    return { transaction, destinationAccountNumber, destinationMaskedName };
  }
}
