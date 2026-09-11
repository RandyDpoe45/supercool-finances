import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import { getAccessToken } from '../../auth/userManager';
import type {
  AccountSummariesFilter,
  AccountSummariesResponse,
  AccountSummaryDto,
  DailyAggregateDto,
  DailyAggregatesFilter,
  DailyAggregatesResponse,
} from './contracts/analytics';

// Re-export the filter-arg types so consumers can name a query's argument from the API slice
// (mirrors `auditApi`'s `AuditFilter` export); the wire DTOs stay owned by `contracts/analytics`.
export type { AccountSummariesFilter, DailyAggregatesFilter } from './contracts/analytics';

// Same-origin, service-namespaced base for the ANALYTICS reporting surface (`/analytics/admin`,
// ADR-17): the internal transport (nginx -> Kong) exposes it under `/analytics/admin`, and Kong
// strips `/analytics` so the analytics server still receives its own `/admin` surface. Dev/test
// route this through the MSW stub (which mirrors the same `/analytics/admin` path). This is a
// DISTINCT namespace from the balance-service `/balance/admin` (see `baseApi`); it uses the SAME
// OIDC bearer (both are behind the internal gateway's admin-role gate). Never hardcode an
// absolute backend URL.
const ANALYTICS_API_BASE_URL = import.meta.env.VITE_ANALYTICS_API_BASE_URL ?? '/analytics/admin';

/**
 * The SECOND RTK Query API slice — the analytics server's admin reporting surface, deliberately
 * kept separate from the balance-service `baseApi` because the two are distinct origins-of-record
 * with distinct contracts and tag spaces (spec 07 / A1 decision). `prepareHeaders` attaches the
 * live OIDC access token as a bearer on every request (identical wiring to `baseApi`). Both
 * endpoints are pure READS — there are no mutations, so nothing ever invalidates their LIST tags.
 */
export const analyticsApi = createApi({
  reducerPath: 'analyticsApi',
  baseQuery: fetchBaseQuery({
    baseUrl: ANALYTICS_API_BASE_URL,
    prepareHeaders: async (headers) => {
      const token = await getAccessToken();
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      return headers;
    },
  }),
  tagTypes: ['AccountSummary', 'DailyAggregate'],
  endpoints: (build) => ({
    getAccountSummaries: build.query<AccountSummaryDto[], AccountSummariesFilter | void>({
      query: (arg) => {
        const params: Record<string, string> = {};
        if (arg) {
          if (arg.ownerId) {
            params.ownerId = arg.ownerId;
          }
          if (arg.accountId) {
            params.accountId = arg.accountId;
          }
          if (arg.currency) {
            params.currency = arg.currency;
          }
          if (arg.limit !== undefined) {
            params.limit = String(arg.limit);
          }
          if (arg.offset !== undefined) {
            params.offset = String(arg.offset);
          }
        }
        return { url: 'reports/account-summaries', params };
      },
      transformResponse: (response: AccountSummariesResponse) => response.accountSummaries,
      providesTags: [{ type: 'AccountSummary', id: 'LIST' }],
    }),
    getDailyAggregates: build.query<DailyAggregateDto[], DailyAggregatesFilter | void>({
      query: (arg) => {
        const params: Record<string, string> = {};
        if (arg) {
          if (arg.currency) {
            params.currency = arg.currency;
          }
          if (arg.type) {
            params.type = arg.type;
          }
          // `from` / `to` are already `YYYY-MM-DD` day strings (from the page's date inputs); the
          // server coerces them to dates. Send them verbatim.
          if (arg.from) {
            params.from = arg.from;
          }
          if (arg.to) {
            params.to = arg.to;
          }
          if (arg.limit !== undefined) {
            params.limit = String(arg.limit);
          }
          if (arg.offset !== undefined) {
            params.offset = String(arg.offset);
          }
        }
        return { url: 'reports/daily-aggregates', params };
      },
      transformResponse: (response: DailyAggregatesResponse) => response.dailyAggregates,
      providesTags: [{ type: 'DailyAggregate', id: 'LIST' }],
    }),
  }),
});

export const { useGetAccountSummariesQuery, useGetDailyAggregatesQuery } = analyticsApi;
