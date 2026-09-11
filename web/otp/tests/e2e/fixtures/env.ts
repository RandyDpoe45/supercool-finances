// Environment configuration for the otp-app end-to-end (Playwright) suites.
//
// These specs exercise the REAL chain — browser -> public-nginx -> Kong -> balance-service —
// NOT the MSW stub. The otp-app is served under the `/otp` base on the same public plane and
// logs in with its OWN Keycloak client (`otp-app`), a separate login from the customer app.
//
// Node's `process` is intentionally NOT in this app's tsconfig `types`, so read the
// environment off `globalThis` with a narrow cast — type-safe under strict mode, and it pulls
// in neither @types/node (which would collide with the DOM lib) nor an ambient redeclaration.

type EnvBag = Record<string, string | undefined>;

const env: EnvBag = (globalThis as { process?: { env?: EnvBag } }).process?.env ?? {};

function flag(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/**
 * PENDING master switch. Left OFF by default: the whole e2e suite is registered but not
 * executed (see `harness.ts`), because the running stack + spec-08 seed data + Keycloak login
 * users do not exist yet. Spec 08 flips this on (`E2E_ENABLED=1`) to run for real.
 */
export const E2E_ENABLED = flag(env.E2E_ENABLED);

/** Public front door (public-nginx). The otp-app lives under the `/otp/` base of this origin. */
export const BASE_URL = env.E2E_BASE_URL ?? 'http://localhost:8080';

/** App origin, for asserting we land back on the SPA after the Keycloak round-trip. */
export const APP_ORIGIN = new URL(BASE_URL).origin;

/** The otp-app entry (its `/otp/` base). PKCE redirect_uri derives from this. */
export const OTP_ENTRY = '/otp/';

/**
 * The out-of-band login. It is the SAME human as the customer app (so the pending it reveals
 * belongs to them), authenticated through the SEPARATE `otp-app` Keycloak client.
 *
 * The credentials are LAZY-REQUIRED, never defaulted: read from the environment on the first
 * access and throw a clear error if unset. No value (least of all a password) is baked in — a
 * committed credential literal has no place in a money app, where it could be mistaken for, or
 * seeded as, the real spec-08 Keycloak credential. They fall back from the `E2E_OTP_*` vars to
 * the shared `E2E_*` customer creds. The accessors run only inside a test body, and the suites
 * are PENDING (`describe.fixme`), so module import and `playwright test --list` never touch
 * them and a disabled run never reads a credential.
 */
function requireCred(kind: 'username' | 'password', ...names: string[]): string {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  throw new Error(
    `${names.join(' or ')} must be set to the spec-08-seeded Keycloak user's ${kind} when E2E_ENABLED=1`,
  );
}

export const requireUsername = (): string =>
  requireCred('username', 'E2E_OTP_USERNAME', 'E2E_USERNAME');
export const requirePassword = (): string =>
  requireCred('password', 'E2E_OTP_PASSWORD', 'E2E_PASSWORD');
