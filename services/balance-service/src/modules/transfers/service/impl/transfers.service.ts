import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
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
  ITransactionRepository,
  TRANSACTION_REPOSITORY,
} from '../../../../database/repositories/interfaces/transaction.repository.interface';
import {
  IDEMPOTENCY_SERVICE,
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
  InvalidOtpError,
  InvalidTransferError,
  OtpLockedOutError,
  TransferNotFoundError,
  TransferNotPendingError,
} from '../errors';
import {
  ConfirmTransferParams,
  InitiateTransferParams,
  ITransfersService,
} from '../interfaces/transfers.service.interface';

/** Canonical unsigned minor-unit string (a positive amount magnitude). Validated before any
 * `BigInt()` so a malformed value raises the domain error, not a raw `SyntaxError`. */
const UNSIGNED_MINOR_UNITS = /^\d+$/;

/**
 * The internal-transfer lifecycle (spec 04 Transfers): two-phase and OTP-gated. Initiate
 * creates a PENDING transaction (no money moves) under the caller's `Idempotency-Key`;
 * confirm consumes the caller's one-time code and posts the transfer through the shared
 * posting reducer's confirm-time seam ({@link IPostingService.postPendingInTx}).
 *
 * Money-once is guaranteed by two independent gates: the `Idempotency-Key` dedups duplicate
 * CREATION at initiate, and at confirm the OTP single-use (`GETDEL`) plus the guarded
 * PENDING→POSTED transition ensure the movement happens exactly once. The OTP is consumed
 * BEFORE the post transaction — the single-use `GETDEL` is the authorization gate; if the post
 * then fails (insufficient funds under the lock, etc.) the code is spent and the transfer
 * stays PENDING, so a retry needs a fresh code (matching the spec's confirm-time funds check).
 *
 * The service works in ENTITIES; DTO serialization is a transport concern at the controller.
 */
@Injectable()
export class TransfersService implements ITransfersService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: IAccountRepository,
    @Inject(TRANSACTION_REPOSITORY) private readonly transactions: ITransactionRepository,
    @Inject(IDEMPOTENCY_SERVICE) private readonly idempotency: IIdempotencyService,
    @Inject(OTP_SERVICE) private readonly otp: IOtpService,
    @Inject(POSTING_SERVICE) private readonly posting: IPostingService,
  ) {}

  async initiateTransfer(params: InitiateTransferParams): Promise<Transaction> {
    const {
      ownerId,
      sourceAccountId,
      destinationAccountId,
      amount,
      currency,
      idempotencyKey,
      confirmDuplicate,
    } = params;

    // a. Shape invariants (defense-in-depth; the wire schema also enforces these).
    if (sourceAccountId === destinationAccountId) {
      throw new InvalidTransferError('source and destination accounts must differ');
    }
    if (!UNSIGNED_MINOR_UNITS.test(amount) || BigInt(amount) <= 0n) {
      throw new InvalidTransferError('amount must be a positive minor-unit integer');
    }
    if (!currency || currency.trim().length === 0) {
      throw new InvalidTransferError('currency is required');
    }

    // b. Anti-IDOR + existence. The SOURCE is owner-scoped (a non-owned/missing source is a
    //    404, never revealing non-ownership). The DESTINATION is resolved by id alone (you
    //    transfer TO another customer's account), so it uses `findById`.
    const source = await this.accounts.findByIdAndOwner(sourceAccountId, ownerId);
    if (!source) {
      throw new TransferNotFoundError();
    }
    const destination = await this.accounts.findById(destinationAccountId);
    if (!destination) {
      throw new TransferNotFoundError();
    }

    // c. Both must be customer accounts sharing the request currency (internal rail only).
    if (source.kind !== AccountKind.Customer || destination.kind !== AccountKind.Customer) {
      throw new InvalidTransferError('both accounts must be customer accounts');
    }
    if (source.currency !== currency) {
      throw new CurrencyMismatchError(source.id, source.currency, currency);
    }
    if (destination.currency !== currency) {
      throw new CurrencyMismatchError(destination.id, destination.currency, currency);
    }

    // d. Claim the Idempotency-Key and create the PENDING header under it (no money moves).
    //    A replayed key returns the original transaction id; SUSPECTED_DUPLICATE /
    //    IDEMPOTENCY_KEY_REUSED propagate from the wrapper.
    const outcome = await this.idempotency.execute(
      {
        ownerId,
        key: idempotencyKey,
        fingerprintInput: {
          type: 'internal',
          source: sourceAccountId,
          destination: destinationAccountId,
          amount,
          currency,
        },
        confirmDuplicate,
      },
      async (queryRunner) => {
        const created = await this.transactions.insertInTx(queryRunner, {
          id: randomUUID(),
          type: TransactionType.Internal,
          status: TransactionStatus.Pending,
          amount,
          currency,
          debitAccountId: sourceAccountId,
          creditAccountId: destinationAccountId,
          initiatedBy: ownerId,
          postedAt: null,
        });
        return { transactionId: created.id };
      },
    );

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
    //    money already moved). Anything else non-PENDING cannot be posted.
    if (transfer.status === TransactionStatus.Posted) {
      return transfer;
    }
    if (transfer.status !== TransactionStatus.Pending) {
      throw new TransferNotPendingError();
    }

    const creditAccountId = transfer.creditAccountId;
    if (!creditAccountId) {
      // A PENDING internal transfer always carries a destination; a breach is malformed state.
      throw new InvalidTransferError('transfer is missing a destination account');
    }

    // 4. Consume the one-time code. Single-use is atomic (GETDEL): a correct code authorizes
    //    exactly one confirm. A wrong code is retryable until lockout.
    const result = await this.otp.consume(ownerId, code);
    if (!result.ok) {
      throw result.lockedOut ? new OtpLockedOutError() : new InvalidOtpError();
    }

    // 5. Post the pending transfer: the guarded transition + funds check under the account
    //    lock, inside one deadlock-retried transaction. The legs are the signed double-entry:
    //    debit source (−amount), credit destination (+amount).
    const command: PostTransactionCommand = {
      type: TransactionType.Internal,
      currency: transfer.currency,
      amount: transfer.amount,
      legs: [
        { accountId: debitAccountId, delta: `-${transfer.amount}` },
        { accountId: creditAccountId, delta: transfer.amount },
      ],
      initiatedBy: ownerId,
    };
    return runInTransactionWithRetry(this.dataSource, (queryRunner) =>
      this.posting.postPendingInTx(queryRunner, transferId, command),
    );
  }

  listPendingAuthorizations(ownerId: string): Promise<Transaction[]> {
    return this.transactions.findPendingByInitiator(ownerId);
  }
}
