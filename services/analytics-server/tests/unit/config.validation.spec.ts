/**
 * DoD (spec 03): "both apps boot with config validation" + Step-3b coordination
 * contract: "Config (zod), fail-fast on boot ... Missing/invalid required var → boot
 * fails (throws / non-zero); no silent default fallback." Analytics reads its OWN env
 * (ADR-16): NODE_ENV, PORT (default 3000), MONGO_HOST, MONGO_PORT (default 27017),
 * MONGO_DB, MONGO_USER, MONGO_PASSWORD, MONGO_AUTH_SOURCE (default `analytics`),
 * INTERNAL_SERVICE_TOKEN. There is NO Redis and NO Postgres/TypeORM here.
 *
 * Pure unit test of the validation function passed to ConfigModule — fully runnable
 * WITHOUT Docker. Each case can fail on a real defect:
 *   - a schema that silently defaults a required var would fail the "throws" cases;
 *   - a schema that leaves PORT/MONGO_PORT a string / accepts "abc" fails the numeric
 *     cases;
 *   - a schema that drops or mis-sets the MONGO_AUTH_SOURCE default fails that case.
 */
import { getValidateEnv, getConfigComposer } from '../support/harness';
import { completeRawEnv, rawEnvWithout } from '../support/env.fixture';

const validateEnv = getValidateEnv();
const composeConfig = getConfigComposer();

/** Read a config value tolerant of flat (PORT) vs the occasional nested (port) shape. */
function portOf(cfg: any): unknown {
  return cfg?.PORT ?? cfg?.port ?? cfg?.app?.port;
}
function mongoPortOf(cfg: any): unknown {
  return cfg?.MONGO_PORT ?? cfg?.mongoPort ?? cfg?.mongo?.port;
}
function mongoAuthSourceOf(cfg: any): unknown {
  return cfg?.MONGO_AUTH_SOURCE ?? cfg?.mongoAuthSource ?? cfg?.mongo?.authSource;
}
function redisPortOf(cfg: any): unknown {
  return cfg?.REDIS_PORT ?? cfg?.redisPort ?? cfg?.redis?.port;
}

describe('config validation (fail-fast, zod)', () => {
  it('accepts a complete valid env and returns a config object with typed values', () => {
    const cfg = validateEnv(completeRawEnv({ PORT: '3000', MONGO_PORT: '27017' }));
    expect(cfg).toBeDefined();
    expect(cfg).not.toBeNull();
    // Numeric fields must be real numbers, not strings — the schema coerces them.
    expect(typeof portOf(cfg)).toBe('number');
    expect(portOf(cfg)).toBe(3000);
    expect(typeof mongoPortOf(cfg)).toBe('number');
    expect(mongoPortOf(cfg)).toBe(27017);
  });

  it('applies the PORT default (3000) as a NUMBER when PORT is omitted', () => {
    // Omitting an optional-with-default var must be accepted (contrast with the
    // required vars below, which must throw when omitted).
    const cfg = validateEnv(rawEnvWithout('PORT'));
    const port = portOf(cfg);
    expect(typeof port).toBe('number');
    expect(port).toBe(3000);
  });

  it('coerces a provided numeric string to a real number (PORT="8080" -> 8080)', () => {
    const cfg = validateEnv(completeRawEnv({ PORT: '8080' }));
    const port = portOf(cfg);
    expect(typeof port).toBe('number');
    expect(port).toBe(8080);
  });

  it('rejects a non-numeric PORT (does NOT fall back to the default)', () => {
    // The dangerous defect this catches: coercion failure silently swallowed into
    // the default, hiding a misconfiguration.
    expect(() => validateEnv(completeRawEnv({ PORT: 'not-a-port' }))).toThrow();
  });

  it('applies the MONGO_PORT default (27017) as a NUMBER when MONGO_PORT is omitted', () => {
    const cfg = validateEnv(rawEnvWithout('MONGO_PORT'));
    const port = mongoPortOf(cfg);
    expect(typeof port).toBe('number');
    expect(port).toBe(27017);
  });

  it('rejects a non-numeric MONGO_PORT (does NOT fall back to the default)', () => {
    expect(() => validateEnv(completeRawEnv({ MONGO_PORT: 'nope' }))).toThrow();
  });

  it('applies the MONGO_AUTH_SOURCE default ("analytics") when it is omitted', () => {
    // This var carries a non-numeric default; a schema that forgot it (or defaulted
    // to "admin") would silently authenticate against the wrong db — a real defect.
    const cfg = validateEnv(rawEnvWithout('MONGO_AUTH_SOURCE'));
    expect(mongoAuthSourceOf(cfg)).toBe('analytics');
  });

  it('fails fast when the REQUIRED secret MONGO_PASSWORD is missing', () => {
    expect(() => validateEnv(rawEnvWithout('MONGO_PASSWORD'))).toThrow();
  });

  it('fails fast when MONGO_PASSWORD is present but empty', () => {
    expect(() => validateEnv(completeRawEnv({ MONGO_PASSWORD: '' }))).toThrow();
  });

  it('fails fast when the REQUIRED coordinate MONGO_HOST is missing', () => {
    expect(() => validateEnv(rawEnvWithout('MONGO_HOST'))).toThrow();
  });

  it('fails fast when the REQUIRED MONGO_DB is missing (no default)', () => {
    expect(() => validateEnv(rawEnvWithout('MONGO_DB'))).toThrow();
  });

  it('fails fast when the REQUIRED MONGO_USER is missing (no default)', () => {
    expect(() => validateEnv(rawEnvWithout('MONGO_USER'))).toThrow();
  });

  it('fails fast when INTERNAL_SERVICE_TOKEN is missing (the /internal secret)', () => {
    expect(() => validateEnv(rawEnvWithout('INTERNAL_SERVICE_TOKEN'))).toThrow();
  });

  it('accepts omitting only the defaulted vars (PORT, MONGO_PORT, MONGO_AUTH_SOURCE)', () => {
    // Proves those three are optional-with-default, not required — and that an env
    // carrying only the required secrets/coordinates still validates.
    expect(() =>
      validateEnv(rawEnvWithout('PORT', 'MONGO_PORT', 'MONGO_AUTH_SOURCE')),
    ).not.toThrow();
  });
});

describe('redis config validation (spec 05 — fail-fast on the stream coordinates/secret)', () => {
  // Spec 05 adds the transaction-stream consumer: analytics now reads Redis
  // (events:transactions). REDIS_HOST + REDIS_PASSWORD are REQUIRED coordinates/secret
  // (fail-fast, no silent default); REDIS_PORT is optional-with-default 6379.
  it('accepts a complete env carrying REDIS_HOST/REDIS_PORT/REDIS_PASSWORD (port coerced to a NUMBER)', () => {
    const cfg = validateEnv(completeRawEnv({ REDIS_PORT: '6379' }));
    expect(typeof redisPortOf(cfg)).toBe('number');
    expect(redisPortOf(cfg)).toBe(6379);
  });

  it('applies the REDIS_PORT default (6379) as a NUMBER when REDIS_PORT is omitted', () => {
    const cfg = validateEnv(rawEnvWithout('REDIS_PORT'));
    const port = redisPortOf(cfg);
    expect(typeof port).toBe('number');
    expect(port).toBe(6379);
  });

  it('coerces a provided numeric REDIS_PORT string to a real number ("6380" -> 6380)', () => {
    const cfg = validateEnv(completeRawEnv({ REDIS_PORT: '6380' }));
    expect(redisPortOf(cfg)).toBe(6380);
  });

  it('rejects a non-numeric REDIS_PORT (does NOT fall back to the default)', () => {
    expect(() => validateEnv(completeRawEnv({ REDIS_PORT: 'not-a-port' }))).toThrow();
  });

  it('fails fast when the REQUIRED coordinate REDIS_HOST is missing', () => {
    expect(() => validateEnv(rawEnvWithout('REDIS_HOST'))).toThrow();
  });

  it('fails fast when the REQUIRED secret REDIS_PASSWORD is missing', () => {
    // A silent default here would connect the consumer to Redis with no/empty auth —
    // a real defect the fail-fast must catch.
    expect(() => validateEnv(rawEnvWithout('REDIS_PASSWORD'))).toThrow();
  });

  it('fails fast when REDIS_PASSWORD is present but empty', () => {
    expect(() => validateEnv(completeRawEnv({ REDIS_PASSWORD: '' }))).toThrow();
  });
});

describe('redis URL composition (URL-encoding, regression lock)', () => {
  // Mirrors the Mongo DSN lock: the reserved-char-free creds every other test uses
  // would let a dropped encoding pass silently while corrupting the DSN. The redis URL
  // has an EMPTY username and the password after the ':' — redis://:<pw>@<host>:<port>.
  const PASSWORD = 'p@ss:w/rd?#'; // '@' ':' '/' '?' '#' — all reserved in userinfo
  const ENC_PASSWORD = 'p%40ss%3Aw%2Frd%3F%23';

  function redisUrlFor(overrides: Record<string, unknown> = {}): string {
    const cfg = composeConfig(completeRawEnv({ REDIS_PASSWORD: PASSWORD, ...overrides }));
    const url = cfg?.redis?.url;
    expect(typeof url).toBe('string');
    return url as string;
  }

  it('composes redis://:<pw>@<host>:<port> with reserved chars percent-encoded', () => {
    const url = redisUrlFor({ REDIS_HOST: 'redis', REDIS_PORT: '6379' });
    expect(url.startsWith('redis://')).toBe(true);
    expect(url).toContain(ENC_PASSWORD);
    // The raw (unencoded) password must NOT appear — that would mean encoding was dropped.
    expect(url).not.toContain(`:${PASSWORD}@`);
    expect(url).toContain('@redis:6379');
  });

  it('round-trips through new URL() back to the intended host/port/password (empty user)', () => {
    // The strongest form: a dropped/wrong encoding either fails to parse or yields the
    // wrong credentials. The password carries '@' and '/', which would break parsing
    // if left bare.
    const url = new URL(redisUrlFor({ REDIS_HOST: 'redis', REDIS_PORT: '6379' }));
    expect(url.protocol).toBe('redis:');
    expect(url.hostname).toBe('redis');
    expect(url.port).toBe('6379');
    expect(url.username).toBe(''); // redis default user — no username in the userinfo
    expect(decodeURIComponent(url.password)).toBe(PASSWORD);
  });

  it('keeps the discrete redis.password RAW (only the composed url is encoded)', () => {
    // Encoding belongs to the DSN, not the stored credential — a client library that
    // takes discrete host/port/password must receive the true password.
    const cfg = composeConfig(completeRawEnv({ REDIS_PASSWORD: PASSWORD }));
    expect(cfg?.redis?.password).toBe(PASSWORD);
  });
});

describe('mongo DSN composition (URL-encoding, regression lock)', () => {
  // Every other test uses reserved-char-free creds, so a regression that dropped the
  // encoding (raw interpolation) would pass the whole suite while silently corrupting
  // the DSN. These lock the percent-encoding of the userinfo against that regression.
  const USER = 'us:er@name'; // contains ':' and '@' — both reserved in userinfo
  const PASSWORD = 'p@ss:w/rd?#'; // '@' ':' '/' '?' '#' — all reserved
  const ENC_USER = 'us%3Aer%40name';
  const ENC_PASSWORD = 'p%40ss%3Aw%2Frd%3F%23';

  function dsnFor(): string {
    const cfg = composeConfig(completeRawEnv({ MONGO_USER: USER, MONGO_PASSWORD: PASSWORD }));
    const dsn = cfg?.mongo?.dsn;
    expect(typeof dsn).toBe('string');
    return dsn as string;
  }

  it('percent-encodes reserved chars in the user and password inside the DSN', () => {
    const dsn = dsnFor();
    expect(dsn).toContain(ENC_PASSWORD);
    expect(dsn).toContain(ENC_USER);
    // The raw (unencoded) forms must NOT appear — that would mean encoding was dropped.
    expect(dsn).not.toContain(`:${PASSWORD}@`);
    expect(dsn).not.toContain(`//${USER}:`);
  });

  it('leaves NO bare reserved char inside the userinfo segment (only the single userinfo/host @)', () => {
    const dsn = dsnFor();
    expect(dsn.startsWith('mongodb://')).toBe(true);
    const afterScheme = dsn.slice('mongodb://'.length);
    // The first literal '@' must be the userinfo/host separator: since the password's
    // own '@' is encoded (%40), the userinfo segment before it carries no bare '@'.
    const sepIdx = afterScheme.indexOf('@');
    expect(sepIdx).toBeGreaterThan(0);
    const userinfo = afterScheme.slice(0, sepIdx);
    // Exactly one bare ':' (the user:password separator); user/password ':' are encoded.
    expect(userinfo.split(':').length - 1).toBe(1);
    // No bare path/query/fragment delimiters leaked into the credentials.
    for (const ch of ['/', '?', '#', '@']) {
      expect(userinfo.includes(ch)).toBe(false);
    }
  });

  it('round-trips through new URL() back to the intended user and password', () => {
    // The strongest form: parse the composed DSN and decode the userinfo. A dropped
    // or wrong encoding either fails to parse or yields the wrong credentials here.
    const url = new URL(dsnFor());
    expect(decodeURIComponent(url.username)).toBe(USER);
    expect(decodeURIComponent(url.password)).toBe(PASSWORD);
    expect(url.hostname).toBe('mongo');
    expect(url.port).toBe('27017');
  });
});
