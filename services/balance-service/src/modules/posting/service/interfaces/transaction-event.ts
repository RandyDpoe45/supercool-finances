import {
  AccountKind,
  TransactionStatus,
  TransactionType,
} from '../../../../database/entities/enums';
import { Transaction } from '../../../../database/entities/transaction.entity';

/**
 * The transaction-event contract as the balance service emits it — the `payload` written
 * to `outbox_event` in the SAME transaction as the ledger change, later relayed to the
 * Redis stream and consumed by the analytics server.
 *
 * Per ADR-16 (self-contained components), this is the balance service's OWN copy of the
 * event shape; the analytics server keeps an independent copy. Neither imports the other —
 * the SPEC (`specs/DATA-MODEL.md` Part 2) is the contract of record that keeps the two in
 * sync.
 *
 * Wire conventions (contract of record):
 * - **camelCase** field names (matches this producer and the analytics stored document).
 * - Money is **`bigint` minor units carried as a `string`** (`amount`, leg `delta`,
 *   `balanceAfter`) — NEVER a JS `number`: a value past 2^53 must survive verbatim.
 * - **Self-contained** (ADR-11): analytics owns Mongo and may NOT join back to Postgres, so
 *   each leg carries the account's `ownerId` / `accountKind` / `systemKey` / `currency`, and
 *   the header carries `status` / `createdAt` / `postedAt` / `payee` — everything a
 *   per-customer or per-account rollup needs without a cross-store lookup.
 * - **Double-entry preserving:** the legs' `delta` values sum to zero, so analytics can
 *   re-assert the invariant on the read side.
 *
 * `event_id` (the `outbox_event.id`, the consumer's dedup key) and `event_type` are STREAM
 * fields the relay emits alongside this object — they are NOT part of the payload.
 *
 * Reversal is **link-only**: a reversal is itself a compensating `transaction.posted` event
 * carrying `reversesTransactionId` — there is no separate `transaction.reversed` event.
 * A **confirm-time BUSINESS failure** (insufficient funds / frozen / limit / payee cooling-off,
 * discovered under the account lock when a user transfer is OTP-confirmed) is persisted as a
 * terminal FAILED transaction and emitted as a single `transaction.failed` event: the same
 * enriched header envelope with `status: 'FAILED'`, a non-null `failureReason` (the domain
 * error's `code`), `postedAt: null`, and an EMPTY `legs` array — NO money moved, so the
 * double-entry sum-zero invariant holds trivially. `failureReason` is carried on the header of
 * BOTH event kinds (null on a `transaction.posted`) so the two share one shape.
 *
 * Declared as `type` aliases (not interfaces) so the payload is assignable to the entity's
 * `Record<string, unknown>` jsonb column without an explicit index signature.
 */

/** The external-payee snapshot carried on an `external_outbound` event so analytics never
 * joins back to `external_payee`. `null` for every other movement. */
export type TransactionEventPayee = {
  id: string;
  displayName: string;
  rail: string;
};

/** One posted leg inside the event: the signed `delta`, the resulting `balanceAfter`, and the
 * account attributes analytics needs to aggregate without a Postgres join. `ownerId` is the
 * customer Keycloak `sub` (null for system/clearing accounts); `systemKey` is the clearing
 * key (null for customer accounts). Money fields are int64 minor units as strings. */
export type TransactionEventLeg = {
  accountId: string;
  ownerId: string | null;
  accountKind: AccountKind;
  systemKey: string | null;
  delta: string;
  balanceAfter: string;
  currency: string;
};

/** The transaction header carried on BOTH the `transaction.posted` and `transaction.failed`
 * events — one uniform, self-contained shape. `status` distinguishes the two (POSTED vs FAILED);
 * `failureReason` is the domain error's `code` on a failure, `null` on a post; `postedAt` is the
 * post instant on a POSTED event, `null` on a FAILED event (no money moved). */
export type TransactionEventHeader = {
  id: string;
  type: TransactionType;
  status: TransactionStatus;
  amount: string;
  currency: string;
  initiatedBy: string;
  reversesTransactionId: string | null;
  payee: TransactionEventPayee | null;
  createdAt: string;
  postedAt: string | null;
  failureReason: string | null;
};

/** The `outbox_event.payload` for a posted transaction — the enriched, self-contained
 * read-model contract. `legs` sum to zero (double-entry); `failureReason` is null. */
export type TransactionPostedPayload = {
  schemaVersion: 1;
  occurredAt: string;
  transaction: TransactionEventHeader;
  legs: TransactionEventLeg[];
};

/** The `outbox_event.payload` for a FAILED transaction — a confirm-time business rejection of a
 * well-formed user transfer. Same envelope as {@link TransactionPostedPayload}, but `legs` is
 * ALWAYS empty (no money moved) and the header carries `status: FAILED` + a non-null
 * `failureReason`. */
export type TransactionFailedPayload = {
  schemaVersion: 1;
  occurredAt: string;
  transaction: TransactionEventHeader;
  legs: TransactionEventLeg[];
};

/** The `outbox_event.event_type` (a stream field) for a transaction event: `transaction.posted`
 * for a money movement, `transaction.failed` for a persisted confirm-time business failure. */
export type TransactionEventType = 'transaction.posted' | 'transaction.failed';

/** `outbox_event.event_type` for a posted-transaction event. */
export const TRANSACTION_POSTED_EVENT: TransactionEventType = 'transaction.posted';

/** `outbox_event.event_type` for a failed-transaction event (confirm-time business failure). */
export const TRANSACTION_FAILED_EVENT: TransactionEventType = 'transaction.failed';

/**
 * Build the `transaction.failed` payload from the (now-FAILED) transaction header. EXPORTED and
 * pure so the transfers layer can emit the event WITHOUT importing from posting `impl/` (the
 * POSTED builder is impl-private): the transfers service already holds the header entity, the
 * payee snapshot (external_outbound only, `null` otherwise), the failure `reason` (the domain
 * error's `code`), and the `occurredAt` instant. `legs` is empty — a FAILED transaction moves no
 * money — so the double-entry sum-zero invariant holds trivially. `createdAt` comes from the
 * existing header; `postedAt` is `null`; `status` is forced to FAILED regardless of the passed
 * entity's momentary state.
 */
export function buildFailedPayload(
  transaction: Transaction,
  options: { reason: string; payee: TransactionEventPayee | null; occurredAt: string },
): TransactionFailedPayload {
  return {
    schemaVersion: 1,
    occurredAt: options.occurredAt,
    transaction: {
      id: transaction.id,
      type: transaction.type,
      status: TransactionStatus.Failed,
      amount: transaction.amount,
      currency: transaction.currency,
      initiatedBy: transaction.initiatedBy,
      reversesTransactionId: transaction.reversesTransactionId,
      payee: options.payee,
      createdAt: transaction.createdAt.toISOString(),
      postedAt: null,
      failureReason: options.reason,
    },
    legs: [],
  };
}
