/**
 * Fixtures for the mocked `POST /api/otp`.
 *
 * `DEV_OTP_CODE` is a DETERMINISTIC dev/test code so the flow is reproducible without a
 * backend — the REAL service mints a random 6-digit code from a CSPRNG and never re-reveals
 * it. This constant is a dev convenience only; it is NOT a secret and must never be treated
 * as one. In dev you copy whatever code the app shows into the client-app confirm step.
 *
 * `OTP_MOCK_TTL_SECONDS` mirrors the 2-minute pending deadline for a coherent demo; the UI
 * always trusts the `ttlSeconds` the server returns over any local assumption.
 */
export const DEV_OTP_CODE = '424242';
export const OTP_MOCK_TTL_SECONDS = 120;
