import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { HydratedDocument, Model } from 'mongoose';
import {
  ITransactionsRepository,
  TransactionLegReadModel,
  TransactionReadModel,
} from '../interfaces/transactions.repository.interface';
import { TRANSACTION_MODEL_NAME } from '../../schemas/transaction.schema';

/**
 * Mongoose implementation of {@link ITransactionsRepository}, bound to the
 * `TRANSACTIONS_REPOSITORY` token in {@link PersistenceModule}. Money stays
 * `bigint` end to end: the `BigInt` SchemaType stores it as BSON `Long` and casts
 * it back to `bigint` on hydration, so reads map exactly without any float step.
 */
@Injectable()
export class TransactionsRepository implements ITransactionsRepository {
  constructor(
    @InjectModel(TRANSACTION_MODEL_NAME)
    private readonly model: Model<TransactionReadModel>,
  ) {}

  async upsertByEventId(doc: TransactionReadModel): Promise<void> {
    const { _id, ...rest } = doc;
    // Idempotent by _id = event_id: a redelivered event re-applies the same set on
    // the same document, so at-least-once redelivery yields exactly one row.
    await this.model.updateOne({ _id }, { $set: rest }, { upsert: true }).exec();
  }

  async findById(eventId: string): Promise<TransactionReadModel | null> {
    const doc = await this.model.findById(eventId).exec();
    return doc ? this.toReadModel(doc) : null;
  }

  /** Whitelist-map a hydrated document → the ODM-independent read model (money as
   *  `bigint`); never returns the Mongoose document itself. */
  private toReadModel(doc: HydratedDocument<TransactionReadModel>): TransactionReadModel {
    return {
      _id: doc._id,
      transactionId: doc.transactionId,
      eventType: doc.eventType,
      type: doc.type,
      status: doc.status,
      amount: doc.amount,
      currency: doc.currency,
      initiatedBy: doc.initiatedBy,
      reversesTransactionId: doc.reversesTransactionId,
      payee: doc.payee
        ? { id: doc.payee.id, displayName: doc.payee.displayName, rail: doc.payee.rail }
        : null,
      legs: doc.legs.map((leg): TransactionLegReadModel => ({
        accountId: leg.accountId,
        ownerId: leg.ownerId,
        accountKind: leg.accountKind,
        systemKey: leg.systemKey,
        delta: leg.delta,
        balanceAfter: leg.balanceAfter,
        currency: leg.currency,
      })),
      owners: [...doc.owners],
      occurredAt: doc.occurredAt,
    };
  }
}
