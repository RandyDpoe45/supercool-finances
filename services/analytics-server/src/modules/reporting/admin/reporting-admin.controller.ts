import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import {
  IReportingService,
  REPORTING_SERVICE,
} from '../service/interfaces/reporting.service.interface';
import { AccountSummaryDto } from './dto/account-summary.dto';
import { DailyAggregateDto } from './dto/daily-aggregate.dto';
import {
  AccountSummariesQueryParams,
  accountSummariesQuerySchema,
  DailyAggregatesQueryParams,
  dailyAggregatesQuerySchema,
} from './dto/reporting-query.schema';
import {
  serializeAccountSummary,
  serializeDailyAggregate,
} from './serializers/reporting.serializer';

/**
 * The reporting feature's `/admin` surface controller (spec 05, step A3) — the dashboard
 * aggregate queries over the Mongo read model. Injects the `REPORTING_SERVICE` behind its
 * token (interface/impl split — depends on `IReportingService`, never the concrete class).
 *
 * Under the global gateway prefix, role-gated by the {@link GatewayIdentityGuard} (`X-User-Id`
 * + `admin` role, else 401/403) — the analytics server has NO `/api` (customers never query
 * it, ADR-12), so these aggregates are unreachable from the public plane. The query string is
 * validated by the {@link ZodValidationPipe} (`.strict()`, malformed → 400). Both routes are
 * pure READS (no writes, no audit). Results are serialized to the wire DTOs at this boundary
 * (money as an int64 string — never spread).
 */
@Controller('admin/reports')
export class ReportingAdminController {
  constructor(@Inject(REPORTING_SERVICE) private readonly reporting: IReportingService) {}

  /** Per-account activity + latest known balance (`accountSummaries` VIEW), optional filters
   *  (ownerId / accountId / currency) + paging (limit clamped ≤200, default 50; offset ≥0).
   *  200, `{ accountSummaries: AccountSummaryDto[] }`. */
  @Get('account-summaries')
  async accountSummaries(
    @Query(new ZodValidationPipe(accountSummariesQuerySchema)) query: AccountSummariesQueryParams,
  ): Promise<{ accountSummaries: AccountSummaryDto[] }> {
    const summaries = await this.reporting.getAccountSummaries({
      ownerId: query.ownerId,
      accountId: query.accountId,
      currency: query.currency,
      limit: query.limit,
      offset: query.offset,
    });
    return { accountSummaries: summaries.map(serializeAccountSummary) };
  }

  /** Per-day × currency × type volume/count over POSTED events (`dailyAggregates` VIEW),
   *  optional filters (currency / type / from / to) + paging (limit clamped ≤200, default 50;
   *  offset ≥0). 200, `{ dailyAggregates: DailyAggregateDto[] }`. */
  @Get('daily-aggregates')
  async dailyAggregates(
    @Query(new ZodValidationPipe(dailyAggregatesQuerySchema)) query: DailyAggregatesQueryParams,
  ): Promise<{ dailyAggregates: DailyAggregateDto[] }> {
    const aggregates = await this.reporting.getDailyAggregates({
      currency: query.currency,
      type: query.type,
      from: query.from,
      to: query.to,
      limit: query.limit,
      offset: query.offset,
    });
    return { dailyAggregates: aggregates.map(serializeDailyAggregate) };
  }
}
