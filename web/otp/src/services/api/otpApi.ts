import { baseApi } from './baseApi';
import type { OtpDto } from './contracts/otp';

/**
 * `POST /api/otp` — mints the caller's user-scoped one-time code (the out-of-band delivery
 * to this app). Modeled as a MUTATION (it has a server side-effect: it claims the single
 * active-code slot). No request body — the code is scoped to the gateway identity, never a
 * client-supplied id. On a successful mint the response `{ code, ttlSeconds }` is shown once;
 * the plaintext exists only on this success path, living transiently in RTK Query's in-memory
 * mutation cache (plus the panel's local state) and dropped via the mutation's `reset()` when
 * the ttl elapses (see `CodeRevealPanel`), so it is never persisted to durable storage. A
 * rejected mint leaves only the error envelope (`code`/`message`/`requestId`) in the store —
 * never a plaintext code.
 *
 * Deliberately does NOT invalidate `PendingAuthorization`: minting a code does not change
 * the pending transfer, and the feed is refreshed explicitly by the user. The singleton
 * gate (a second mint while a code is active → 409 `OTP_ALREADY_ACTIVE`) is enforced
 * server-side and surfaced to the UI via the error envelope.
 */
export const otpApi = baseApi.injectEndpoints({
  endpoints: (build) => ({
    generateOtp: build.mutation<OtpDto, void>({
      query: () => ({ url: 'otp', method: 'POST' }),
    }),
  }),
});

export const { useGenerateOtpMutation } = otpApi;
