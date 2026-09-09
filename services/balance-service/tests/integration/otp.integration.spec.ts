/**
 * Spec 04 — Balance Service, Step 4a (REVISED): the Redis-backed OTP module against REAL Redis.
 * Written FROM the spec's "OTP module" bullet + the developer-directed typo-tolerance change,
 * NOT from the implementor's code. The service is resolved BY TOKEN through the booted app graph,
 * and a raw ioredis client (the same `REDIS_CLIENT` the service injects) is resolved for
 * assertions and cleanup — both through the single harness seam.
 *
 * Why DB-backed against a REAL Redis and not mocked: the two properties this module exists to
 * provide — single-use (a code authorizes EXACTLY one transaction) and the singleton gate — plus
 * the new typo-tolerance / lockout behaviour, ride on Redis's own atomic commands (GETDEL, SET
 * NX, SET KEEPTTL) under real concurrency. The single-winner atomicity proof (two simultaneous
 * consumes of the SAME correct code → exactly one winner) is only meaningful against a real
 * server; a fake cannot prove GETDEL's atomicity. So the suite drives the real DI'd service
 * against the compose Redis.
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (a default `npm test` reports SKIPPED, never a
 * false pass). beforeAll TCP-probes Redis (REDIS_HOST:REDIS_PORT, default 127.0.0.1:6379) and
 * fails loudly if unreachable. Booting the real AppModule also brings up DatabaseModule, so the
 * compose Postgres must be reachable too; beforeAll probes it and fails loud rather than
 * surfacing an opaque boot error.
 *
 * Isolation: every test uses a UNIQUE userId (so parallel/re-runs never collide) and deletes only
 * the keys it created in afterEach — the record `otp:<u>` AND every composite `otp:<u>:<codeHash>`
 * it minted (the hash recomputed from the minted code with the app's pepper) — NEVER `flushall`
 * (the Redis container is shared).
 *
 * To run:
 *   1. bring up the compose datastores (Redis + Postgres reachable to the test runner);
 *   2. BALANCE_INTEGRATION=1 [REDIS_HOST=… REDIS_PORT=… DB_HOST=… DB_PORT=…] npm test
 */
import 'reflect-metadata';
import { createHmac, randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import {
  getAppModule,
  getOtpServiceToken,
  getRedisClientToken,
  getOtpConstants,
  getOtpAlreadyActiveError,
  tcpProbe,
} from '../support/harness';
import { completeRawEnv } from '../support/env.fixture';

const ENABLED = process.env.BALANCE_INTEGRATION === '1';

if (!ENABLED) {
  console.info(
    '[integration] SKIPPED otp suite: set BALANCE_INTEGRATION=1 (and point ' +
      'REDIS_HOST/REDIS_PORT at a reachable Redis, plus DB_* at Postgres since booting ' +
      'AppModule needs it) to run it.',
  );
}

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || '6379');
const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || '5432');
// The SAME pepper the booted app is configured with (below) — so the test can compute the
// hashed composite key `otp:<userId>:<codeHash>` for real cleanup + assertions, as an independent
// oracle of the impl's HMAC construction. Defaults to the shared fixture value.
const OTP_HASH_SECRET = process.env.OTP_HASH_SECRET || 'test-otp-hash-secret-0123456789';

const suite = ENABLED ? describe : describe.skip;

const OTP = getOtpConstants();
const OtpAlreadyActiveError = getOtpAlreadyActiveError();
// Typo-tolerance allowance before lockout — spec value 3; fall back to 3 if the impl does not
// export the constant. All ladder proofs are written off MAX so they stay correct either way.
const MAX = OTP.OTP_MAX_ATTEMPTS ?? 3;

suite('OtpService — Redis-backed OTP module (integration, needs Redis)', () => {
  let app: INestApplication;
  let otp: any;
  let redis: any;

  // Every key a test creates (record + composites) is tracked; afterEach deletes ONLY these,
  // never flushall.
  let trackedKeys: string[] = [];

  beforeAll(async () => {
    const redisReachable = await tcpProbe(REDIS_HOST, REDIS_PORT);
    if (!redisReachable) {
      throw new Error(
        `[integration] BALANCE_INTEGRATION=1 but Redis is not reachable at ` +
          `${REDIS_HOST}:${REDIS_PORT}. Bring up the compose datastores (and publish/point ` +
          `REDIS_HOST/REDIS_PORT at them) or unset BALANCE_INTEGRATION.`,
      );
    }
    const dbReachable = await tcpProbe(DB_HOST, DB_PORT);
    if (!dbReachable) {
      throw new Error(
        `[integration] BALANCE_INTEGRATION=1 but Postgres is not reachable at ` +
          `${DB_HOST}:${DB_PORT}. Booting AppModule requires it (DatabaseModule). Bring up the ` +
          `compose datastores (and point DB_HOST/DB_PORT at them) or unset BALANCE_INTEGRATION.`,
      );
    }

    const env = completeRawEnv({
      DB_HOST,
      DB_PORT: String(DB_PORT),
      DB_NAME: process.env.DB_NAME || 'balance',
      DB_USER: process.env.DB_USER || 'balance_app',
      DB_PASSWORD: process.env.DB_PASSWORD || 'changeme-balance-local',
      REDIS_HOST,
      REDIS_PORT: String(REDIS_PORT),
      REDIS_PASSWORD: process.env.REDIS_PASSWORD || 'changeme-redis-local',
      INTERNAL_SERVICE_TOKEN: process.env.INTERNAL_SERVICE_TOKEN || 'test-internal-service-token',
      // Booting AppModule now validates OTP_HASH_SECRET (env.schema, min 16 chars) and the
      // OtpService reads it as the HMAC pepper — must match the value the test hashes with.
      OTP_HASH_SECRET,
    });
    for (const [k, v] of Object.entries(env)) process.env[k] = String(v);

    const AppModule = getAppModule();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    // The module binds `{ provide: OTP_SERVICE, useClass: OtpService }`, so the instance is
    // resolved BY TOKEN, not by class.
    otp = app.get(getOtpServiceToken(), { strict: false });
    if (!otp || typeof otp.generate !== 'function' || typeof otp.consume !== 'function') {
      throw new Error(
        '[integration] resolved the OTP service but it has no `generate`/`consume` methods. If ' +
          'the entry points are named differently, update the seam ' +
          '(tests/support/harness.ts:getOtpServiceToken) / coordinate the contract.',
      );
    }

    redis = app.get(getRedisClientToken(), { strict: false });
    if (!redis || typeof redis.exists !== 'function' || typeof redis.ttl !== 'function') {
      throw new Error(
        '[integration] could not resolve a usable ioredis client via REDIS_CLIENT for ' +
          'assertions/cleanup (update tests/support/harness.ts:getRedisClientToken).',
      );
    }
  }, 60_000);

  afterEach(async () => {
    const keys = Array.from(new Set(trackedKeys));
    trackedKeys = [];
    if (!keys.length || !redis) return;
    try {
      await redis.del(...keys); // ONLY the keys this test made — never flushall
    } catch {
      /* best-effort; unique per-test userIds keep re-runs safe even if one cleanup fails */
    }
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  // ---- helpers --------------------------------------------------------------------------

  function newUser(): string {
    const u = `otp-it-${Date.now()}-${randomUUID()}`;
    trackedKeys.push(recordKey(u)); // the record key is created by any generate for this user
    return u;
  }

  function recordKey(userId: string): string {
    return `otp:${userId}`;
  }

  /** The at-rest composite marker key. Post-hashing change it is keyed by the HMAC of the code,
   *  NOT the plaintext — recomputed here with node crypto + the SAME pepper the app is configured
   *  with, so cleanup and assertions target the REAL key (and this doubles as an independent oracle
   *  of the impl's construction). */
  function codeHash(userId: string, code: string): string {
    return createHmac('sha256', OTP_HASH_SECRET).update(`${userId}:${code}`).digest('hex');
  }

  function compositeKey(userId: string, code: string): string {
    return `otp:${userId}:${codeHash(userId, code)}`;
  }

  /** generate + track the composite key it minted (so afterEach can delete it). */
  async function generate(userId: string): Promise<{ code: string; ttlSeconds: number }> {
    const r = await otp.generate(userId);
    trackedKeys.push(compositeKey(userId, r.code));
    return r;
  }

  /** A wrong code of the SAME length as `code` (flip the last digit): a guaranteed mismatch that
   *  hashes to a DIFFERENT (non-existent) composite key. */
  function wrongOf(code: string): string {
    const last = code[code.length - 1];
    const replacement = last === '0' ? '1' : '0';
    return code.slice(0, -1) + replacement;
  }

  async function captureRejection(p: Promise<unknown>): Promise<any> {
    try {
      await p;
      return undefined;
    } catch (e) {
      return e;
    }
  }

  // ---- 1) single-use ATOMICITY keystone: exactly one of two concurrent consumes wins ----

  it('lets EXACTLY ONE of two concurrent consumes of the same code win (GETDEL atomicity)', async () => {
    // A code authorizes exactly one transaction; two confirmations microseconds apart cannot
    // both succeed. The composite-key GETDEL is the single-winner gate. Repeat a few rounds to
    // catch a rare race, but keep it fast.
    for (let round = 0; round < 5; round++) {
      const u = newUser();
      const { code } = await generate(u);

      const [a, b] = await Promise.all([otp.consume(u, code), otp.consume(u, code)]);
      const winners = [a, b].filter((r) => r.ok === true);
      const losers = [a, b].filter((r) => r.ok === false);

      expect(winners).toHaveLength(1); // exactly one ok:true
      expect(losers).toHaveLength(1); // exactly one ok:false
      expect(await redis.exists(recordKey(u))).toBe(0); // record gone (slot freed)
      // Composite (hashed) key gone either way. NB: this is no longer the resurrection detector —
      // the SET-XX resurrection guard is proven white-box in tests/unit/otp.service.spec.ts.
      expect(await redis.exists(compositeKey(u, code))).toBe(0);
    }
  }, 30_000);

  // ---- 2) typo tolerance: wrong is non-destructive, correct still works -----------------

  it('is typo-tolerant: a wrong code returns ok:false with remaining decremented, and the correct code still works', async () => {
    const u = newUser();
    const { code } = await generate(u);

    expect(await otp.consume(u, wrongOf(code))).toEqual({
      ok: false,
      remainingAttempts: MAX - 1,
      lockedOut: false,
    });
    // Non-destructive at the datastore level: the record survived the wrong attempt.
    expect(await redis.exists(recordKey(u))).toBe(1);

    // The correct code STILL authorizes after the typo.
    const ok = await otp.consume(u, code);
    expect(ok.ok).toBe(true);
    expect(ok.lockedOut).toBe(false);
    expect(await redis.exists(recordKey(u))).toBe(0); // consumed → slot freed
  });

  // ---- 3) lockout burns: MAX wrong attempts lock out and delete both keys ---------------

  it('locks out on the MAX-th wrong attempt and BURNS the code (both keys gone; correct code fails after)', async () => {
    const u = newUser();
    const { code } = await generate(u);
    const wrong = wrongOf(code);

    for (let i = 1; i < MAX; i++) {
      const res = await otp.consume(u, wrong);
      expect(res).toEqual({ ok: false, remainingAttempts: MAX - i, lockedOut: false });
    }
    // The MAX-th wrong attempt is the lockout.
    expect(await otp.consume(u, wrong)).toEqual({
      ok: false,
      remainingAttempts: 0,
      lockedOut: true,
    });

    // Burned: both the composite marker and the record are gone.
    expect(await redis.exists(compositeKey(u, code))).toBe(0);
    expect(await redis.exists(recordKey(u))).toBe(0);

    // The correct code no longer authorizes (no active code left).
    const after = await otp.consume(u, code);
    expect(after.ok).toBe(false);
  });

  // ---- 4) singleton gate: 2nd generate rejects; slot frees on consume -------------------

  it('rejects a second generate while a code is active, then allows generate once the slot frees', async () => {
    const u = newUser();
    const first = await generate(u);

    const err = await captureRejection(otp.generate(u));
    expect(err).toBeDefined(); // at most one active code per user
    expect(err.code).toBe('OTP_ALREADY_ACTIVE');
    if (OtpAlreadyActiveError) expect(err).toBeInstanceOf(OtpAlreadyActiveError);

    // Consuming the active code frees the slot; a fresh generate then succeeds.
    expect((await otp.consume(u, first.code)).ok).toBe(true);
    const second = await generate(u);
    expect(typeof second.code).toBe('string');
    expect(second.code.length).toBeGreaterThan(0);
    expect(await redis.exists(recordKey(u))).toBe(1); // the new code is live
  });

  // ---- 5) counter reset on regenerate ---------------------------------------------------

  it('resets the attempt counter on regenerate: a wrong attempt on the new code has the full-minus-one allowance again', async () => {
    const u = newUser();
    const first = await generate(u);

    // Burn one attempt on the first code (remaining MAX-1), then free the slot by consuming it.
    expect(await otp.consume(u, wrongOf(first.code))).toEqual({
      ok: false,
      remainingAttempts: MAX - 1,
      lockedOut: false,
    });
    expect((await otp.consume(u, first.code)).ok).toBe(true); // frees the slot

    // Regenerate — a fresh code with a fresh counter.
    const second = await generate(u);
    expect(await otp.consume(u, wrongOf(second.code))).toEqual({
      ok: false,
      remainingAttempts: MAX - 1, // NOT MAX-2 — the counter reset on regenerate
      lockedOut: false,
    });
  });

  // ---- 6) TTL is set on BOTH keys (no real-time sleep) ----------------------------------

  it('sets a bounded TTL on BOTH the record and the composite key at generation', async () => {
    const u = newUser();
    const { code } = await generate(u);

    const recordTtl = await redis.ttl(recordKey(u));
    const compositeTtl = await redis.ttl(compositeKey(u, code));

    // ttl > 0 rules out -2 (no key) and -1 (no expiry set) — the TTL-bound requirement on BOTH.
    expect(recordTtl).toBeGreaterThan(0);
    expect(compositeTtl).toBeGreaterThan(0);
    if (OTP.OTP_TTL_SECONDS) {
      expect(recordTtl).toBeLessThanOrEqual(OTP.OTP_TTL_SECONDS);
      expect(compositeTtl).toBeLessThanOrEqual(OTP.OTP_TTL_SECONDS);
    }
  });

  // ---- 7) AT-REST HASHING against REAL Redis: the plaintext code is never persisted ------

  it('hashes the code at rest: the raw record holds a codeHash (never the plaintext), no plaintext-keyed composite exists, and the correct code still consumes', async () => {
    const u = newUser();
    const { code } = await generate(u);

    // Read the raw record straight from Redis. It decodes to { codeHash, attempts } — no plaintext
    // `code` field, and the codeHash differs from the plaintext (asserted on decoded fields rather
    // than a raw-substring scan, so a hex digest that incidentally contains the digit-run can't
    // flake the proof).
    const raw = await redis.get(recordKey(u));
    expect(raw).not.toBeNull();
    const record = JSON.parse(raw as string);
    expect(record.code).toBeUndefined();
    expect(Object.values(record)).not.toContain(code); // no stored field equals the plaintext
    expect(typeof record.codeHash).toBe('string');
    expect(record.codeHash).not.toBe(code);
    // Independent oracle: the stored hash IS HMAC-SHA256(pepper, `<u>:<code>`) — pins the exact
    // keyed, userId-mixed construction end-to-end against real Redis.
    expect(record.codeHash).toBe(codeHash(u, code));

    // The OLD plaintext-keyed composite must NOT exist; the hashed marker (the GETDEL target) does.
    expect(await redis.exists(`otp:${u}:${code}`)).toBe(0);
    expect(await redis.exists(compositeKey(u, code))).toBe(1);

    // The plaintext code still authorizes — consume must rehash the supplied code identically.
    const ok = await otp.consume(u, code);
    expect(ok.ok).toBe(true);
    expect(await redis.exists(recordKey(u))).toBe(0); // consumed → slot freed
  });
});
