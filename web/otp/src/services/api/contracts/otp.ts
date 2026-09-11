/**
 * App-local copy of the balance-service `POST /api/otp` wire contract (mirrors
 * `OtpDto` + `serializeOtp`). Per ADR-16 the otp-app keeps its own copy rather than
 * importing from the service; it is kept in sync via specs/07-frontends.md, the contract
 * of record.
 *
 * `code` is the plaintext one-time code, delivered out-of-band to this app and **shown
 * once** — the server never persists or re-reveals it. `ttlSeconds` is how long it stays
 * valid before it must be regenerated. The code is user-scoped (authorizes the caller's
 * single pending transfer); there is no transfer id in the request or response.
 */
export interface OtpDto {
  code: string;
  ttlSeconds: number;
}
