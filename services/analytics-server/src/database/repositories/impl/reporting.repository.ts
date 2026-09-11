import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage } from 'mongoose';
import {
  AccountSummariesFilter,
  AccountSummary,
  DailyAggregate,
  DailyAggregatesFilter,
  IReportingRepository,
} from '../interfaces/reporting.repository.interface';
import { TransactionReadModel } from '../interfaces/transactions.repository.interface';
import { TRANSACTION_MODEL_NAME } from '../../schemas/transaction.schema';

/**
 * Convert an aggregated money value to `bigint`. `.aggregate()` BYPASSES the schema's
 * `BigInt` hydration, so `$sum` / `$last` over a BSON `Long` come back as a `Long`
 * wrapper (or already a `bigint` on a hydrated path). Either way this yields the exact
 * int64 minor-unit value via its decimal string — never a lossy JS `number`.
 */
const toBigInt = (v: unknown): bigint =>
  typeof v === 'bigint' ? v : BigInt((v as { toString(): string }).toString());

/** Raw `$group` output for the account-summaries pipeline (money fields are BSON `Long`). */
interface AccountSummaryRow {
  _id: string;
  ownerId: string | null;
  accountKind: string;
  systemKey: string | null;
  currency: string;
  lastBalanceAfter: unknown;
  txnCount: number;
  totalDebited: unknown;
  totalCredited: unknown;
  lastActivityAt: Date;
}

/** Raw `$group` output for the daily-aggregates pipeline (`totalAmount` is BSON `Long`). */
interface DailyAggregateRow {
  _id: { date: string; currency: string; type: string };
  count: number;
  totalAmount: unknown;
}

/**
 * Query-time aggregation over the `transactions` read model — the two reporting VIEWs
 * (spec DATA-MODEL Part 2). NOTHING is materialized: every figure is recomputed from the
 * deduped (`_id = event_id`) source docs, so a redelivered event can never double-count.
 * Bound to the `REPORTING_REPOSITORY` token in {@link PersistenceModule}; reads inject the
 * interface, never this class.
 *
 * Money invariant: aggregated `Long` values are converted to `bigint` HERE (the
 * `.aggregate()` path bypasses schema hydration), so the domain result carries exact
 * int64 minor units — never a JS float.
 */
@Injectable()
export class ReportingRepository implements IReportingRepository {
  constructor(
    @InjectModel(TRANSACTION_MODEL_NAME)
    private readonly model: Model<TransactionReadModel>,
  ) {}

  async accountSummaries(filter: AccountSummariesFilter): Promise<AccountSummary[]> {
    // Built after `$unwind`, so predicates target the unwound leg sub-doc. FAILED events
    // carry empty `legs` and so drop out of `$unwind` naturally (never counted).
    const legMatch: Record<string, unknown> = {};
    if (filter.currency !== undefined) legMatch['legs.currency'] = filter.currency;
    if (filter.ownerId !== undefined) legMatch['legs.ownerId'] = filter.ownerId;
    if (filter.accountId !== undefined) legMatch['legs.accountId'] = filter.accountId;

    const pipeline: PipelineStage[] = [
      { $unwind: '$legs' },
      { $match: legMatch },
      // Ascending by event time so `$last balanceAfter` is the account's latest known balance.
      { $sort: { occurredAt: 1 } },
      {
        $group: {
          _id: '$legs.accountId',
          ownerId: { $first: '$legs.ownerId' },
          accountKind: { $first: '$legs.accountKind' },
          systemKey: { $first: '$legs.systemKey' },
          currency: { $first: '$legs.currency' },
          lastBalanceAfter: { $last: '$legs.balanceAfter' },
          txnCount: { $sum: 1 },
          totalDebited: {
            $sum: { $cond: [{ $lt: ['$legs.delta', 0] }, { $abs: '$legs.delta' }, 0] },
          },
          totalCredited: {
            $sum: { $cond: [{ $gt: ['$legs.delta', 0] }, '$legs.delta', 0] },
          },
          lastActivityAt: { $max: '$occurredAt' },
        },
      },
      { $sort: { lastActivityAt: -1, _id: 1 } },
      { $skip: filter.offset },
      { $limit: filter.limit },
    ];

    const rows = await this.model.aggregate<AccountSummaryRow>(pipeline).exec();
    return rows.map((row) => ({
      accountId: row._id,
      ownerId: row.ownerId,
      accountKind: row.accountKind,
      systemKey: row.systemKey,
      currency: row.currency,
      lastBalanceAfter: toBigInt(row.lastBalanceAfter),
      txnCount: row.txnCount,
      totalDebited: toBigInt(row.totalDebited),
      totalCredited: toBigInt(row.totalCredited),
      lastActivityAt: row.lastActivityAt,
    }));
  }

  async dailyAggregates(filter: DailyAggregatesFilter): Promise<DailyAggregate[]> {
    // POSTED-only: the money-volume view counts settled money, excluding FAILED attempts.
    // A reversal is a compensating `transaction.posted` (status POSTED, reversesTransactionId
    // set) — link-only, no REVERSED document — so it IS counted here (gross volume). Predicates
    // are added only when provided (no injection — typed pipeline).
    const match: Record<string, unknown> = { status: 'POSTED' };
    if (filter.currency !== undefined) match.currency = filter.currency;
    if (filter.type !== undefined) match.type = filter.type;
    if (filter.from !== undefined || filter.to !== undefined) {
      const occurredAt: Record<string, Date> = {};
      if (filter.from !== undefined) occurredAt.$gte = filter.from;
      if (filter.to !== undefined) occurredAt.$lte = filter.to;
      match.occurredAt = occurredAt;
    }

    const pipeline: PipelineStage[] = [
      { $match: match },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$occurredAt', timezone: 'UTC' } },
            currency: '$currency',
            type: '$type',
          },
          count: { $sum: 1 },
          totalAmount: { $sum: '$amount' },
        },
      },
      { $sort: { '_id.date': -1, '_id.currency': 1, '_id.type': 1 } },
      { $skip: filter.offset },
      { $limit: filter.limit },
    ];

    const rows = await this.model.aggregate<DailyAggregateRow>(pipeline).exec();
    return rows.map((row) => ({
      date: row._id.date,
      currency: row._id.currency,
      type: row._id.type,
      count: row.count,
      totalAmount: toBigInt(row.totalAmount),
    }));
  }
}
