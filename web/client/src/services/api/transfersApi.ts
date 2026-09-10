import { baseApi } from './baseApi';
import type {
  CancelTransferRequest,
  ConfirmTransferRequest,
  InitiateTransferRequest,
  PendingAuthorizationResponse,
  ResolveDestinationDto,
  ResolveDestinationRequest,
  TransferDto,
} from './contracts/transfers';

/**
 * The transfers `/api` write surface + the pending feed, injected onto `baseApi` (so the bearer
 * wiring is reused). The internal-transfer journey is: `resolveDestination` (confirmation of payee)
 * → `initiateTransfer` (PENDING, no money moves) → `confirmTransfer` (POSTED, money moves) or
 * `cancelTransfer`. `getPendingAuthorization` reflects the caller's single active pending.
 *
 * Cache invalidation is the load-bearing correctness here: a POSTED confirm changes balances, so it
 * invalidates the caller's accounts LIST + the source account's tag — refetching `getAccounts` and
 * any open statement. Initiate / confirm / cancel all invalidate `PendingAuthorization` so the feed
 * reflects the new lifecycle state.
 */
export const transfersApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    resolveDestination: build.mutation<ResolveDestinationDto, ResolveDestinationRequest>({
      query: (body) => ({ url: 'transfers/resolve-destination', method: 'POST', body }),
    }),

    initiateTransfer: build.mutation<TransferDto, InitiateTransferRequest>({
      // The idempotency key rides the `Idempotency-Key` HEADER, never the body; the caller REUSES
      // the same key across retries of one logical transfer so a retry cannot double-submit.
      query: ({ idempotencyKey, ...body }) => ({
        url: 'transfers',
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body,
      }),
      invalidatesTags: ['PendingAuthorization'],
    }),

    confirmTransfer: build.mutation<TransferDto, ConfirmTransferRequest>({
      query: ({ transferId, code }) => ({
        url: `transfers/${encodeURIComponent(transferId)}/confirm`,
        method: 'POST',
        body: { code },
      }),
      // A POSTED confirm moves money: refetch the accounts list (all balances) and the source
      // account (its per-id tag also covers an open statement), plus the pending feed.
      invalidatesTags: (result) =>
        result
          ? [
              { type: 'Account', id: 'LIST' },
              ...(result.sourceAccountId
                ? [{ type: 'Account' as const, id: result.sourceAccountId }]
                : []),
              'PendingAuthorization',
            ]
          : ['PendingAuthorization'],
    }),

    cancelTransfer: build.mutation<TransferDto, CancelTransferRequest>({
      query: ({ transferId }) => ({
        url: `transfers/${encodeURIComponent(transferId)}/cancel`,
        method: 'POST',
      }),
      // An internal cancel moves no money (no hold), so only the pending feed changes.
      invalidatesTags: ['PendingAuthorization'],
    }),

    getPendingAuthorization: build.query<PendingAuthorizationResponse, void>({
      query: () => 'pending-authorization',
      providesTags: ['PendingAuthorization'],
    }),
  }),
});

export const {
  useResolveDestinationMutation,
  useInitiateTransferMutation,
  useConfirmTransferMutation,
  useCancelTransferMutation,
  useGetPendingAuthorizationQuery,
} = transfersApi;
