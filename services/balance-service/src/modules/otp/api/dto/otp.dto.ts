/**
 * The minted one-time code returned by `POST /api/otp` — the mocked out-of-band delivery to
 * the OTP app. `code` is the plaintext (delivered to the user, never persisted server-side);
 * `ttlSeconds` is how long it stays valid before it must be regenerated.
 */
export interface OtpDto {
  code: string;
  ttlSeconds: number;
}
