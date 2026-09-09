/** DI token for {@link IOtpService}. Consumers depend on the interface via this token,
 * never the concrete class. */
export const OTP_SERVICE = Symbol('OTP_SERVICE');

/** The minted code and how long it is valid — returned to the caller that will deliver it
 * out-of-band. */
export interface OtpGenerationResult {
  code: string;
  ttlSeconds: number;
}

/**
 * The user-scoped one-time code service (spec 04 OTP module): at most one active code per
 * user, single-use, TTL-bound. It is the out-of-band second factor for a user authorizing
 * their OWN transfers — not transaction-scoped.
 */
export interface IOtpService {
  /**
   * Mint and store a new code for `userId`. **Singleton-gated:** rejects with
   * `OtpAlreadyActiveError` when a code is already active for this user — the slot frees
   * only when the active code is consumed or its TTL expires. A user MAY generate without a
   * pending transfer, but never a second code while one is live.
   */
  generate(userId: string): Promise<OtpGenerationResult>;

  /**
   * Atomically verify-and-consume the user's active code via `GETDEL`. Returns `true` iff an
   * active code existed AND matched `code`. **The delete is unconditional:** ANY active code
   * is consumed regardless of match (GETDEL deletes then we compare), so a wrong guess still
   * burns the code — one confirmation attempt per code, no oracle for brute force.
   */
  consume(userId: string, code: string): Promise<boolean>;
}
