import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { runInTransactionWithRetry } from '../../../../common/db/run-in-transaction';
import { INBOUND_RAIL } from '../../../../common/rails/inbound-rail';
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
  HOLD_REPOSITORY,
  IHoldRepository,
} from '../../../../database/repositories/interfaces/hold.repository.interface';
import {
  ITransactionRepository,
  TRANSACTION_REPOSITORY,
} from '../../../../database/repositories/interfaces/transaction.repository.interface';
import {
  IDEMPOTENCY_SERVICE,
  IIdempotencyService,
} from '../../../idempotency/service/interfaces/idempotency.service.interface';
import { CurrencyMismatchError } from '../../../posting/service/errors';
import { PostTransactionCommand } from '../../../posting/service/interfaces/post-transaction.command';
import {
  IPostingService,
  POSTING_SERVICE,
} from '../../../posting/service/interfaces/posting.service.interface';
import {
  InboundDestinationNotFoundError,
  InvalidSettlementStateError,
  SettlementTargetNotFoundError,
} from '../errors';
import {
  InboundCreditParams,
  IRailsService,
  OutboundSettlementParams,
} from '../interfaces/rails.service.interface';

/** The `system_key` of the per-rail inbound clearing account an external inbound debits — the
 * counter-leg of the customer credit. Seeded by `SeedSystemAccounts` (`clearing:rail-inbound`). */
const INBOUND_CLEARING_KEY = `clearing:${INBOUND_RAIL}`;

/** The actor recorded on the transaction header for a rail-webhook-posted movement (a reversal or
 * an inbound credit). A SYSTEM identity — never a customer `sub` — with the `system:` prefix that
 * marks system actors (mirroring the `clearing:` / `otp:` key conventions), so it can never
 * collide with a customer or hit the single-pending index (rail movements are POSTED, not PENDING). */
const RAIL_ACTOR = 'system:rail';

/**
 * The mocked external rail webhooks (spec 04 "Mocked external rails", step 5c). Applies the
 * outbound settlement callback and the inbound credit that the `/external` surface receives.
 *
 * Money-safety keystones: every money movement here funnels through the single posting reducer
 * ({@link IPostingService.postFreshInTx} — balance + ledger + outbox in ONE tx). Both callbacks
 * are IDEMPOTENT:
 * - **outbound success** is RECONCILE-ONLY — record the rail ref on the settled hold, NO ledger
 *   movement (the money already moved customer → `clearing:rail-outbound` at OTP-confirm). The
 *   `external_ref IS NULL` guard makes a retry a no-op.
 * - **outbound failure** REVERSES — one tx, customer-locked FIRST, guarded `POSTED → REVERSED`,
 *   then a fresh compensating `clearing → customer` movement (`reverses_transaction_id`). The
 *   guarded transition makes a retry a no-op (no double reversal).
 * - **inbound** is a fresh POSTED `external_inbound` movement (`clearing:rail-inbound` → customer),
 *   NOT OTP-gated, deduplicated by the rail `externalRef` (a duplicate ref returns the original —
 *   no double-credit; distinct refs always process). A frozen customer may still be credited (the
 *   reducer only blocks customer DEBITS).
 *
 * Success XOR failure — never both. The two outbound branches guard on DISJOINT rows (success on
 * the hold's `external_ref IS NULL`, failure on the transaction's `status = POSTED`), so a
 * simultaneous success + failure for one transfer would otherwise both commit (a double-apply on a
 * third-party trust boundary). Both branches therefore lock the **customer (source) row FIRST** —
 * the SAME row — as their first in-tx step, and read the state-machine inputs (transaction status +
 * hold `external_ref`) only AFTER that lock: the second-arriving callback re-reads the first's
 * committed effect and rejects (`INVALID_SETTLEMENT_STATE`) / no-ops.
 *
 * Source-before-clearing: every path that touches a customer + a clearing account locks the
 * CUSTOMER first (before the reducer's canonical locking reaches the clearing account), the same
 * order a 5b settle uses — so a rail op can never deadlock against a concurrent settle. (Success
 * touches no clearing account; it still locks the customer purely to serialize against failure.)
 *
 * The methods return the plain {@link Transaction} entity; DTO serialization is a transport
 * concern applied at the controller.
 */
@Injectable()
export class RailsService implements IRailsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: IAccountRepository,
    @Inject(TRANSACTION_REPOSITORY) private readonly transactions: ITransactionRepository,
    @Inject(HOLD_REPOSITORY) private readonly holds: IHoldRepository,
    @Inject(POSTING_SERVICE) private readonly posting: IPostingService,
    @Inject(IDEMPOTENCY_SERVICE) private readonly idempotency: IIdempotencyService,
  ) {}

  async settleOutbound(params: OutboundSettlementParams): Promise<Transaction> {
    const { transactionId, status, externalRef } = params;

    // 1. Load the target (plain read). Missing → 404. It MUST be an external_outbound transfer;
    //    anything else is a 409 (the rail correlated on a non-outbound id).
    const transfer = await this.transactions.findById(transactionId);
    if (!transfer) {
      throw new SettlementTargetNotFoundError(transactionId);
    }
    if (transfer.type !== TransactionType.ExternalOutbound) {
      throw new InvalidSettlementStateError(
        `transaction ${transactionId} is not an external outbound (${transfer.type})`,
      );
    }
    const customerId = transfer.debitAccountId; // the payer (source), debited at confirm
    if (!customerId) {
      // An external_outbound always carries its debit (source) account; a breach is malformed state.
      throw new Error(`External outbound ${transactionId} is missing its debit account`);
    }

    return status === 'success'
      ? this.reconcileOutboundSuccess(transactionId, customerId, externalRef)
      : this.reverseOutboundFailure(transactionId, customerId);
  }

  /**
   * Rail SUCCESS: reconcile only. In ONE tx, record the rail `externalRef` on the settled hold —
   * NO ledger movement, NO balance/held change. Idempotent (rail ref already set → no-op); a
   * success for an already-reversed transfer is rejected (a failed transfer can't later succeed).
   *
   * Concurrency: the customer (source) row is locked `FOR UPDATE` as the FIRST in-tx step — the
   * SAME lock the failure path takes — so a simultaneous success + failure for one transfer are
   * SERIALIZED on that row: the second-arriving callback re-reads the first's committed effect and
   * rejects. Without this, the success guard (hold `external_ref IS NULL`) and the failure guard
   * (transaction `status = POSTED`) sit on DISJOINT rows and could both commit (double-apply).
   */
  private reconcileOutboundSuccess(
    transactionId: string,
    customerId: string,
    externalRef: string,
  ): Promise<Transaction> {
    return runInTransactionWithRetry(this.dataSource, async (queryRunner) => {
      // Lock the customer (source) FIRST — the serialization point shared with the failure path.
      const customer = await this.accounts.lockByIdForUpdate(queryRunner, customerId);
      if (!customer) {
        throw new Error(`Customer account ${customerId} vanished during settlement`);
      }

      // Read the state-machine inputs UNDER the lock, so a concurrent failure's committed effect
      // (status → REVERSED) is visible to a later-arriving success.
      const current = await this.transactions.findByIdInTx(queryRunner, transactionId);
      if (!current) {
        // Unreachable: the id was just found in settleOutbound; a vanished row is a fault.
        throw new SettlementTargetNotFoundError(transactionId);
      }
      const hold = await this.holds.findByTransactionInTx(queryRunner, transactionId);
      if (!hold) {
        // A confirmed external_outbound always carries its (SETTLED) hold — the reservation that
        // backed the customer → clearing move. Its absence is a broken invariant, not a client fault.
        throw new Error(`External outbound ${transactionId} has no hold to reconcile`);
      }

      // Idempotent: the rail ref is already recorded → a retried success callback → no-op.
      if (hold.externalRef !== null) {
        return current;
      }
      // A reversed (failed) transfer cannot later be reported as success.
      if (current.status === TransactionStatus.Reversed) {
        throw new InvalidSettlementStateError(
          `transaction ${transactionId} was reversed and cannot be settled as success`,
        );
      }
      // A success is only valid on a POSTED (settled) external_outbound — reject a stale success on
      // a PENDING/EXPIRED/CANCELLED one, symmetric with the failure's `WHERE status = POSTED` gate.
      if (current.status !== TransactionStatus.Posted) {
        throw new InvalidSettlementStateError(
          `transaction ${transactionId} is not posted (${current.status}) and cannot be reconciled`,
        );
      }

      // Reconcile ONLY (external_ref IS NULL guard is the concurrency backstop). No money moves.
      await this.holds.recordExternalRefInTx(queryRunner, hold.id, externalRef);
      return current;
    });
  }

  /**
   * Rail FAILURE: reverse. In ONE tx — lock the customer (source) FIRST (the serialization point
   * shared with the success path, AND customer-before-clearing so postFreshInTx's canonical locking
   * reaches clearing after), then guarded `POSTED → REVERSED`, then a fresh compensating
   * `clearing → customer` movement (`reverses_transaction_id` = the original) that refunds the
   * payer. Idempotent (already reversed → no-op, no double reversal); a failure for an
   * already-reconciled success is rejected. Returns the ORIGINAL transfer (now REVERSED).
   */
  private reverseOutboundFailure(transactionId: string, customerId: string): Promise<Transaction> {
    // A failure does NOT record the rail ref (nothing is reconciled) — the hold stays SETTLED with
    // external_ref NULL, and the reversal is recorded via the compensating transaction. The rail
    // externalRef is used only to reject a failure against an already-reconciled success, checked
    // via the hold read below.
    return runInTransactionWithRetry(this.dataSource, async (queryRunner) => {
      // Lock the CUSTOMER (source) FIRST — the serialization point shared with the success path,
      // and before postFreshInTx's canonical locking reaches the clearing account (so the effective
      // order is customer → clearing, deadlock-free against a 5b settle that locks the same order).
      const customer = await this.accounts.lockByIdForUpdate(queryRunner, customerId);
      if (!customer) {
        throw new Error(`Customer account ${customerId} vanished during reversal`);
      }

      // Read the state-machine inputs UNDER the lock, so a concurrent success's committed effect
      // (hold.external_ref set) is visible to a later-arriving failure.
      const current = await this.transactions.findByIdInTx(queryRunner, transactionId);
      if (!current) {
        throw new SettlementTargetNotFoundError(transactionId);
      }
      // Idempotent: an already-reversed transfer → no-op (no double reversal).
      if (current.status === TransactionStatus.Reversed) {
        return current;
      }
      const hold = await this.holds.findByTransactionInTx(queryRunner, transactionId);
      if (!hold) {
        throw new Error(`External outbound ${transactionId} has no hold to reverse`);
      }
      // A success already reconciled (rail ref recorded) cannot later be reported as failure.
      if (hold.externalRef !== null) {
        throw new InvalidSettlementStateError(
          `transaction ${transactionId} was reconciled as success and cannot be reversed`,
        );
      }

      const clearingId = current.creditAccountId; // clearing:rail-outbound, credited at confirm
      if (!clearingId) {
        // A settled external_outbound always carries its credit (clearing) leg; a breach is malformed.
        throw new Error(`External outbound ${transactionId} is missing its credit account`);
      }

      // Guarded POSTED → REVERSED — the idempotency gate. 0 rows → a concurrent caller already
      // reversed it → no-op / re-read (never a second compensating post).
      const reversed = await this.transactions.transitionToReversedInTx(queryRunner, transactionId);
      if (!reversed) {
        const after = await this.transactions.findByIdInTx(queryRunner, transactionId);
        return after ?? current;
      }

      // Post the fresh compensating movement: clearing → customer (refunds the payer). The
      // customer leg is a CREDIT, so a frozen customer is still refunded; clearing (a system
      // account) may go negative. `reverses_transaction_id` links it to the original.
      const command: PostTransactionCommand = {
        type: TransactionType.ExternalOutbound,
        currency: current.currency,
        amount: current.amount,
        legs: [
          { accountId: clearingId, delta: `-${current.amount}` },
          { accountId: customerId, delta: current.amount },
        ],
        initiatedBy: RAIL_ACTOR,
        reversesTransactionId: transactionId,
      };
      await this.posting.postFreshInTx(queryRunner, command);

      // Return the ORIGINAL transfer, now REVERSED (the id the rail correlated on).
      const after = await this.transactions.findByIdInTx(queryRunner, transactionId);
      return after ?? current;
    });
  }

  async creditInbound(params: InboundCreditParams): Promise<Transaction> {
    const { accountNumber, amount, currency, externalRef } = params;

    // 1. Resolve the destination by human account number → it MUST be a customer account (missing
    //    OR a system/clearing account collapses to the SAME 404 — never reveal system accounts).
    const destination = await this.accounts.findByAccountNumber(accountNumber);
    if (!destination || destination.kind !== AccountKind.Customer || !destination.ownerId) {
      throw new InboundDestinationNotFoundError();
    }
    if (destination.currency !== currency) {
      throw new CurrencyMismatchError(destination.id, destination.currency, currency);
    }

    // 2. The counter-leg is the seeded inbound-rail clearing account. Its absence is a system
    //    misconfiguration (a missing seed), not a client fault → a 500-class internal error.
    const clearing = await this.accounts.findBySystemKey(INBOUND_CLEARING_KEY);
    if (!clearing) {
      throw new Error(`Inbound clearing account ${INBOUND_CLEARING_KEY} is not provisioned`);
    }
    if (clearing.currency !== currency) {
      throw new CurrencyMismatchError(clearing.id, clearing.currency, currency);
    }

    // 3. Idempotent by the rail `externalRef`, keyed under the destination owner. `confirmDuplicate:
    //    true` BYPASSES the 60s soft-duplicate: two legitimate inbound credits with the same
    //    fingerprint (same account/amount/currency) within 60s must BOTH process — the rail
    //    externalRef is the authoritative dedup, so a duplicate ref returns the original (no
    //    double-credit) and distinct refs always process.
    const outcome = await this.idempotency.execute(
      {
        ownerId: destination.ownerId,
        key: `rail-inbound:${externalRef}`,
        fingerprintInput: {
          type: TransactionType.ExternalInbound,
          source: clearing.id,
          destination: destination.id,
          amount,
          currency,
        },
        confirmDuplicate: true,
      },
      async (queryRunner) => {
        // Lock the CUSTOMER first — before postFreshInTx's canonical locking reaches the clearing
        // account — for the source-before-clearing order. NOT OTP-gated; the customer leg is a
        // CREDIT, so a FROZEN customer is still credited (the reducer only blocks customer DEBITS).
        await this.accounts.lockByIdForUpdate(queryRunner, destination.id);
        const command: PostTransactionCommand = {
          type: TransactionType.ExternalInbound,
          currency,
          amount,
          legs: [
            { accountId: clearing.id, delta: `-${amount}` },
            { accountId: destination.id, delta: amount },
          ],
          initiatedBy: RAIL_ACTOR,
        };
        const posted = await this.posting.postFreshInTx(queryRunner, command);
        return { transactionId: posted.id };
      },
    );

    const tx = await this.transactions.findById(outcome.transactionId);
    if (!tx) {
      // Unreachable: the wrapper just committed (or replayed) this id.
      throw new Error(`Inbound transaction ${outcome.transactionId} vanished after credit`);
    }
    return tx;
  }
}
