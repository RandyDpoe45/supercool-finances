/** DI token for {@link IOtpService}. Consumers depend on the interface via this token,
 * never the concrete class. */
export const OTP_SERVICE = Symbol('OTP_SERVICE');

/** The minted code and how long it is valid — returned to the caller that will deliver it
 * out-of-band. */
export interface OtpGenerationResult {
  code: string;
  ttlSeconds: number;
}

/** The outcome of a single {@link IOtpService.consume} attempt — a rich result rather than a
 * bare boolean, so the caller can distinguish a wrong-but-retryable guess from a lockout. */
export interface OtpConsumeResult {
  /** True iff the supplied code matched the active code and was consumed (single-use). */
  ok: boolean;
  /** Attempts left on the CURRENT code before lockout (0 when ok or locked out). */
  remainingAttempts: number;
  /** True iff THIS attempt exhausted the allowance — the active code was burned and the
   *  user must regenerate. */
  lockedOut: boolean;
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
   * pending transfer, but never a second code while one is live. Generation resets the
   * attempt allowance for the fresh code.
   */
  generate(userId: string): Promise<OtpGenerationResult>;

  /**
   * Verify-and-consume the user's active code. **Typo-tolerant:** a WRONG code is
   * non-destructive — the active code survives so the user can retry, up to a maximum number
   * of attempts. The single-use guarantee stays atomic (a correct code is claimed via
   * `GETDEL`, so two concurrent correct confirms cannot both win). On the final failed attempt
   * the allowance is exhausted, the active code is BURNED, and the user must regenerate
   * (`lockedOut: true`). Returns a rich {@link OtpConsumeResult}, never throws for a wrong code.
   */
  consume(userId: string, code: string): Promise<OtpConsumeResult>;
}
