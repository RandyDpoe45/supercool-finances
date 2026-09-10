import { baseApi } from './baseApi';
import type { PayeeDto, PayeesResponse, RegisterPayeeRequest } from './contracts/payees';

/**
 * The payees `/api` surface, injected onto `baseApi` (so the bearer wiring is reused). `getPayees`
 * unwraps the `{ payees }` envelope to the array directly; `registerPayee` enrolls a beneficiary.
 *
 * Enrollment is a sensitive, fraud-relevant write, so the CALLER gates it behind the demo captcha
 * before dispatching this mutation (the mutation itself carries no captcha — it is a prototype gate,
 * not a server control). On success the list is invalidated so the newly enrolled payee (still in
 * its cooling-off window) appears. The request body is exactly `{ displayName, destinationRef }` —
 * the rail/status/coolingOffUntil/ownerId are all server-owned and are never sent.
 */
export const payeesApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getPayees: build.query<PayeeDto[], void>({
      query: () => 'payees',
      transformResponse: (response: PayeesResponse) => response.payees,
      providesTags: (payees) =>
        payees
          ? [
              ...payees.map((payee) => ({ type: 'Payee' as const, id: payee.id })),
              { type: 'Payee' as const, id: 'LIST' },
            ]
          : [{ type: 'Payee' as const, id: 'LIST' }],
    }),

    registerPayee: build.mutation<PayeeDto, RegisterPayeeRequest>({
      // Send ONLY the two whitelisted fields — never rail/status/coolingOffUntil/ownerId.
      query: ({ displayName, destinationRef }) => ({
        url: 'payees',
        method: 'POST',
        body: { displayName, destinationRef },
      }),
      invalidatesTags: (result) =>
        result
          ? [
              { type: 'Payee', id: 'LIST' },
              { type: 'Payee', id: result.id },
            ]
          : [{ type: 'Payee', id: 'LIST' }],
    }),
  }),
});

export const { useGetPayeesQuery, useRegisterPayeeMutation } = payeesApi;
