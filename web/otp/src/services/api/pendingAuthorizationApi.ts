import { baseApi } from './baseApi';
import type {
  PendingAuthorizationDto,
  PendingAuthorizationResponse,
} from './contracts/pending-authorization';

/**
 * The `/api/pending-authorization` read endpoint — the one authenticated smoke call for
 * O1. It unwraps the `{ authorization }` envelope, so consumers get the pending transfer
 * (or `null` when there is none) directly. The real pending-feed + code reveal build on
 * this in O2.
 */
export const pendingAuthorizationApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getPendingAuthorization: build.query<PendingAuthorizationDto | null, void>({
      query: () => 'pending-authorization',
      transformResponse: (response: PendingAuthorizationResponse) => response.authorization,
      providesTags: ['PendingAuthorization'],
    }),
  }),
});

export const { useGetPendingAuthorizationQuery } = pendingAuthorizationApi;
