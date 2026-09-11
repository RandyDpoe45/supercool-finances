import { Schema } from 'mongoose';
import { TransactionReadModel } from '../repositories/interfaces/transactions.repository.interface';

/**
 * The `transactions` read-model collection — a flattened, append-only projection
 * of the transaction event stream (`events:transactions`), ONE document PER EVENT
 * (a posting and its later reversal are two documents = a faithful money history).
 * Contract of record: specs/DATA-MODEL.md Part 2 + specs/analytics-schema.yaml.
 *
 * MONEY IS STORED AS BSON `Long` (int64), not a string: the Mongoose `BigInt`
 * SchemaType maps a JS `bigint` to a BSON `Long` on write and casts it back to a
 * `bigint` on read — exact past 2^53 and directly aggregatable (`$sum`), which the
 * query-time views (numeric `totalAmount` / `lastBalanceAfter`) require. The WIRE
 * event still carries money as a string; the consumer (A2) parses that string into
 * the `bigint` this schema persists as a `Long`.
 *
 * `_id` is the `event_id` (a uuid string set explicitly on upsert, NOT an
 * auto-generated ObjectId): it is the idempotent-upsert dedup key that makes
 * at-least-once stream redelivery yield exactly one document (spec 05 DoD).
 */
export const TRANSACTION_MODEL_NAME = 'Transaction';
export const TRANSACTION_COLLECTION = 'transactions';

/** External beneficiary snapshot (external_outbound only). No own `_id`. */
const PayeeSchema = new Schema(
  {
    id: { type: String, required: true },
    displayName: { type: String, required: true },
    rail: { type: String, required: true },
  },
  { _id: false },
);

/**
 * One double-entry leg. No own `_id`. `delta` / `balanceAfter` are money → stored
 * as BSON `Long` via the `BigInt` SchemaType. `ownerId` / `systemKey` are nullable
 * (customer vs. system/clearing legs).
 */
const LegSchema = new Schema(
  {
    accountId: { type: String, required: true },
    ownerId: { type: String, default: null },
    accountKind: { type: String, required: true },
    systemKey: { type: String, default: null },
    delta: { type: BigInt, required: true },
    balanceAfter: { type: BigInt, required: true },
    currency: { type: String, required: true },
  },
  { _id: false },
);

export const TransactionSchema = new Schema<TransactionReadModel>(
  {
    // event_id — a uuid string set explicitly on upsert (not an ObjectId).
    _id: { type: String, required: true },
    transactionId: { type: String, required: true },
    eventType: { type: String, required: true },
    type: { type: String, required: true },
    status: { type: String, required: true },
    // Money: BSON Long (int64), positive magnitude in minor units.
    amount: { type: BigInt, required: true },
    currency: { type: String, required: true },
    initiatedBy: { type: String, required: true },
    reversesTransactionId: { type: String, default: null },
    // Domain error code on a transaction.failed (per-reason analytics); null on posted.
    failureReason: { type: String, default: null },
    payee: { type: PayeeSchema, default: null },
    legs: { type: [LegSchema], default: [] },
    // Distinct customer ownerIds across legs — per-customer filter/index helper.
    owners: { type: [String], default: [] },
    occurredAt: { type: Date, required: true },
  },
  { versionKey: false, collection: TRANSACTION_COLLECTION },
);

// Full index set (unique { _id } is automatic — the primary key / dedup gate).
TransactionSchema.index({ transactionId: 1 });
TransactionSchema.index({ occurredAt: -1 });
TransactionSchema.index({ owners: 1, occurredAt: -1 });
TransactionSchema.index({ type: 1, occurredAt: -1 });
TransactionSchema.index({ 'legs.accountId': 1 });
