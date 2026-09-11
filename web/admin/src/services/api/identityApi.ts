import { baseApi } from './baseApi';
import type { WhoamiDto } from './contracts/identity';

/**
 * `GET /balance/admin/whoami` — echoes the caller's gateway-resolved admin identity
 * (`{ userId, roles }`). It is the one authenticated smoke call for Step 1: a successful
 * response proves the OIDC bearer round-trips through the gateway to the admin surface.
 *
 * The response is the identity object directly (no `{ ... }` envelope to unwrap). The
 * account-management / reversals / audit screens build on this base in later steps.
 */
export const identityApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    getWhoami: build.query<WhoamiDto, void>({
      query: () => 'whoami',
    }),
  }),
});

export const { useGetWhoamiQuery } = identityApi;
