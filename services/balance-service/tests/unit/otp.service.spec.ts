/**
 * Spec 04 — Balance Service, Step 4a (REVISED): the Redis-backed OTP module (service-only).
 * Written FROM the spec's "OTP module" bullet + the developer-directed typo-tolerance change,
 * NOT from the implementor's code. The OtpService class is resolved through the single harness
 * seam (`getOtpService`), the same coordination point every other suite imports through.
 *
 * Contract under test (spec-derived — the source of truth, independent of the impl):
 *   IOtpService.generate(userId): Promise<{ code: string; ttlSeconds: number }>
 *   IOtpService.consume(userId, code): Promise<{ ok: boolean; remainingAttempts: number; lockedOut: boolean }>
 *
 *   Storage shape (informational; assertions are on BEHAVIOUR / return values, with a light
 *   decode of the fake store where a datastore-level invariant is the point). The OTP code is
 *   HASHED at rest — `codeHash = HMAC-SHA256(pepper, `<userId>:<code>`)` (hex) — so the plaintext
 *   code is NEVER persisted: `generate` returns it once for out-of-band delivery and only the hash
 *   is stored, in the key name AND the record:
 *     - `otp:<userId>`            → a JSON record `{ codeHash, attempts }` (singleton gate +
 *                                   counter + reverse lookup used to burn the composite key).
 *     - `otp:<userId>:<codeHash>` → the composite marker, the atomic GETDEL target that makes a
 *                                   CORRECT consume a single-winner. Keyed by the HASH, not the
 *                                   plaintext, so nothing at rest reveals the code.
 *   Verification is by hashed-key existence: consume GETDELs `otp:<userId>:<hash(supplied)>` — a
 *   WRONG code (including a wrong-LENGTH code) simply hashes to a non-existent composite key → a
 *   GETDEL miss → an ordinary wrong attempt. There is NO plaintext compare and NO length guard.
 *
 *   - User-scoped, at most ONE active record per user; generation is singleton-gated: a second
 *     generate WHILE a code is active is rejected (OtpAlreadyActiveError, code OTP_ALREADY_ACTIVE).
 *     The slot frees on consume-SUCCESS, TTL lapse, OR lockout. Generate RESETS attempts to 0.
 *   - CORRECT code → { ok:true, ... }, single-use: the composite marker is GETDEL'd and the record
 *     removed, so a 2nd consume of the same code finds no active code (ok:false).
 *   - WRONG code is NON-DESTRUCTIVE (typo tolerance): { ok:false, remainingAttempts: N-1,
 *     lockedOut:false } and the CORRECT code still works afterward. Allowance = OTP_MAX_ATTEMPTS
 *     (3): 1st wrong → remaining 2, 2nd → 1, and you can still succeed on the 3rd try.
 *   - LOCKOUT: the MAX-th wrong attempt returns { ok:false, remainingAttempts:0, lockedOut:true }
 *     and BURNS the code — the correct code afterward returns ok:false. The slot frees.
 *   - NO ACTIVE CODE (never generated / consumed / expired) → { ok:false, remainingAttempts:0,
 *     lockedOut:false } and creates/leaks NO key.
 *   - WRONG-LENGTH code → a normal wrong attempt (ok:false, non-destructive), never throws.
 *   - Code is a fixed-length numeric CSPRNG string; a TTL is set on BOTH keys.
 *   - AT-REST HASHING: the plaintext code is never stored — the record's `codeHash` and the
 *     composite key segment are `HMAC-SHA256(pepper, `<userId>:<code>`)`, recomputed independently
 *     in-test (node crypto + the SAME stub pepper) to pin the exact keyed, userId-mixed construction.
 *   - RESURRECTION-RACE GUARD: the wrong-attempt counter bump is a `SET … XX KEEPTTL`, so a
 *     concurrent winner's DEL landing between the loser's GET and its SET can NOT recreate a
 *     TTL-less record — a null reply yields `{ ok:false, remainingAttempts:0, lockedOut:false }`.
 *
 * Why a hand-rolled fake and not a mock: the fake FAITHFULLY models the ioredis commands this
 * design rides on — SET ... EX NX (mint iff absent), SET ... XX KEEPTTL (bump the counter iff the
 * record still exists, keeping the expiry), SET ... EX (overwrite + expiry), GETDEL (atomic
 * read-and-delete), GET, DEL — so the singleton gate, the attempt counter, the single-use
 * guarantee, and the XX resurrection guard are the OtpService's OWN logic running on real
 * datastore semantics, not stubbed away. Every assertion is on a real return value or the fake
 * store's observable state — never "a method was called". The HMAC is recomputed with node crypto
 * as an INDEPENDENT oracle (not imported from the impl). Pure, no real Redis, runs in the DEFAULT
 * `npm test` (never skipped).
 */
import 'reflect-metadata';
import { createHash, createHmac } from 'crypto';
import { getOtpService, getOtpConstants, getOtpAlreadyActiveError } from '../support/harness';

const OtpService = getOtpService();
const OTP = getOtpConstants();
const OtpAlreadyActiveError = getOtpAlreadyActiveError();

/** The stub pepper the unit service is constructed with. The SAME value is fed to the
 *  independent HMAC oracle below, so the recomputed hash pins the impl's exact construction. */
const UNIT_PEPPER = 'unit-test-pepper-0123456789';
/** The 2nd constructor arg: `OtpService(redis, config)` reads `config.otp.hashSecret`. */
const configStub = { otp: { hashSecret: UNIT_PEPPER } };

/**
 * INDEPENDENT oracle for the at-rest hash. Recomputed here with node crypto (NOT imported from the
 * impl) so it can pin the exact construction the impl must use: a keyed HMAC-SHA256 over
 * `<userId>:<code>` with the pepper, hex-encoded. A plaintext store, an unkeyed hash, an omitted
 * userId, or a different pepper all produce a different digest and fail the equality assertions. */
function hmacHex(userId: string, code: string): string {
  return createHmac('sha256', UNIT_PEPPER).update(`${userId}:${code}`).digest('hex');
}

// Resolved code length when the constant is exported; otherwise the structural fallback.
const CODE_LEN: number | undefined = OTP.OTP_CODE_LENGTH;
const codeRegex = CODE_LEN ? new RegExp(`^\\d{${CODE_LEN}}$`) : /^\d{4,}$/;

// The typo-tolerance allowance before lockout. Falls back to 3 (the spec value) when the
// implementor does not export the constant — the ladder proofs are written generically off MAX
// so they stay correct whatever the resolved allowance is (they still require MAX >= 2 to be
// meaningful, which any real config satisfies).
const MAX = OTP.OTP_MAX_ATTEMPTS ?? 3;

interface FakeEntry {
  value: string;
  ttlSeconds: number | null;
}

/**
 * An in-memory fake of the ioredis commands the SET-NX / KEEPTTL / GETDEL design uses. Each is
 * modeled to Redis's real semantics so the service's OWN attempt/gate/single-use logic is what
 * runs — nothing about the logic under test is stubbed:
 *   set(key,val,'EX',n,'NX') — mint iff absent: 'OK' + record ttl, or null on the NX conflict.
 *   set(key,val,'KEEPTTL')   — overwrite the value, PRESERVE the recorded ttl, always 'OK'.
 *   set(key,val,'EX',n)      — overwrite + (re)set ttl, always 'OK'. Plain SET clears the ttl.
 *   get(key)                 — value / null.
 *   getdel(key)              — value + atomic delete / null.
 *   del(...keys)             — delete, return the number actually removed.
 * `store` is exposed so tests can assert the datastore's observable state directly.
 */
function createFakeRedis(): {
  store: Map<string, FakeEntry>;
  set: (key: string, value: string, ...opts: unknown[]) => Promise<'OK' | null>;
  get: (key: string) => Promise<string | null>;
  getdel: (key: string) => Promise<string | null>;
  del: (...keys: unknown[]) => Promise<number>;
} {
  const store = new Map<string, FakeEntry>();

  return {
    store,
    async set(key: string, value: string, ...opts: unknown[]): Promise<'OK' | null> {
      const flags = opts.map((o) => (typeof o === 'string' ? o.toUpperCase() : o));
      const nx = flags.includes('NX');
      const xx = flags.includes('XX');
      const keepttl = flags.includes('KEEPTTL');

      let ttlSeconds: number | null = null;
      let ttlSpecified = false;
      for (let i = 0; i < opts.length; i++) {
        const f = typeof opts[i] === 'string' ? String(opts[i]).toUpperCase() : opts[i];
        if (f === 'EX') {
          ttlSeconds = Number(opts[i + 1]);
          ttlSpecified = true;
        } else if (f === 'PX') {
          ttlSeconds = Number(opts[i + 1]) / 1000;
          ttlSpecified = true;
        }
      }

      const existing = store.get(key);
      const exists = existing !== undefined;
      if (nx && exists) return null; // SET NX fails when the key is present
      if (xx && !exists) return null; // SET XX fails when the key is absent

      let finalTtl: number | null;
      if (ttlSpecified)
        finalTtl = ttlSeconds; // EX/PX (re)sets the ttl
      else if (keepttl)
        finalTtl = existing ? existing.ttlSeconds : null; // KEEPTTL preserves it
      else finalTtl = null; // a plain SET (no EX/PX/KEEPTTL) clears the ttl, as real Redis does

      store.set(key, { value: String(value), ttlSeconds: finalTtl });
      return 'OK';
    },
    async get(key: string): Promise<string | null> {
      const entry = store.get(key);
      return entry === undefined ? null : entry.value;
    },
    async getdel(key: string): Promise<string | null> {
      const entry = store.get(key);
      if (entry === undefined) return null;
      store.delete(key); // atomic read-and-delete
      return entry.value;
    },
    async del(...keys: unknown[]): Promise<number> {
      const flat = keys.flat() as string[]; // tolerate del(a,b) and del([a,b])
      let removed = 0;
      for (const k of flat) if (store.delete(String(k))) removed++;
      return removed;
    },
  };
}

function makeService(): {
  service: any;
  redis: ReturnType<typeof createFakeRedis>;
} {
  const redis = createFakeRedis();
  // Post-hashing change: the service takes (redis, config) and reads config.otp.hashSecret.
  const service = new OtpService(redis, configStub);
  return { service, redis };
}

const recordKey = (userId: string): string => `otp:${userId}`;
/** The composite marker key. Post-hashing change it is keyed by the HASH of the code, not the
 *  plaintext — computed via the SAME independent oracle so the existing marker-existence proofs
 *  target the real key while also proving the code was hashed into the key name. */
const compositeKey = (userId: string, code: string): string =>
  `otp:${userId}:${hmacHex(userId, code)}`;

/** A wrong code of the SAME length as `code` (flip the last digit) — a guaranteed mismatch that
 *  hashes to a DIFFERENT (non-existent) composite key, exercising the wrong-but-well-formed path. */
function wrongOf(code: string): string {
  const last = code[code.length - 1];
  const replacement = last === '0' ? '1' : '0';
  return code.slice(0, -1) + replacement;
}

/** Simulate the whole OTP entry expiring in Redis (record + composite vanish together, as they
 *  would under a shared TTL) — WITHOUT going through consume, so an impl that cached "active"
 *  state in process memory would be caught. */
function simulateTtlLapse(redis: ReturnType<typeof createFakeRedis>, userId: string): void {
  const prefix = recordKey(userId);
  for (const k of [...redis.store.keys()]) {
    if (k === prefix || k.startsWith(prefix + ':')) redis.store.delete(k);
  }
}

/** True iff the fake store holds ANY key for this user (record or composite) — for no-leak proofs. */
function hasAnyKeyFor(redis: ReturnType<typeof createFakeRedis>, userId: string): boolean {
  const prefix = recordKey(userId);
  for (const k of redis.store.keys()) {
    if (k === prefix || k.startsWith(prefix + ':')) return true;
  }
  return false;
}

async function captureRejection(p: Promise<unknown>): Promise<any> {
  try {
    await p;
    return undefined; // resolved — no rejection
  } catch (e) {
    return e;
  }
}

describe('OtpService.generate — mint + singleton gate', () => {
  it('mints a fixed-length numeric code, TTL-bound, under both the record and composite keys, user-scoped', async () => {
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

    // The singleton-gate record landed WITH a positive ttl (a code that never expires would
    // violate the TTL-bound requirement).
    const record = redis.store.get(recordKey(userId));
    expect(record).toBeDefined();
    expect(record!.ttlSeconds as number).toBeGreaterThan(0);

    // The composite marker (the atomic GETDEL target) also landed and is TTL-bound — the spec
    // requires a TTL on BOTH keys.
    const composite = redis.store.get(compositeKey(userId, result.code));
    expect(composite).toBeDefined();
    expect(composite!.ttlSeconds as number).toBeGreaterThan(0);

    // User-scoped: no OTHER user's slot was written.
    expect(hasAnyKeyFor(redis, 'sub-bob')).toBe(false);
  });

  it('rejects a SECOND generate while a code is active (singleton gate), leaving the first consumable', async () => {
    const { service, redis } = makeService();
    const userId = 'sub-alice';

    const first = await service.generate(userId);
    const recordBefore = redis.store.get(recordKey(userId));

    const err = await captureRejection(service.generate(userId));
    expect(err).toBeDefined(); // MUST reject — at most one active code per user
    expect(err.code).toBe('OTP_ALREADY_ACTIVE');
    if (OtpAlreadyActiveError) expect(err).toBeInstanceOf(OtpAlreadyActiveError);

    // The active record is NOT rotated/overwritten by the rejected attempt (NX left it), so the
    // originally-issued code still consumes.
    expect(redis.store.get(recordKey(userId))).toEqual(recordBefore);
    expect((await service.consume(userId, first.code)).ok).toBe(true);
  });

  it('allows generate again once the active code has been CONSUMED (the slot frees)', async () => {
    const { service } = makeService();
    const userId = 'sub-alice';

    const first = await service.generate(userId);
    expect((await service.consume(userId, first.code)).ok).toBe(true); // slot freed

    // A fresh mint now succeeds (and yields a live, consumable code).
    const second = await service.generate(userId);
    expect(second.code).toMatch(codeRegex);
    expect((await service.consume(userId, second.code)).ok).toBe(true);
  });

  it('the singleton gate is Redis-backed, not in-process: generate succeeds again once the entry lapses', async () => {
    const { service, redis } = makeService();
    const userId = 'sub-alice';

    await service.generate(userId);
    // Simulate the TTL expiring in Redis (record + composite vanish) WITHOUT consuming — an impl
    // that cached "active" state in process memory would wrongly keep rejecting.
    simulateTtlLapse(redis, userId);

    const again = await service.generate(userId);
    expect(again.code).toMatch(codeRegex);
    expect(redis.store.has(recordKey(userId))).toBe(true);
  });

  it('RESETS the attempt counter on regenerate: after a lockout frees the slot, the new code has a fresh allowance', async () => {
    const { service } = makeService();
    const userId = 'sub-alice';

    // Burn the first code via a full lockout (which frees the slot).
    const first = await service.generate(userId);
    const wrong1 = wrongOf(first.code);
    for (let i = 1; i <= MAX; i++) await service.consume(userId, wrong1);

    // Regenerate — the lockout freed the slot, so this must succeed with a FRESH counter.
    const second = await service.generate(userId);
    expect(second.code).toMatch(codeRegex);

    // One wrong attempt on the NEW code returns the full-minus-one remaining again: proof the
    // counter reset to 0 (a leaked counter would show fewer remaining, or an immediate lockout).
    const afterFirstWrong = await service.consume(userId, wrongOf(second.code));
    expect(afterFirstWrong).toEqual({ ok: false, remainingAttempts: MAX - 1, lockedOut: false });

    // ...and the new code itself still works (it survived the wrong attempt).
    expect((await service.consume(userId, second.code)).ok).toBe(true);
  });
});

describe('OtpService.consume — single-use, typo tolerance, lockout', () => {
  it('consumes a CORRECT code exactly once, then the slot is gone (record + composite removed; 2nd consume → no active code)', async () => {
    const { service, redis } = makeService();
    const userId = 'sub-alice';

    const { code } = await service.generate(userId);

    const ok = await service.consume(userId, code);
    expect(ok.ok).toBe(true);
    expect(ok.lockedOut).toBe(false); // a success is never a lockout

    // Single-use: BOTH keys are gone after a successful consume — the slot is freed.
    expect(redis.store.has(recordKey(userId))).toBe(false);
    expect(redis.store.has(compositeKey(userId, code))).toBe(false);

    // A replay of the same (now consumed) code hits the no-active-code branch.
    expect(await service.consume(userId, code)).toEqual({
      ok: false,
      remainingAttempts: 0,
      lockedOut: false,
    });
  });

  it('TYPO TOLERANCE: a wrong code is non-destructive — remaining drops but the CORRECT code still works', async () => {
    const { service, redis } = makeService();
    const userId = 'sub-alice';

    const { code } = await service.generate(userId);
    const wrong = wrongOf(code);

    // 1st wrong attempt: non-destructive, remaining = MAX - 1, not locked out. (Also proves the
    // counter started at 0: the very first wrong leaves MAX-1 tries.)
    expect(await service.consume(userId, wrong)).toEqual({
      ok: false,
      remainingAttempts: MAX - 1,
      lockedOut: false,
    });

    // The record and the composite marker SURVIVED the wrong attempt (nothing was burned).
    expect(redis.store.has(recordKey(userId))).toBe(true);
    expect(redis.store.has(compositeKey(userId, code))).toBe(true);

    // The headline guarantee: the correct code STILL authorizes after the typo.
    expect((await service.consume(userId, code)).ok).toBe(true);
  });

  it('ATTEMPT LADDER + LOCKOUT: wrong attempts count down, the MAX-th locks out and burns the code', async () => {
    const { service, redis } = makeService();
    const userId = 'sub-alice';

    const { code } = await service.generate(userId);
    const wrong = wrongOf(code);

    for (let i = 1; i <= MAX; i++) {
      const res = await service.consume(userId, wrong);
      if (i < MAX) {
        // still within the allowance: remaining counts down, not locked out
        expect(res).toEqual({ ok: false, remainingAttempts: MAX - i, lockedOut: false });
        expect(redis.store.has(compositeKey(userId, code))).toBe(true); // code survives
      } else {
        // the MAX-th wrong attempt is the lockout: remaining 0, lockedOut true
        expect(res).toEqual({ ok: false, remainingAttempts: 0, lockedOut: true });
      }
    }

    // The lockout BURNED the code: record + composite are gone, and the correct code no longer
    // works (it falls through to the no-active-code branch).
    expect(redis.store.has(recordKey(userId))).toBe(false);
    expect(redis.store.has(compositeKey(userId, code))).toBe(false);
    expect(await service.consume(userId, code)).toEqual({
      ok: false,
      remainingAttempts: 0,
      lockedOut: false,
    });
  });

  it('you can still succeed WITHIN the allowance: MAX-1 wrong attempts, then the correct code wins', async () => {
    const { service } = makeService();
    const userId = 'sub-alice';

    const { code } = await service.generate(userId);
    const wrong = wrongOf(code);

    for (let i = 1; i < MAX; i++) {
      const res = await service.consume(userId, wrong);
      expect(res.ok).toBe(false);
      expect(res.lockedOut).toBe(false);
      expect(res.remainingAttempts).toBe(MAX - i);
    }

    // The correct code on the last allowed try succeeds — the wrong attempts never burned it.
    expect((await service.consume(userId, code)).ok).toBe(true);
  });

  it('returns the no-active-code result for a user who never generated, and leaks NO key', async () => {
    const { service, redis } = makeService();

    const res = await service.consume('sub-nobody', '123456');
    expect(res).toEqual({ ok: false, remainingAttempts: 0, lockedOut: false });

    // A consume against nothing must not conjure a record/composite (no counter to leak).
    expect(hasAnyKeyFor(redis, 'sub-nobody')).toBe(false);
    expect(redis.store.size).toBe(0);
  });

  it('treats a WRONG-LENGTH code as an ordinary wrong attempt: ok:false, non-destructive, never throws', async () => {
    const { service, redis } = makeService();
    const userId = 'sub-alice';

    const { code } = await service.generate(userId);
    // Post-hashing change there is NO length guard and NO timingSafeEqual: a wrong-length code
    // simply hashes to a composite key `otp:<userId>:<hash(shorter)>` that was never written, so
    // the GETDEL misses and it falls through to the ordinary wrong-attempt path — a normal
    // non-destructive miss, never a throw.
    const shorter = code.slice(0, -1); // one digit short — a guaranteed non-existent hashed key

    await expect(service.consume(userId, shorter)).resolves.toEqual({
      ok: false,
      remainingAttempts: MAX - 1,
      lockedOut: false,
    });

    // Non-destructive: the code survived, and the correct code still works.
    expect(redis.store.has(compositeKey(userId, code))).toBe(true);
    expect((await service.consume(userId, code)).ok).toBe(true);
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

describe('OtpService.consume — resurrection-race guard (SET XX on the counter bump)', () => {
  it('does NOT recreate a deleted record when a concurrent winner DELs between the loser GET and its bump', async () => {
    const { service, redis } = makeService();
    const userId = 'sub-alice';

    const { code } = await service.generate(userId);

    // Simulate the concurrent winner's DEL landing in the tiny window between the loser's
    // `GET otp:<userId>` and its counter-bump SET: right after get() hands back the meta record,
    // drop the record key. The bump is a `SET … XX KEEPTTL`, so on a now-absent record it MUST
    // no-op (XX) and the impl MUST return the null-reply result — never resurrect a TTL-less key.
    const originalGet = redis.get.bind(redis);
    let armed = true;
    redis.get = async (key: string): Promise<string | null> => {
      const value = await originalGet(key);
      if (armed && key === recordKey(userId) && value !== null) {
        armed = false; // one-shot: only the loser's read triggers the concurrent DEL
        redis.store.delete(recordKey(userId));
      }
      return value;
    };

    // A WRONG code forces the get()+bump path (the composite GETDEL misses first).
    const res = await service.consume(userId, wrongOf(code));

    // (a) On the vanished record the XX bump returns null → the null-reply contract. (Pre-fix
    //     code used a plain KEEPTTL SET, which recreated the record and returned remaining MAX-1.)
    expect(res).toEqual({ ok: false, remainingAttempts: 0, lockedOut: false });

    // (b) The record was NOT resurrected — a plain SET would have recreated `otp:<userId>` with no
    //     TTL, permanently wedging the singleton gate.
    expect(redis.store.has(recordKey(userId))).toBe(false);

    // (c) The gate is not stuck: a fresh generate SUCCEEDS and yields a live, consumable code.
    const again = await service.generate(userId);
    expect(again.code).toMatch(codeRegex);
    expect((await service.consume(userId, again.code)).ok).toBe(true);
  });
});

describe('OtpService — at-rest hashing (plaintext code is never persisted)', () => {
  it('stores only the HMAC of the code: no store value equals, and no key segment is, the plaintext', async () => {
    const { service, redis } = makeService();
    const userId = 'sub-alice';

    const { code } = await service.generate(userId);

    // No stored VALUE equals the plaintext code (the record holds { codeHash, attempts }; the
    // composite marker holds a constant sentinel).
    for (const entry of redis.store.values()) {
      expect(entry.value).not.toBe(code);
    }
    // No KEY segment is the plaintext code — the composite is keyed by the HASH, so the OLD
    // plaintext-keyed composite `otp:<userId>:<code>` must NOT exist.
    for (const key of redis.store.keys()) {
      expect(key.split(':')).not.toContain(code);
    }
    expect(redis.store.has(`otp:${userId}:${code}`)).toBe(false);

    // The stored record decodes to { codeHash, attempts } with NO plaintext `code` field; its
    // codeHash differs from the plaintext (i.e. the code was hashed, not stored verbatim).
    const record = JSON.parse(redis.store.get(recordKey(userId))!.value);
    expect(record.code).toBeUndefined();
    expect(typeof record.codeHash).toBe('string');
    expect(record.codeHash).not.toBe(code);
    expect(record.attempts).toBe(0);
  });

  it('pins the EXACT keyed, userId-mixed HMAC construction (independent recomputation)', async () => {
    const { service, redis } = makeService();
    const userId = 'sub-alice';

    const { code } = await service.generate(userId);
    const record = JSON.parse(redis.store.get(recordKey(userId))!.value);

    // The stored codeHash === HMAC-SHA256(pepper, `<userId>:<code>`) recomputed independently.
    // This single equality pins: keyed (not a bare hash), the exact pepper, AND userId mixed into
    // the message — any of those wrong yields a different digest.
    expect(record.codeHash).toBe(hmacHex(userId, code));

    // The composite marker (the GETDEL target) is keyed by that SAME hash.
    expect(redis.store.has(`otp:${userId}:${record.codeHash}`)).toBe(true);

    // Negative controls — each would (wrongly) match if the impl used that weaker construction:
    //   - a plain UNKEYED sha256 (no pepper) must differ;
    expect(record.codeHash).not.toBe(
      createHash('sha256').update(`${userId}:${code}`).digest('hex'),
    );
    //   - hashing WITHOUT the userId mixed in must differ (per-user separation);
    expect(record.codeHash).not.toBe(createHmac('sha256', UNIT_PEPPER).update(code).digest('hex'));
    //   - a DIFFERENT user with the SAME code must hash differently (no cross-user marker reuse).
    expect(record.codeHash).not.toBe(hmacHex('sub-bob', code));
  });

  it('verifies deterministically: hash(code)@generate == hash(supplied)@consume, so the correct code still consumes', async () => {
    const { service } = makeService();
    const userId = 'sub-alice';

    const { code } = await service.generate(userId);
    // No plaintext was stored, yet the correct plaintext still consumes — the only way is that
    // consume rehashes the supplied code identically and finds the composite marker.
    expect((await service.consume(userId, code)).ok).toBe(true);
  });
});
