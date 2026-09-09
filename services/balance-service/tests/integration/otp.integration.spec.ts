/**
 * Spec 04 — Balance Service, Step 4a: the Redis-backed OTP module against REAL Redis.
 * Written FROM the spec's "OTP module" bullet (the behavioral contract), NOT from the
 * implementor's code. The service is resolved BY TOKEN through the booted app graph, and a
 * raw ioredis client (the same `REDIS_CLIENT` the service injects) is resolved for assertions
 * and cleanup — both through the single harness seam.
 *
 * Why DB-backed against a REAL Redis and not mocked: the two guarantees this module exists to
 * provide — single-use (a code authorizes EXACTLY one transaction) and the singleton gate —
 * are properties of Redis's own atomic commands (GETDEL, SET NX) under real concurrency. The
 * atomicity proof (two simultaneous consumes of the same code → exactly one winner) is only
 * meaningful against a real server; a fake cannot prove GETDEL's atomicity. So the suite drives
 * the real DI'd service against the compose Redis.
 *
 * Honest-SKIP: OPT-IN via BALANCE_INTEGRATION=1 (a default `npm test` reports SKIPPED, never a
 * false pass). beforeAll TCP-probes Redis (REDIS_HOST:REDIS_PORT, default 127.0.0.1:6379) and
 * fails loudly if unreachable. Booting the real AppModule also brings up DatabaseModule, so the
 * compose Postgres must be reachable too (same posture as every other integration suite here);
 * beforeAll probes it and fails loud rather than surfacing an opaque boot error.
 *
 * Isolation: every test uses a UNIQUE userId (so parallel/re-runs never collide) and deletes
 * only the keys it created in afterEach — NEVER `flushall` (the Redis container is shared).
 *
 * To run:
 *   1. bring up the compose datastores (Redis + Postgres reachable to the test runner);
 *   2. BALANCE_INTEGRATION=1 [REDIS_HOST=… REDIS_PORT=… DB_HOST=… DB_PORT=…] npm test
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
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

const suite = ENABLED ? describe : describe.skip;

const OTP = getOtpConstants();
const OtpAlreadyActiveError = getOtpAlreadyActiveError();

suite('OtpService — Redis-backed OTP module (integration, needs Redis)', () => {
  let app: INestApplication;
  let otp: any;
  let redis: any;

  // Every userId a test mints is tracked here; afterEach deletes ONLY those keys (never flushall).
  let trackedUsers: string[] = [];

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
    const users = trackedUsers;
    trackedUsers = [];
    if (!users.length || !redis) return;
    try {
      await redis.del(...users.map(otpKey)); // ONLY the keys this test made — never flushall
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
    trackedUsers.push(u);
    return u;
  }

  function otpKey(userId: string): string {
    return `otp:${userId}`;
  }

  async function captureRejection(p: Promise<unknown>): Promise<any> {
    try {
      await p;
      return undefined;
    } catch (e) {
      return e;
    }
  }

  // ---- 1) round-trip: generate → consume(correct) → key gone ----------------------------

  it('round-trips: generate then consume(correct) returns true and the key no longer exists', async () => {
    const u = newUser();
    const { code } = await otp.generate(u);
    expect(typeof code).toBe('string');
    expect(code.length).toBeGreaterThan(0);

    expect(await otp.consume(u, code)).toBe(true);
    expect(await redis.exists(otpKey(u))).toBe(0); // single-use: gone after a successful consume
  });

  // ---- 2) single-use ATOMICITY (the money-safety-grade proof): exactly one winner --------

  it('lets EXACTLY ONE of two concurrent consumes of the same code win (GETDEL atomicity)', async () => {
    // A code authorizes exactly one transaction; two confirmations microseconds apart cannot
    // both succeed. Repeat a few rounds to catch a rare race, but keep it fast.
    for (let round = 0; round < 5; round++) {
      const u = newUser();
      const { code } = await otp.generate(u);

      const [a, b] = await Promise.all([otp.consume(u, code), otp.consume(u, code)]);
      const winners = [a, b].filter((r) => r === true);
      const losers = [a, b].filter((r) => r === false);

      expect(winners).toHaveLength(1); // exactly one true
      expect(losers).toHaveLength(1); // exactly one false
      expect(await redis.exists(otpKey(u))).toBe(0); // and the code is gone either way
    }
  }, 30_000);

  // ---- 3) singleton-gate: second generate rejects; slot frees on consume ----------------

  it('rejects a second generate while a code is active, then allows generate once the slot frees', async () => {
    const u = newUser();
    const first = await otp.generate(u);

    const err = await captureRejection(otp.generate(u));
    expect(err).toBeDefined(); // at most one active code per user
    expect(err.code).toBe('OTP_ALREADY_ACTIVE');
    if (OtpAlreadyActiveError) expect(err).toBeInstanceOf(OtpAlreadyActiveError);

    // Consuming the active code frees the slot; a fresh generate then succeeds.
    expect(await otp.consume(u, first.code)).toBe(true);
    const second = await otp.generate(u);
    expect(typeof second.code).toBe('string');
    expect(second.code.length).toBeGreaterThan(0);
    expect(await redis.exists(otpKey(u))).toBe(1); // the new code is live
  });

  // ---- 4) TTL is set on the key (no real-time sleep) ------------------------------------

  it('sets a bounded TTL on the OTP key at generation', async () => {
    const u = newUser();
    await otp.generate(u);

    const ttl = await redis.ttl(otpKey(u));
    // ttl > 0 rules out -2 (no key) and -1 (no expiry set) — the TTL-bound requirement.
    expect(ttl).toBeGreaterThan(0);
    if (OTP.OTP_TTL_SECONDS) expect(ttl).toBeLessThanOrEqual(OTP.OTP_TTL_SECONDS);
  });

  // ---- 5) wrong code: false, and the code is gone (documents GETDEL semantics) ----------

  it('returns false for a wrong code and the active code is gone afterward (GETDEL semantics)', async () => {
    const u = newUser();
    const { code } = await otp.generate(u);
    const wrong = code === '000000' ? '111111' : '000000';

    expect(await otp.consume(u, wrong)).toBe(false);
    expect(await redis.exists(otpKey(u))).toBe(0); // GETDEL deleted it regardless of the match
    expect(await otp.consume(u, code)).toBe(false); // the correct code no longer works either
  });
});
