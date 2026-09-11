// Environment configuration for the client-app end-to-end (Playwright) suites.
//
// These specs exercise the REAL chain — browser -> public-nginx -> Kong (JWT verify +
// identity injection) -> balance-service — NOT the MSW stub. Everything that depends on
// the running stack is parameterized here so the suites carry no hardcoded infrastructure
// assumptions. All defaults target the local docker-compose topology (public plane :8080).
//
// Node's `process` is intentionally NOT in this app's tsconfig `types`, so read the
// environment off `globalThis` with a narrow cast — this stays type-safe under strict mode
// and pulls in neither @types/node (which would collide with the DOM lib) nor an ambient
// redeclaration.

type EnvBag = Record<string, string | undefined>;

const env: EnvBag = (globalThis as { process?: { env?: EnvBag } }).process?.env ?? {};

function flag(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/**
 * PENDING master switch. Left OFF by default: the whole e2e suite is registered but not
 * executed (see `harness.ts`), because the running stack + spec-08 seed data + Keycloak
 * login users do not exist yet. Spec 08 flips this on (`E2E_ENABLED=1`) to run for real —
 * no code edit required.
 */
export const E2E_ENABLED = flag(env.E2E_ENABLED);

/** Public front door (public-nginx). The OIDC redirect_uri derives from this origin. */
export const BASE_URL = env.E2E_BASE_URL ?? 'http://localhost:8080';

/** App origin, for asserting we have landed back on the SPA after the Keycloak round-trip. */
export const APP_ORIGIN = new URL(BASE_URL).origin;

/**
 * Login credentials are LAZY-REQUIRED, never defaulted: read from the environment on the first
 * access and throw a clear error if unset. No value (least of all a password) is baked in — a
 * committed credential literal has no place in a money app, where it could be mistaken for, or
 * seeded as, the real spec-08 Keycloak credential. The accessors run only inside a test body,
 * and the suites are PENDING (`describe.fixme`), so module import and `playwright test --list`
 * never touch them and a disabled run never reads a credential.
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

/** Customer login (spec-08-seeded Keycloak user in the `customer` realm role). */
export const requireUsername = (): string => requireCred('username', 'E2E_USERNAME');
export const requirePassword = (): string => requireCred('password', 'E2E_PASSWORD');

/**
 * The OTP app has a SEPARATE Keycloak client but is the SAME human (same `sub`), so the
 * pending authorization it reveals belongs to this customer. Falls back to the customer creds;
 * set the `E2E_OTP_*` vars only if spec 08 seeds a distinct OTP login.
 */
export const requireOtpUsername = (): string =>
  requireCred('username', 'E2E_OTP_USERNAME', 'E2E_USERNAME');
export const requireOtpPassword = (): string =>
  requireCred('password', 'E2E_OTP_PASSWORD', 'E2E_PASSWORD');

/** A seeded 10-digit destination account number for the internal-transfer confirmation-of-payee. */
export const DEST_ACCOUNT = env.E2E_DEST_ACCOUNT ?? '2000000001';

/**
 * The transfer amount, given in BOTH representations so the money-movement assertions stay
 * float-free: the human major-unit string typed into the form, and the exact minor-unit
 * (centavos, MXN scale 2) delta the balance must move by. Keep the two consistent when
 * overriding (10.00 MXN == 1000 centavos).
 */
export const TRANSFER_MAJOR = env.E2E_TRANSFER_MAJOR ?? '10.00';
export const TRANSFER_MINOR = env.E2E_TRANSFER_MINOR ?? '1000';
