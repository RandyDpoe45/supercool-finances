import { baseApi } from './baseApi';
import type { AccountDto, AccountsResponse, StatementResponse } from './contracts/accounts';

/**
 * The `/api/accounts` read endpoints. `getAccounts` unwraps the `{ accounts }` envelope so
 * consumers get the array directly; `getAccountStatement` keeps its `{ accountId, entries }`
 * envelope (the caller reads `.entries`, which arrive newest-first from the server). Both
 * reuse `baseApi`'s bearer wiring.
 */
export const accountsApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getAccounts: build.query<AccountDto[], void>({
      query: () => 'accounts',
      transformResponse: (response: AccountsResponse) => response.accounts,
      providesTags: (accounts) =>
        accounts
          ? [
              ...accounts.map((account) => ({ type: 'Account' as const, id: account.id })),
              { type: 'Account' as const, id: 'LIST' },
            ]
          : [{ type: 'Account' as const, id: 'LIST' }],
    }),
    getAccountStatement: build.query<StatementResponse, string>({
      query: (accountId) => `accounts/${encodeURIComponent(accountId)}/transactions`,
      providesTags: (_result, _error, accountId) => [{ type: 'Account' as const, id: accountId }],
    }),
  }),
});

export const { useGetAccountsQuery, useGetAccountStatementQuery } = accountsApi;
