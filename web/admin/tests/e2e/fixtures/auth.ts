import { type Page } from '@playwright/test';
import { APP_ORIGIN } from './env';

/**
 * Real OIDC Authorization-Code + PKCE login against Keycloak, driven through the browser exactly
 * as an admin would: navigate to the SPA -> get redirected to the Keycloak realm login form ->
 * submit credentials -> land back on the app origin, where the SPA completes the code exchange.
 * This is a genuine round-trip through the identity provider, not a token stub.
 *
 * Selectors target the stock Keycloak login theme (`#username` / `#password` / `#kc-login`); if
 * spec 08 ships a custom theme these are the single place to adjust. The admin app has no
 * out-of-band OTP step, so a single login is all the e2e spine needs.
 */
export async function keycloakLogin(
  page: Page,
  options: { entryPath: string; username: string; password: string },
): Promise<void> {
  await page.goto(options.entryPath);

  // Redirected off-origin to the Keycloak authorization endpoint.
  await page.waitForURL(/\/realms\/supercool\/protocol\/openid-connect\/auth/);
  await page.fill('#username', options.username);
  await page.fill('#password', options.password);
  await page.click('#kc-login');

  // Back on the SPA origin (the code/state land here and are then stripped by the app).
  await page.waitForURL((url) => url.origin === APP_ORIGIN && !url.pathname.includes('/realms/'));
}
