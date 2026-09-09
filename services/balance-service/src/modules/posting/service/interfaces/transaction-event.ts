import { TransactionType } from '../../../../database/entities/enums';

/**
 * The transaction-event contract as the balance service emits it — the `payload` written
 * to `outbox_event` in the SAME transaction as the ledger change, later relayed to the
 * Redis stream and consumed by the analytics server.
 *
 * Per ADR-16 (self-contained components), this is the balance service's OWN copy of the
 * event shape; the analytics server keeps an independent copy. Neither imports the other —
 * the SPEC (`specs/04-balance-service.md`) is the contract of record that keeps the two in
 * sync. This shape is PROVISIONAL for the posting step: it captures the posted movement;
 * the relay step and the analytics consumer may refine it, tracked via the spec.
 *
 * Declared as `type` aliases (not interfaces) so the payload is assignable to the entity's
 * `Record<string, unknown>` jsonb column without an explicit index signature.
 */

/** One posted leg inside the event: the signed delta and the resulting `balance_after`. */
export type TransactionEventLeg = {
  accountId: string;
  delta: string;
  balanceAfter: string;
};

/** The `outbox_event.payload` for a posted transaction. */
export type TransactionPostedPayload = {
  txId: string;
  type: TransactionType;
  currency: string;
  amount: string;
  legs: TransactionEventLeg[];
  occurredAt: string;
};

/** `outbox_event.event_type` for a posted-transaction event. */
export const TRANSACTION_POSTED_EVENT = 'transaction.posted';
