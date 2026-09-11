import {
  AccountKind,
  TransactionStatus,
  TransactionType,
} from '../../../../database/entities/enums';

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
 * FAILED-transaction persistence and the `transaction.failed` event are a SUBSEQUENT step;
 * the `event_type` union below reserves `transaction.failed` for forward-compat, but this
 * step emits only `transaction.posted`.
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

/** The `outbox_event.payload` for a posted transaction — the enriched, self-contained
 * read-model contract. */
export type TransactionPostedPayload = {
  schemaVersion: 1;
  occurredAt: string;
  transaction: {
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
  };
  legs: TransactionEventLeg[];
};

/** The `outbox_event.event_type` (a stream field) for a transaction event. Only
 * `transaction.posted` is emitted in this step; `transaction.failed` is reserved for the
 * subsequent FAILED-persistence step. */
export type TransactionEventType = 'transaction.posted' | 'transaction.failed';

/** `outbox_event.event_type` for a posted-transaction event. */
export const TRANSACTION_POSTED_EVENT: TransactionEventType = 'transaction.posted';
