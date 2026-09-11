import { Inject, Injectable } from '@nestjs/common';
import {
  AccountSummary,
  DailyAggregate,
  IReportingRepository,
  REPORTING_REPOSITORY,
} from '../../../../database/repositories/interfaces/reporting.repository.interface';
import {
  AccountSummariesQuery,
  DailyAggregatesQuery,
  IReportingService,
} from '../interfaces/reporting.service.interface';

/** Paging bounds for the reporting VIEWs. A missing `limit` defaults to
 *  {@link REPORT_DEFAULT_LIMIT}; a larger request is clamped to {@link REPORT_MAX_LIMIT},
 *  so an over-large page can never scan the collection unbounded (mirrors the
 *  balance-service `listTransactions` clamp). */
const REPORT_DEFAULT_LIMIT = 50;
const REPORT_MAX_LIMIT = 200;

/**
 * Reporting BL (spec 05, step A3). Injects `REPORTING_REPOSITORY` and normalizes the
 * untrusted admin query before the aggregation runs: `limit` is defaulted/floored/capped
 * and `offset` floored to ≥0, so an admin can never ask Mongo for an unbounded scan. It
 * shapes no wire response — it returns the domain arrays (money as `bigint`); the
 * controller serializes at the boundary.
 */
@Injectable()
export class ReportingService implements IReportingService {
  constructor(@Inject(REPORTING_REPOSITORY) private readonly reporting: IReportingRepository) {}

  getAccountSummaries(query: AccountSummariesQuery): Promise<AccountSummary[]> {
    return this.reporting.accountSummaries({
      ownerId: query.ownerId,
      accountId: query.accountId,
      currency: query.currency,
      limit: this.clampLimit(query.limit),
      offset: this.clampOffset(query.offset),
    });
  }

  getDailyAggregates(query: DailyAggregatesQuery): Promise<DailyAggregate[]> {
    return this.reporting.dailyAggregates({
      currency: query.currency,
      type: query.type,
      from: query.from,
      to: query.to,
      limit: this.clampLimit(query.limit),
      offset: this.clampOffset(query.offset),
    });
  }

  private clampLimit(limit?: number): number {
    return Math.min(Math.max(limit ?? REPORT_DEFAULT_LIMIT, 1), REPORT_MAX_LIMIT);
  }

  private clampOffset(offset?: number): number {
    return Math.max(offset ?? 0, 0);
  }
}
