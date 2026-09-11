import { baseApi } from './baseApi';
import type { AdminAccountDto, AdminAccountsResponse } from './contracts/account';

/**
 * The `/admin/accounts` read + freeze/unfreeze endpoints. `getAccounts` unwraps the `{ accounts }`
 * envelope so consumers get the array directly, and takes an optional `{ ownerId }` filter (paging
 * is server-defaulted; the admin view does not paginate in this step). Freeze/unfreeze POST with no
 * body and return the updated account; they invalidate both that account's tag and the LIST tag so
 * the table reflects the new status without a manual refetch. All reuse `baseApi`'s bearer wiring.
 */
export const accountsApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getAccounts: build.query<AdminAccountDto[], { ownerId?: string } | void>({
      query: (arg) => {
        const params: Record<string, string> = {};
        if (arg && arg.ownerId) {
          params.ownerId = arg.ownerId;
        }
        return { url: 'accounts', params };
      },
      transformResponse: (response: AdminAccountsResponse) => response.accounts,
      providesTags: (accounts) =>
        accounts
          ? [
              ...accounts.map((account) => ({ type: 'Account' as const, id: account.id })),
              { type: 'Account' as const, id: 'LIST' },
            ]
          : [{ type: 'Account' as const, id: 'LIST' }],
    }),
    freezeAccount: build.mutation<AdminAccountDto, string>({
      query: (id) => ({ url: `accounts/${encodeURIComponent(id)}/freeze`, method: 'POST' }),
      invalidatesTags: (_result, _error, id) => [
        { type: 'Account', id },
        { type: 'Account', id: 'LIST' },
      ],
    }),
    unfreezeAccount: build.mutation<AdminAccountDto, string>({
      query: (id) => ({ url: `accounts/${encodeURIComponent(id)}/unfreeze`, method: 'POST' }),
      invalidatesTags: (_result, _error, id) => [
        { type: 'Account', id },
        { type: 'Account', id: 'LIST' },
      ],
    }),
  }),
});

export const { useGetAccountsQuery, useFreezeAccountMutation, useUnfreezeAccountMutation } =
  accountsApi;
