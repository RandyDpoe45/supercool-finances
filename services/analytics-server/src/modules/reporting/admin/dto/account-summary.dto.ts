/**
 * Wire view of one `accountSummaries` VIEW row on `GET /admin/reports/account-summaries`.
 * A role-gated admin view. Money renders as a canonical `bigint` minor-unit STRING
 * (`lastBalanceAfter` / `totalDebited` / `totalCredited`) — never a JS number, matching the
 * event/int64 wire convention; `lastActivityAt` is an ISO-8601 UTC string. Every field is
 * listed explicitly by the serializer (it never spreads the domain object).
 */
export interface AccountSummaryDto {
  accountId: string;
  ownerId: string | null;
  accountKind: string;
  systemKey: string | null;
  currency: string;
  lastBalanceAfter: string;
  txnCount: number;
  totalDebited: string;
  totalCredited: string;
  lastActivityAt: string;
}
