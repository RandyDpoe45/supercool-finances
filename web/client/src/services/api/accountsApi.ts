import { baseApi } from './baseApi';
import type {
  AccountDto,
  AccountsResponse,
  CreateAccountRequest,
  StatementResponse,
} from './contracts/accounts';

/**
 * The `/api/accounts` endpoints. `getAccounts` unwraps the `{ accounts }` envelope so consumers get
 * the array directly; `getAccountStatement` keeps its `{ accountId, entries }` envelope (the caller
 * reads `.entries`, which arrive newest-first from the server); `createAccount` opens a new account.
 * All reuse `baseApi`'s bearer wiring.
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

    // Open a new (empty, MXN, active) customer account. The body carries only `label`; the server
    // owns every money-safe field. On success the accounts LIST is invalidated so `getAccounts`
    // refetches and the new account appears in the overview.
    createAccount: build.mutation<AccountDto, CreateAccountRequest>({
      query: (body) => ({ url: 'accounts', method: 'POST', body }),
      invalidatesTags: [{ type: 'Account', id: 'LIST' }],
    }),
  }),
});

export const { useGetAccountsQuery, useGetAccountStatementQuery, useCreateAccountMutation } =
  accountsApi;
