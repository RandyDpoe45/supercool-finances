import {
  AccountSummary,
  DailyAggregate,
} from '../../../../database/repositories/interfaces/reporting.repository.interface';
import { AccountSummaryDto } from '../dto/account-summary.dto';
import { DailyAggregateDto } from '../dto/daily-aggregate.dto';

/**
 * The anti-leak transport boundary for the reporting VIEWs: explicit whitelists that list
 * every output field BY HAND and MUST NOT spread the domain object. Money renders via
 * `bigint.toString()` (canonical int64 minor-unit string, never a JS number); dates via
 * `Date.toISOString()`. Adding a field here is a deliberate act, not an accident of shape.
 */
export function serializeAccountSummary(summary: AccountSummary): AccountSummaryDto {
  return {
    accountId: summary.accountId,
    ownerId: summary.ownerId,
    accountKind: summary.accountKind,
    systemKey: summary.systemKey,
    currency: summary.currency,
    lastBalanceAfter: summary.lastBalanceAfter.toString(),
    txnCount: summary.txnCount,
    totalDebited: summary.totalDebited.toString(),
    totalCredited: summary.totalCredited.toString(),
    lastActivityAt: summary.lastActivityAt.toISOString(),
  };
}

export function serializeDailyAggregate(aggregate: DailyAggregate): DailyAggregateDto {
  return {
    date: aggregate.date,
    currency: aggregate.currency,
    type: aggregate.type,
    count: aggregate.count,
    totalAmount: aggregate.totalAmount.toString(),
  };
}
