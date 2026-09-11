// Environment configuration for the admin-app end-to-end (Playwright) suites.
//
// These specs exercise the REAL chain — browser -> internal-nginx -> Kong (JWT verify +
// identity injection, admin-role enforced) -> balance-service admin surface — NOT the MSW stub.
// Everything that depends on the running stack is parameterized here so the suites carry no
// hardcoded infrastructure assumptions. Defaults target the local docker-compose topology
// (internal plane :8081).
//
// Node's `process` is intentionally NOT in this app's tsconfig `types`, so read the environment
// off `globalThis` with a narrow cast — this stays type-safe under strict mode and pulls in
// neither @types/node (which would collide with the DOM lib) nor an ambient redeclaration.

type EnvBag = Record<string, string | undefined>;

const env: EnvBag = (globalThis as { process?: { env?: EnvBag } }).process?.env ?? {};

function flag(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/**
 * PENDING master switch. Left OFF by default: the whole e2e suite is registered but not executed
 * (see `harness.ts`), because the running stack + spec-08 seed data + a Keycloak admin login user
 * do not exist yet. Spec 08 flips this on (`E2E_ENABLED=1`) to run for real — no code edit needed.
 */
export const E2E_ENABLED = flag(env.E2E_ENABLED);

/** Internal front door (internal-nginx). The OIDC redirect_uri derives from this origin. */
export const BASE_URL = env.E2E_BASE_URL ?? 'http://localhost:8081/';

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
function requireCred(kind: 'username' | 'password', name: string): string {
  const value = env[name];
  if (value !== undefined && value !== '') {
    return value;
  }
  throw new Error(
    `${name} must be set to the spec-08-seeded Keycloak admin user's ${kind} when E2E_ENABLED=1`,
  );
}

/** Admin login (spec-08-seeded Keycloak user carrying the `admin` realm role). */
export const requireUsername = (): string => requireCred('username', 'E2E_USERNAME');
export const requirePassword = (): string => requireCred('password', 'E2E_PASSWORD');

/**
 * SECOND admin login, the maker-checker CHECKER. Four-eyes requires a DIFFERENT admin than the maker
 * (`E2E_USERNAME`) to approve a reversal — the server 403s (`SELF_APPROVAL_FORBIDDEN`) if the same
 * identity tries to decide its own proposal — so the reversal e2e drives a second browser context
 * with these credentials. Same lazy-required / never-defaulted contract as the maker accessors: read
 * from the environment on first access, throw a clear error if unset. Must be the spec-08-seeded
 * SECOND admin (`demo-admin-2`, carrying the `admin` realm role), distinct from the maker.
 */
function requireCheckerCred(kind: 'username' | 'password', name: string): string {
  const value = env[name];
  if (value !== undefined && value !== '') {
    return value;
  }
  throw new Error(
    `${name} must be set to the spec-08-seeded SECOND Keycloak admin user's ${kind} ` +
      `(the maker-checker CHECKER: demo-admin-2, distinct from the maker, carrying the ` +
      `'admin' realm role) when E2E_ENABLED=1`,
  );
}

export const requireCheckerUsername = (): string =>
  requireCheckerCred('username', 'E2E_CHECKER_USERNAME');
export const requireCheckerPassword = (): string =>
  requireCheckerCred('password', 'E2E_CHECKER_PASSWORD');
