import { baseApi } from './baseApi';
import type { AccountDto, AccountsResponse } from './contracts/accounts';

/**
 * The `/api/accounts` read endpoint — the one authenticated smoke call for F1. It
 * unwraps the `{ accounts }` envelope so consumers get the array directly.
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
  }),
});

export const { useGetAccountsQuery } = accountsApi;
