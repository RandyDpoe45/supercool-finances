import { baseApi } from './baseApi';
import type {
  CancelTransferRequest,
  ConfirmTransferRequest,
  InitiateExternalTransferRequest,
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
 * Cache invalidation is the load-bearing correctness here, and it is NOT symmetric between the
 * two transfer kinds because a hold moves the money boundary at a different time:
 *  - an INTERNAL initiate moves nothing (funds are checked at confirm), so it invalidates only
 *    `PendingAuthorization`;
 *  - an EXTERNAL initiate PLACES A HOLD at once — the source's `available` drops immediately — so
 *    `initiateExternalTransfer` also invalidates the accounts LIST + the source account's tag;
 *  - a POSTED confirm changes balances for BOTH kinds, so `confirmTransfer` invalidates the LIST +
 *    source tag (refetching `getAccounts` and any open statement);
 *  - a CANCEL releases a hold ONLY for an external transfer, so `cancelTransfer` invalidates
 *    `Account` iff the cancelled transfer's `type` is `external_outbound`; an internal cancel moves
 *    no money and must NOT refetch balances.
 * Initiate / confirm / cancel all invalidate `PendingAuthorization` so the feed reflects the new
 * lifecycle state.
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

    initiateExternalTransfer: build.mutation<TransferDto, InitiateExternalTransferRequest>({
      // Same idempotency discipline as internal — the key rides the header and is REUSED across
      // retries of one logical transfer. Addressed by `payeeId`; there is no confirmation token.
      query: ({ idempotencyKey, ...body }) => ({
        url: 'transfers/external',
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body,
      }),
      // An external initiate PLACES A HOLD — the source account's `available` drops immediately — so
      // it must refetch the accounts list + the source account (unlike an internal initiate, which
      // moves nothing). Uses the source id from the request arg (the caller's own, always present).
      invalidatesTags: (result, _error, arg) =>
        result
          ? [
              { type: 'Account', id: 'LIST' },
              { type: 'Account', id: arg.sourceAccountId },
              'PendingAuthorization',
            ]
          : ['PendingAuthorization'],
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
      // Cancelling an EXTERNAL pending releases its hold — the source's `available` recovers — so the
      // accounts cache must be refetched. Cancelling an INTERNAL pending moves no money (no hold),
      // so it must NOT refetch balances. The distinction is the returned transfer's `type`
      // (`external_outbound`), inspected here so the invalidation matches what actually changed.
      invalidatesTags: (result) =>
        result && result.type === 'external_outbound'
          ? [
              { type: 'Account', id: 'LIST' },
              ...(result.sourceAccountId
                ? [{ type: 'Account' as const, id: result.sourceAccountId }]
                : []),
              'PendingAuthorization',
            ]
          : ['PendingAuthorization'],
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
  useInitiateExternalTransferMutation,
  useConfirmTransferMutation,
  useCancelTransferMutation,
  useGetPendingAuthorizationQuery,
} = transfersApi;
