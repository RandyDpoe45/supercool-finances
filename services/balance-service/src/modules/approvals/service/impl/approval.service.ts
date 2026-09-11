import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { runInTransactionWithRetry } from '../../../../common/db/run-in-transaction';
import { ApprovalRequest } from '../../../../database/entities/approval-request.entity';
import {
  ApprovalAction,
  ApprovalStatus,
  TransactionStatus,
  TransactionType,
} from '../../../../database/entities/enums';
import {
  ACCOUNT_REPOSITORY,
  IAccountRepository,
} from '../../../../database/repositories/interfaces/account.repository.interface';
import {
  APPROVAL_REQUEST_REPOSITORY,
  IApprovalRequestRepository,
} from '../../../../database/repositories/interfaces/approval-request.repository.interface';
import {
  ITransactionRepository,
  TRANSACTION_REPOSITORY,
} from '../../../../database/repositories/interfaces/transaction.repository.interface';
import {
  AUDIT_ACTIONS,
  AUDIT_SERVICE,
  IAuditService,
} from '../../../audit/service/interfaces/audit.service.interface';
import { PostTransactionCommand } from '../../../posting/service/interfaces/post-transaction.command';
import {
  IPostingService,
  POSTING_SERVICE,
} from '../../../posting/service/interfaces/posting.service.interface';
// The reversal target is a transaction; a missing/unknown target reuses the transfers-owned
// TRANSFER_NOT_FOUND (404) — the same "transaction not found" semantics, no new code.
import { TransferNotFoundError } from '../../../transfers/service/errors';
import {
  ApprovalNotFoundError,
  ApprovalNotPendingError,
  ReversalAlreadyRequestedError,
  SelfApprovalForbiddenError,
  TransactionNotReversibleError,
} from '../errors';
import { IApprovalService } from '../interfaces/approval.service.interface';

/**
 * Maker-checker (four-eyes) reversals (spec 04 "Admin ops", step 8b). A maker proposes a reversal
 * of a POSTED internal transfer / external_inbound credit; a DIFFERENT checker approves (executing
 * it atomically) or rejects it.
 *
 * Money-safety keystones:
 * - **Two guarded gates.** Approve runs in ONE deadlock-retried tx and depends on two guarded,
 *   `WHERE status = ...` UPDATEs, each of which "exactly one caller wins": the approval
 *   `PENDING → EXECUTED` transition (the maker-checker concurrency gate — two simultaneous checkers
 *   yield exactly ONE execution) and the original `POSTED → REVERSED` transition (the
 *   no-double-reversal gate — a duplicate approval can never reverse twice). If either affects 0
 *   rows the whole tx rolls back.
 * - **All money funnels through the reducer.** The compensating movement is posted via
 *   {@link IPostingService.postFreshInTx} inside the same tx — a balanced double-entry (credit the
 *   original debit account, debit the original credit account) carrying `reverses_transaction_id`.
 * - **FORCED, but still balanced.** The compensating post sets `forced: true`, so the counterparty
 *   debit BYPASSES the overdraft + frozen checks and always applies (the counterparty may go
 *   negative) — no money is created or lost, and it is authorized by four-eyes. `forced` is set
 *   ONLY here; it is unreachable from any customer-initiated path.
 * - **Reversals don't touch spend counters** — no `limitAccountId` on the compensating command
 *   (fixed-window limits, consistent with the outbound-only rule).
 * - **Source-before-clearing.** An external_inbound reversal debits the customer and credits the
 *   `clearing:rail-inbound` system account; the customer (the original CREDIT account) is locked
 *   FIRST — before the reducer's canonical locking reaches the clearing account — exactly as the
 *   rail settlement/inbound paths do, so a reversal can never deadlock against a concurrent rail op.
 *   An internal reversal is customer↔customer, so no pre-lock is needed (the reducer locks
 *   canonically by id).
 */
@Injectable()
export class ApprovalService implements IApprovalService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(APPROVAL_REQUEST_REPOSITORY) private readonly approvals: IApprovalRequestRepository,
    @Inject(TRANSACTION_REPOSITORY) private readonly transactions: ITransactionRepository,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: IAccountRepository,
    @Inject(POSTING_SERVICE) private readonly posting: IPostingService,
    @Inject(AUDIT_SERVICE) private readonly audit: IAuditService,
  ) {}

  async proposeReversal(
    actorId: string,
    transactionId: string,
    reason?: string,
  ): Promise<ApprovalRequest> {
    // Load the target (plain read). Missing → 404 (reuses TRANSFER_NOT_FOUND).
    const target = await this.transactions.findById(transactionId);
    if (!target) {
      throw new TransferNotFoundError();
    }
    // Reversible = a POSTED internal transfer OR a POSTED external_inbound credit. NOT
    // external_outbound (its reversal is the 5c rail-failure path); non-POSTED / already-REVERSED
    // → not reversible.
    const reversible =
      target.status === TransactionStatus.Posted &&
      (target.type === TransactionType.Internal || target.type === TransactionType.ExternalInbound);
    if (!reversible) {
      throw new TransactionNotReversibleError();
    }

    // Best-effort duplicate guard: reject a new proposal if one is already PENDING or EXECUTED for
    // this target. The hard backstop is the guarded POSTED → REVERSED at execute time (two PENDING
    // approvals can never both reverse), so this need not be transactional.
    const existing = await this.approvals.findByTargetTransaction(transactionId);
    if (
      existing.some(
        (approval) =>
          approval.status === ApprovalStatus.Pending || approval.status === ApprovalStatus.Executed,
      )
    ) {
      throw new ReversalAlreadyRequestedError();
    }

    // In ONE tx: create the PENDING approval + write the propose audit row (they commit together).
    return runInTransactionWithRetry(this.dataSource, async (queryRunner) => {
      const approval = await this.approvals.createInTx(queryRunner, {
        actionType: ApprovalAction.Reversal,
        status: ApprovalStatus.Pending,
        makerId: actorId,
        checkerId: null,
        targetTransactionId: transactionId,
        payload: {
          reason: reason ?? null,
          originalType: target.type,
          amount: target.amount,
          debitAccountId: target.debitAccountId,
          creditAccountId: target.creditAccountId,
        },
      });
      await this.audit.recordInTx(queryRunner, {
        actorId,
        action: AUDIT_ACTIONS.REVERSAL_PROPOSED,
        targetType: 'transaction',
        targetId: transactionId,
        metadata: { approvalId: approval.id, amount: target.amount },
      });
      return approval;
    });
  }

  async approve(actorId: string, approvalId: string): Promise<ApprovalRequest> {
    const approval = await this.approvals.findById(approvalId);
    if (!approval) {
      throw new ApprovalNotFoundError();
    }
    if (
      approval.actionType !== ApprovalAction.Reversal ||
      approval.status !== ApprovalStatus.Pending
    ) {
      throw new ApprovalNotPendingError();
    }
    // Four-eyes: a maker can never decide their own proposal (the DB CHECK backstops this).
    if (actorId === approval.makerId) {
      throw new SelfApprovalForbiddenError();
    }
    const targetTransactionId = approval.targetTransactionId;
    if (!targetTransactionId) {
      // A reversal approval always carries its target; a breach is malformed state (500-class).
      throw new Error(`Reversal approval ${approvalId} is missing its target transaction`);
    }

    return runInTransactionWithRetry(this.dataSource, async (queryRunner) => {
      // 1. Maker-checker concurrency gate: guarded PENDING → EXECUTED. 0 rows → a concurrent
      //    checker already decided → not pending (rolls back). Sets checker_id = actorId (the
      //    service already verified checker <> maker, so the DB CHECK never fires).
      const executed = await this.approvals.transitionToExecutedInTx(
        queryRunner,
        approvalId,
        actorId,
      );
      if (!executed) {
        throw new ApprovalNotPendingError();
      }

      // 2. Load the target UNDER the tx and derive the compensating legs from its CURRENT
      //    debit/credit accounts (not the propose-time payload snapshot).
      const original = await this.transactions.findByIdInTx(queryRunner, targetTransactionId);
      if (!original) {
        throw new TransferNotFoundError();
      }
      const originalDebitId = original.debitAccountId;
      const originalCreditId = original.creditAccountId;
      if (!originalDebitId || !originalCreditId) {
        // A reversible internal / external_inbound movement is always a clean 2-leg pair.
        throw new Error(
          `Transaction ${targetTransactionId} is missing a leg and cannot be reversed`,
        );
      }

      // 3. Lock ordering. An external_inbound reversal touches a clearing/system account: the
      //    original CREDIT is the customer (now debited), the original DEBIT is clearing (now
      //    credited). Lock the CUSTOMER (the original credit account) FIRST — source-before-clearing
      //    — before postFreshInTx's canonical locking reaches the clearing account. An internal
      //    reversal is customer↔customer; let postFreshInTx lock canonically (no pre-lock).
      if (original.type === TransactionType.ExternalInbound) {
        await this.accounts.lockByIdForUpdate(queryRunner, originalCreditId);
      }

      // 4. No-double-reversal gate: guarded POSTED → REVERSED. 0 rows → already reversed / not
      //    posted → not reversible (rolls back, so the EXECUTED transition is undone too). The
      //    reason `'admin_reversal'` (not the rail default) is stamped on the original's
      //    `failure_reason` so the admin transaction view never mislabels it as a rail failure.
      const reversed = await this.transactions.transitionToReversedInTx(
        queryRunner,
        targetTransactionId,
        'admin_reversal',
      );
      if (!reversed) {
        throw new TransactionNotReversibleError();
      }

      // 5. Post the FORCED compensating movement: credit the original debit account (+amount),
      //    debit the original credit account (−amount) — mirrored legs, balanced, carrying
      //    `reverses_transaction_id`. `forced: true` bypasses the counterparty debit's overdraft +
      //    frozen checks (it may go negative). NO limitAccountId (reversals don't touch spend
      //    counters).
      const command: PostTransactionCommand = {
        type: original.type,
        currency: original.currency,
        amount: original.amount,
        legs: [
          { accountId: originalDebitId, delta: original.amount },
          { accountId: originalCreditId, delta: `-${original.amount}` },
        ],
        initiatedBy: actorId,
        reversesTransactionId: targetTransactionId,
        forced: true,
        // No payee snapshot on a reversal — the emitted compensating event links to the original
        // via reversesTransactionId (payee is external_outbound-forward only).
        payee: null,
      };
      const compensating = await this.posting.postFreshInTx(queryRunner, command);

      // 6. Audit the executed reversal.
      await this.audit.recordInTx(queryRunner, {
        actorId,
        action: AUDIT_ACTIONS.REVERSAL_EXECUTED,
        targetType: 'transaction',
        targetId: targetTransactionId,
        metadata: {
          approvalId,
          reversalTransactionId: compensating.id,
          originalAmount: original.amount,
        },
      });

      // Return the EXECUTED approval, re-read within the tx so it reflects the transition.
      const after = await this.approvals.findByIdInTx(queryRunner, approvalId);
      if (!after) {
        // Unreachable: the row was just transitioned under this same transaction.
        throw new Error(`Approval ${approvalId} vanished after its EXECUTED transition`);
      }
      return after;
    });
  }

  async reject(actorId: string, approvalId: string): Promise<ApprovalRequest> {
    const approval = await this.approvals.findById(approvalId);
    if (!approval) {
      throw new ApprovalNotFoundError();
    }
    if (
      approval.actionType !== ApprovalAction.Reversal ||
      approval.status !== ApprovalStatus.Pending
    ) {
      throw new ApprovalNotPendingError();
    }
    // Four-eyes: the DB CHECK forbids checker == maker on reject too, so guard it here.
    if (actorId === approval.makerId) {
      throw new SelfApprovalForbiddenError();
    }

    return runInTransactionWithRetry(this.dataSource, async (queryRunner) => {
      const rejected = await this.approvals.transitionToRejectedInTx(
        queryRunner,
        approvalId,
        actorId,
      );
      if (!rejected) {
        // A concurrent checker already decided it.
        throw new ApprovalNotPendingError();
      }
      await this.audit.recordInTx(queryRunner, {
        actorId,
        action: AUDIT_ACTIONS.REVERSAL_REJECTED,
        targetType: 'approval',
        targetId: approvalId,
      });
      const after = await this.approvals.findByIdInTx(queryRunner, approvalId);
      if (!after) {
        // Unreachable: the row was just transitioned under this same transaction.
        throw new Error(`Approval ${approvalId} vanished after its REJECTED transition`);
      }
      return after;
    });
  }
}
