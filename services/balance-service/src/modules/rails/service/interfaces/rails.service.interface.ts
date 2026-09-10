import { Transaction } from '../../../../database/entities/transaction.entity';

/** DI token for {@link IRailsService}. Consumers (the `/external` surface controller) depend on
 * the interface via this token, never the concrete class. */
export const RAILS_SERVICE = Symbol('RAILS_SERVICE');

/** The rail's report of an outbound transfer's completion, correlated by OUR transaction id
 * (the `external_outbound` transfer the customer confirmed). `status` is the rail outcome;
 * `externalRef` is the rail's own reference for reconciliation. */
export interface OutboundSettlementParams {
  /** Our `external_outbound` transaction id the rail is settling. */
  transactionId: string;
  /** The rail outcome: `success` (money delivered) or `failure` (money not delivered). */
  status: 'success' | 'failure';
  /** The rail's reference for this settlement — recorded on the hold on success; used to guard
   *  a failure against an already-reconciled success. */
  externalRef: string;
}

/** A fresh external inbound credit the rail is pushing to a customer (already approved by the
 * originating institution — NOT ours to authorize). Addressed by the customer's human account
 * number; deduplicated by the rail's `externalRef`. */
export interface InboundCreditParams {
  /** The destination customer's human 10-digit account number. */
  accountNumber: string;
  /** Positive magnitude in minor units (canonical `bigint` string — never float). */
  amount: string;
  currency: string;
  /** The rail's reference — the authoritative dedup key: a duplicate ref must never double-credit. */
  externalRef: string;
}

/**
 * The mocked external rail webhooks (spec 04 "Mocked external rails"): the outbound settlement
 * callback and the inbound credit. Both live behind the `/external` surface (a distinct trust
 * domain, API-key authenticated). Every money movement here still funnels through the single
 * posting reducer (balance + ledger + outbox), and both callbacks are IDEMPOTENT.
 *
 * The methods return the plain {@link Transaction} entity; DTO serialization is a transport
 * concern applied at the controller boundary.
 */
export interface IRailsService {
  /**
   * Apply an outbound settlement callback for an `external_outbound` transfer, IDEMPOTENTLY:
   * - **success** — reconcile only: record the rail `externalRef` on the settled hold. NO new
   *   ledger movement (the money already moved customer → `clearing:rail-outbound` at
   *   OTP-confirm). A repeat is a no-op; a success for an already-reversed transfer is rejected.
   * - **failure** — reverse: in ONE tx, lock the customer FIRST, guarded `POSTED → REVERSED`,
   *   then post a fresh compensating `clearing:rail-outbound → customer` movement
   *   (`reverses_transaction_id` = the original) that refunds the payer. A repeat is a no-op
   *   (no double reversal); a failure for an already-reconciled success is rejected.
   *
   * Returns the ORIGINAL transfer (unchanged on success, now REVERSED on failure). Throws
   * {@link SettlementTargetNotFoundError} (missing) / {@link InvalidSettlementStateError}
   * (wrong type or contradictory outcome).
   */
  settleOutbound(params: OutboundSettlementParams): Promise<Transaction>;

  /**
   * Apply a fresh external inbound credit to a customer resolved by account number: a POSTED
   * `external_inbound` movement debiting `clearing:rail-inbound` and crediting the customer.
   * NOT OTP-gated (approved by the originating institution), and a FROZEN customer may still be
   * credited (the reducer only blocks customer DEBITS). Idempotent by the rail `externalRef`: a
   * duplicate ref returns the original transaction (no double-credit), and distinct refs always
   * process. Returns the posted inbound transaction. Throws
   * {@link InboundDestinationNotFoundError} (unknown/non-customer account) or a currency
   * mismatch against the account or the inbound clearing account.
   */
  creditInbound(params: InboundCreditParams): Promise<Transaction>;
}
