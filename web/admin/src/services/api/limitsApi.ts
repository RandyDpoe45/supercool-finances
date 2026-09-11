import { baseApi } from './baseApi';
import type { LimitsDto, LimitsResponse, UpsertLimitsBody } from './contracts/limits';

/**
 * The `/admin/limits` read + upsert endpoints. `getLimits` unwraps the `{ limits }` envelope and
 * takes an optional `{ scope, ownerId }` filter — contract-faithful, but currently unused (the
 * limits screen fetches all rows; a filter UI is a later step). `upsertLimits` PUTs the body (the scope⇒ownerId
 * rule is validated client-side before this fires AND re-checked by the server) and invalidates the
 * Limits LIST so the table refetches the new baseline/override. All reuse `baseApi`'s bearer wiring.
 */
export const limitsApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getLimits: build.query<LimitsDto[], { scope?: string; ownerId?: string } | void>({
      query: (arg) => {
        const params: Record<string, string> = {};
        if (arg && arg.scope) {
          params.scope = arg.scope;
        }
        if (arg && arg.ownerId) {
          params.ownerId = arg.ownerId;
        }
        return { url: 'limits', params };
      },
      transformResponse: (response: LimitsResponse) => response.limits,
      providesTags: (limits) =>
        limits
          ? [
              ...limits.map((row) => ({ type: 'Limits' as const, id: row.id })),
              { type: 'Limits' as const, id: 'LIST' },
            ]
          : [{ type: 'Limits' as const, id: 'LIST' }],
    }),
    upsertLimits: build.mutation<LimitsDto, UpsertLimitsBody>({
      query: (body) => ({ url: 'limits', method: 'PUT', body }),
      invalidatesTags: [{ type: 'Limits', id: 'LIST' }],
    }),
  }),
});

export const { useGetLimitsQuery, useUpsertLimitsMutation } = limitsApi;
