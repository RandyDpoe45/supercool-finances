/**
 * Spec 04 — Balance Service, Step 4a: the Redis-backed OTP module (service-only; no HTTP yet).
 * Written FROM the spec's "OTP module" bullet (the behavioral contract), NOT from the
 * implementor's code. The OtpService class is resolved through the single harness seam
 * (`getOtpService`), the same coordination point every other suite imports through.
 *
 * Contract under test (spec-derived — the source of truth, independent of the impl):
 *   IOtpService.generate(userId): Promise<{ code: string; ttlSeconds: number }>
 *   IOtpService.consume(userId, code): Promise<boolean>
 *   - User-scoped, at most ONE active code per user, key `otp:<userId>`.
 *   - Generation is singleton-gated: a second generate WHILE a code is active is rejected
 *     (OtpAlreadyActiveError, code OTP_ALREADY_ACTIVE); the slot frees on consume OR TTL lapse.
 *   - Single-use via atomic GETDEL: consume returns true iff an active code existed AND
 *     matched; after a successful consume the code is gone (second consume → false).
 *   - A WRONG code → consume returns false, and (GETDEL semantics) the active code is deleted
 *     regardless — so a subsequent consume with the correct code also returns false. Encoded
 *     here as INTENDED behavior per the contract.
 *   - Code is a fixed-length numeric string minted from a CSPRNG; a TTL is set on the key.
 *
 * Why a hand-rolled fake and not a mock: the fake FAITHFULLY models the two Redis commands the
 * design uses — SET ... NX (mint iff absent) and GETDEL (read-and-delete atomically). That is
 * modeling the datastore CONTRACT, not mocking away the logic under test: the singleton gate
 * and the single-use guarantee are the OtpService's own logic riding on those two primitives,
 * and every assertion is on a real return value or the fake store's observable state — never
 * "a method was called". Pure, no real Redis, runs in the DEFAULT `npm test` (never skipped).
 */
import 'reflect-metadata';
import { getOtpService, getOtpConstants, getOtpAlreadyActiveError } from '../support/harness';

const OtpService = getOtpService();
const OTP = getOtpConstants();
const OtpAlreadyActiveError = getOtpAlreadyActiveError();

// Resolved code length when the constant is exported; otherwise the structural fallback.
const CODE_LEN: number | undefined = OTP.OTP_CODE_LENGTH;
const codeRegex = CODE_LEN ? new RegExp(`^\\d{${CODE_LEN}}$`) : /^\d{4,}$/;

interface FakeEntry {
  value: string;
  ttlSeconds: number | null;
}

/**
 * An in-memory fake of the exactly two ioredis commands the GETDEL/SET-NX design uses.
 *   set(key, value, ...opts) — models `SET key value EX <n> NX`: returns 'OK' and stores the
 *     value (recording the EX/PX ttl) iff the NX precondition holds (key absent); returns null
 *     (the NX conflict signal) when the key already exists. XX is modeled for completeness.
 *   getdel(key) — models `GETDEL key`: returns the stored value and deletes it atomically, or
 *     null when the key is absent.
 * `store` is exposed so tests can assert the datastore's observable state directly.
 */
function createFakeRedis(): {
  store: Map<string, FakeEntry>;
  set: (key: string, value: string, ...opts: unknown[]) => Promise<'OK' | null>;
  getdel: (key: string) => Promise<string | null>;
} {
  const store = new Map<string, FakeEntry>();

  return {
    store,
    async set(key: string, value: string, ...opts: unknown[]): Promise<'OK' | null> {
      const flags = opts.map((o) => (typeof o === 'string' ? o.toUpperCase() : o));
      const nx = flags.includes('NX');
      const xx = flags.includes('XX');

      let ttlSeconds: number | null = null;
      for (let i = 0; i < opts.length; i++) {
        const f = typeof opts[i] === 'string' ? String(opts[i]).toUpperCase() : opts[i];
        if (f === 'EX') ttlSeconds = Number(opts[i + 1]);
        else if (f === 'PX') ttlSeconds = Number(opts[i + 1]) / 1000;
      }

      const exists = store.has(key);
      if (nx && exists) return null; // SET NX fails when the key is present
      if (xx && !exists) return null; // SET XX fails when the key is absent
      store.set(key, { value: String(value), ttlSeconds });
      return 'OK';
    },
    async getdel(key: string): Promise<string | null> {
      const entry = store.get(key);
      if (entry === undefined) return null;
      store.delete(key); // atomic read-and-delete
      return entry.value;
    },
  };
}

function makeService(): {
  service: any;
  redis: ReturnType<typeof createFakeRedis>;
} {
  const redis = createFakeRedis();
  const service = new OtpService(redis);
  return { service, redis };
}

const key = (userId: string): string => `otp:${userId}`;

async function captureRejection(p: Promise<unknown>): Promise<any> {
  try {
    await p;
    return undefined; // resolved — no rejection
  } catch (e) {
    return e;
  }
}

describe('OtpService.generate — mint + singleton gate', () => {
  it('mints a fixed-length numeric code with a positive TTL and stores it under otp:<userId>', async () => {
    const { service, redis } = makeService();
    const userId = 'sub-alice';

    const result = await service.generate(userId);

    // Return shape: a numeric code of the expected length + a positive ttl.
    expect(typeof result.code).toBe('string');
    expect(result.code).toMatch(codeRegex);
    if (CODE_LEN) expect(result.code.length).toBe(CODE_LEN);
    else expect(result.code.length).toBeGreaterThanOrEqual(4);
    expect(typeof result.ttlSeconds).toBe('number');
    expect(result.ttlSeconds).toBeGreaterThan(0);
    if (OTP.OTP_TTL_SECONDS) expect(result.ttlSeconds).toBe(OTP.OTP_TTL_SECONDS);

    // The mint actually landed under the user-scoped key WITH a positive ttl recorded (the
    // TTL-bound requirement — a code that never expires would violate the contract).
    const stored = redis.store.get(key(userId));
    expect(stored).toBeDefined();
    expect(stored!.ttlSeconds).not.toBeNull();
    expect(stored!.ttlSeconds as number).toBeGreaterThan(0);

    // User-scoped: no OTHER user's slot was written.
    expect(redis.store.has(key('sub-bob'))).toBe(false);
  });

  it('rejects a SECOND generate while a code is active (singleton gate), leaving the first intact', async () => {
    const { service, redis } = makeService();
    const userId = 'sub-alice';

    const first = await service.generate(userId);
    const before = redis.store.get(key(userId));

    const err = await captureRejection(service.generate(userId));
    expect(err).toBeDefined(); // MUST reject — at most one active code per user
    expect(err.code).toBe('OTP_ALREADY_ACTIVE');
    if (OtpAlreadyActiveError) expect(err).toBeInstanceOf(OtpAlreadyActiveError);

    // The active code is NOT overwritten/rotated by the rejected attempt (NX left it in place),
    // so the originally-issued code still consumes.
    expect(redis.store.get(key(userId))).toEqual(before);
    expect(await service.consume(userId, first.code)).toBe(true);
  });

  it('allows generate again once the active code has been CONSUMED (the slot frees)', async () => {
    const { service } = makeService();
    const userId = 'sub-alice';

    const first = await service.generate(userId);
    expect(await service.consume(userId, first.code)).toBe(true); // slot freed

    // A fresh mint now succeeds (and yields a live, consumable code).
    const second = await service.generate(userId);
    expect(second.code).toMatch(codeRegex);
    expect(await service.consume(userId, second.code)).toBe(true);
  });

  it('the singleton gate is Redis-backed, not in-process: generate succeeds again once the key lapses', async () => {
    const { service, redis } = makeService();
    const userId = 'sub-alice';

    await service.generate(userId);
    // Simulate the TTL expiring in Redis (the key vanishes) WITHOUT going through consume — an
    // impl that cached "active" state in process memory would wrongly keep rejecting.
    redis.store.delete(key(userId));

    const again = await service.generate(userId);
    expect(again.code).toMatch(codeRegex);
    expect(redis.store.has(key(userId))).toBe(true);
  });
});

describe('OtpService.consume — single-use via atomic GETDEL', () => {
  it('consumes a CORRECT code exactly once: true, then the code is gone (second consume → false)', async () => {
    const { service, redis } = makeService();
    const userId = 'sub-alice';

    const { code } = await service.generate(userId);

    expect(await service.consume(userId, code)).toBe(true);
    // After a successful consume the key is deleted — the single-use guarantee.
    expect(redis.store.has(key(userId))).toBe(false);
    // A replay of the same (now consumed) code cannot succeed a second time.
    expect(await service.consume(userId, code)).toBe(false);
  });

  it('returns false for a WRONG code AND deletes the active code (GETDEL semantics, per contract)', async () => {
    const { service, redis } = makeService();
    const userId = 'sub-alice';

    const { code } = await service.generate(userId);
    const wrong = code === '000000' ? '111111' : '000000';

    // Wrong code → false, but GETDEL has already consumed (deleted) the active code.
    expect(await service.consume(userId, wrong)).toBe(false);
    expect(redis.store.has(key(userId))).toBe(false);
    // Consequence encoded as intended: the correct code no longer works either (it is gone).
    expect(await service.consume(userId, code)).toBe(false);
  });

  it('returns false when no code exists for the user', async () => {
    const { service } = makeService();
    expect(await service.consume('sub-nobody', '123456')).toBe(false);
  });

  it('returns false (does not throw) for a WRONG-LENGTH code — the constant-time compare is length-guarded', async () => {
    const { service, redis } = makeService();
    const userId = 'sub-alice';

    const { code } = await service.generate(userId);
    // A mistyped code of a DIFFERENT length exercises the length-guard branch that must run
    // before timingSafeEqual (which throws on unequal-length buffers). It must be rejected
    // cleanly as false, never surface that throw. GETDEL still consumes the active code.
    const shorter = code.slice(0, -1); // one digit short
    await expect(service.consume(userId, shorter)).resolves.toBe(false);
    expect(redis.store.has(key(userId))).toBe(false);
  });
});

describe('OtpService — CSPRNG code generation', () => {
  it('mints numeric codes of the expected shape with entropy across users (not a constant)', async () => {
    const { service } = makeService();
    const N = 50;
    const codes: string[] = [];

    for (let i = 0; i < N; i++) {
      const { code } = await service.generate(`sub-user-${i}`); // distinct users → no NX block
      expect(code).toMatch(codeRegex); // every code is a fixed-length numeric string
      codes.push(code);
    }

    // Distribution sanity for a CSPRNG source: NOT uniqueness of all N (that would be flaky),
    // just "more than one distinct value" — a hard-coded/constant code fails this.
    expect(new Set(codes).size).toBeGreaterThan(1);
  });
});
