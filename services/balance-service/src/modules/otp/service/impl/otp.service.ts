import { Inject, Injectable } from '@nestjs/common';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../../../redis/redis.tokens';
import { IOtpService, OtpGenerationResult } from '../interfaces/otp.service.interface';
import { OtpAlreadyActiveError } from '../errors';

/** Code length (6-digit numeric) and TTL (5 minutes) — prototype defaults, not
 * env-configurable yet. Exported for the test writer and future callers. */
export const OTP_CODE_LENGTH = 6;
export const OTP_TTL_SECONDS = 300;

/**
 * User-scoped one-time code stored in Redis at `otp:<sub>` (see spec 04 OTP module).
 * Single client injected via {@link REDIS_CLIENT}. The two invariants both lean on atomic
 * Redis primitives rather than read-then-write, so concurrent callers cannot both win:
 * - **Singleton gate** — generation uses `SET … EX … NX`; a `null` reply means the slot is
 *   already taken, so the second generation is rejected.
 * - **Single-use** — consumption uses `GETDEL`, which reads and deletes atomically; two
 *   confirmations of the same code cannot both find it.
 */
@Injectable()
export class OtpService implements IOtpService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  private key(userId: string): string {
    return `otp:${userId}`;
  }

  async generate(userId: string): Promise<OtpGenerationResult> {
    const code = this.mintCode();
    // NX makes the write the gate: it stores only when no code exists. res === null means a
    // code is already active (slot taken) → reject rather than overwrite the live code.
    const res = await this.redis.set(this.key(userId), code, 'EX', OTP_TTL_SECONDS, 'NX');
    if (res === null) {
      throw new OtpAlreadyActiveError();
    }
    return { code, ttlSeconds: OTP_TTL_SECONDS };
  }

  async consume(userId: string, code: string): Promise<boolean> {
    // GETDEL is unconditional and atomic: it deletes ANY active code before we compare, so a
    // wrong guess still burns the code (one attempt per code — no brute-force oracle). Do NOT
    // early-return before this call, or the delete would stop being atomic/unconditional.
    const stored = await this.redis.getdel(this.key(userId));
    return stored !== null && this.safeEqual(stored, code);
  }

  /** Mint a zero-padded numeric code from a CSPRNG (`crypto.randomInt`), never `Math.random`. */
  private mintCode(): string {
    const n = randomInt(0, 10 ** OTP_CODE_LENGTH);
    return String(n).padStart(OTP_CODE_LENGTH, '0');
  }

  /** Constant-time compare. `timingSafeEqual` throws on unequal Buffer lengths, so the length
   * guard runs first (and short-circuits an obvious mismatch without leaking timing). */
  private safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  }
}
