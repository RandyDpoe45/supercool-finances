/** DI token for {@link IReportingRepository}. Consumers depend on the interface,
 *  never the concrete Mongoose implementation (ADR: depend on interfaces/tokens). */
export const REPORTING_REPOSITORY = Symbol('REPORTING_REPOSITORY');

/**
 * `accountSummaries` VIEW row (spec DATA-MODEL Part 2) — per-account activity + latest
 * known balance, produced by a query-time `$group` on `legs.accountId` (NOT stored).
 * Money is `bigint` (int64 minor units), carried exact from the BSON `Long` legs — the
 * `.aggregate()` path bypasses the schema's `BigInt` hydration, so the repo converts each
 * aggregated money value `Long → bigint` explicitly. Counts are plain `number`.
 */
export interface AccountSummary {
  accountId: string;
  ownerId: string | null;
  accountKind: string;
  systemKey: string | null;
  currency: string;
  lastBalanceAfter: bigint;
  txnCount: number;
  totalDebited: bigint;
  totalCredited: bigint;
  lastActivityAt: Date;
}

/**
 * `dailyAggregates` VIEW row (spec DATA-MODEL Part 2) — per-day × currency × type
 * volume/count over POSTED events, produced by a query-time `$group` (NOT stored).
 * `totalAmount` is `bigint` (int64 minor units); `count` is a plain `number`.
 */
export interface DailyAggregate {
  date: string;
  currency: string;
  type: string;
  count: number;
  totalAmount: bigint;
}

/** Repo-level filter for {@link IReportingRepository.accountSummaries}. Already
 *  clamped/normalized by the service — `limit`/`offset` are required, bounded values. */
export interface AccountSummariesFilter {
  ownerId?: string;
  accountId?: string;
  currency?: string;
  limit: number;
  offset: number;
}

/** Repo-level filter for {@link IReportingRepository.dailyAggregates}. Already
 *  clamped/normalized by the service — `limit`/`offset` are required, bounded values. */
export interface DailyAggregatesFilter {
  currency?: string;
  type?: string;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
}

/**
 * Query port for the analytics reporting aggregates. Runs the two query-time
 * aggregation pipelines over the `transactions` read model (no materialized rollups) —
 * idempotent by construction over the deduped source docs. Money is returned as
 * `bigint` (int64 minor units), converted from the aggregated BSON `Long`.
 */
export interface IReportingRepository {
  accountSummaries(filter: AccountSummariesFilter): Promise<AccountSummary[]>;
  dailyAggregates(filter: DailyAggregatesFilter): Promise<DailyAggregate[]>;
}
