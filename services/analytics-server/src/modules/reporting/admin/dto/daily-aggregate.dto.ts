/**
 * Wire view of one `dailyAggregates` VIEW row on `GET /admin/reports/daily-aggregates`.
 * A role-gated admin view over POSTED events. `totalAmount` renders as a canonical
 * `bigint` minor-unit STRING — never a JS number, matching the event/int64 wire
 * convention; `count` is a safe integer. Every field is listed explicitly by the
 * serializer (it never spreads the domain object).
 */
export interface DailyAggregateDto {
  date: string;
  currency: string;
  type: string;
  count: number;
  totalAmount: string;
}
