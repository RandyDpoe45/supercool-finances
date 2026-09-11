import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import { getAccessToken } from '../../auth/userManager';

// Same-origin, service-namespaced base (`/balance/api`, ADR-17): the transport (nginx -> Kong)
// exposes the balance-service under `/balance/api`, and Kong strips `/balance` so the service
// still receives its own `/api` surface. Dev/test route this through the MSW stub (which mirrors
// the same `/balance/api` path). Never hardcode an absolute backend URL.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/balance/api';

/**
 * The single RTK Query API slice. `prepareHeaders` attaches the live OIDC access
 * token as a bearer on every request. Feature endpoints are added via
 * `baseApi.injectEndpoints(...)` in per-feature files so this base stays closed for
 * modification but open for extension.
 */
export const baseApi = createApi({
  reducerPath: 'api',
  baseQuery: fetchBaseQuery({
    baseUrl: API_BASE_URL,
    prepareHeaders: async (headers) => {
      const token = await getAccessToken();
      if (token) {
        headers.set('Authorization', `Bearer ${token}`);
      }
      return headers;
    },
  }),
  tagTypes: ['PendingAuthorization'],
  endpoints: () => ({}),
});
