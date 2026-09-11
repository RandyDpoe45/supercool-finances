import { baseApi } from './baseApi';
import type { AdminTransactionDto, AdminTransactionsResponse } from './contracts/transaction';

/** Optional filters for `GET /admin/transactions`, mirroring the service's `.strict()` query schema.
 * `status` is one of PENDING|POSTED|FAILED|REVERSED|EXPIRED|CANCELLED; `type` is one of
 * internal|external_outbound|external_inbound; `limit`/`offset` are server-clamped ([1,200], ≥0). All
 * absent → the server default (50, offset 0, all owners). */
export interface TransactionsFilter {
  ownerId?: string;
  accountId?: string;
  status?: string;
  type?: string;
  limit?: number;
  offset?: number;
}

/**
 * The `/admin/transactions` read endpoint. `getTransactions` unwraps the `{ transactions }` envelope
 * so consumers get the array directly, and takes an optional filter that builds only the params that
 * are present (like `accountsApi.getAccounts`). `providesTags` a per-id tag + a LIST tag on
 * `'Transaction'` so an executed reversal (which flips the original to REVERSED and adds a
 * compensating tx) invalidates the list. Reuses `baseApi`'s bearer wiring.
 */
export const transactionsApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getTransactions: build.query<AdminTransactionDto[], TransactionsFilter | void>({
      query: (arg) => {
        const params: Record<string, string> = {};
        if (arg) {
          if (arg.ownerId) {
            params.ownerId = arg.ownerId;
          }
          if (arg.accountId) {
            params.accountId = arg.accountId;
          }
          if (arg.status) {
            params.status = arg.status;
          }
          if (arg.type) {
            params.type = arg.type;
          }
          if (arg.limit !== undefined) {
            params.limit = String(arg.limit);
          }
          if (arg.offset !== undefined) {
            params.offset = String(arg.offset);
          }
        }
        return { url: 'transactions', params };
      },
      transformResponse: (response: AdminTransactionsResponse) => response.transactions,
      providesTags: (transactions) =>
        transactions
          ? [
              ...transactions.map((tx) => ({ type: 'Transaction' as const, id: tx.id })),
              { type: 'Transaction' as const, id: 'LIST' },
            ]
          : [{ type: 'Transaction' as const, id: 'LIST' }],
    }),
  }),
});

export const { useGetTransactionsQuery } = transactionsApi;
