import {
  AccountSummary,
  DailyAggregate,
} from '../../../../database/repositories/interfaces/reporting.repository.interface';

/** DI token for {@link IReportingService}. Consumers depend on the interface,
 *  never the concrete class (ADR: depend on interfaces/tokens). */
export const REPORTING_SERVICE = Symbol('REPORTING_SERVICE');

/**
 * Admin query for the `accountSummaries` VIEW. All filters optional; `limit`/`offset`
 * are UNCLAMPED here — the service normalizes them (default/max/floor) before the repo.
 */
export interface AccountSummariesQuery {
  ownerId?: string;
  accountId?: string;
  currency?: string;
  limit?: number;
  offset?: number;
}

/**
 * Admin query for the `dailyAggregates` VIEW. All filters optional; `from`/`to` bound
 * `occurredAt`; `limit`/`offset` are UNCLAMPED here — the service normalizes them.
 */
export interface DailyAggregatesQuery {
  currency?: string;
  type?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

/**
 * The reporting BL (spec 05, step A3). Normalizes the untrusted admin query — CLAMPS
 * paging so an over-large page can never scan unbounded — then delegates to the
 * query-time aggregation repository. Returns DOMAIN objects (money as `bigint`); DTO
 * serialization is the controller's concern.
 */
export interface IReportingService {
  getAccountSummaries(query: AccountSummariesQuery): Promise<AccountSummary[]>;
  getDailyAggregates(query: DailyAggregatesQuery): Promise<DailyAggregate[]>;
}
