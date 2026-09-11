/** DI token for {@link ITransactionsRepository}. Consumers depend on the interface,
 * never the concrete Mongoose implementation (ADR: depend on interfaces/tokens). */
export const TRANSACTIONS_REPOSITORY = Symbol('TRANSACTIONS_REPOSITORY');

/** One double-entry leg of a transaction, as projected onto the read model.
 *  `delta` / `balanceAfter` are money — `bigint` (persisted as BSON `Long`, int64,
 *  exact). `ownerId` / `systemKey` are null for the counterpart kind (system vs.
 *  customer). */
export interface TransactionLegReadModel {
  accountId: string;
  ownerId: string | null;
  accountKind: string;
  systemKey: string | null;
  delta: bigint;
  balanceAfter: bigint;
  currency: string;
}

/** External beneficiary snapshot (external_outbound only; null otherwise). */
export interface TransactionPayeeReadModel {
  id: string;
  displayName: string;
  rail: string;
}

/**
 * The projected, ODM-independent `transactions` document. The consumer (spec 05,
 * step A2) builds this from a stream event and this repository upserts it; reads
 * are mapped back to it (never a Mongoose document). Money is `bigint`, stored as
 * BSON `Long` (int64) — exact past 2^53 and directly aggregatable.
 *
 * `_id` is the `event_id` (a uuid string) — the idempotent-upsert dedup key.
 */
export interface TransactionReadModel {
  _id: string;
  transactionId: string;
  eventType: string;
  type: string;
  status: string;
  amount: bigint;
  currency: string;
  initiatedBy: string;
  reversesTransactionId: string | null;
  /** The domain error `code` on a `transaction.failed` (e.g. `INSUFFICIENT_FUNDS`,
   *  `ACCOUNT_FROZEN`, `LIMIT_EXCEEDED`); `null` on a `transaction.posted`. Carried
   *  for per-reason failure analytics — the reason it rides the event header. */
  failureReason: string | null;
  payee: TransactionPayeeReadModel | null;
  legs: TransactionLegReadModel[];
  owners: string[];
  occurredAt: Date;
}

/** Persistence port for the `transactions` read-model collection. */
export interface ITransactionsRepository {
  /**
   * Idempotent upsert keyed on `_id` (`{ _id: doc._id }`, `upsert: true`). The
   * `_id` is the `event_id`, so re-applying the SAME event (at-least-once stream
   * redelivery) targets the same document and yields exactly one — the exactly-once
   * gate the spec 05 DoD requires. The consumer's ONLY write, run before `XACK`.
   */
  upsertByEventId(doc: TransactionReadModel): Promise<void>;
  /** Read one document back by `event_id`, mapped to {@link TransactionReadModel}
   *  (money as `bigint`), or `null` if absent. Never leaks a Mongoose document. */
  findById(eventId: string): Promise<TransactionReadModel | null>;
}
