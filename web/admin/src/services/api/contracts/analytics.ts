/**
 * App-local copy of the analytics-server admin reporting wire contract — the
 * `GET /admin/reports/account-summaries` and `GET /admin/reports/daily-aggregates` reads.
 * Per ADR-16 (self-contained components, no cross-folder imports) the admin-app keeps its
 * OWN copy rather than importing from the analytics server or the sibling SPAs; it is kept in
 * sync via specs/07-frontends.md, the contract of record. Mirrors the analytics-server
 * `serializeAccountSummary` / `serializeDailyAggregate` output VERBATIM (an explicit
 * whitelist — every field listed by hand, never a spread).
 *
 * This is the admin app's SECOND backend surface, distinct from the balance-service
 * `/balance/admin` (`contracts/account.ts` et al.): the analytics reporting surface lives
 * behind the internal gateway's `/analytics/admin` namespace (ADR-17 — the gateway strips
 * `/analytics`, so the analytics server still serves its own `/admin/reports` surface).
 *
 * Money fields — `lastBalanceAfter` / `totalDebited` / `totalCredited` (account summaries) and
 * `totalAmount` (daily aggregates) — are canonical bigint minor-unit STRINGS (int64 precision).
 * NEVER parse them into a float: `Number`/`parseFloat` silently loses precision above 2^53. They
 * are rendered float-free via the `Money` atom (`lib/money`). `txnCount` / `count` are the only
 * numerics (safe integers).
 *
 * `lastActivityAt` is an ISO-8601 UTC instant, converted to Mexico City time at the display edge
 * (via the `Timestamp` atom). `date` (daily aggregates) is DIFFERENT: it is a per-DAY UTC bucket
 * LABEL (`YYYY-MM-DD`, produced server-side as `$dateToString` in UTC), NOT a full instant — it is
 * rendered VERBATIM and MUST NOT be timezone-converted.
 */

/** One row of the per-account activity + latest-known-balance report. */
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

/** Envelope returned by `GET /admin/reports/account-summaries`. */
export interface AccountSummariesResponse {
  accountSummaries: AccountSummaryDto[];
}

/** One row of the per-day × currency × type volume/count report (over POSTED events). */
export interface DailyAggregateDto {
  date: string;
  currency: string;
  type: string;
  count: number;
  totalAmount: string;
}

/** Envelope returned by `GET /admin/reports/daily-aggregates`. */
export interface DailyAggregatesResponse {
  dailyAggregates: DailyAggregateDto[];
}

/** Optional filters for `GET /admin/reports/account-summaries`, mirroring the server's `.strict()`
 * query schema. `ownerId` / `accountId` (uuid) / `currency` are exact-match; `limit` / `offset` are
 * server-clamped (`[1, 200]`, default 50; `offset ≥ 0`). All absent → the server default. */
export interface AccountSummariesFilter {
  ownerId?: string;
  accountId?: string;
  currency?: string;
  limit?: number;
  offset?: number;
}

/** Optional filters for `GET /admin/reports/daily-aggregates`, mirroring the server's `.strict()`
 * query schema. `currency` is exact-match; `type` is one of `internal` | `external_outbound` |
 * `external_inbound`; `from` / `to` are inclusive `YYYY-MM-DD` UTC-day bounds; `limit` / `offset`
 * are server-clamped (`[1, 200]`, default 50; `offset ≥ 0`). All absent → the server default. */
export interface DailyAggregatesFilter {
  currency?: string;
  type?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}
