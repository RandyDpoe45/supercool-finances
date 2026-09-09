import { Inject, Injectable } from '@nestjs/common';
import { createHmac, randomInt } from 'node:crypto';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../../../redis/redis.tokens';
import { APP_CONFIG } from '../../../../config/config.tokens';
import { AppConfig } from '../../../../config/configuration';
import {
  IOtpService,
  OtpConsumeResult,
  OtpGenerationResult,
} from '../interfaces/otp.service.interface';
import { OtpAlreadyActiveError } from '../errors';

/** Code length (6-digit numeric), TTL (5 minutes), and the per-code attempt allowance —
 * prototype defaults, not env-configurable yet. Exported for the test writer and future
 * callers. */
export const OTP_CODE_LENGTH = 6;
export const OTP_TTL_SECONDS = 300;
export const OTP_MAX_ATTEMPTS = 3;

/** Shape of the user-scoped record stored (as JSON) at `otp:<userId>`. The plaintext code is
 * NEVER persisted — only its keyed hash ({@link OtpService.hash}). */
interface OtpMeta {
  codeHash: string;
  attempts: number;
}

/**
 * User-scoped one-time code (see spec 04 OTP module). Single client injected via
 * {@link REDIS_CLIENT}. The plaintext code is delivered out-of-band on `generate` and **never
 * stored**: Redis holds only a keyed HMAC of the code (peppered by `OTP_HASH_SECRET`, userId
 * mixed in), so a Redis-only attacker cannot brute-force the 10^6 space offline. Two keys per
 * user, both TTL-bound to {@link OTP_TTL_SECONDS}:
 * - **`otp:<userId>`** — the record `{ codeHash, attempts }`. Does triple duty: the singleton
 *   gate (claimed with `SET … EX … NX`), the attempt counter, and the reverse-lookup that
 *   lets a lockout/regenerate delete the composite key by userId (via the stored hash).
 * - **`otp:<userId>:<codeHash>`** — a marker (`'1'`), the `GETDEL` target.
 *
 * The single-use money-safety invariant rides on the `GETDEL` of the composite key, NOT on the
 * counter: because the code's HASH is IN the key name, `GETDEL otp:<userId>:<hash(supplied)>`
 * on a WRONG code targets a non-existent key → a no-op → the real code survives (typo-tolerant),
 * while the correct code is read+deleted atomically so two concurrent correct confirms cannot
 * both win. Verification is therefore hashed-key existence — there is NO plaintext compare. The
 * attempt counter is a best-effort throttle: a rare concurrent double-wrong may under-count by
 * one, which is acceptable — it never weakens single-use.
 */
@Injectable()
export class OtpService implements IOtpService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private metaKey(userId: string): string {
    return `otp:${userId}`;
  }

  private codeKey(userId: string, codeHash: string): string {
    return `otp:${userId}:${codeHash}`;
  }

  /** Keyed HMAC-SHA256 of the code, peppered by `OTP_HASH_SECRET` (a Redis-only attacker cannot
   * brute-force offline) with `userId` mixed into the message so identical codes for different
   * users hash differently. Deterministic given the pepper, so it slots into the composite key. */
  private hash(userId: string, code: string): string {
    return createHmac('sha256', this.config.otp.hashSecret)
      .update(`${userId}:${code}`)
      .digest('hex');
  }

  async generate(userId: string): Promise<OtpGenerationResult> {
    const code = this.mintCode();
    const h = this.hash(userId, code);
    // Meta-first: the record is the authoritative singleton gate. NX + EX is an atomic claim
    // WITH ttl — a null reply means a code is already active → reject rather than overwrite.
    // Only the hash is persisted; the plaintext code leaves this method only in the return value.
    const claimed = await this.redis.set(
      this.metaKey(userId),
      JSON.stringify({ codeHash: h, attempts: 0 } satisfies OtpMeta),
      'EX',
      OTP_TTL_SECONDS,
      'NX',
    );
    if (claimed === null) {
      throw new OtpAlreadyActiveError();
    }
    // The GETDEL target, keyed by the HASH. A crash between these two writes self-heals: the
    // marker is missing so every consume misses, and the gate/counter clears on TTL or lockout.
    await this.redis.set(this.codeKey(userId, h), '1', 'EX', OTP_TTL_SECONDS);
    return { code, ttlSeconds: OTP_TTL_SECONDS };
  }

  async consume(userId: string, supplied: string): Promise<OtpConsumeResult> {
    // Hash the supplied code with the same keyed HMAC used at generation, then look up the
    // hashed composite key. Correct code ⇒ the key exists ⇒ GETDEL returns the marker and
    // deletes it atomically. A wrong code hashes to a non-existent key ⇒ no-op ⇒ the real code
    // survives. There is no plaintext compare — verification is hashed-key existence.
    const h = this.hash(userId, supplied);
    const hit = await this.redis.getdel(this.codeKey(userId, h));
    if (hit !== null) {
      await this.redis.del(this.metaKey(userId)); // free the slot + clear the counter
      return { ok: true, remainingAttempts: 0, lockedOut: false };
    }

    // Miss: wrong code, or already-consumed/expired. Only count it against a live record — do
    // NOT create anything on a null read, which would resurrect a TTL-less key.
    const raw = await this.redis.get(this.metaKey(userId));
    if (raw === null) {
      return { ok: false, remainingAttempts: 0, lockedOut: false };
    }

    const { codeHash, attempts } = JSON.parse(raw) as OtpMeta;
    const used = attempts + 1;
    if (used >= OTP_MAX_ATTEMPTS) {
      // Allowance exhausted: burn the composite via the STORED hash + the record itself.
      await this.redis.del(this.codeKey(userId, codeHash), this.metaKey(userId));
      return { ok: false, remainingAttempts: 0, lockedOut: true };
    }

    // XX-guarded so we NEVER resurrect a TTL-less record: if a concurrent consume DEL'd the meta
    // key between the GET above and this SET, XX makes SET a no-op (null reply) instead of
    // recreating the key with no TTL — which would jam the `SET … EX … NX` singleton gate in
    // generate forever (permanent self-lockout). KEEPTTL persists the bumped count without
    // extending the code's remaining life. On a null reply the record is gone → no active code.
    const bumped = await this.redis.set(
      this.metaKey(userId),
      JSON.stringify({ codeHash, attempts: used } satisfies OtpMeta),
      // Redis parses SET options order-independently; this KEEPTTL-then-XX order matches
      // the ioredis typed overload for the combination. Semantics: KEEPTTL + XX-guard.
      'KEEPTTL',
      'XX',
    );
    if (bumped === null) {
      return { ok: false, remainingAttempts: 0, lockedOut: false };
    }
    return { ok: false, remainingAttempts: OTP_MAX_ATTEMPTS - used, lockedOut: false };
  }

  /** Mint a zero-padded numeric code from a CSPRNG (`crypto.randomInt`), never `Math.random`. */
  private mintCode(): string {
    const n = randomInt(0, 10 ** OTP_CODE_LENGTH);
    return String(n).padStart(OTP_CODE_LENGTH, '0');
  }
}
