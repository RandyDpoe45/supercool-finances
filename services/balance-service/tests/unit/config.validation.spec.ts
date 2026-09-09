/**
 * DoD (spec 03): "both apps boot with config validation" + coordination contract
 * "Config (zod), fail-fast on boot ... Missing/invalid required var → boot fails,
 * does not start with defaults".
 *
 * Pure unit test of the validation function passed to ConfigModule — fully runnable
 * WITHOUT Docker. Each case can fail on a real defect:
 *   - a schema that silently defaults a required var would fail the "throws" cases;
 *   - a schema that leaves PORT a string / accepts "abc" would fail the numeric cases.
 */
import { getValidateEnv } from '../support/harness';
import { completeRawEnv, rawEnvWithout } from '../support/env.fixture';

const validateEnv = getValidateEnv();

/** Read a config value tolerant of flat (PORT) vs the occasional nested (port) shape. */
function portOf(cfg: any): unknown {
  return cfg?.PORT ?? cfg?.port ?? cfg?.app?.port;
}

describe('config validation (fail-fast, zod)', () => {
  it('accepts a complete valid env and returns a config object', () => {
    const cfg = validateEnv(completeRawEnv());
    expect(cfg).toBeDefined();
    expect(cfg).not.toBeNull();
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

  it('fails fast when a REQUIRED secret (DB_PASSWORD) is missing', () => {
    expect(() => validateEnv(rawEnvWithout('DB_PASSWORD'))).toThrow();
  });

  it('fails fast when DB_PASSWORD is present but empty', () => {
    expect(() => validateEnv(completeRawEnv({ DB_PASSWORD: '' }))).toThrow();
  });

  it('fails fast when a REQUIRED coordinate (DB_HOST) is missing', () => {
    expect(() => validateEnv(rawEnvWithout('DB_HOST'))).toThrow();
  });

  it('fails fast when INTERNAL_SERVICE_TOKEN is missing (the /internal secret)', () => {
    expect(() => validateEnv(rawEnvWithout('INTERNAL_SERVICE_TOKEN'))).toThrow();
  });

  it('fails fast when OTP_HASH_SECRET is missing (the OTP-code pepper)', () => {
    // The pepper keys the HMAC that hashes OTP codes at rest; booting without it would leave
    // the OTP module unable to hash/verify — the schema must require it, not default it.
    expect(() => validateEnv(rawEnvWithout('OTP_HASH_SECRET'))).toThrow();
  });

  it('fails fast when OTP_HASH_SECRET is present but too short (< 16 chars)', () => {
    // A trivially short pepper weakens the keyed HMAC; the min-length floor must reject it
    // rather than silently accept a weak secret.
    expect(() => validateEnv(completeRawEnv({ OTP_HASH_SECRET: 'short' }))).toThrow();
  });

  it('accepts omitting DB_PORT and REDIS_PORT (they carry defaults 5432 / 6379)', () => {
    // Proves these are optional-with-default, not required — and that a default env
    // still validates once the required secrets are present.
    expect(() => validateEnv(rawEnvWithout('DB_PORT', 'REDIS_PORT'))).not.toThrow();
  });
});
